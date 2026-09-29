const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MysqlRuntime } = require('../mysqlRuntime.cjs');
const { createRunDirectory } = require('../../backend/scripts/integration-test-utils.cjs');
const mysql = require('../../backend/node_modules/mysql2/promise');
const { createMysqlDump, verifyMysqlDumpFile } = require('../../backend/services/mysqlBackup');
const projectDir = path.resolve(__dirname, '../..');
const root = createRunDirectory('mysql-runtime');
const options = {
    root, runtimeDir: path.join(projectDir, 'desktop/resources/mysql'),
    nodeBinary: process.execPath, hostScript: path.join(projectDir, 'backend/services/privateMysqlHost.js'),
    dependenciesDir: path.join(projectDir, 'backend/node_modules'),
    templateFile: path.join(projectDir, 'desktop/resources/templates/factory-template.db')
};
let runtime;
const checks = {};
async function main() {
    runtime = new MysqlRuntime(options);
    await runtime.start();
    const configFile = path.join(root, 'data/database-config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal(config.type, 'mysql');
    assert.equal(config.managedBy, 'desktop-mysql');
    assert.notEqual(config.user, 'root');
    let connection = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
    const [[count]] = await connection.query('SELECT COUNT(*) AS n FROM factories');
    assert.equal(Number(count.n), 3);
    await connection.query("INSERT INTO settings (`key`,value) VALUES ('mysql_runtime_test','preserve')");
    await connection.end();
    process.env.MYSQLDUMP_PATH = path.join(options.runtimeDir, 'bin', 'mysqldump.exe');
    process.env.MYSQL_CLIENT_PATH = path.join(options.runtimeDir, 'bin', 'mysql.exe');
    const backup = path.join(root, 'private-mysql-test.sql.gz');
    await createMysqlDump(config, backup, { timeoutMs: 30000 });
    assert.equal((await verifyMysqlDumpFile(backup)).valid, true);
    checks.bundledBackupToolsWorkWithApplicationAccount = true;
    await runtime.stop();
    checks.coldStartImportsTemplateAndStops = true;

    runtime = new MysqlRuntime(options);
    await runtime.start();
    const resumed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    connection = await mysql.createConnection({ host: resumed.host, port: resumed.port, user: resumed.user, password: resumed.password, database: resumed.database });
    const [[saved]] = await connection.query("SELECT value FROM settings WHERE `key`='mysql_runtime_test'");
    assert.equal(saved.value, 'preserve');
    await connection.end();
    // Losing the Electron IPC channel must stop the private MySQL host too.
    runtime.child.disconnect();
    let timer;
    await Promise.race([runtime.completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IPC disconnect left MySQL host running')), 20000); })]).finally(() => clearTimeout(timer));
    checks.restartPreservesDataAndParentDisconnectStops = true;

    const externalRoot = createRunDirectory('mysql-existing-config');
    fs.mkdirSync(path.join(externalRoot, 'data'));
    const original = JSON.stringify({ type: 'mysql', host: 'existing.example', port: 3307, user: 'existing', password: 'unchanged', database: 'customer' });
    const externalFile = path.join(externalRoot, 'data/database-config.json');
    fs.writeFileSync(externalFile, original);
    const external = new MysqlRuntime({ ...options, root: externalRoot });
    assert.equal(await external.start(), null);
    assert.equal(external.child, null);
    assert.equal(fs.readFileSync(externalFile, 'utf8'), original);
    checks.existingConfigurationUntouched = true;
    fs.writeFileSync(externalFile, '{"password":"SECRET-DO-NOT-LOG",');
    await assert.rejects(external.start(), error => !error.message.includes('SECRET-DO-NOT-LOG') && /配置文件/.test(error.message));
    checks.corruptConfigurationDoesNotLeakSecrets = true;
    const report = { success: true, checks, root };
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; }).finally(async () => { if (runtime) await runtime.stop(); });
