'use strict';
// Deterministic coarse filesystem timestamps, isolated SQLite only; no services.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const directory = createRunDirectory('database-backup-ties'), backups = path.join(directory, 'backups');
const originalStat = fs.statSync;
let database;
let clockMovedBack = false;
(async () => {
    const filename = path.join(directory, 'factory.db'); await createTestDatabase(filename);
    Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: filename, DB_BACKUP_DIR: backups,
        DB_RECOVERY_DIR: path.join(directory, 'recovery'), DB_BACKUP_RETENTION: '1', DISABLE_AUTO_START: 'true' });
    database = require('../db/database');
    const first = await database.createDatabaseBackup('older');
    fs.statSync = function (file, ...args) {
        const stat = originalStat.call(fs, file, ...args);
        if (path.dirname(path.resolve(String(file))) !== backups || !String(file).endsWith('.db')) return stat;
        const time = clockMovedBack && String(file).includes('clock-moved-back') ? 500 : 1000;
        return new Proxy(stat, { get(target, property) { return property === 'mtimeMs' ? time : Reflect.get(target, property); } });
    };
    const created = await database.createDatabaseBackup('newer');
    assert.notEqual(created.filename, first.filename);
    assert.ok(fs.existsSync(path.join(backups, created.filename)), 'the just-verified backup must survive retention pruning even when mtimes tie');
    assert.equal(database.getDatabaseBackupStatus().backups[0].filename, created.filename);
    assert.equal(database.getDatabaseBackupStatus().backups.length, 1);
    assert.equal(fs.existsSync(path.join(backups, first.filename)), false);
    clockMovedBack = true;
    const backwards = await database.createDatabaseBackup('clock-moved-back');
    assert.ok(fs.existsSync(path.join(backups, backwards.filename)), 'a newly verified snapshot also survives a backwards filesystem clock');
    assert.equal(database.getDatabaseBackupStatus().backups.length, 1);
    assert.equal((await database.restoreDatabaseBackup(backwards.filename)).success, true);
    console.log(JSON.stringify({ success: true, directory, sameMtimeRetainsNewestVerifiedBackup: true, backwardsFileTimeRetainsNewest: true, soleRetainedBackupRestores: true }));
})().catch(error => { console.error(error); process.exitCode = 1; })
.finally(async () => { fs.statSync = originalStat; await database?.closeDb(); });
