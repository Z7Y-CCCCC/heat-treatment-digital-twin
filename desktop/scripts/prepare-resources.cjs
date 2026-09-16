const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareResourceDirectory, copySqliteSnapshot } = require('./resource-preparation.cjs');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const resourcesDir = path.join(desktopDir, 'resources');
const nativeClientSourceDir = path.join(projectDir, 'unity-client', 'Builds', 'Windows');
const explicitSourceDb = String(process.env.DESKTOP_TEMPLATE_SOURCE_DB || '').trim();
const sourceUploads = path.resolve(
    process.env.DESKTOP_TEMPLATE_SOURCE_UPLOADS || path.join(projectDir, 'backend', 'uploads')
);
const nodeBinary = process.execPath;
const backendNodeModules = path.join(projectDir, 'backend', 'node_modules');
const configurationTables = [
    'settings',
    'workshops',
    'lines',
    'devices',
    'data_points',
    'models',
    'bindings',
    'device_templates',
    'datapoint_templates',
    'projects',
    'scenes',
    'widgets',
    'releases'
];

function enabled(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function mysqlSourceConfig() {
    return {
        host: process.env.DESKTOP_MYSQL_HOST || process.env.MYSQL_HOST || process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DESKTOP_MYSQL_PORT || process.env.MYSQL_PORT || process.env.DB_PORT || 3307),
        user: process.env.DESKTOP_MYSQL_USER || process.env.MYSQL_USER || process.env.DB_USER || 'root',
        password: process.env.DESKTOP_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD || 'root',
        database: process.env.DESKTOP_MYSQL_DATABASE || process.env.MYSQL_DATABASE || process.env.DB_NAME || 'dongtai_daping',
        dateStrings: true,
        decimalNumbers: true,
        supportBigNumbers: true,
        bigNumberStrings: false
    };
}

function sqliteValue(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

async function createEmptySqliteDatabase(dataDir, filename) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
        type: 'sqlite',
        filename
    }, null, 2));

    Object.assign(process.env, {
        APP_DATA_DIR: dataDir,
        DB_TYPE: 'sqlite',
        SQLITE_FILE: filename,
        DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000)
    });
    const databaseModule = require(path.join(projectDir, 'backend', 'db', 'database.js'));
    await databaseModule.getDb();
    await databaseModule.closeDb();
}

async function exportMysqlConfiguration(destination) {
    const mysql = require(path.join(backendNodeModules, 'mysql2', 'promise'));
    const Database = require(path.join(backendNodeModules, 'better-sqlite3'));
    const sourceConfig = mysqlSourceConfig();
    const includeHistory = enabled(process.env.DESKTOP_TEMPLATE_INCLUDE_HISTORY, false);
    const connection = await mysql.createConnection(sourceConfig);
    const generatedDataDir = path.dirname(destination);

    try {
        await createEmptySqliteDatabase(generatedDataDir, destination);
        const [mysqlTableRows] = await connection.query('SHOW TABLES');
        const mysqlTables = new Set(mysqlTableRows.map(row => String(Object.values(row)[0])));
        const tablesToCopy = includeHistory
            ? [...configurationTables, 'event_logs', 'metric_snapshots']
            : configurationTables;
        const db = new Database(destination);
        try {
            db.pragma('foreign_keys = OFF');
            const sqliteTables = db.prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).all().map(row => row.name);

            const copy = db.transaction((tableRows) => {
                for (const table of sqliteTables) {
                    db.prepare(`DELETE FROM \`${table.replace(/`/g, '``')}\``).run();
                }

                for (const entry of tableRows) {
                    const quotedTable = `\`${entry.table.replace(/`/g, '``')}\``;
                    const quotedColumns = entry.columns.map(column => `\`${column.replace(/`/g, '``')}\``);
                    const placeholders = entry.columns.map(() => '?').join(', ');
                    const insert = db.prepare(
                        `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${placeholders})`
                    );
                    for (const row of entry.rows) {
                        insert.run(entry.columns.map(column => sqliteValue(row[column])));
                    }
                }
            });

            const tableRows = [];
            for (const table of tablesToCopy) {
                if (!mysqlTables.has(table) || !sqliteTables.includes(table)) continue;
                const sqliteColumns = db.prepare(`PRAGMA table_info(\`${table.replace(/`/g, '``')}\`)`)
                    .all()
                    .map(column => column.name);
                const [mysqlColumnRows] = await connection.query(
                    `SHOW COLUMNS FROM \`${table.replace(/`/g, '``')}\``
                );
                const mysqlColumns = new Set(mysqlColumnRows.map(column => column.Field));
                const columns = sqliteColumns.filter(column => mysqlColumns.has(column));
                const selectColumns = columns.map(column => `\`${column.replace(/`/g, '``')}\``).join(', ');
                const [rows] = await connection.query(
                    `SELECT ${selectColumns} FROM \`${table.replace(/`/g, '``')}\``
                );
                tableRows.push({ table, columns, rows });
            }
            copy(tableRows);
            db.pragma('foreign_keys = ON');
            const foreignKeyErrors = db.pragma('foreign_key_check');
            if (foreignKeyErrors.length > 0) {
                throw new Error(`MySQL 配置迁移后存在 ${foreignKeyErrors.length} 条外键错误`);
            }
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.pragma('journal_mode = DELETE');
            db.exec('VACUUM');
            const integrity = db.pragma('quick_check', { simple: true });
            if (integrity !== 'ok') throw new Error(`MySQL 配置迁移完整性检查失败：${integrity}`);

            const counts = {};
            for (const table of tablesToCopy) {
                if (!sqliteTables.includes(table)) continue;
                counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM \`${table.replace(/`/g, '``')}\``).get().count;
            }
            if ((counts.devices || 0) === 0) throw new Error('MySQL 中没有可交付的设备配置');
            if ((counts.data_points || 0) === 0) throw new Error('MySQL 中没有可交付的 PLC 点位配置');
            return {
                label: `MySQL ${sourceConfig.host}:${sourceConfig.port}/${sourceConfig.database}`,
                counts,
                includeHistory
            };
        } finally {
            db.close();
        }
    } finally {
        await connection.end();
    }
}

