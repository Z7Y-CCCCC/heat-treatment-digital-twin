const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');
const { seedMysql, APPLICATION_TABLES, STATE_TABLE } = require('../services/mysqlSeed');

const baseDir = process.argv[2];
if (!baseDir || !fs.existsSync(path.join(baseDir, 'bin', 'mysqld.exe'))) {
    throw new Error('Usage: node scripts/mysql-seed-test.cjs <standalone-mysql-directory>');
}
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-twin-mysql-seed-中文-'));
const dataDir = path.join(runDir, 'data');
fs.mkdirSync(dataDir);
const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-twin-mysql-alias-'));
const runtimeAlias = path.join(aliasRoot, 'runtime');
const dataAlias = path.join(aliasRoot, 'data');
fs.symlinkSync(path.resolve(baseDir), runtimeAlias, 'junction');
fs.symlinkSync(dataDir, dataAlias, 'junction');
const sourcePath = path.resolve(__dirname, '../../desktop/resources/templates/factory-template.db');
const logFile = path.join(runDir, 'mysqld.log');
const resultFile = path.join(runDir, 'result.json');
const q = name => `\`${String(name).replace(/`/g, '``')}\``;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;

function launch(args) {
    const log = fs.openSync(logFile, 'a');
    const child = spawn(path.join(runtimeAlias, 'bin', 'mysqld.exe'), args, {
        windowsHide: true, argv0: 'mysqld.exe', cwd: aliasRoot, stdio: ['ignore', log, log]
    });
    fs.closeSync(log);
    return child;
}

async function freePort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return port;
}

function canonical(value, type) {
    if (value === null) return null;
    if (type === 'json') return typeof value === 'string' ? JSON.parse(value) : value;
    if (['datetime', 'timestamp'].includes(type)) return String(value).replace('T', ' ').replace(/Z$/, '').replace(/\.0+$/, '');
    return value;
}

async function compareSnapshot(config) {
    const connection = await mysql.createConnection({ ...config, dateStrings: true });
    const snapshot = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
        const [columns] = await connection.query('SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.columns WHERE table_schema = ?', [config.database]);
        for (const table of APPLICATION_TABLES) {
            const fields = snapshot.prepare(`PRAGMA table_info(${q(table)})`).all();
            const keys = fields.filter(field => field.pk).sort((a, b) => a.pk - b.pk).map(field => field.name);
            const projection = fields.map(field => q(field.name)).join(', ');
            const source = snapshot.prepare(`SELECT ${projection} FROM ${q(table)}`).all();
            const [target] = await connection.query(`SELECT ${projection} FROM ${q(table)}`);
            const normalize = rows => rows.map(row => Object.fromEntries(fields.map(field => [field.name,
                canonical(row[field.name], columns.find(column => column.TABLE_NAME === table && column.COLUMN_NAME === field.name).DATA_TYPE)
            ]))).sort((a, b) => JSON.stringify(keys.map(key => a[key])).localeCompare(JSON.stringify(keys.map(key => b[key]))));
            assert.deepEqual(normalize(target), normalize(source), `Every imported value in ${table} must match the snapshot`);
        }
    } finally { snapshot.close(); await connection.end(); }
}

