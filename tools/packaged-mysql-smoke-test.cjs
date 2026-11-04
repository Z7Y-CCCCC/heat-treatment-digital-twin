const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess, createSmokeEnvironment } = require('../desktop/scripts/smoke-sandbox.cjs');
const { snapshotTree, verifyTree } = require('./package-resource-integrity.cjs');
const { createPackageView, activateFixture } = require('./activation-test-fixture.cjs');
const mysql = require('../backend/node_modules/mysql2/promise');
const Database = require('../backend/node_modules/better-sqlite3');

const sourceExecutable = path.resolve(process.argv[2] || '安装包/win-unpacked/热处理数字孪生大屏.exe');
const sourceResources = path.join(path.dirname(sourceExecutable), 'resources');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const configurationTables = ['factories', 'factory_settings', 'workshops', 'lines', 'devices', 'data_points',
    'models', 'bindings', 'device_templates', 'datapoint_templates', 'projects', 'scenes', 'widgets', 'releases'];

function filesBelow(directory, prefix = '') {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const name = path.join(prefix, entry.name);
        return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), name) : [name];
    });
}

function fileHash(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function isInside(root, filename) {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(filename));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function processExists(pid) {
    try { process.kill(pid, 0); return true; } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
    }
}

async function main() {
    assert.ok(fs.existsSync(sourceExecutable), `Missing packaged executable: ${sourceExecutable}`);
    assert.ok(fs.existsSync(path.join(sourceResources, 'mysql', 'bin', 'mysqld.exe')), 'The MySQL runtime must be packaged.');
    const directory = createRunDirectory('packaged-mysql-smoke');
    const resourcesBefore = await snapshotTree(sourceResources);
    const { executable, resources, privateKey } = createPackageView(sourceExecutable, directory);
    const dataDir = path.join(directory, 'data');
    const configPath = path.join(dataDir, 'database-config.json');
    const template = new Database(path.join(resources, 'templates', 'factory-template.db'), { readonly: true, fileMustExist: true });
    const expectedCounts = {};
    try {
        assert.equal(template.pragma('quick_check', { simple: true }), 'ok');
        for (const table of configurationTables) expectedCounts[table] = template.prepare(`SELECT COUNT(*) AS n FROM \`${table}\``).get().n;
    } finally { template.close(); }

    const env = createSmokeEnvironment(directory, {
        APP_USER_DATA_DIR: directory,
        APP_DATA_DIR: dataDir,
        UPLOADS_DIR: path.join(directory, 'uploads'),
        DB_BACKUP_DIR: path.join(dataDir, 'backups'),
        DB_RECOVERY_DIR: path.join(dataDir, 'recovery'),
        SITE_BACKUP_DIR: path.join(dataDir, 'site-backups'),
        LICENSE_FILE: path.join(dataDir, 'license.json'),
        DISABLE_AUTO_START: 'true',
        NATIVE_CLIENT_SMOKE_MODE: 'true',
        DESKTOP_SMOKE_STANDALONE: 'true',
        DESKTOP_SMOKE_EXIT_AFTER_MS: '22000'
    });
    assert.equal(fs.existsSync(configPath), false, 'First launch must begin without a pre-created database configuration.');
    const persistenceToken = crypto.randomBytes(16).toString('hex');
    const launches = [];

    for (const phase of ['first-install', 'restart']) {
        const started = Date.now();
        const logPath = path.join(directory, 'logs', 'backend.log');
        const previousLog = fs.existsSync(logPath) ? fs.statSync(logPath) : null;
        const child = spawn(executable, [], { cwd: path.dirname(executable), windowsHide: true, env, stdio: 'ignore' });
        let exited = false;
        let spawnError;
        const completion = new Promise(resolve => {
            child.once('error', error => { spawnError = error; exited = true; resolve({ error: error.message }); });
            child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
        });
        let connection;
        let mysqlPid;
        let result;
        let activated = false;
        let phaseError;
        try {
            // A cold fixture copies the complete package, verifies prerequisites,
            // initializes MySQL and extracts native dependencies on this disk.
            // Keep that installation work separate from runtime readiness.
            const readyDeadline = Date.now() + (phase === 'first-install' ? 420000 : 240000);
            while (Date.now() < readyDeadline) {
                if (spawnError) throw spawnError;
                if (exited) throw new Error(`Desktop exited before its MySQL backend became ready; inspect ${directory}`);
                let log = '';
                if (fs.existsSync(logPath)) {
                    const currentLog = fs.statSync(logPath);
                    // The desktop rotates its log at every launch. A new file
                    // must be read from byte zero, including on the warm run.
                    const offset = previousLog && previousLog.ino === currentLog.ino && currentLog.size >= previousLog.size ? previousLog.size : 0;
                    log = fs.readFileSync(logPath).subarray(offset).toString('utf8');
                }
                if (fs.existsSync(configPath) && log.includes('Database:    mysql')) {
                    const match = log.match(/后端服务已启动:\s*(http:\/\/127\.0\.0\.1:\d+)/);
                    if (match) { await activateFixture(match[1], privateKey); activated = true; break; }
                }
                const startupFailure = path.join(directory, 'logs', 'startup-error.log');
                if (fs.existsSync(startupFailure)) throw new Error(fs.readFileSync(startupFailure, 'utf8'));
                await delay(500);
            }
            assert.equal(activated, true, `Desktop backend/activation readiness timed out; inspect ${directory}`);
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.equal(activated, true, 'Real activation must complete before Unity starts');
            assert.equal(config.type, 'mysql');
            connection = await mysql.createConnection({
                host: config.host, port: config.port, user: config.user, password: config.password,
                database: config.database, connectTimeout: 10000
            });
            const [[server]] = await connection.query('SELECT @@version AS version, @@datadir AS datadir, @@pid_file AS pidFile, @@port AS port');
            assert.ok(isInside(directory, server.datadir), 'The smoke test must use its own MySQL data directory.');
            assert.ok(isInside(directory, server.pidFile), 'The MySQL PID file must be isolated.');
            mysqlPid = Number(fs.readFileSync(server.pidFile, 'utf8').trim());
            assert.ok(Number.isSafeInteger(mysqlPid) && mysqlPid > 0);
            const actualCounts = {};
            for (const table of configurationTables) {
                const [[row]] = await connection.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
                actualCounts[table] = Number(row.n);
            }
            assert.deepEqual(actualCounts, expectedCounts, 'All delivered configuration tables must survive MySQL import.');
            const [[seedRow]] = await connection.query('SELECT result_json FROM _desktop_seed_state WHERE id = 1');
            const seedResult = JSON.parse(seedRow.result_json);
            const snapshotDb = new Database(
                path.join(resources, 'templates', 'factory-template.db'), { readonly: true, fileMustExist: true });
            try {
                for (const table of ['event_logs', 'metric_snapshots']) {
                    const expected = snapshotDb.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
                    assert.equal(seedResult.counts[table], expected, `All delivered history must survive MySQL import: ${table}`);
                }
            } finally { snapshotDb.close(); }
            const deliveredConfiguration = filesBelow(path.join(resources, 'templates', 'data'));
            for (const name of deliveredConfiguration) {
                const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
                const actual = readJson(path.join(dataDir, name));
                const expected = readJson(path.join(resources, 'templates', 'data', name));
                if (/^backup-storage-(?:database|site)\.json$/.test(name)) {
                    // New installations intentionally refresh migration metadata;
                    // the configured storage budget must remain unchanged.
                    assert.equal(actual.maxTotalBytes, expected.maxTotalBytes, `Backup storage budget differs: ${name}`);
                } else {
                    assert.deepEqual(actual, expected, `Portable application configuration differs: ${name}`);
                }
            }
            if (phase === 'first-install') {
                await connection.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', ['packaged_smoke_persistence', persistenceToken]);
            } else {
                const [[row]] = await connection.query('SELECT value FROM settings WHERE `key` = ?', ['packaged_smoke_persistence']);
                assert.equal(row?.value, persistenceToken, 'Restart must retain user additions instead of reimporting the template.');
            }
            const uploadFiles = filesBelow(path.join(resources, 'templates', 'uploads'));
            for (const filename of uploadFiles) {
                assert.equal(fileHash(path.join(directory, 'uploads', filename)), fileHash(path.join(resources, 'templates', 'uploads', filename)), `Upload differs: ${filename}`);
            }
            await connection.end();
            connection = null;
            // Health readiness precedes Unity/WebView startup. Account-protected
            // installations also need the login chrome, then the 22s smoke run
            // and up to 40s of safe shutdown; 60s truncated valid cold launches.
            const remaining = 150000;
            let timeout;
            const exit = await Promise.race([
                completion,
                new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Desktop did not finish startup/shutdown; inspect ${directory}`)), remaining); })
            ]).finally(() => clearTimeout(timeout));
            assert.equal(exit.code, 0, `Desktop failed: ${JSON.stringify(exit)}`);
            const nativeLog = fs.readFileSync(path.join(directory, 'logs', 'native-client.log'), 'utf8');
            assert.match(nativeLog, /\[FactoryRuntime\] (?:Application tab chrome requested|Native factory ready)/);
            assert.doesNotMatch(nativeLog, /(?:InvalidCast|NullReference|Argument|IndexOutOfRange)Exception:/);
            const desktopErrors = path.join(directory, 'logs', 'desktop-error.log');
            if (fs.existsSync(desktopErrors)) assert.equal(fs.readFileSync(desktopErrors, 'utf8').trim(), '');
            const backendErrorPath = path.join(directory, 'logs', 'backend-error.log');
            const backendErrors = fs.existsSync(backendErrorPath) ? fs.readFileSync(backendErrorPath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
            const unexpectedBackendErrors = backendErrors.filter(line => !line.includes('[PlcReader]') && !(line.includes('EADDRINUSE') && line.includes('8787')));
            assert.deepEqual(unexpectedBackendErrors, [], 'Backend errors (including database/backup failures) must be resolved.');
            const stopDeadline = Date.now() + 15000;
            while (processExists(mysqlPid) && Date.now() < stopDeadline) await delay(250);
            assert.equal(processExists(mysqlPid), false, 'The private MySQL process must exit with its desktop supervisor.');
            result = { phase, success: true, elapsedMs: Date.now() - started, mysqlVersion: server.version,
                mysqlPort: Number(server.port), mysqlStopped: true, configurationCounts: actualCounts, uploadFilesVerified: uploadFiles.length,
                historyCountsImported: { event_logs: seedResult.counts.event_logs, metric_snapshots: seedResult.counts.metric_snapshots },
                portableConfigurationFilesVerified: deliveredConfiguration.length };
            launches.push(result);
        } catch (error) {
            phaseError = error;
            fs.writeFileSync(path.join(directory, 'smoke-failure.json'), JSON.stringify({ success: false, phase, error: error.stack }, null, 2));
            throw error;
        } finally {
            if (connection) await connection.end().catch(() => {});
            if (!exited) {
                try { await stopOwnedSmokeProcess(child); }
                catch (cleanupError) {
                    if (phaseError) throw new AggregateError([phaseError, cleanupError], 'Packaged smoke failed and cleanup also failed');
                    throw cleanupError;
                }
            }
        }
    }
    const resourceIntegrity = await verifyTree(sourceResources, resourcesBefore);
    const report = { success: true, executable: sourceExecutable, fixtureExecutable: executable, fixtureTrustOnly: true, userDataDirectory: directory, programData: env.ProgramData, resourceIntegrity, launches };
    fs.writeFileSync(path.join(directory, 'smoke-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
