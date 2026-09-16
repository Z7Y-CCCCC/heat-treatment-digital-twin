const fs = require('fs');
const path = require('path');
const {
    BACKEND_DIR,
    copySqliteDatabase,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    testFetch,
    waitForExit,
    waitForHttp,
    waitUntil
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `database-retention-${process.pid}-${Date.now()}`;
let backend = null;
let origin = null;

function setAge(filename, days) {
    const timestamp = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    fs.utimesSync(filename, timestamp, timestamp);
}

async function gracefulStop() {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    await fetch(`${origin}/api/internal/shutdown`, {
        method: 'POST',
        headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
    });
    await waitForExit(backend, 30000);
    backend = null;
}

async function main() {
    const runDirectory = createRunDirectory('database-retention');
    const resultFile = path.join(runDirectory, 'result.json');
    const dataDir = path.join(runDirectory, 'data');
    const backupDir = path.join(dataDir, 'backups');
    const databaseFile = path.join(dataDir, 'factory.db');
    const startedAt = Date.now();
    let result;

    try {
        fs.mkdirSync(backupDir, { recursive: true });
        await createTestDatabase(databaseFile);
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile,
            backupRetentionDays: 365
        }, null, 2));
        fs.writeFileSync(path.join(dataDir, 'data-sources.json'), JSON.stringify({
            connections: [],
            backup: { autoEnabled: false, intervalHours: 6, retention: 10, selectedConnectionIds: [] }
        }, null, 2));

        const seededBackups = [
            { filename: 'factory-20260101T000000000Z-oldest.db', ageDays: 90 },
            { filename: 'factory-20260215T000000000Z-old.db', ageDays: 45 },
            { filename: 'factory-20260730T000000000Z-recent.db', ageDays: 5 },
            { filename: 'factory-20260805T000000000Z-newest.db', ageDays: 2 }
        ];
        for (const backup of seededBackups) {
            const destination = path.join(backupDir, backup.filename);
            await copySqliteDatabase(databaseFile, destination);
            setAge(destination, backup.ageDays);
        }
        const orphanTemporary = path.join(backupDir, 'factory-orphan.db.999.tmp-wal');
        fs.writeFileSync(orphanTemporary, 'stale temporary sidecar');
        setAge(orphanTemporary, 2);

        const port = await findFreePort(3621);
        origin = `http://127.0.0.1:${port}`;
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(port),
                APP_DATA_DIR: dataDir,
                ENABLE_CORS: 'false',
                DB_BACKUP_RETENTION: '100',
                DB_BACKUP_PRUNE_INTERVAL_MS: String(60 * 60 * 1000),
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${origin}/api/health`, 30000);
        await waitUntil(async () => {
            const status = await requestJson(`${origin}/api/database/backups`);
            return status.supported && status.backups?.length >= seededBackups.length ? status : null;
        }, 15000, 'database backup status');

        const policy30 = await requestJson(`${origin}/api/database/backups/config`, {
            method: 'PUT',
            body: JSON.stringify({ retentionDays: 30 })
        });
        const status30 = policy30.status;
        const names30 = new Set(status30.backups.map(item => item.filename));

        for (const name of fs.readdirSync(backupDir).filter(name => name.endsWith('.db'))) {
            setAge(path.join(backupDir, name), 90);
        }
        const policy1 = await requestJson(`${origin}/api/database/backups/config`, {
            method: 'PUT',
            body: JSON.stringify({ retentionDays: 1 })
        });
        const status1 = policy1.status;
        const storedConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'database-config.json'), 'utf8'));

        const invalidResponse = await testFetch(`${origin}/api/database/backups/config`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ retentionDays: 0 })
        });
        const invalidBody = await invalidResponse.json();

        const created = await requestJson(`${origin}/api/database/backups`, { method: 'POST' });
        const createdFilename = created.backup.filename;
        const createdPath = path.join(backupDir, createdFilename);
        const deleted = await requestJson(`${origin}/api/database/backups/${encodeURIComponent(createdFilename)}`, {
            method: 'DELETE'
        });
        const deleteAgainResponse = await testFetch(
            `${origin}/api/database/backups/${encodeURIComponent(createdFilename)}`,
            { method: 'DELETE' }
        );
        const invalidDeleteResponse = await testFetch(`${origin}/api/database/backups/not-a-backup.txt`, {
            method: 'DELETE'
        });

        const checks = {
            retentionDaysSaved: status30.retentionDays === 30 && storedConfig.backupRetentionDays === 1,
            expiredBackupsDeleted: !names30.has(seededBackups[0].filename)
                && !names30.has(seededBackups[1].filename)
                && names30.has(seededBackups[2].filename),
            cleanupReported: policy30.cleanup?.deletedCount >= 2
                && policy30.cleanup?.deleted?.every(item => item.cause === 'expired'),
            orphanArtifactsRemoved: policy30.cleanup?.orphanDeletedCount >= 1
                && !fs.existsSync(orphanTemporary),
            latestValidBackupProtected: status1.backups.length === 1
                && status1.backups[0].valid === true,
            statusStatisticsCorrect: status1.totalBackupBytes === status1.backups[0].size
                && status1.oldestBackup?.filename === status1.newestBackup?.filename,
            invalidRetentionRejected: invalidResponse.status === 400
                && /1-3650/.test(String(invalidBody.error || '')),
            manualBackupDeleted: deleted.success === true
                && deleted.deleted?.filename === createdFilename
                && !fs.existsSync(createdPath)
                && !deleted.status.backups.some(item => item.filename === createdFilename),
            missingBackupDeleteRejected: deleteAgainResponse.status === 404,
            invalidBackupNameDeleteRejected: invalidDeleteResponse.status === 400
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        if (failed.length) {
            throw new Error(`数据库备份保留策略检查失败：${failed.join(', ')}；status1=${JSON.stringify(status1)}；cleanup1=${JSON.stringify(policy1.cleanup)}`);
        }

        await gracefulStop();
        result = {
            success: true,
            durationMs: Date.now() - startedAt,
            checks,
            cleanup30: policy30.cleanup,
            cleanup1: policy1.cleanup,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
    } catch (error) {
        result = {
            success: false,
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
        process.exitCode = 1;
    } finally {
        await forceStop(backend);
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    }
}

main();
