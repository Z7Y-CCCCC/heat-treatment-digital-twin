const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { setTimeout: delay, setImmediate: nextTurn } = require('node:timers/promises');
const { acquireMysqlConnection, MysqlSession } = require('../utils/mysqlRuntimeSafety');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const directory = createRunDirectory('mysql-runtime-safety');
process.env.APP_DATA_DIR = path.join(directory, 'data');
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_FILE = path.join(directory, 'data', 'unused.db');
const results = [];
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function pendingCheckouts(pool, count) {
    const checkouts = Array.from({ length: count }, () => pool.getConnection());
    // Preserve the promises for assertions while consuming failures that may
    // arrive before the test reaches an await, including cleanup after failure.
    for (const checkout of checkouts) checkout.catch(() => {});
    return checkouts;
}

async function createMysqlFixture({ handshake = true, connectTimeout = 1000 } = {}) {
    const mysql = require('mysql2');
    const server = mysql.createServer();
    const serverConnections = new Set(), serverSockets = new Set(), clientSockets = new Set();
    let closing = false;
    const track = (set, value, stream = value) => {
        set.add(value);
        stream.once('close', () => set.delete(value));
    };
    server._server.on('connection', socket => {
        track(serverSockets, socket);
        if (closing) socket.destroy();
    });
    server.on('connection', connection => {
        track(serverConnections, connection, connection.stream);
        connection.on('error', () => {});
        if (closing) { connection.destroy(); connection.stream.destroy(); return; }
        if (!handshake) return;
        connection.serverHandshake({ protocolVersion: 10, serverVersion: '5.7.0-isolated', connectionId: 1,
            statusFlags: 2, characterSet: 45, capabilityFlags: 0x00088200 });
        connection.on('query', query => {
            if (query === 'SELECT healthy') connection.writeOk();
            // All other commands and prepares deliberately receive no reply.
        });
        connection.on('stmt_prepare', query => {
            if (query === 'SELECT broken') connection.writeError({ code: 1064, message: 'isolated fixture syntax error' });
        });
    });
    await new Promise((resolve, reject) => { server._server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server._server.address().port;
    const pool = mysql.createPool({ host: '127.0.0.1', port, user: 'isolated', password: '',
        connectionLimit: 1, queueLimit: 2, waitForConnections: true, connectTimeout,
        stream: () => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            track(clientSockets, socket);
            if (closing) socket.destroy();
            return socket;
        } }).promise();
    const destroyOwned = () => {
        // mysql2 destroy() ends the stream; force destruction also closes a
        // stalled handshake. Server Connection.destroy() clears its timeout.
        const clients = [];
        for (let index = 0; index < pool.pool._allConnections.length; index += 1) clients.push(pool.pool._allConnections.get(index));
        for (const connection of [...clients, ...serverConnections]) {
            try { connection.destroy(); } finally { connection.stream.destroy(); }
        }
        for (const socket of [...serverSockets, ...clientSockets]) socket.destroy();
    };
    async function close(endPool = () => pool.end()) {
        closing = true;
        const closedSockets = [...new Set([...serverSockets, ...clientSockets])].map(socket =>
            socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve)));
        // Initiate both closes before awaiting either. A failed pool end must
        // not leave the listener open, and late sockets are rejected above.
        const stoppingServer = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        let stoppingPool;
        try { stoppingPool = Promise.resolve(endPool()); } catch (error) { stoppingPool = Promise.reject(error); }
        const completed = Promise.allSettled([stoppingServer, stoppingPool, ...closedSockets]);
        destroyOwned();
        let timer;
        try {
            const result = await Promise.race([completed, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('MySQL fixture cleanup exceeded 2000ms')), 2000);
            })]);
            await nextTurn();
            assert.equal(server._server.listening, false);
            assert.equal(serverSockets.size, 0, 'fixture must close every accepted server socket');
            assert.equal(clientSockets.size, 0, 'fixture must close every client socket, including failed checkouts');
            assert.equal(serverConnections.size, 0, 'fixture must retire server-side handshake timers');
            const rejected = result.find(row => row.status === 'rejected');
            if (rejected) throw rejected.reason;
        } finally { clearTimeout(timer); destroyOwned(); }
    }
    return { pool, close, serverSockets, clientSockets, serverConnections };
}
async function check(name, callback) {
    try { await callback(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); }
}

