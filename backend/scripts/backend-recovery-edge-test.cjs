const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const outputRoot = path.resolve(__dirname, '..', '..', 'output');
fs.mkdirSync(outputRoot, { recursive: true });
const runDirectory = fs.mkdtempSync(path.join(outputRoot, 'backend-recovery-edge-'));
Object.assign(process.env, {
    NODE_ENV: 'test',
    APP_DATA_DIR: path.join(runDirectory, 'data'),
    DB_TYPE: 'sqlite',
    SQLITE_FILE: path.join(runDirectory, 'data', 'factory.db'),
    DB_BACKUP_DIR: path.join(runDirectory, 'database-backups'),
    DB_RECOVERY_DIR: path.join(runDirectory, 'database-recovery'),
    SITE_BACKUP_DIR: path.join(runDirectory, 'site-backups'),
    SITE_IMPORT_DIR: path.join(runDirectory, 'site-imports'),
    SITE_BACKUP_MIRROR_RETENTION: '2',
    SITE_BACKUP_RETENTION: '2',
    SITE_BACKUP_AUTO_ENABLED: 'false',
    DATA_SOURCE_BACKUP_DIR: path.join(runDirectory, 'source-backups')
});
delete process.env.SQLITE_RECOVERY_TEMPLATE;
delete process.env.SQLITE_UPGRADE_TEMPLATE;

const database = require('../db/database');
const siteBackup = require('../services/siteBackup');
const uploadsRoot = path.join(runDirectory, 'uploads');
fs.mkdirSync(path.join(uploadsRoot, 'models'), { recursive: true });
const results = [];

async function check(name, callback) {
    try {
        await callback();
        results.push({ name, passed: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, passed: false, error: error.stack });
        console.error(`FAIL ${name}: ${error.message}`);
    }
}

async function writeArchive(filename, entries) {
    const archive = archiver('zip', { zlib: { level: 1 } });
    const output = fs.createWriteStream(filename, { flags: 'wx' });
    const complete = new Promise((resolve, reject) => {
        output.once('close', resolve);
        output.once('error', reject);
        archive.once('error', reject);
    });
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.content, { name: entry.path });
    await Promise.all([archive.finalize(), complete]);
}

