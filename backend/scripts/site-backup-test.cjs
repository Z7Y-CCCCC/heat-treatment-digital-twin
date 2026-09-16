const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const unzipper = require('unzipper');
const {
    BACKEND_DIR,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    testFetch,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `site-backup-test-${process.pid}-${Date.now()}`;
const SETTING_KEY = 'site_backup_test_marker';
const ORIGINAL_SETTING = 'value-before-export';
const MUTATED_SETTING = 'value-after-export';
const MODEL_FILENAME = 'site-backup-test.glb';
const ORIGINAL_MODEL = Buffer.from('site-backup-original-model-content');
const MUTATED_MODEL = Buffer.from('site-backup-mutated-model-content');
const DATA_SOURCE_ID = 'site_backup_external_source';

let backend = null;
let backendOrigin = null;
let runDirectory = null;

function inspectDatabase(filename) {
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try {
        return {
            quickCheck: db.pragma('quick_check', { simple: true }),
            setting: db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY)?.value ?? null
        };
    } finally {
        db.close();
    }
}

async function putSetting(value) {
    return requestJson(`${backendOrigin}/api/settings`, {
        method: 'PUT',
        body: JSON.stringify({ [SETTING_KEY]: value })
    });
}

async function readSetting() {
    const settings = await requestJson(`${backendOrigin}/api/settings`);
    return settings[SETTING_KEY] ?? null;
}

async function importArchive(filename, uploadName = path.basename(filename)) {
    const form = new FormData();
    form.append('backup', new Blob([fs.readFileSync(filename)], { type: 'application/zip' }), uploadName);
    const response = await testFetch(`${backendOrigin}/api/site-backups/import`, { method: 'POST', body: form });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (error) { body = text; }
    return { ok: response.ok, status: response.status, body };
}

async function gracefulStop() {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    await requestJson(`${backendOrigin}/api/internal/shutdown`, {
        method: 'POST',
        headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
    });
    await waitForExit(backend, 15000);
    backend = null;
}

