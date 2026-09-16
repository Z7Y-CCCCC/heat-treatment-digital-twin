const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const unzipper = require('unzipper');
const {
    BACKEND_DIR,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    testFetch,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `mysql-backup-test-${process.pid}-${Date.now()}`;
const MARKER = 'mysql_backup_restore_test_marker';
const MODEL_FILENAME = 'mysql-backup-test.glb';
const ORIGINAL_MODEL = Buffer.from('mysql-site-backup-original');
const MUTATED_MODEL = Buffer.from('mysql-site-backup-mutated');
let backend = null;
let origin = null;
let databaseName = null;

function loadSourceConfig() {
    if (process.env.ALLOW_MYSQL_TEST !== 'true' || !process.env.TEST_MYSQL_HOST || !process.env.TEST_MYSQL_USER) {
        throw new Error('MySQL 灾备测试需显式设置 ALLOW_MYSQL_TEST=true 和 TEST_MYSQL_HOST/PORT/USER/PASSWORD；不会读取现场数据库配置');
    }
    return {
        type: 'mysql', host: process.env.TEST_MYSQL_HOST,
        port: Number(process.env.TEST_MYSQL_PORT || 3306),
        user: process.env.TEST_MYSQL_USER, password: process.env.TEST_MYSQL_PASSWORD || ''
    };
}

async function gracefulStop() {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    await requestJson(`${origin}/api/internal/shutdown`, {
        method: 'POST',
        headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
    });
    await waitForExit(backend, 30000);
    backend = null;
}

async function main() {
    const runDirectory = createRunDirectory('mysql-backup');
    const resultFile = path.join(runDirectory, 'result.json');
    const startedAt = Date.now();
    const source = loadSourceConfig();
    databaseName = `dongtai_backup_test_${process.pid}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '');
    const adminConfig = {
        host: source.host,
        port: source.port,
        user: source.user,
        password: source.password,
        multipleStatements: false
    };
    let result;

    try {
        const admin = await mysql.createConnection(adminConfig);
        try {
            await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        } finally {
            await admin.end();
        }

        const dataDir = path.join(runDirectory, 'data');
        const uploadsDir = path.join(runDirectory, 'uploads');
        fs.mkdirSync(path.join(uploadsDir, 'models'), { recursive: true });
        fs.mkdirSync(path.join(uploadsDir, 'audio'), { recursive: true });
        fs.writeFileSync(path.join(uploadsDir, 'models', MODEL_FILENAME), ORIGINAL_MODEL);
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            ...source,
            database: databaseName
        }, null, 2));
        const port = await findFreePort(3401);
        origin = `http://127.0.0.1:${port}`;
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            allowExternalDatabase: true,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(port),
                APP_DATA_DIR: dataDir,
                UPLOADS_DIR: uploadsDir,
                ENABLE_CORS: 'false',
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
                DB_BACKUP_RETENTION: '5',
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${origin}/api/health`, 30000);

        await requestJson(`${origin}/api/settings`, {
            method: 'PUT',
            body: JSON.stringify({ [MARKER]: 'before-backup' })
        });
        const created = await requestJson(`${origin}/api/database/backups`, { method: 'POST' });
        if (!created.backup?.filename?.endsWith('.sql.gz')) throw new Error('MySQL 备份未生成 .sql.gz 文件');

        await requestJson(`${origin}/api/settings`, {
            method: 'PUT',
            body: JSON.stringify({ [MARKER]: 'after-backup' })
        });
        const restored = await requestJson(
            `${origin}/api/database/backups/${encodeURIComponent(created.backup.filename)}/restore`,
            { method: 'POST' }
        );
        const settings = await requestJson(`${origin}/api/settings`);
        const status = await requestJson(`${origin}/api/database/backups`);

        const siteExport = await requestJson(`${origin}/api/site-backups/export`, { method: 'POST' });
        if (!siteExport.success || !siteExport.backup?.filename) throw new Error('MySQL 整站备份未生成');
        const siteDownload = await testFetch(`${origin}/api/site-backups/${encodeURIComponent(siteExport.backup.filename)}/download`);
        if (!siteDownload.ok) throw new Error(`MySQL 整站备份下载失败：HTTP ${siteDownload.status}`);
        const siteArchive = path.join(runDirectory, siteExport.backup.filename);
        fs.writeFileSync(siteArchive, Buffer.from(await siteDownload.arrayBuffer()));
        const archive = await unzipper.Open.file(siteArchive);
        const manifest = JSON.parse((await archive.files.find(entry => entry.path === 'manifest.json').buffer()).toString('utf8'));
        await requestJson(`${origin}/api/settings`, {
            method: 'PUT',
            body: JSON.stringify({ [MARKER]: 'mutated-before-site-restore' })
        });
        fs.writeFileSync(path.join(uploadsDir, 'models', MODEL_FILENAME), MUTATED_MODEL);
        const form = new FormData();
        form.append('backup', new Blob([fs.readFileSync(siteArchive)], { type: 'application/zip' }), path.basename(siteArchive));
        const siteRestoreResponse = await testFetch(`${origin}/api/site-backups/import`, { method: 'POST', body: form });
        const siteRestoreBody = await siteRestoreResponse.json();
        const siteSettings = await requestJson(`${origin}/api/settings`);
        const siteModel = fs.readFileSync(path.join(uploadsDir, 'models', MODEL_FILENAME));

        const checks = {
            backupSupported: status.supported === true && status.type === 'mysql' && status.toolAvailable === true,
            compressedDumpCreated: created.backup.filename.endsWith('.sql.gz') && created.backup.valid === true,
            restoreSucceeded: restored.success === true,
            valueRestored: settings[MARKER] === 'before-backup',
            rollbackCreated: status.backups.some(item => item.filename.includes('-before-restore.sql.gz') && item.valid),
            siteManifestValid: manifest.databaseType === 'mysql' && manifest.databasePath === 'database/mysql.sql.gz',
            siteRestoreSucceeded: siteRestoreResponse.ok && siteRestoreBody.success === true,
            siteDatabaseRestored: siteSettings[MARKER] === 'before-backup',
            siteUploadRestored: siteModel.equals(ORIGINAL_MODEL)
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        if (failed.length) throw new Error(`MySQL 灾备检查失败：${failed.join(', ')}`);

        await gracefulStop();
        result = {
            success: true,
            durationMs: Date.now() - startedAt,
            database: databaseName,
            backup: created.backup.filename,
            checks,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
    } catch (error) {
        result = {
            success: false,
            durationMs: Date.now() - startedAt,
            database: databaseName,
            error: error.stack || error.message,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
        process.exitCode = 1;
    } finally {
        await forceStop(backend);
        try {
            const admin = await mysql.createConnection(adminConfig);
            try { await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``); } finally { await admin.end(); }
        } catch (error) {
            result.cleanupError = error.message;
            process.exitCode = 1;
        }
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    }
}

main();
