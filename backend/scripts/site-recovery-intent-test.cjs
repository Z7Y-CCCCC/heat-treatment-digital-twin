const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, forceStop } = require('./integration-test-utils.cjs');

const directory = createRunDirectory('site-recovery-intent');
Object.assign(process.env, { NODE_ENV: 'test', APP_DATA_DIR: path.join(directory, 'data'), DB_TYPE: 'sqlite',
    SQLITE_FILE: path.join(directory, 'data', 'business.db'), DB_BACKUP_DIR: path.join(directory, 'backups'),
    DB_RECOVERY_DIR: path.join(directory, 'recovery'), SITE_IMPORT_DIR: path.join(directory, 'imports'),
    SITE_BACKUP_DIR: path.join(directory, 'site-backups'), UPLOADS_DIR: path.join(directory, 'uploads') });
delete process.env.SQLITE_RECOVERY_TEMPLATE;
delete process.env.SQLITE_UPGRADE_TEMPLATE;
const recovery = require('../services/siteRecoveryIntent');
const results = [];
const source = path.join(directory, 'source.zip');
const rollback = path.join(directory, 'before.db');
fs.writeFileSync(source, 'isolated utility evidence');
fs.writeFileSync(rollback, 'isolated rollback evidence');
const intentOptions = { archiveFilename: source, rollbackDatabaseFilename: rollback,
    stagingDirectory: path.join(directory, 'staging'), uploadsRoot: process.env.UPLOADS_DIR, databaseType: 'sqlite' };

async function check(name, callback) {
    try { await callback(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); }
}
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