async function prepareDatabaseTemplate(stagingDirectory, outputDb) {
    const generatedDataDir = path.join(stagingDirectory, '.template-build');
    const generatedDb = path.join(generatedDataDir, 'factory.db');
    let templateSource;
    let sourceLabel;
    let exportResult = null;

    if (explicitSourceDb) {
        templateSource = path.resolve(explicitSourceDb);
        if (!fs.existsSync(templateSource)) throw new Error(`指定的数据库模板不存在：${templateSource}`);
        sourceLabel = templateSource;
    } else {
        exportResult = await exportMysqlConfiguration(generatedDb);
        templateSource = generatedDb;
        sourceLabel = exportResult.label;
    }

    const Database = require(path.join(backendNodeModules, 'better-sqlite3'));
    await copySqliteSnapshot(templateSource, outputDb, Database);
    fs.rmSync(generatedDataDir, { recursive: true, force: true });
    return { sourceLabel, exportResult };
}

async function main() {
    for (const required of ['HeatTreatmentDigitalTwin.exe', 'UnityPlayer.dll', 'HeatTreatmentDigitalTwin_Data']) {
        if (!fs.existsSync(path.join(nativeClientSourceDir, required))) {
            throw new Error(`找不到 Unity 原生客户端产物：${path.join(nativeClientSourceDir, required)}`);
        }
    }

    const databaseSource = await prepareResourceDirectory(resourcesDir, async stagingDirectory => {
        const runtimeDir = path.join(stagingDirectory, 'runtime');
        const templatesDir = path.join(stagingDirectory, 'templates');
        const backendDependenciesTar = path.join(stagingDirectory, 'backend-dependencies.tar');
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.mkdirSync(templatesDir, { recursive: true });
        const result = await prepareDatabaseTemplate(stagingDirectory, path.join(templatesDir, 'factory-template.db'));
        fs.copyFileSync(nodeBinary, path.join(runtimeDir, 'node.exe'));
        execFileSync('tar', ['-cf', backendDependenciesTar, '-C', backendNodeModules, '.'], { windowsHide: true });
        if (!fs.existsSync(backendDependenciesTar) || fs.statSync(backendDependenciesTar).size < 1024 * 1024) {
            throw new Error(`后端依赖包生成失败或文件异常：${backendDependenciesTar}`);
        }
        fs.cpSync(nativeClientSourceDir, path.join(stagingDirectory, 'native-client'), {
            recursive: true,
            filter: source => !path.basename(source).includes('BurstDebugInformation_DoNotShip')
        });
        if (fs.existsSync(sourceUploads)) {
            fs.cpSync(sourceUploads, path.join(templatesDir, 'uploads'), { recursive: true });
        }
        return result;
    });

    console.log(`已准备数据库模板：${path.join(resourcesDir, 'templates', 'factory-template.db')}（来源：${databaseSource.sourceLabel}）`);
    if (databaseSource.exportResult) {
        console.log(`已迁移现场配置：${JSON.stringify(databaseSource.exportResult.counts)}`);
        console.log(`运行历史：${databaseSource.exportResult.includeHistory ? '已包含' : '已清空（仅交付配置）'}`);
    }
    console.log(`已准备上传资源：${fs.existsSync(sourceUploads) ? sourceUploads : '无'}`);
    console.log(`已准备 Node.js 运行时：${nodeBinary}`);
    console.log(`已准备后端运行依赖包：${path.join(resourcesDir, 'backend-dependencies.tar')}`);
    console.log(`已准备 Unity 原生客户端：${path.join(resourcesDir, 'native-client')}`);
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
