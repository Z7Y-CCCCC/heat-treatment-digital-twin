// Runs the existing HTTP backup/restore regression against a new owned MySQL.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EnduranceMysql } = require('../backend/scripts/endurance-mysql.cjs');
const { createRunDirectory, forceStop } = require('../backend/scripts/integration-test-utils.cjs');
const directory = createRunDirectory('private-mysql-backup');
const runtime = path.resolve(process.argv[2] || 'desktop/resources/mysql');
const source = path.resolve(process.argv[3] || 'desktop/resources/templates/factory-template.db');
const owned = new EnduranceMysql(directory, runtime);
let child;
(async () => {
    await owned.initialize(source, path.join(directory, 'database-config.json'));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(MYSQL_|TEST_MYSQL_|DB_|SQLITE_|APP_DATA_DIR$|UPLOADS_DIR$)/i.test(key)) delete env[key];
    Object.assign(env, { ALLOW_MYSQL_TEST: 'true', TEST_MYSQL_HOST: '127.0.0.1', TEST_MYSQL_PORT: String(owned.port), TEST_MYSQL_USER: 'root', TEST_MYSQL_PASSWORD: owned.password, MYSQLDUMP_PATH: path.join(owned.runtimeAlias, 'bin/mysqldump.exe'), MYSQL_CLIENT_PATH: path.join(owned.runtimeAlias, 'bin/mysql.exe') });
    const logFile = path.join(directory, 'backup-test.log');
    const output = fs.openSync(logFile, 'w');
    try { child = spawn(process.execPath, [path.resolve(__dirname, '../backend/scripts/mysql-backup-test.cjs')], { cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', output, output] }); }
    finally { fs.closeSync(output); }
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const log = fs.readFileSync(logFile, 'utf8');
    assert.equal(code, 0, `Backup/restore regression failed: ${log}`);
    const result = JSON.parse(log.trim());
    assert.equal(result.success, true);
    const report = { success: true, directory, mysqlVersion: owned.version, port: owned.port, ownedDataDir: owned.dataDir, privateInstanceIdentityVerified: true, backupTest: result };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
})().catch(error => {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, directory, error: error.stack }, null, 2));
    console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await forceStop(child); await owned.stop(); });