async function main() {
    await database.getDb();
    const mirrorDirectory = path.join(runDirectory, 'shared-mirror');
    fs.mkdirSync(mirrorDirectory, { recursive: true });
    siteBackup.saveSiteBackupConfig({ autoEnabled: false, mirrorDirectory });
    let validArchive;

    await check('mirror retention never deletes unrelated ZIP files in a shared directory', async () => {
        const externalNames = ['finance-backup.zip', 'drawings.zip', 'manual-handover.zip'];
        for (const name of externalNames) {
            const filename = path.join(mirrorDirectory, name);
            fs.writeFileSync(filename, name);
            fs.utimesSync(filename, new Date('2020-01-01Z'), new Date('2020-01-01Z'));
        }
        for (const [index, stamp] of ['20260101T000000000Z', '20260201T000000000Z'].entries()) {
            const filename = path.join(mirrorDirectory, `heat-treatment-site-backup-${stamp}.zip`);
            fs.writeFileSync(filename, 'old managed fixture');
            fs.utimesSync(filename, new Date(2021, index, 1), new Date(2021, index, 1));
        }
        fs.writeFileSync(path.join(uploadsRoot, 'models', 'current.glb'), 'archive model fixture');
        const created = await siteBackup.createSiteBackup(uploadsRoot);
        assert.equal(created.mirrorError, undefined);
        validArchive = siteBackup.resolveSiteBackupPath(created.filename);
        for (const name of externalNames) assert.equal(fs.readFileSync(path.join(mirrorDirectory, name), 'utf8'), name);
        assert.equal(fs.readdirSync(mirrorDirectory).filter(name => /^heat-treatment-site-backup-/.test(name)).length, 2);
    });

    const backup = await database.createDatabaseBackup('archive-path-test');
    const databaseBytes = fs.readFileSync(database.resolveDatabaseBackupPath(backup.filename));
    let archiveCounter = 0;
    async function malformedArchive(paths, databaseContent = databaseBytes) {
        const entries = [
            { path: 'database/factory.db', content: databaseContent },
            ...paths.map(archivePath => ({ path: archivePath, content: Buffer.from('test asset') }))
        ];
        const manifest = {
            format: 'heat-treatment-digital-twin-site-backup',
            version: 3,
            databaseType: 'sqlite',
            databasePath: 'database/factory.db',
            uploadGroups: ['models'],
            files: entries.map(entry => ({
                path: entry.path,
                size: entry.content.length,
                sha256: crypto.createHash('sha256').update(entry.content).digest('hex')
            }))
        };
        const filename = path.join(runDirectory, `invalid-archive-${++archiveCounter}.zip`);
        await writeArchive(filename, [{ path: 'manifest.json', content: JSON.stringify(manifest) }, ...entries]);
        return filename;
    }

    for (const invalidPath of ['uploads/models/file.glb:alternate', 'uploads/models/CON.glb', 'uploads/models/file.glb.']) {
        await check(`restore rejects unsafe portable archive path: ${invalidPath}`, async () => {
            const filename = await malformedArchive([invalidPath]);
            await assert.rejects(siteBackup.restoreSiteBackup(filename, uploadsRoot), /路径/);
            assert.equal(fs.readFileSync(path.join(uploadsRoot, 'models', 'current.glb'), 'utf8'), 'archive model fixture');
        });
    }

    await check('restore rejects case-insensitive duplicate archive destinations', async () => {
        const filename = await malformedArchive(['uploads/models/Model.glb', 'uploads/models/model.glb']);
        await assert.rejects(siteBackup.restoreSiteBackup(filename, uploadsRoot), /重复文件/);
    });

    await check('an intact unrelated SQLite database cannot replace the application database', async () => {
        const Database = require('better-sqlite3');
        const unrelatedFile = path.join(runDirectory, 'unrelated.db');
        const unrelated = new Database(unrelatedFile);
        try { unrelated.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)'); }
        finally { unrelated.close(); }
        const filename = await malformedArchive(['uploads/models/replacement.glb'], fs.readFileSync(unrelatedFile));
        await assert.rejects(siteBackup.restoreSiteBackup(filename, uploadsRoot), /不是本软件的业务数据库/);
        assert.equal(fs.readFileSync(path.join(uploadsRoot, 'models', 'current.glb'), 'utf8'), 'archive model fixture');
    });

    await check('database restore rejects overlapping operations and releases its guard after failure', async () => {
        const first = database.restoreDatabaseBackup('missing-backup.db').catch(error => error);
        await assert.rejects(database.restoreDatabaseBackup('another-missing.db'), /正在恢复/);
        assert.match((await first).message, /不存在/);
        await assert.rejects(database.restoreDatabaseBackup('missing-backup.db'), /不存在/);
    });

    await check('failed automatic rollback preserves original upload files for recovery', async () => {
        assert.ok(validArchive, 'a valid site archive is required');
        const originalFile = path.join(uploadsRoot, 'models', 'original-before-restore.glb');
        fs.writeFileSync(originalFile, 'irreplaceable original fixture');
        const originalCopy = fs.cpSync;
        fs.cpSync = function(source, destination, options) {
            const resolvedSource = path.resolve(String(source));
            const resolvedDestination = path.resolve(String(destination));
            if (resolvedSource.startsWith(`${process.env.SITE_IMPORT_DIR}${path.sep}`)
                && resolvedDestination === path.join(uploadsRoot, 'models')) {
                throw new Error('injected restore and rollback copy failure');
            }
            return originalCopy.call(fs, source, destination, options);
        };
        try {
            await assert.rejects(siteBackup.restoreSiteBackup(validArchive, uploadsRoot), /原始文件保留于/);
        } finally {
            fs.cpSync = originalCopy;
        }
        const preserved = fs.readdirSync(process.env.SITE_IMPORT_DIR)
            .map(name => path.join(process.env.SITE_IMPORT_DIR, name, 'rollback-uploads', 'models', path.basename(originalFile)))
            .find(filename => fs.existsSync(filename));
        assert.ok(preserved, 'rollback originals must not be erased from staging');
        assert.equal(fs.readFileSync(preserved, 'utf8'), 'irreplaceable original fixture');
    });

    await database.closeDb();
    const failed = results.filter(result => !result.passed).length;
    fs.writeFileSync(path.join(runDirectory, 'result.json'), JSON.stringify({ runDirectory, results }, null, 2));
    console.log(JSON.stringify({ tests: results.length, passed: results.length - failed, failed, runDirectory }));
    process.exitCode = failed ? 1 : 0;
}

main().catch(async error => {
    console.error(error);
    try { await database.closeDb(); } catch (_) { /* preserve original test error */ }
    process.exitCode = 1;
});
