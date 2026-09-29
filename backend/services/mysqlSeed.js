const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');

const STATE_TABLE = '_desktop_seed_state';
const APPLICATION_TABLES = [
    'factories', 'factory_settings', 'workshops', 'lines', 'devices', 'data_points',
    'models', 'projects', 'scenes', 'device_templates', 'datapoint_templates',
    'widgets', 'bindings', 'releases', 'event_logs', 'metric_snapshots', 'settings'
];

function identifier(value) {
    return `\`${String(value).replace(/`/g, '``')}\``;
}

function atomicJson(filename, value) {
    if (!filename) return;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filename);
}

function normalizeValue(value, column, table) {
    if (value === undefined || value === null) return null;
    if (column.DATA_TYPE === 'json') {
        // Reject malformed snapshots rather than silently losing configuration.
        try { return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value); }
        catch { throw new Error(`Invalid JSON in ${table}.${column.COLUMN_NAME}`); }
    }
    if (['datetime', 'timestamp'].includes(column.DATA_TYPE) && typeof value === 'string') {
        return value.replace(/^(\d{4}-\d\d-\d\d)T/, '$1 ').replace(/Z$/, '');
    }
    return value;
}

function readSnapshot(sourcePath) {
    const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
        if (String(db.pragma('quick_check', { simple: true })).toLowerCase() !== 'ok') {
            throw new Error('Delivery snapshot integrity check failed');
        }
        const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all().map(row => row.name);
        const unknown = names.filter(name => !APPLICATION_TABLES.includes(name));
        const missing = APPLICATION_TABLES.filter(name => !names.includes(name));
        if (unknown.length || missing.length) {
            throw new Error(`Unsupported snapshot schema; missing: ${missing.join(', ')}; unknown: ${unknown.join(', ')}`);
        }
        return APPLICATION_TABLES.map(name => ({
            name,
            columns: db.prepare(`PRAGMA table_info(${identifier(name)})`).all().map(column => column.name),
            rows: db.prepare(`SELECT * FROM ${identifier(name)}`).all()
        }));
    } finally { db.close(); }
}

/**
 * Import only a database owned by this bootstrap, before the application starts.
 * Schema DDL may be resumed; all application rows and the completion state are
 * committed together. There is deliberately no DELETE, TRUNCATE, DROP or REPLACE.
 * The database state is authoritative; the optional local marker is diagnostic.
 */
