const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const archiver = require('archiver');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');

const root = createRunDirectory('site-backup-retention');
const dataDir = path.join(root, 'data');
const backupDir = path.join(dataDir, 'site-backups');
const databaseFile = path.join(dataDir, 'factory.db');
const mirrorDirectory = path.join(root, 'external-mirror');
Object.assign(process.env, {
    NODE_ENV: 'test', APP_DATA_DIR: dataDir, DB_TYPE: 'sqlite', SQLITE_FILE: databaseFile,
    SITE_BACKUP_DIR: backupDir, SITE_IMPORT_DIR: path.join(dataDir, 'site-imports'),
    DB_BACKUP_DIR: path.join(dataDir, 'backups'), DB_RECOVERY_DIR: path.join(dataDir, 'recovery'),
    SITE_BACKUP_MIN_FREE_BYTES: '1', SITE_BACKUP_AUTO_ENABLED: 'false'
});
for (const key of ['SITE_BACKUP_RETENTION', 'SITE_BACKUP_RETENTION_DAYS', 'SITE_BACKUP_MAX_TOTAL_BYTES', 'SITE_BACKUP_MIRROR_DIR', 'SQLITE_RECOVERY_TEMPLATE', 'SQLITE_UPGRADE_TEMPLATE']) delete process.env[key];
const checks = {};
const dayMs = 86400000;
function setAge(filename, days) {
    const date = new Date(Date.now() - days * dayMs);
    fs.utimesSync(filename, date, date);
}

