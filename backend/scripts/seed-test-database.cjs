// Bootstrap test data in a separate process so cached DB modules and environment
// variables cannot redirect another test (or the user's running application).
const fs = require('fs');
const path = require('path');
const { requireTestPath } = require('./integration-test-utils.cjs');
const filename = requireTestPath(process.argv[2]);

for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SQLITE_TEMPLATE_FILE', 'SQLITE_RECOVERY_TEMPLATE', 'SQLITE_UPGRADE_TEMPLATE']) delete process.env[key];
process.env.APP_DATA_DIR = path.dirname(filename);
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_FILE = filename;
process.env.DB_BACKUP_DIR = path.join(path.dirname(filename), 'backups');
process.env.DB_RECOVERY_DIR = path.join(path.dirname(filename), 'recovery');
process.env.LICENSE_ENFORCE = 'false';

const { getDb, closeDb } = require('../db/database');
(async () => {
    const db = await getDb();
    await db.upsert('settings', { key: 'data_mode', value: 'simulation' }, 'key');
    await db.upsert('settings', { key: 'lan_display_enabled', value: 'false' }, 'key');
    await db.run('UPDATE devices SET plc_enabled = 0');
    if (Number((await db.get('SELECT COUNT(*) AS count FROM data_points')).count) === 0) {
        for (const device of await db.all('SELECT id FROM devices')) {
            for (const point of [
                ['actual_temp', '实际温度', 'DB1.DBD0', 'REAL', 'analog', 'actual_temp', '℃'],
                ['running', '运行状态', 'DB1.DBX4.0', 'BOOL', 'status', 'running', ''],
                ['door_open', '炉门状态', 'DB1.DBX4.1', 'BOOL', 'status', 'front_door_open', '']
            ]) {
                await db.run('INSERT INTO data_points (device_id, name, label, plc_tag, data_type, category, value_role, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [device.id, ...point]);
            }
        }
    }
    await closeDb();
    fs.writeFileSync(path.join(path.dirname(filename), 'database-config.json'), JSON.stringify({ type: 'sqlite', filename }, null, 2));
})().catch(async error => {
    console.error(error.stack || error.message);
    try { await closeDb(); } catch { /* retain initialization error */ }
    process.exitCode = 1;
});