async function main() {
    let admin;
    const checks = {};
    try {
        const initialization = launch(['--no-defaults', '--initialize-insecure', `--basedir=${runtimeAlias}`, `--datadir=${dataAlias}`, '--console']);
        const initialized = await new Promise((resolve, reject) => { initialization.once('error', reject); initialization.once('exit', resolve); });
        assert.equal(initialized, 0, `mysqld initialization; see ${logFile}`);
        const port = await freePort();
        const credentials = { host: '127.0.0.1', port, user: 'root', password: '' };
        server = launch(['--no-defaults', `--basedir=${runtimeAlias}`, `--datadir=${dataAlias}`, '--bind-address=127.0.0.1', `--port=${port}`, '--mysqlx=0', '--max-allowed-packet=64M', '--console']);
        server.on('error', error => console.error(error.message));
        for (let attempt = 0; attempt < 100; attempt++) {
            if (server.exitCode !== null) throw new Error(`Private test mysqld exited; see ${logFile}`);
            try { admin = await mysql.createConnection(credentials); break; } catch { await sleep(200); }
        }
        if (!admin) throw new Error(`Private test mysqld did not start; see ${logFile}`);
        const connection = { ...credentials, database: 'fresh_delivery_test' };
        const markerPath = path.join(runDir, 'seed-complete.json');
        const seeded = await seedMysql({ connection, sourcePath, markerPath });
        assert.equal(seeded.alreadyInitialized, false);
        await compareSnapshot(connection);
        checks.everySnapshotValuePreserved = true;
        assert.equal(JSON.parse(fs.readFileSync(markerPath)).counts.devices, seeded.counts.devices);
        checks.localMarkerWritten = true;

        await admin.query(`INSERT INTO ${q(connection.database)}.settings (\`key\`, value) VALUES ('seed_idempotency_test', '现场修改不覆盖')`);
        fs.unlinkSync(markerPath);
        const repeated = await seedMysql({ connection, sourcePath: path.join(runDir, 'missing-after-upgrade.db'), markerPath });
        assert.equal(repeated.alreadyInitialized, true);
        const [edit] = await admin.query(`SELECT value FROM ${q(connection.database)}.settings WHERE \`key\` = 'seed_idempotency_test'`);
        assert.equal(edit[0].value, '现场修改不覆盖');
        assert.equal(fs.existsSync(markerPath), true);
        checks.restartPreservesEditsAndRepairsMarker = true;

        await admin.query('CREATE DATABASE existing_customer_database');
        await admin.query('CREATE TABLE existing_customer_database.customer_data (value VARCHAR(64))');
        await admin.query("INSERT INTO existing_customer_database.customer_data VALUES ('must remain unchanged')");
        await assert.rejects(seedMysql({ connection: { ...credentials, database: 'existing_customer_database' }, sourcePath }), /existing database/);
        const [protectedRows] = await admin.query('SELECT * FROM existing_customer_database.customer_data');
        assert.equal(protectedRows[0].value, 'must remain unchanged');
        const [protectedTables] = await admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'existing_customer_database'");
        assert.equal(protectedTables.length, 1);
        checks.existingDatabaseUntouched = true;

        const interruptedConfig = { ...credentials, database: 'interrupted_delivery_test' };
        const originalCreateConnection = mysql.createConnection;
        let failedDuringDataWrite = false;
        mysql.createConnection = async (...args) => {
            const client = await originalCreateConnection(...args);
            const query = client.query.bind(client);
            client.query = async (sql, ...parameters) => {
                if (!failedDuringDataWrite && String(sql).startsWith('INSERT INTO `widgets`')) {
                    failedDuringDataWrite = true;
                    // A real server error after earlier tables were written.
                    return query('SIGNAL SQLSTATE \'45000\' SET MESSAGE_TEXT = \'simulated interruption\'');
                }
                return query(sql, ...parameters);
            };
            return client;
        };
        try {
            await assert.rejects(seedMysql({ connection: interruptedConfig, sourcePath }), /simulated interruption/);
        } finally { mysql.createConnection = originalCreateConnection; }
        for (const table of APPLICATION_TABLES) {
            const [rows] = await admin.query(`SELECT COUNT(*) AS count FROM ${q(interruptedConfig.database)}.${q(table)}`);
            assert.equal(Number(rows[0].count), 0, `${table} must roll back after interruption`);
        }
        const [pending] = await admin.query(`SELECT state FROM ${q(interruptedConfig.database)}.${q(STATE_TABLE)}`);
        assert.equal(pending[0].state, 'initializing');
        await seedMysql({ connection: interruptedConfig, sourcePath });
        await compareSnapshot(interruptedConfig);
        checks.interruptedImportRollsBackAndResumes = true;
        fs.writeFileSync(resultFile, JSON.stringify({ success: true, checks, counts: seeded.counts, runDir }, null, 2));
        console.log(JSON.stringify({ success: true, checks, counts: seeded.counts, resultFile }, null, 2));
    } catch (error) {
        fs.writeFileSync(resultFile, JSON.stringify({ success: false, checks, error: error.stack, runDir }, null, 2));
        throw error;
    } finally {
        if (admin) { try { await admin.query('SHUTDOWN'); } catch { /* server closes connection */ } try { await admin.end(); } catch {} }
        if (server && server.exitCode === null) {
            await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(10000)]);
            if (server.exitCode === null) server.kill();
        }
    }
}

main().catch(error => { console.error(error.stack); console.error(`Artifacts: ${runDir}`); process.exitCode = 1; });
