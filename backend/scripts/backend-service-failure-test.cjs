const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const { Writable } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');

// This suite has no network use case. Fail closed even if a future lazy driver
// import stops matching one of the explicit module stubs below.
net.Socket.prototype.connect = function() {
    throw new Error('Test isolation forbids all TCP connections');
};

const outputRoot = path.resolve(__dirname, '..', '..', 'output');
fs.mkdirSync(outputRoot, { recursive: true });
const runDirectory = fs.mkdtempSync(path.join(outputRoot, 'backend-service-failure-'));
Object.assign(process.env, {
    NODE_ENV: 'test', APP_DATA_DIR: path.join(runDirectory, 'data'), DB_TYPE: 'sqlite',
    SQLITE_FILE: path.join(runDirectory, 'data', 'factory.db'),
    DB_BACKUP_DIR: path.join(runDirectory, 'backups'), DB_RECOVERY_DIR: path.join(runDirectory, 'recovery'),
    DATA_SOURCE_BACKUP_DIR: path.join(runDirectory, 'source-backups')
});
delete process.env.SQLITE_RECOVERY_TEMPLATE;
delete process.env.SQLITE_UPGRADE_TEMPLATE;
const results = [];

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function requireWithStubs(filename, stubs) {
    const target = require.resolve(filename);
    const dependencies = new Map(Object.entries(stubs).map(([dependency, value]) => [require.resolve(dependency), value]));
    const isolated = new Module(target, module);
    isolated.filename = target;
    isolated.paths = Module._nodeModulePaths(path.dirname(target));
    const originalRequire = isolated.require.bind(isolated);
    isolated.require = request => {
        const resolved = Module._resolveFilename(request, isolated);
        return dependencies.has(resolved) ? dependencies.get(resolved) : originalRequire(request);
    };
    // The override belongs to this module instance, so lazy require() inside
    // exported methods remains isolated after loading has returned.
    isolated._compile(fs.readFileSync(target, 'utf8'), target);
    return isolated.exports;
}

