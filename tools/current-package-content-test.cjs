const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('../backend/node_modules/better-sqlite3');
const mysql = require('../backend/node_modules/mysql2/promise');
const { CONFIGURATION_FILES } = require('../desktop/templateData.cjs');

const resources = path.resolve(process.argv[2]);
const userData = path.resolve(process.argv[3]);
const reportFile = path.resolve(process.argv[4]);
const project = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function filesBelow(dir, prefix = '') {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const name = path.join(prefix, entry.name);
        return entry.isDirectory() ? filesBelow(path.join(dir, entry.name), name) : [name];
    });
}

(async () => {
    const db = new Database(path.join(resources, 'templates', 'factory-template.db'), { readonly: true, fileMustExist: true });
    let source;
    try {
        assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
        const config = JSON.parse(fs.readFileSync(path.join(userData, 'data', 'database-config.json'), 'utf8').replace(/^\uFEFF/, ''));
        source = config.type === 'mysql' ? await mysql.createConnection({
            host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
            dateStrings: true, decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: false
        }) : new Database(config.filename || path.join(userData, 'data', 'factory.db'), { readonly: true, fileMustExist: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const counts = {};
        for (const { name } of tables) {
            const table = `\`${name.replace(/`/g, '``')}\``;
            const packaged = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
            const actual = config.type === 'mysql'
                ? Number((await source.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n)
                : source.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
            assert.equal(packaged, actual, `Current source table omitted or changed during packaging: ${name}`);
            if (!['event_logs', 'metric_snapshots'].includes(name)) {
                const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name).sort();
                const select = `SELECT ${columns.map(column => `\`${column}\``).join(', ')} FROM ${table}`;
                const sourceRows = config.type === 'mysql' ? (await source.query(select))[0] : source.prepare(select).all();
                const normalize = rows => rows.map(row => JSON.stringify(columns.map(column => {
                    const value = row[column];
                    return value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);
                }))).sort();
                assert.deepEqual(normalize(db.prepare(select).all()), normalize(sourceRows), `Current configuration content differs: ${name}`);
            }
            counts[name] = packaged;
        }
        const uploads = filesBelow(path.join(userData, 'uploads'));
        for (const name of uploads)
            assert.equal(hash(path.join(resources, 'templates', 'uploads', name)), hash(path.join(userData, 'uploads', name)), `Upload mismatch: ${name}`);
        const settings = CONFIGURATION_FILES.filter(name => fs.existsSync(path.join(userData, 'data', name)));
        for (const name of settings)
            assert.equal(hash(path.join(resources, 'templates', 'data', name)), hash(path.join(userData, 'data', name)), `Configuration mismatch: ${name}`);
        const builtInAssets = filesBelow(path.join(project, 'backend', 'assets')).filter(name => !/\.blend1?$/.test(name));
        for (const name of builtInAssets)
            assert.equal(hash(path.join(resources, 'backend', 'assets', name)), hash(path.join(project, 'backend', 'assets', name)), `Built-in asset mismatch: ${name}`);
        const report = { success: true, resources, sourceUserDataDirectory: userData, tableCounts: counts,
            uploadFilesVerified: uploads.length, portableConfigurationFilesVerified: settings,
            builtInAssetFilesVerified: builtInAssets.length, configurationRowsVerified: true,
            snapshotSha256: hash(path.join(resources, 'templates', 'factory-template.db')) };
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally { db.close(); if (source) await (source.end ? source.end() : source.close()); }
})().catch(error => { console.error(error); process.exitCode = 1; });