async function main() {
    await check('published evidence is verified and concurrent recoveries cannot overwrite the authority', async () => {
        const attempts = await Promise.allSettled([recovery.beginSiteRecoveryIntent(intentOptions), recovery.beginSiteRecoveryIntent(intentOptions)]);
        assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
        const intent = attempts.find(row => row.status === 'fulfilled').value;
        assert.equal(hash(intent.files['source.zip'].filename), intent.files['source.zip'].sha256);
        await recovery.finishSiteRecoveryIntent(intent, 'rolled-back');
    });
    await check('an existing intent cannot hide recovery by supplying pending=false', async () => {
        const intent = await recovery.beginSiteRecoveryIntent(intentOptions);
        fs.writeFileSync(recovery.intentFilename, JSON.stringify({ ...intent, pending: false, requiresRecovery: false }));
        assert.equal(recovery.siteRecoveryStatus().pending, true);
        assert.equal(recovery.siteRecoveryStatus().requiresRecovery, true);
        await recovery.finishSiteRecoveryIntent(intent, 'rolled-back');
    });
    await check('filesystem stat EACCES and EIO preserve failed readiness; only ENOENT means no intent', async () => {
        const intent = await recovery.beginSiteRecoveryIntent(intentOptions);
        const stat = fs.statSync;
        let checked = 0;
        try {
            for (const code of ['EACCES', 'EIO', 'ENOENT']) {
                fs.statSync = (filename, options) => {
                    if (filename === recovery.intentFilename) {
                        checked += 1;
                        throw Object.assign(new Error(`injected stat ${code}`), { code });
                    }
                    return stat(filename, options);
                };
                const status = recovery.siteRecoveryStatus();
                assert.equal(status.pending, code !== 'ENOENT');
                if (code !== 'ENOENT') {
                    assert.equal(status.requiresRecovery, true);
                    assert.equal(status.phase, 'unreadable');
                    assert.match(status.error, new RegExp(code));
                    assert.throws(() => recovery.assertNoPendingSiteRecovery(), /待决恢复/);
                }
            }
        } finally { fs.statSync = stat; }
        assert.equal(checked, 5, 'status and guards must use stat errors rather than silently returning false from existsSync');
        assert.ok(fs.existsSync(intent.files['source.zip'].filename));
        await recovery.finishSiteRecoveryIntent(intent, 'rolled-back');
    });
    await check('failed phase replacement preserves the previous complete intent and its evidence', async () => {
        const intent = await recovery.beginSiteRecoveryIntent(intentOptions);
        const originalHash = hash(recovery.intentFilename);
        const rename = fs.promises.rename;
        fs.promises.rename = async (from, to) => { if (to === recovery.intentFilename) throw Object.assign(new Error('injected phase EACCES'), { code: 'EACCES' }); return rename(from, to); };
        try { await assert.rejects(recovery.updateSiteRecoveryIntent(intent, 'business-restored'), /EACCES/); }
        finally { fs.promises.rename = rename; }
        assert.equal(hash(recovery.intentFilename), originalHash);
        assert.ok(fs.existsSync(intent.files['source.zip'].filename));
        await recovery.finishSiteRecoveryIntent(intent, 'rolled-back');
    });
    await check('intent retirement failure leaves pending evidence intact', async () => {
        const intent = await recovery.beginSiteRecoveryIntent(intentOptions);
        const rename = fs.promises.rename;
        fs.promises.rename = async (from, to) => { if (from === recovery.intentFilename) throw Object.assign(new Error('injected retirement EACCES'), { code: 'EACCES' }); return rename(from, to); };
        try { await assert.rejects(recovery.finishSiteRecoveryIntent(intent, 'spool-committed'), /EACCES/); }
        finally { fs.promises.rename = rename; }
        assert.equal(recovery.siteRecoveryStatus().pending, true);
        assert.ok(fs.existsSync(intent.files['source.zip'].filename));
        assert.ok(fs.existsSync(intent.files['database-before.db'].filename));
        await recovery.finishSiteRecoveryIntent(intent, 'spool-committed');
    });
    await check('completed evidence cleanup failure is reported after atomic retirement without changing restored data', async () => {
        const intent = await recovery.beginSiteRecoveryIntent(intentOptions);
        const remove = fs.promises.rm;
        fs.promises.rm = async (filename, options) => { if (filename === intent.evidenceDirectory) throw new Error('injected completed cleanup error'); return remove(filename, options); };
        let completed;
        try { completed = await recovery.finishSiteRecoveryIntent(intent, 'spool-committed'); }
        finally { fs.promises.rm = remove; }
        assert.match(completed.cleanupWarning, /cleanup error/);
        assert.equal(recovery.siteRecoveryStatus().pending, false);
        assert.ok(fs.existsSync(path.join(intent.evidenceDirectory, 'completed-intent.json')));
    });
    await check('actual business restore followed by abrupt exit preserves pending spool evidence and cold-start health refuses readiness', async () => {
        await createTestDatabase(process.env.SQLITE_FILE);
        const database = require('../db/database');
        let db = await database.getDb();
        await db.run('INSERT INTO settings (`key`, value) VALUES (?, ?)', ['intent-fixture-state', 'source']);
        const alarms = require('../services/alarmOutbox');
        const outbox = alarms.getAlarmOutbox();
        outbox.record('factory_default', [{ deviceId: 'intent-device', deviceName: 'Intent', alarm: true, quality: 'good', occurredAt: Date.now() }]);
        const site = require('../services/siteBackup');
        fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
        const exported = await site.createSiteBackup(process.env.UPLOADS_DIR);
        const archiveFilename = site.resolveSiteBackupPath(exported.filename);
        outbox.acknowledge(outbox.batch('factory_default')[0]);
        await db.run('UPDATE settings SET value = ? WHERE `key` = ?', ['changed', 'intent-fixture-state']);
        alarms.closeAlarmOutbox();
        await database.closeDb();
        const child = spawnSync(process.execPath, ['-e', `
            const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
            const target = require.resolve(process.argv[1]);
            const isolated = new Module(target, module); isolated.filename = target; isolated.paths = Module._nodeModulePaths(path.dirname(target));
            const originalRequire = isolated.require.bind(isolated);
            isolated.require = request => {
                const value = originalRequire(request);
                return request === '../db/database' ? { ...value, restoreDatabaseBackup: async name => {
                    await value.restoreDatabaseBackup(name);
                    process.exit(93);
                } } : value;
            };
            isolated._compile(fs.readFileSync(target, 'utf8'), target);
            isolated.exports.restoreSiteBackup(process.argv[2], process.env.UPLOADS_DIR).catch(error => { console.error(error.stack); process.exit(1); });
        `, require.resolve('../services/siteBackup'), archiveFilename], { env: { ...process.env }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
        assert.equal(child.status, 93, child.stderr || child.stdout);
        const pending = recovery.siteRecoveryStatus();
        assert.equal(pending.pending, true);
        assert.equal(pending.phase, 'before-business-restore');
        assert.ok(fs.existsSync(pending.stagingDirectory));
        for (const evidence of Object.values(pending.files)) assert.equal(hash(evidence.filename), evidence.sha256);
        const Database = require('better-sqlite3');
        const readOnly = new Database(process.env.SQLITE_FILE, { readonly: true });
        try { assert.equal(readOnly.prepare('SELECT value FROM settings WHERE `key` = ?').get('intent-fixture-state').value, 'source'); }
        finally { readOnly.close(); }
        const evidenceSpool = new Database(pending.files['alarm-outbox.db'].filename, { readonly: true });
        try { assert.equal(evidenceSpool.prepare('SELECT COUNT(*) AS count FROM pending_alarm').get().count, 1); }
        finally { evidenceSpool.close(); }
        const DataEngine = require('../services/dataEngine');
        const engine = new DataEngine({});
        await assert.rejects(engine.start(), /待决恢复/);
        const before = hash(process.env.SQLITE_FILE);
        const port = await findFreePort();
        const backend = startLoggedProcess(process.execPath, [path.resolve(__dirname, '..', 'server.js')], {
            cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CAST_STREAM_PORT: String(await findFreePort()) },
            logFile: path.join(directory, 'pending-backend.log') });
        try {
            await waitForHttp(`http://127.0.0.1:${port}/api/health`, 15000);
            const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
            assert.equal(health.components.siteRecovery.status, 'requires_recovery');
            assert.equal(health.readiness.displayReady, false);
            assert.ok(health.readiness.failures.includes('site_recovery'));
            assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`)).status, 503);
            assert.equal(hash(process.env.SQLITE_FILE), before);
            assert.ok(fs.existsSync(pending.files['alarm-outbox.db'].filename));
        } finally { await forceStop(backend.child || backend); }
        // The test knows the business commit succeeded from the independent
        // read-only probe. Production deliberately requires operator review.
        const recovered = alarms.getAlarmOutbox();
        const merging = recovered.beginImportSnapshot(pending.files['alarm-outbox.db'].filename);
        merging.commit();
        await recovery.finishSiteRecoveryIntent(pending, 'spool-committed');
        assert.equal(recovered.pending('factory_default'), 1);
        alarms.closeAlarmOutbox();
        db = await database.getDb();
        await database.closeDb();
    });
}

main().then(() => {
    const result = { success: results.every(row => row.passed), passed: results.filter(row => row.passed).length, total: results.length, results, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, results: undefined }));
    if (!result.success) process.exitCode = 1;
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