async function check(name, callback) {
    try { await callback(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

async function main() {
    await check('MySQL preflight closes both admin and failed query connections', async () => {
        let closes = 0;
        let destroys = 0;
        const database = requireWithStubs('../db/database', {
            'mysql2/promise': { createConnection: async config => {
                assert.ok(config.connectTimeout >= 1000 && config.connectTimeout <= 30000);
                return {
                    async query(options) {
                        assert.ok(options.timeout >= 1000 && options.timeout <= 60000);
                        if (config.database) throw new Error('injected query failure');
                        return [[]];
                    },
                    destroy() { destroys += 1; },
                    async end() { closes += 1; }
                };
            } }
        });
        await assert.rejects(database.testDatabaseConfig({ type: 'mysql', database: 'probe_fixture' }), /injected/);
        assert.equal(closes, 1);
        assert.equal(destroys, 1);
    });

    await check('PostgreSQL preflight closes a pool after query failure', async () => {
        let closes = 0;
        class Pool {
            constructor(config) {
                assert.ok(config.connectionTimeoutMillis >= 1000 && config.connectionTimeoutMillis <= 30000);
                assert.ok(config.query_timeout >= 1000 && config.query_timeout <= 60000);
                assert.equal(config.statement_timeout, config.query_timeout);
                this.config = config;
            }
            async query() { if (this.config.database === 'probe_fixture') throw new Error('injected query failure'); return { rowCount: 1 }; }
            async end() { closes += 1; }
        }
        const database = requireWithStubs('../db/database', { pg: { Pool } });
        await assert.rejects(database.testDatabaseConfig({ type: 'postgres', database: 'probe_fixture' }), /injected/);
        assert.equal(closes, 2);
    });

    for (const failDuringConnect of [false, true]) {
        await check(`SQL Server preflight uses independent pools and closes after ${failDuringConnect ? 'connect' : 'query'} failure`, async () => {
            let closes = 0;
            let globalConnections = 0;
            class ConnectionPool {
                constructor(config) {
                    assert.ok(config.connectionTimeout >= 1000 && config.connectionTimeout <= 30000);
                    assert.ok(config.requestTimeout >= 1000 && config.requestTimeout <= 60000);
                    this.config = config;
                }
                async connect() { if (failDuringConnect && this.config.database === 'probe_fixture') throw new Error('injected connect failure'); return this; }
                request() { return { query: async () => { if (this.config.database === 'probe_fixture') throw new Error('injected query failure'); return {}; } }; }
                async close() { closes += 1; }
            }
            const database = requireWithStubs('../db/database', { mssql: { ConnectionPool, async connect() { globalConnections += 1; throw new Error('global pool must not be used'); } } });
            await assert.rejects(database.testDatabaseConfig({ type: 'sqlserver', database: 'probe_fixture' }), /injected/);
            assert.equal(closes, 2);
            assert.equal(globalConnections, 0);
        });
    }

    await check('SQLite preflight closes a database after failed integrity check', async () => {
        let closes = 0;
        class FakeSqlite {
            prepare() { return { get: () => ({ value: 1 }) }; }
            pragma() { return 'injected corruption'; }
            close() { closes += 1; }
        }
        const database = requireWithStubs('../db/database', { 'better-sqlite3': FakeSqlite });
        await assert.rejects(database.testDatabaseConfig({ type: 'sqlite' }), /完整性/);
        assert.equal(closes, 1);
    });

    await check('external compressed backup handles disk-write errors without an unhandled stream error', async () => {
        let closes = 0;
        class FakePgClient {
            async connect() {}
            async query() { return { rows: [] }; }
            async end() { closes += 1; }
        }
        const sources = requireWithStubs('../services/dataSources', { pg: { Client: FakePgClient } });
        sources.saveDataSource({ id: 'stream_failure', type: 'postgres', name: 'Isolated stream test', database: 'fixture', enabled: true });
        const originalWriteStream = fs.createWriteStream;
        fs.createWriteStream = function(filename, options) {
            if (String(filename).startsWith(process.env.DATA_SOURCE_BACKUP_DIR)) {
                return new Writable({ write(chunk, encoding, callback) { callback(new Error('injected ENOSPC')); } });
            }
            return originalWriteStream.call(fs, filename, options);
        };
        try { await assert.rejects(sources.createConnectionBackup('stream_failure'), /ENOSPC/); }
        finally { fs.createWriteStream = originalWriteStream; }
        assert.equal(closes, 1);
    });

    await check('external backups of the same connection are shared and maintenance stop waits for them', async () => {
        const entered = deferred();
        const release = deferred();
        let backups = 0;
        let closes = 0;
        class FakeSqlite {
            pragma() { return 'ok'; }
            async backup(filename) { backups += 1; entered.resolve(); await release.promise; fs.writeFileSync(filename, 'isolated snapshot'); }
            close() { closes += 1; }
        }
        const sources = requireWithStubs('../services/dataSources', { 'better-sqlite3': FakeSqlite });
        const source = path.join(runDirectory, 'external-fixture.db');
        fs.writeFileSync(source, 'isolated SQLite stand-in');
        sources.saveDataSource({ id: 'parallel_backup', type: 'sqlite', filename: source, enabled: true });
        const first = sources.createConnectionBackup('parallel_backup');
        const second = sources.createConnectionBackup('parallel_backup');
        await entered.promise;
        let stopped = false;
        const stopping = sources.stopDataSourceMaintenance({ backup: false }).then(() => { stopped = true; });
        await nextTurn();
        assert.equal(stopped, false);
        release.resolve();
        const saved = await Promise.all([first, second]);
        await stopping;
        assert.equal(backups, 1);
        assert.equal(closes, 1);
        assert.equal(saved[0].filename, saved[1].filename);
    });

    await check('stopping data-source maintenance cancels a queued startup backup', async () => {
        let backups = 0;
        const sources = requireWithStubs('../services/dataSources', {
            '../db/database': {
                loadDatabaseConfig: () => ({ type: 'sqlite', filename: process.env.SQLITE_FILE }),
                createDatabaseBackup: async () => { backups += 1; return { filename: 'fixture.db' }; }
            }
        });
        sources.saveBackupConfig({ startupEnabled: true, scheduledEnabled: false, shutdownEnabled: false, selectedConnectionIds: ['primary'] });
        sources.startDataSourceMaintenance();
        await sources.stopDataSourceMaintenance({ backup: false });
        await nextTurn();
        assert.equal(backups, 0);
    });

    await check('invalid external SQLite input is rejected before entering asynchronous backup', async () => {
        const sources = require('../services/dataSources');
        const filename = path.join(runDirectory, 'not-a-database.db');
        fs.writeFileSync(filename, 'deliberately invalid isolated database fixture');
        sources.saveDataSource({ id: 'invalid_sqlite', type: 'sqlite', filename, enabled: true });
        await assert.rejects(sources.createConnectionBackup('invalid_sqlite'), /not a database|完整性/);
    });

    const failed = results.filter(result => !result.passed).length;
    fs.writeFileSync(path.join(runDirectory, 'result.json'), JSON.stringify({ runDirectory, results }, null, 2));
    console.log(JSON.stringify({ tests: results.length, passed: results.length - failed, failed, runDirectory }));
    process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