async function main() {
    runDirectory = createRunDirectory('site-backup');
    const resultFile = path.join(runDirectory, 'result.json');
    const dataDir = path.join(runDirectory, 'data');
    const uploadsDir = path.join(runDirectory, 'uploads');
    const mirrorDir = path.join(runDirectory, 'external-mirror');
    const modelsDir = path.join(uploadsDir, 'models');
    const databaseFile = path.join(dataDir, 'factory.db');
    const startedAt = Date.now();
    let result;

    try {
        fs.mkdirSync(modelsDir, { recursive: true });
        await createTestDatabase(databaseFile, { source: process.env.SITE_BACKUP_TEST_SOURCE_DB });
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2));
        fs.writeFileSync(path.join(modelsDir, MODEL_FILENAME), ORIGINAL_MODEL);

        const port = await findFreePort(3301);
        backendOrigin = `http://127.0.0.1:${port}`;
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(port),
                APP_DATA_DIR: dataDir,
                UPLOADS_DIR: uploadsDir,
                SITE_BACKUP_RETENTION: '3',
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
                DB_BACKUP_RETENTION: '10',
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${backendOrigin}/api/health`, 30000);

        const configured = await requestJson(`${backendOrigin}/api/site-backups/config`, {
            method: 'PUT',
            body: JSON.stringify({
                autoEnabled: true,
                intervalHours: 24,
                mirrorDirectory: mirrorDir
            })
        });
        if (!configured.success || path.resolve(configured.config?.mirrorDirectory || '') !== path.resolve(mirrorDir)) {
            throw new Error('External backup mirror configuration was not persisted');
        }

        await putSetting(ORIGINAL_SETTING);
        const savedDataSource = await requestJson(`${backendOrigin}/api/data-sources/connections`, {
            method: 'POST',
            body: JSON.stringify({
                id: DATA_SOURCE_ID,
                name: '整站灾备外部库',
                type: 'sqlite',
                filename: databaseFile,
                enabled: true
            })
        });
        if (!savedDataSource.success) throw new Error(`External data source setup failed: ${savedDataSource.error}`);
        const savedBackupConfig = await requestJson(`${backendOrigin}/api/data-sources/backups/config`, {
            method: 'PUT',
            body: JSON.stringify({
                autoEnabled: false,
                intervalHours: 12,
                retention: 7,
                selectedConnectionIds: ['primary', DATA_SOURCE_ID]
            })
        });
        if (!savedBackupConfig.success) throw new Error(`Data source backup config setup failed: ${savedBackupConfig.error}`);
        const exported = await requestJson(`${backendOrigin}/api/site-backups/export`, { method: 'POST' });
        if (!exported.success || !exported.backup?.filename) throw new Error('Export API did not return a backup filename');
        const mirroredArchive = path.join(mirrorDir, exported.backup.filename);

        const downloadResponse = await testFetch(`${backendOrigin}/api/site-backups/${encodeURIComponent(exported.backup.filename)}/download`);
        if (!downloadResponse.ok) throw new Error(`Backup download failed: HTTP ${downloadResponse.status}`);
        const downloadedArchive = path.join(runDirectory, exported.backup.filename);
        fs.writeFileSync(downloadedArchive, Buffer.from(await downloadResponse.arrayBuffer()));

        const archive = await unzipper.Open.file(downloadedArchive);
        const manifestEntry = archive.files.find(entry => entry.path === 'manifest.json');
        if (!manifestEntry) throw new Error('Exported archive does not contain manifest.json');
        const manifest = JSON.parse((await manifestEntry.buffer()).toString('utf8'));
        const archivePaths = new Set(archive.files.filter(entry => entry.type === 'File').map(entry => entry.path));

        await putSetting(MUTATED_SETTING);
        fs.writeFileSync(path.join(modelsDir, MODEL_FILENAME), MUTATED_MODEL);
        await requestJson(`${backendOrigin}/api/data-sources/connections/${encodeURIComponent(DATA_SOURCE_ID)}`, { method: 'DELETE' });
        await requestJson(`${backendOrigin}/api/data-sources/backups/config`, {
            method: 'PUT',
            body: JSON.stringify({ autoEnabled: false, intervalHours: 2, retention: 1, selectedConnectionIds: ['primary'] })
        });
        const imported = await importArchive(downloadedArchive);
        if (!imported.ok || !imported.body?.success) {
            throw new Error(`Valid import failed: HTTP ${imported.status} ${JSON.stringify(imported.body)}`);
        }

        const settingAfterRestore = await readSetting();
        const modelAfterRestore = fs.readFileSync(path.join(modelsDir, MODEL_FILENAME));
        const databaseAfterRestore = inspectDatabase(databaseFile);
        const dataSourcesAfterRestore = await requestJson(`${backendOrigin}/api/data-sources`);

        const corruptedArchive = path.join(runDirectory, 'corrupted-site-backup.zip');
        const corrupted = fs.readFileSync(downloadedArchive);
        const offset = Math.max(0, Math.floor(corrupted.length / 2));
        corrupted[offset] ^= 0xff;
        fs.writeFileSync(corruptedArchive, corrupted);
        const corruptedImport = await importArchive(corruptedArchive);

        const checks = {
            manifestFormatValid: manifest.format === 'heat-treatment-digital-twin-site-backup' && manifest.version === 3,
            databaseIncluded: archivePaths.has('database/factory.db'),
            uploadedModelIncluded: archivePaths.has(`uploads/models/${MODEL_FILENAME}`),
            dataSourceConfigIncluded: archivePaths.has('config/data-sources.json')
                && manifest.containsSensitiveConfiguration === true,
            databaseSettingRestored: settingAfterRestore === ORIGINAL_SETTING && databaseAfterRestore.setting === ORIGINAL_SETTING,
            uploadedModelRestored: modelAfterRestore.equals(ORIGINAL_MODEL),
            dataSourceConnectionRestored: dataSourcesAfterRestore.connections?.some(item => item.id === DATA_SOURCE_ID) === true,
            dataSourceBackupSelectionRestored: dataSourcesAfterRestore.backup?.intervalHours === 12
                && dataSourcesAfterRestore.backup?.retention === 7
                && dataSourcesAfterRestore.backup?.selectedConnectionIds?.includes(DATA_SOURCE_ID),
            databaseIntegrityValid: databaseAfterRestore.quickCheck === 'ok',
            corruptedArchiveRejected: !corruptedImport.ok && corruptedImport.status === 400,
            rollbackBackupCreated: imported.body?.rollback?.filename?.includes('-before-restore.db') === true,
            archiveHashMatches: crypto.createHash('sha256').update(fs.readFileSync(downloadedArchive)).digest('hex') === exported.backup.sha256,
            externalMirrorCreated: fs.existsSync(mirroredArchive) && exported.backup.mirror?.filename === exported.backup.filename,
            externalMirrorHashMatches: fs.existsSync(mirroredArchive)
                && crypto.createHash('sha256').update(fs.readFileSync(mirroredArchive)).digest('hex') === exported.backup.sha256,
            externalMirrorAtomic: fs.existsSync(mirrorDir)
                && !fs.readdirSync(mirrorDir).some(name => name.endsWith('.tmp'))
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        if (failed.length) throw new Error(`Site backup checks failed: ${failed.join(', ')}`);

        result = {
            success: true,
            durationMs: Date.now() - startedAt,
            checks,
            artifacts: {
                archive: downloadedArchive,
                mirror: mirroredArchive,
                result: resultFile,
                log: path.join(runDirectory, 'backend.log')
            }
        };
        await gracefulStop();
    } catch (error) {
        result = {
            success: false,
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
        await forceStop(backend);
        process.exitCode = 1;
    } finally {
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    }
}

main();