async function main() {
    await check('expired checkouts return late connections without leaking a pool slot', async () => {
        const arriving = deferred();
        let releases = 0;
        await assert.rejects(acquireMysqlConnection({ getConnection: () => arriving.promise }, 25), /acquisition/);
        arriving.resolve({ release() { releases += 1; } });
        await nextTurn();
        assert.equal(releases, 1);
    });
    await check('failed late-checkout cleanup destroys its connection without unhandled rejection', async () => {
        const arriving = deferred();
        let destroys = 0;
        const unhandled = [];
        const listener = error => unhandled.push(error);
        process.on('unhandledRejection', listener);
        try {
            await assert.rejects(acquireMysqlConnection({ getConnection: () => arriving.promise }, 25), /acquisition/);
            arriving.resolve({ release() { throw new Error('injected late release failure'); }, destroy() { destroys += 1; } });
            await delay(25);
            assert.equal(destroys, 1);
            assert.equal(unhandled.length, 0);
        } finally { process.off('unhandledRejection', listener); }
    });
    await check('query timeout destroys only its exclusively owned connection and never releases it', async () => {
        let destroyed = 0, released = 0, otherDestroyed = 0;
        const other = new MysqlSession({ execute: async () => [[{ value: 7 }]], destroy() { otherDestroyed += 1; }, release() {} }, 50);
        const session = new MysqlSession({ execute: () => new Promise(() => {}), destroy() { destroyed += 1; }, release() { released += 1; } }, 25);
        await assert.rejects(session.execute('SELECT 1', []), /statement/);
        session.release();
        assert.equal(destroyed, 1);
        assert.equal(released, 0);
        assert.equal(otherDestroyed, 0);
        assert.equal((await other.execute('SELECT 7', []))[0][0].value, 7);
        other.release();
        assert.throws(() => session.execute('late write', []), /ended/);
    });
    await check('release failures preserve the original statement error', async () => {
        const session = new MysqlSession({ execute: async () => { throw new Error('original failure'); },
            release() { throw new Error('release failure'); }, destroy() {} }, 50);
        let failure;
        try { await session.execute('SELECT 1', []); }
        catch (error) { failure = error; }
        finally { session.release(); }
        assert.equal(failure.message, 'original failure');
        assert.equal(session.destroyed, true);
    });
    await check('production transaction deadline rejects a late callback and never commits or reuses its client', async () => {
        const filename = require.resolve('../db/database');
        const context = vm.createContext({ require: createRequire(filename), __dirname: path.dirname(filename), process, console,
            module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval, Buffer });
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
        let commits = 0, destroys = 0, releases = 0;
        const callback = deferred();
        const connection = { beginTransaction: async () => {}, execute: async () => [{ affectedRows: 1 }],
            commit: async () => { commits += 1; }, rollback: async () => {}, destroy() { destroys += 1; }, release() { releases += 1; } };
        context.fixture = { getConnection: async () => connection };
        vm.runInContext("activeConfig = { type: 'mysql', transactionTimeoutMs: 1000 }; pool = fixture", context);
        let client;
        const transaction = vm.runInContext('transaction', context)(async tx => { client = tx; await callback.promise; return 9; });
        await assert.rejects(transaction, /transaction.*1000ms/);
        callback.resolve();
        await nextTurn();
        await assert.rejects(client.run('INSERT INTO anything VALUES (?)', [1]), /ended/);
        assert.equal(commits, 0);
        assert.equal(destroys, 1);
        assert.equal(releases, 0);
    });
    await check('real mysql2 half-open TCP commands time out, while pool capacity remains bounded', async () => {
        const fixture = await createMysqlFixture();
        const { pool } = fixture;
        try {
            const first = await acquireMysqlConnection(pool, 1000);
            const waiting = pendingCheckouts(pool, 2);
            await assert.rejects(pool.getConnection(), /Queue limit reached/);
            const session = new MysqlSession(first, 50);
            await assert.rejects(session.execute('SELECT black_hole', []), /statement/);
            session.release();
            const next = await waiting[0];
            const healthy = new MysqlSession(next, 1000);
            await healthy.deadline('healthy query', () => next.query('SELECT healthy'));
            healthy.release();
            (await waiting[1]).release();
            assert.ok(pool.pool._connectionQueue.length <= 2);

            const filename = require.resolve('../db/database');
            const context = vm.createContext({ require: createRequire(filename), __dirname: path.dirname(filename), process, console,
                module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval, Buffer });
            vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
            context.fixture = pool;
            vm.runInContext("activeConfig = { type: 'mysql', queryTimeoutMs: 1000, connectTimeoutMs: 1000 }; pool = fixture; databaseReady = true; initPromise = Promise.resolve()", context);
            const db = await context.module.exports.getDb();
            assert.equal(context.module.exports.getDbStatus().connected, true);
            await assert.rejects(db.all('SELECT black_hole'), /statement/);
            assert.equal(context.module.exports.getDbStatus().connected, false, 'transport timeout must remove database readiness');
            await vm.runInContext('queryMysql', context)('SELECT healthy');
            assert.equal(context.module.exports.getDbStatus().connected, true, 'a successful query restores runtime readiness');
            await assert.rejects(db.all('SELECT broken'), error => error.errno === 1064);
            assert.equal(context.module.exports.getDbStatus().connected, true, 'SQL syntax failure is not an offline database');
        } finally {
            await fixture.close();
        }
    });
    await check('a real stalled handshake and failed pool close still retire all fixture sockets and timers', async () => {
        const fixture = await createMysqlFixture({ handshake: false, connectTimeout: 50 });
        try {
            await assert.rejects(fixture.pool.getConnection(), error => error.code === 'ETIMEDOUT');
        } finally {
            await assert.rejects(fixture.close(() => {
                fixture.pool.end().catch(() => {});
                throw new Error('injected fixture pool end failure');
            }), /injected fixture pool end failure/);
        }
        assert.equal(fixture.serverSockets.size + fixture.clientSockets.size + fixture.serverConnections.size, 0);
    });
    await check('early fixture failure consumes queued checkout rejections and preserves the original error', async () => {
        const fixture = await createMysqlFixture();
        const unhandled = [];
        const listener = error => unhandled.push(error);
        process.on('unhandledRejection', listener);
        let waiting = [];
        try {
            await assert.rejects((async () => {
                try {
                    await fixture.pool.getConnection();
                    waiting = pendingCheckouts(fixture.pool, 2);
                    throw new Error('injected early fixture command failure');
                } finally { await fixture.close(); }
            })(), /injected early fixture command failure/);
            assert.equal(waiting.length, 2);
            for (const checkout of waiting) await assert.rejects(checkout, /Pool is closed/);
            await delay(25);
            assert.equal(unhandled.length, 0);
            assert.equal(fixture.serverSockets.size + fixture.clientSockets.size + fixture.serverConnections.size, 0);
        } finally { process.off('unhandledRejection', listener); }
    });
}

main().then(() => {
    const result = { success: results.every(row => row.passed), passed: results.filter(row => row.passed).length, total: results.length, results, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, results: undefined }));
    if (!result.success) process.exitCode = 1;
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