async function seedMysql(options) {
    const config = options?.connection;
    if (!config || !/^[a-zA-Z0-9_]{1,64}$/.test(String(config.database || ''))) {
        throw new Error('A valid explicit target MySQL database is required');
    }
    if (!config.host || !config.user || !Number.isInteger(Number(config.port))) {
        throw new Error('Explicit MySQL host, port and user are required');
    }
    const sourcePath = path.resolve(options.sourcePath || '');
    const markerPath = options.markerPath ? path.resolve(options.markerPath) : null;
    const connection = await mysql.createConnection({
        host: config.host, port: Number(config.port), user: config.user,
        password: config.password || '', charset: 'utf8mb4',
        connectTimeout: 10000, multipleStatements: false, dateStrings: true
    });
    const lockName = `desktop_seed_${crypto.createHash('sha256').update(config.database).digest('hex').slice(0, 40)}`;
    let locked = false;
    let transaction = false;
    try {
        const [locks] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
        if (Number(locks[0].acquired) !== 1) throw new Error('Another desktop database initialization is in progress');
        locked = true;
        const [existing] = await connection.query(
            'SELECT TABLE_NAME AS name, TABLE_TYPE AS kind FROM information_schema.tables WHERE table_schema = ?',
            [config.database]
        );
        if (existing.length && !existing.some(table => table.name === STATE_TABLE)) {
            throw new Error('Refusing to seed an existing database without desktop ownership state');
        }
        const unexpected = existing.filter(table => table.kind !== 'BASE TABLE'
            || (!APPLICATION_TABLES.includes(table.name) && table.name !== STATE_TABLE));
        if (unexpected.length) throw new Error('Refusing to seed a database with unrecognized tables or views');
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${identifier(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await connection.query(`USE ${identifier(config.database)}`);
        await connection.query(`CREATE TABLE IF NOT EXISTS ${identifier(STATE_TABLE)} (
            id INT PRIMARY KEY, source_sha256 CHAR(64) NOT NULL,
            state VARCHAR(16) NOT NULL, result_json LONGTEXT NULL,
            completed_at DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const [states] = await connection.query(`SELECT * FROM ${identifier(STATE_TABLE)} WHERE id = 1`);
        const state = states[0];
        if (state?.state === 'complete') {
            const result = { ...JSON.parse(state.result_json), alreadyInitialized: true };
            atomicJson(markerPath, result);
            return result;
        }
        if (!state && existing.some(table => table.name !== STATE_TABLE)) {
            throw new Error('Refusing to adopt pre-existing application schema without ownership state');
        }
        const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
        if (state && (state.state !== 'initializing' || state.source_sha256 !== sourceHash)) {
            throw new Error('An unfinished initialization requires its original delivery snapshot');
        }
        const snapshot = readSnapshot(sourcePath);
        if (!state) {
            await connection.query(`INSERT INTO ${identifier(STATE_TABLE)} (id, source_sha256, state) VALUES (1, ?, 'initializing')`, [sourceHash]);
        }
        // This shared helper also refuses every populated application table.
        const { initializeEmptyMysqlSchema } = require('../db/database');
        await initializeEmptyMysqlSchema(connection, { ...config, type: 'mysql' });
        const [targetColumns] = await connection.query(
            'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.columns WHERE table_schema = ?',
            [config.database]
        );
        const tableColumns = new Map(APPLICATION_TABLES.map(table => [table,
            new Map(targetColumns.filter(column => column.TABLE_NAME === table).map(column => [column.COLUMN_NAME, column]))
        ]));
        // Validate the full schema and values before beginning any data writes.
        for (const table of snapshot) {
            const columns = tableColumns.get(table.name);
            for (const column of table.columns) {
                if (!columns.has(column)) throw new Error(`Snapshot column is unsupported: ${table.name}.${column}`);
            }
            table.values = table.rows.map(row => table.columns.map(column => normalizeValue(row[column], columns.get(column), table.name)));
        }
        await connection.beginTransaction();
        transaction = true;
        const counts = {};
        for (const table of snapshot) {
            const sql = `INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')})`;
            for (const values of table.values) await connection.query(sql, values);
            const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${identifier(table.name)}`);
            counts[table.name] = Number(rows[0].count);
            if (counts[table.name] !== table.rows.length) throw new Error(`Row verification failed: ${table.name}`);
        }
        const result = {
            version: 1, database: config.database, sourceSha256: sourceHash,
            completedAt: new Date().toISOString(), counts, alreadyInitialized: false
        };
        await connection.query(`UPDATE ${identifier(STATE_TABLE)} SET state = 'complete', result_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = 1`, [JSON.stringify(result)]);
        await connection.commit();
        transaction = false;
        atomicJson(markerPath, result);
        return result;
    } catch (error) {
        if (transaction) { try { await connection.rollback(); } catch { /* disconnected connections roll back */ } }
        throw error;
    } finally {
        if (locked) { try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* disconnected */ } }
        await connection.end();
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config') {
        console.error('Usage: node mysqlSeed.js --config <private-json-file>');
        process.exitCode = 1;
    } else {
        Promise.resolve().then(() => {
            const input = fs.readFileSync(path.resolve(args[1]), 'utf8').replace(/^\uFEFF/, '');
            try { return JSON.parse(input); }
            catch { throw new Error('Private MySQL seed configuration is not valid JSON'); }
        })
            .then(seedMysql)
            .then(result => console.log(JSON.stringify(result)))
            .catch(error => { console.error(`[MySQL seed] ${error.message}`); process.exitCode = 1; });
    }
}

module.exports = { seedMysql, APPLICATION_TABLES, STATE_TABLE };