async function archive(filename, bytes, tamperPayload = false) {
    const zip = archiver('zip', { zlib: { level: 1 } });
    const out = fs.createWriteStream(filename, { flags: 'wx' });
    const completion = new Promise((resolve, reject) => {
        out.once('close', resolve); out.once('error', reject); zip.once('error', reject);
    });
    zip.pipe(out);
    const payload = Buffer.alloc(65536, 0xab);
    const manifest = {
        format: 'heat-treatment-digital-twin-site-backup', version: 4,
        databaseType: 'sqlite', databasePath: 'database/factory.db', uploadGroups: [],
        files: [{ path: 'database/factory.db', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
            { path: 'uploads/models/retained-payload.glb', size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') }]
    };
    zip.append(bytes, { name: 'database/factory.db' });
    zip.append(tamperPayload ? Buffer.alloc(payload.length, 0xcd) : payload, { name: 'uploads/models/retained-payload.glb' });
    zip.append(JSON.stringify(manifest), { name: 'manifest.json' });
    await Promise.all([zip.finalize(), completion]);
}

async function main() {
    await createTestDatabase(databaseFile);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(mirrorDirectory, { recursive: true });
    const databaseBytes = fs.readFileSync(databaseFile);
    const ages = [90, 45, 20, 15, 10, 5, 2, 1];
    const names = [];
    for (let i = 0; i < ages.length; i++) {
        const name = `heat-treatment-site-backup-2026010${i + 1}T000000000Z.zip`;
        names.push(name);
        await archive(path.join(backupDir, name), databaseBytes);
        setAge(path.join(backupDir, name), ages[i]);
    }
    const unrelated = path.join(backupDir, 'manual-project-backup.zip');
    fs.writeFileSync(unrelated, 'not a managed package'); setAge(unrelated, 100);
    const external = path.join(mirrorDirectory, names[0]);
    fs.writeFileSync(external, 'external recovery point'); setAge(external, 100);
    const service = require('../services/siteBackup');
    const database = require('../db/database');
    let config = service.saveSiteBackupConfig({ autoEnabled: false, intervalHours: 12, mirrorDirectory });
    assert.equal(config.retentionDays, 30);
    assert.equal(service.getSiteBackupStatus().retention, null);
    checks.dayPolicyReplacesDefaultFiveFileCap = true;

    config = service.saveSiteBackupConfig({ retentionDays: 30 });
    assert.equal(config.autoEnabled, false);
    assert.equal(config.intervalHours, 12);
    assert.equal(config.mirrorDirectory, mirrorDirectory);
    const originalWrite = fs.createWriteStream;
    const uploadWrites = [];
    let cleanup;
    try {
        fs.createWriteStream = function(filename, ...args) {
            if (String(filename).startsWith(path.join(dataDir, 'site-imports') + path.sep) && String(filename).includes(path.sep + 'uploads' + path.sep)) uploadWrites.push(filename);
            return originalWrite.call(this, filename, ...args);
        };
        cleanup = await service.cleanupSiteBackups('policy-save');
    } finally { fs.createWriteStream = originalWrite; }
    assert.deepEqual(uploadWrites, [], 'Retention verification must hash model payloads without expanding them to disk');
    checks.retainedAssetsVerifiedWithoutDiskExpansion = true;
    assert.equal(cleanup.deletedCount, 2);
    assert.ok(cleanup.deleted.every(item => item.cause === 'expired'));
    assert.ok(names.slice(2).every(name => fs.existsSync(path.join(backupDir, name))));
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'not a managed package');
    assert.equal(fs.readFileSync(external, 'utf8'), 'external recovery point');
    checks.partialSavePreservesAutomaticAndExternalSettings = true;
    checks.expiredOnlyManagedLocalBackupsDeleted = true;
    const status = service.getSiteBackupStatus();
    assert.equal(status.totalBackupBytes, status.backups.reduce((sum, item) => sum + item.size, 0));
    assert.equal(status.newestBackup.filename, names[7]);
    assert.equal(status.oldestBackup.filename, path.basename(unrelated));
    assert.ok(status.backups.every(item => item.fullPath === path.join(backupDir, item.filename)));
    assert.equal(status.localDirectory, backupDir);
    checks.statisticsAndCompletePathsReturned = true;

    for (const name of names.slice(2)) setAge(path.join(backupDir, name), 90);
    const corruptName = 'heat-treatment-site-backup-20260201T000000000Z.zip';
    fs.writeFileSync(path.join(backupDir, corruptName), 'broken newest package');
    setAge(path.join(backupDir, corruptName), 89);
    service.saveSiteBackupConfig({ retentionDays: 1 });
    const protectedCleanup = await service.cleanupSiteBackups('policy-save');
    assert.equal(protectedCleanup.remainingCount, 2);
    assert.ok(names.slice(2).some(name => fs.existsSync(path.join(backupDir, name))));
    assert.ok(fs.existsSync(path.join(backupDir, corruptName)));
    checks.latestValidRecoveryPointProtectedWhenNewestCorrupt = true;
    for (const name of fs.readdirSync(backupDir).filter(name => name.startsWith('heat-treatment-site-backup-'))) {
        fs.writeFileSync(path.join(backupDir, name), 'all unverified'); setAge(path.join(backupDir, name), 90);
    }
    assert.equal((await service.cleanupSiteBackups()).deletedCount, 0);
    checks.noVerifiedRecoveryPointPreservesAllCandidates = true;
    const validAgain = path.join(backupDir, 'heat-treatment-site-backup-20260301T000000000Z.zip');
    await archive(validAgain, databaseBytes);
    const originalRm = fs.promises.rm;
    let cleanupWarning;
    try {
        fs.promises.rm = async (filename, options) => {
            if (path.dirname(filename) === path.join(dataDir, 'site-imports') && path.basename(filename).startsWith('verify-')) {
                throw new Error('simulated verification cleanup failure');
            }
            return originalRm(filename, options);
        };
        cleanupWarning = await service.cleanupSiteBackups('policy-save');
    } finally { fs.promises.rm = originalRm; }
    assert.ok(cleanupWarning.errors.some(item => /校验暂存目录清理失败/.test(item.error)));
    assert.ok(fs.existsSync(validAgain));
    const verificationRoot = path.join(dataDir, 'site-imports');
    for (const name of fs.readdirSync(verificationRoot).filter(name => name.startsWith('verify-'))) {
        const filename = path.resolve(verificationRoot, name);
        assert.equal(path.dirname(filename), verificationRoot);
        assert.ok(filename.startsWith(`${root}${path.sep}`));
        await originalRm(filename, { recursive: true, force: true });
    }
    checks.verificationCleanupFailureReportedWithoutFailingPolicy = true;
    setAge(validAgain, 90);
    const tampered = path.join(backupDir, 'heat-treatment-site-backup-20260401T000000000Z.zip');
    await archive(tampered, databaseBytes, true); setAge(tampered, 89);
    await service.cleanupSiteBackups('tampered-payload');
    assert.ok(fs.existsSync(validAgain), 'A tampered streamed payload must not displace the older valid recovery point');
    checks.streamedPayloadHashStillProtectsKnownGoodRecovery = true;
    const before = fs.readFileSync(path.join(dataDir, 'site-backup-config.json'), 'utf8');
    for (const invalid of [0, 3651, 1.5, 'no']) assert.throws(() => service.saveSiteBackupConfig({ retentionDays: invalid }), /1-3650/);
    assert.equal(fs.readFileSync(path.join(dataDir, 'site-backup-config.json'), 'utf8'), before);
    config = service.saveSiteBackupConfig({ autoEnabled: true, intervalHours: 24, mirrorDirectory });
    assert.equal(config.retentionDays, 1);
    checks.invalidPolicyRejectedAndAutomaticSaveKeepsPolicy = true;
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    fs.copyFileSync(databaseFile, path.join(dataDir, 'backups', 'factory-20260101T000000000Z-test.db'));
    assert.ok(database.getDatabaseBackupStatus().backups.every(item => item.fullPath === path.join(dataDir, 'backups', item.filename)));
    checks.databaseBackupCompletePathsReturned = true;
    const imports = path.join(dataDir, 'site-imports');
    assert.ok(!fs.existsSync(imports) || !fs.readdirSync(imports).some(name => name.startsWith('verify-')));
    checks.verificationTemporaryFilesCleaned = true;
    await service.stopSiteBackupMaintenance();
    return { success: true, checks, cleanup, protectedCleanup };
}

main().then(result => {
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, result: path.join(root, 'result.json') }, null, 2));
}).catch(error => {
    const result = { success: false, checks, error: error.stack };
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result, null, 2)); process.exitCode = 1;
});
