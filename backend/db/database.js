const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const {
    buildDocumentFromLegacy,
    isCanonicalDocument,
    safeJsonParse: parseDashboardJson
} = require('../utils/dashboardDocument');
const {
    safeObject,
    finiteNumber,
    normalizeAngleDegrees,
    normalizeSpatialTransform,
    defaultWorkshopLayout,
    normalizeWorkshopLayout,
    normalizeLineLayout,
    localToParentPoint,
    parentToLocalPoint,
    composeSpatialTransforms,
    deviceYawToDegrees,
    deviceYawFromDegrees,
    effectiveDeviceLineId,
    configuredDeviceWorkshopId
} = require('../utils/spatialLayout');
const {
    createMysqlDump,
    resolveMysqlTools,
    restoreMysqlDump,
    verifyMysqlDumpFile,
    verifyMysqlDumpFileSync
} = require('../services/mysqlBackup');

const DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'database-config.json');
const BACKUP_DIR = path.resolve(process.env.DB_BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const RECOVERY_DIR = path.resolve(process.env.DB_RECOVERY_DIR || path.join(DATA_DIR, 'recovery'));
const BACKUP_INTERVAL_MS = positiveInteger(process.env.DB_BACKUP_INTERVAL_MS, 6 * 60 * 60 * 1000);
const BACKUP_RETENTION_DAYS_MIN = 1;
const BACKUP_RETENTION_DAYS_MAX = 3650;
const BACKUP_RETENTION_DAYS_DEFAULT = boundedInteger(
    process.env.DB_BACKUP_RETENTION_DAYS,
    30,
    BACKUP_RETENTION_DAYS_MIN,
    BACKUP_RETENTION_DAYS_MAX
);
// 兼容旧部署中的“保留份数”环境变量，同时把默认上限放宽；主清理策略改为按天数。
const BACKUP_RETENTION = positiveInteger(process.env.DB_BACKUP_RETENTION, 1000);
const BACKUP_MAX_TOTAL_BYTES = positiveInteger(process.env.DB_BACKUP_MAX_TOTAL_BYTES, 20 * 1024 * 1024 * 1024);
const BACKUP_MIN_FREE_BYTES = positiveInteger(process.env.DB_BACKUP_MIN_FREE_BYTES, 512 * 1024 * 1024);
const BACKUP_PRUNE_INTERVAL_MS = positiveInteger(process.env.DB_BACKUP_PRUNE_INTERVAL_MS, 6 * 60 * 60 * 1000);
const BACKUP_ORPHAN_GRACE_MS = positiveInteger(process.env.DB_BACKUP_ORPHAN_GRACE_MS, 60 * 60 * 1000);
const DAY_MS = 24 * 60 * 60 * 1000;
const SQLITE_BACKUP_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

const DEFAULT_CONFIG = {
    type: 'mysql',
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'root',
    database: 'dongtai_daping',
    filename: path.join(DATA_DIR, 'factory.db'),
    backupRetentionDays: BACKUP_RETENTION_DAYS_DEFAULT,
    encrypt: false,
    trustServerCertificate: true
};

let pool;
let sqliteDb;
let activeConfig;
let initPromise;
let closePromise;
let sqliteOperationQueue = Promise.resolve();
const sqliteTransactionContext = new AsyncLocalStorage();
let lastInitError = null;
let mysqlDriver;
let pgDriver;
let sqlserverDriver;
let sqliteDriver;
let backupTimer;
let backupPromise;
let databaseRestoreActive = false;
let lastBackup = null;
let lastRecovery = null;
let lastBackupError = null;
let lastBackupCleanup = null;
const protectedBackupFiles = new Set();

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function getMysql() {
    if (!mysqlDriver) mysqlDriver = require('mysql2/promise');
    return mysqlDriver;
}

function getPgPool() {
    if (!pgDriver) pgDriver = require('pg').Pool;
    return pgDriver;
}

function getSqlServer() {
    if (!sqlserverDriver) sqlserverDriver = require('mssql');
    return sqlserverDriver;
}

function getSqliteDatabase() {
    if (!sqliteDriver) sqliteDriver = require('better-sqlite3');
    return sqliteDriver;
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function timestampToken(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

function sanitizeBackupReason(reason) {
    const value = String(reason || 'manual').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    return value.replace(/^-+|-+$/g, '').slice(0, 32) || 'manual';
}

function sqliteQuickCheck(db) {
    const result = db.pragma('quick_check', { simple: true });
    if (String(result).toLowerCase() !== 'ok') {
        throw new Error(`SQLite 完整性检查失败: ${result}`);
    }
}

function verifySqliteFile(filename, options = {}) {
    const resolved = path.resolve(filename);
    if (!fs.existsSync(resolved)) return { valid: false, error: '文件不存在' };

    const Database = getSqliteDatabase();
    let db;
    try {
        db = new Database(resolved, { readonly: true, fileMustExist: true });
        sqliteQuickCheck(db);
        if (options.requireApplicationSchema) {
            const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
                .map(row => String(row.name).toLowerCase()));
            const missing = ['settings', 'devices', 'data_points', 'workshops', 'lines'].filter(table => !tables.has(table));
            if (missing.length) throw new Error(`备份不是本软件的业务数据库，缺少表：${missing.join(', ')}`);
        }
        return { valid: true, error: null };
    } catch (error) {
        return { valid: false, error: error.message };
    } finally {
        try { db?.close(); } catch (error) { /* ignore */ }
    }
}

function configureSqlite(db) {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('wal_autocheckpoint = 1000');
    sqliteQuickCheck(db);
    return db;
}

function backupDescriptor(filename, options = {}) {
    const stat = fs.statSync(filename);
    return {
        filename: path.basename(filename),
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        valid: options.valid ?? null,
        error: options.error || null
    };
}

function backupExtension(config = activeConfig || loadDatabaseConfig()) {
    return dialectName(config) === 'mysql' ? '.sql.gz' : '.db';
}

function backupMatchesConfig(filename, config = activeConfig || loadDatabaseConfig()) {
    const lower = String(filename || '').toLowerCase();
    return lower.endsWith(backupExtension(config));
}

function ensureBackupDiskSpace(directory) {
    if (typeof fs.statfsSync !== 'function') return;
    try {
        const stats = fs.statfsSync(directory);
        const available = Number(stats.bavail || 0) * Number(stats.bsize || 0);
        if (available > 0 && available < BACKUP_MIN_FREE_BYTES) {
            throw new Error(`备份磁盘可用空间不足（至少需要 ${Math.round(BACKUP_MIN_FREE_BYTES / 1024 / 1024)} MB）`);
        }
    } catch (error) {
        if (error.message.includes('可用空间不足')) throw error;
        // 某些 Windows 文件系统不提供 statfs，不能因此阻断备份。
    }
}

function databaseBackupArtifactPaths(filename) {
    const resolved = path.resolve(filename);
    const lower = resolved.toLowerCase();
    if (!lower.endsWith('.db') && !lower.includes('.db.')) return [resolved];
    return [resolved, ...SQLITE_BACKUP_SIDECAR_SUFFIXES.map(suffix => `${resolved}${suffix}`)];
}

function removeDatabaseBackupArtifacts(filename) {
    const artifacts = databaseBackupArtifactPaths(filename);
    let bytes = 0;
    const errors = [];
    for (const artifact of artifacts) {
        try {
            if (fs.existsSync(artifact)) bytes += Number(fs.statSync(artifact).size || 0);
        } catch (error) {
            errors.push({ filename: path.basename(artifact), error: error.message });
        }
    }
    for (const artifact of artifacts) {
        try {
            fs.rmSync(artifact, { force: true });
        } catch (error) {
            errors.push({ filename: path.basename(artifact), error: error.message });
        }
    }
    return { bytes, errors, primaryExists: fs.existsSync(artifacts[0]) };
}

function pruneOrphanBackupArtifacts() {
    ensureDirectory(BACKUP_DIR);
    const now = Date.now();
    let deletedCount = 0;
    let deletedBytes = 0;
    const errors = [];
    const removedBases = new Set();
    const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true }).filter(entry => entry.isFile());
    for (const entry of entries) {
        const filename = entry.name;
        const lower = filename.toLowerCase();
        const isTemporary = /\.db\.[^.]+\.tmp$|\.sql\.gz\.[^.]+\.tmp$/i.test(filename);
        const sidecarSuffix = SQLITE_BACKUP_SIDECAR_SUFFIXES.find(suffix => lower.endsWith(suffix));
        if (!isTemporary && !sidecarSuffix) continue;
        const fullPath = path.join(BACKUP_DIR, filename);
        let ageMs = 0;
        try { ageMs = now - fs.statSync(fullPath).mtimeMs; } catch (error) { continue; }
        if (ageMs < BACKUP_ORPHAN_GRACE_MS) continue;
        const basePath = isTemporary
            ? fullPath
            : fullPath.slice(0, -sidecarSuffix.length);
        if (!isTemporary && fs.existsSync(basePath)) continue;
        if (removedBases.has(basePath)) continue;
        const removed = removeDatabaseBackupArtifacts(basePath);
        if (removed.primaryExists) continue;
        removedBases.add(basePath);
        deletedCount += 1;
        deletedBytes += removed.bytes;
        errors.push(...removed.errors);
    }
    return { deletedCount, deletedBytes, errors };
}

function listDatabaseBackups({ validate = true } = {}) {
    ensureDirectory(BACKUP_DIR);
    return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && backupMatchesConfig(entry.name))
        .map(entry => path.join(BACKUP_DIR, entry.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
        .map(filename => {
            const verification = validate
                ? (backupExtension() === '.db' ? verifySqliteFile(filename) : verifyMysqlDumpFileSync(filename))
                : { valid: null, error: null };
            return backupDescriptor(filename, verification);
        });
}

function resolveDatabaseBackupPath(filename) {
    const name = path.basename(String(filename || ''));
    if (!name || name !== filename || !backupMatchesConfig(name)) {
        throw new Error('备份文件名不合法');
    }
    const resolved = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error('备份文件不存在');
    }
    return resolved;
}

async function deleteDatabaseBackup(filename) {
    if (backupPromise) await backupPromise;
    const resolved = resolveDatabaseBackupPath(filename);
    const name = path.basename(resolved);
    if (protectedBackupFiles.has(name)) {
        throw new Error('该备份正在用于恢复，暂时不能删除');
    }

    const removed = removeDatabaseBackupArtifacts(resolved);
    if (removed.primaryExists) throw new Error('备份文件删除失败');
    if (removed.errors.length) {
        throw new Error(`备份附属文件删除不完整：${removed.errors.map(item => item.error).join('；')}`);
    }
    if (lastBackup?.filename === name) lastBackup = null;
    return {
        success: true,
        deleted: { filename: name, size: removed.bytes },
        status: getDatabaseBackupStatus()
    };
}

function latestRecoverySource() {
    const backup = listDatabaseBackups({ validate: true }).find(item => item.valid);
    if (backup) return { type: 'backup', filename: path.join(BACKUP_DIR, backup.filename) };

    const template = process.env.SQLITE_RECOVERY_TEMPLATE
        ? path.resolve(process.env.SQLITE_RECOVERY_TEMPLATE)
        : '';
    if (template && verifySqliteFile(template).valid) {
        return { type: 'template', filename: template };
    }
    return null;
}

function removeSqliteSidecars(filename) {
    for (const suffix of SQLITE_BACKUP_SIDECAR_SUFFIXES) {
        try { fs.rmSync(`${filename}${suffix}`, { force: true }); } catch (error) { /* ignore */ }
    }
}

function installSqliteCopy(source, destination) {
    ensureDirectory(path.dirname(destination));
    const temporary = `${destination}.restore-${process.pid}-${Date.now()}.tmp`;
    fs.copyFileSync(source, temporary);
    const verification = verifySqliteFile(temporary);
    if (!verification.valid) {
        removeDatabaseBackupArtifacts(temporary);
        throw new Error(`恢复源无效: ${verification.error}`);
    }
    removeSqliteSidecars(destination);
    removeDatabaseBackupArtifacts(destination);
    fs.renameSync(temporary, destination);
    removeDatabaseBackupArtifacts(temporary);
}

function quarantineSqliteFiles(filename, label = 'corrupt') {
    ensureDirectory(RECOVERY_DIR);
    const token = timestampToken();
    const moved = [];
    for (const suffix of ['', '-wal', '-shm']) {
        const source = `${filename}${suffix}`;
        if (!fs.existsSync(source)) continue;
        const destination = path.join(
            RECOVERY_DIR,
            `${path.basename(filename)}${suffix}.${token}.${label}`
        );
        fs.renameSync(source, destination);
        moved.push({ source, destination });
    }
    return moved;
}

function isLegacyDemoDatabase(db) {
    try {
        const devices = db.prepare('SELECT id FROM devices ORDER BY id').all().map(row => String(row.id));
        const expectedIds = Array.from({ length: 20 }, (_, index) => `Furnace_${String(index + 1).padStart(2, '0')}`);
        const pointCount = Number(db.prepare('SELECT COUNT(*) AS count FROM data_points').get()?.count || 0);
        const lineCount = Number(db.prepare('SELECT COUNT(*) AS count FROM `lines`').get()?.count || 0);
        return devices.length === expectedIds.length
            && devices.every((id, index) => id === expectedIds[index])
            && pointCount <= 1
            && lineCount === 4;
    } catch (error) {
        return false;
    }
}

function isDeliverableTemplate(filename) {
    const verification = verifySqliteFile(filename);
    if (!verification.valid) return false;
    const Database = getSqliteDatabase();
    let db;
    try {
        db = new Database(filename, { readonly: true, fileMustExist: true });
        const devices = Number(db.prepare('SELECT COUNT(*) AS count FROM devices').get()?.count || 0);
        const points = Number(db.prepare('SELECT COUNT(*) AS count FROM data_points').get()?.count || 0);
        return devices > 0 && points > 0 && !isLegacyDemoDatabase(db);
    } catch (error) {
        return false;
    } finally {
        try { db?.close(); } catch (error) { /* ignore */ }
    }
}

async function upgradeLegacyDemoDatabase(filename) {
    const template = process.env.SQLITE_UPGRADE_TEMPLATE
        ? path.resolve(process.env.SQLITE_UPGRADE_TEMPLATE)
        : '';
    if (!template || !fs.existsSync(filename) || path.resolve(filename) === template) return null;
    if (!isDeliverableTemplate(template)) {
        console.warn(`[DB] 跳过旧演示库迁移：交付模板无效或缺少设备/点位配置 (${template})`);
        return null;
    }

    const Database = getSqliteDatabase();
    let current;
    try {
        current = new Database(filename, { readonly: true, fileMustExist: true });
        sqliteQuickCheck(current);
        if (!isLegacyDemoDatabase(current)) return null;
    } finally {
        try { current?.close(); } catch (error) { /* ignore */ }
    }

    ensureDirectory(BACKUP_DIR);
    const backupName = `factory-before-template-upgrade-${timestampToken()}.db`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    const temporaryBackup = `${backupPath}.tmp`;
    let source;
    try {
        source = new Database(filename, { fileMustExist: true });
        await source.backup(temporaryBackup);
    } finally {
        try { source?.close(); } catch (error) { /* ignore */ }
    }
    const backupVerification = verifySqliteFile(temporaryBackup);
    if (!backupVerification.valid) {
        removeDatabaseBackupArtifacts(temporaryBackup);
        throw new Error(`旧演示数据库备份校验失败: ${backupVerification.error}`);
    }
    fs.renameSync(temporaryBackup, backupPath);
    removeDatabaseBackupArtifacts(temporaryBackup);
    installSqliteCopy(template, filename);
    const migration = {
        reason: 'legacy_demo_upgrade',
        sourceType: 'delivery_template',
        source: path.basename(template),
        backup: backupName,
        recoveredAt: new Date().toISOString()
    };
    console.warn(`[DB] 已备份并迁移旧演示数据库：${backupName} -> ${path.basename(template)}`);
    return migration;
}

async function openSqliteWithRecovery(filename) {
    const Database = getSqliteDatabase();
    const resolved = path.resolve(filename);
    ensureDirectory(path.dirname(resolved));

    if (!fs.existsSync(resolved)) {
        const recoverySource = latestRecoverySource();
        if (recoverySource) {
            installSqliteCopy(recoverySource.filename, resolved);
            lastRecovery = {
                reason: 'database_missing',
                sourceType: recoverySource.type,
                source: path.basename(recoverySource.filename),
                recoveredAt: new Date().toISOString()
            };
        }
    }

    if (fs.existsSync(resolved)) {
        try {
            const migration = await upgradeLegacyDemoDatabase(resolved);
            if (migration) lastRecovery = migration;
        } catch (error) {
            console.warn(`[DB] 旧演示库自动迁移失败，继续保留原数据库: ${error.message}`);
        }
    }

    let db;
    try {
        db = new Database(resolved);
        return configureSqlite(db);
    } catch (error) {
        try { db?.close(); } catch (closeError) { /* ignore */ }
        const recoverySource = latestRecoverySource();
        if (!recoverySource) {
            throw new Error(`SQLite 数据库损坏且没有有效备份: ${error.message}`);
        }

        const quarantined = quarantineSqliteFiles(resolved, 'corrupt');
        installSqliteCopy(recoverySource.filename, resolved);
        db = configureSqlite(new Database(resolved));
        lastRecovery = {
            reason: 'integrity_failure',
            sourceType: recoverySource.type,
            source: path.basename(recoverySource.filename),
            quarantined: quarantined.map(item => path.basename(item.destination)),
            recoveredAt: new Date().toISOString(),
            error: error.message
        };
        console.warn(`[DB] 主数据库损坏，已从${recoverySource.type === 'backup' ? '备份' : '模板'}恢复: ${recoverySource.filename}`);
        return db;
    }
}

function readStoredConfig() {
    ensureDataDir();
    if (!fs.existsSync(CONFIG_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.warn('[DB] database-config.json 读取失败，使用默认配置:', e.message);
        return {};
    }
}

function parseJsonObject(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function loadDatabaseConfig() {
    const stored = readStoredConfig();
    const merged = { ...DEFAULT_CONFIG, ...stored };
    if (process.env.DB_TYPE) merged.type = process.env.DB_TYPE;
    if (process.env.MYSQL_HOST || process.env.DB_HOST) merged.host = process.env.MYSQL_HOST || process.env.DB_HOST;
    if (process.env.MYSQL_PORT || process.env.DB_PORT) merged.port = Number(process.env.MYSQL_PORT || process.env.DB_PORT);
    if (process.env.MYSQL_USER || process.env.DB_USER) merged.user = process.env.MYSQL_USER || process.env.DB_USER;
    if (process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD) merged.password = process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD;
    if (process.env.MYSQL_DATABASE || process.env.DB_NAME) merged.database = process.env.MYSQL_DATABASE || process.env.DB_NAME;
    if (process.env.SQLITE_FILE) merged.filename = process.env.SQLITE_FILE;
    if (process.env.DB_BACKUP_RETENTION_DAYS) merged.backupRetentionDays = process.env.DB_BACKUP_RETENTION_DAYS;
    return normalizeConfig(merged);
}

function normalizeConfig(config) {
    const type = String(config.type || 'mysql').toLowerCase();
    const port = Number(config.port || defaultPort(type));
    return {
        ...config,
        type,
        port: Number.isFinite(port) ? port : defaultPort(type),
        database: config.database || DEFAULT_CONFIG.database,
        filename: config.filename || DEFAULT_CONFIG.filename,
        backupRetentionDays: boundedInteger(
            config.backupRetentionDays,
            BACKUP_RETENTION_DAYS_DEFAULT,
            BACKUP_RETENTION_DAYS_MIN,
            BACKUP_RETENTION_DAYS_MAX
        ),
        encrypt: !!config.encrypt,
        trustServerCertificate: config.trustServerCertificate !== false
    };
}

function defaultPort(type) {
    if (type === 'postgres' || type === 'postgresql') return 5432;
    if (type === 'sqlserver' || type === 'mssql') return 1433;
    if (type === 'mysql' || type === 'mariadb') return 3307;
    return 0;
}

function publicDatabaseConfig(config = loadDatabaseConfig()) {
    const normalized = normalizeConfig(config);
    return {
        ...normalized,
        password: normalized.password ? '******' : ''
    };
}

function saveDatabaseConfig(input) {
    ensureDataDir();
    const current = loadDatabaseConfig();
    const next = normalizeConfig({
        ...current,
        ...input,
        password: input.password === '******' ? current.password : (input.password ?? current.password)
    });
    writeDatabaseConfig(next);
    return publicDatabaseConfig(next);
}

function writeDatabaseConfig(config) {
    const temporary = `${CONFIG_PATH}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, CONFIG_PATH);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

function parseBackupRetentionDays(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < BACKUP_RETENTION_DAYS_MIN || parsed > BACKUP_RETENTION_DAYS_MAX) {
        throw new Error(`备份保留天数必须是 ${BACKUP_RETENTION_DAYS_MIN}-${BACKUP_RETENTION_DAYS_MAX} 之间的整数`);
    }
    return parsed;
}

async function saveDatabaseBackupPolicy(input = {}) {
    if (backupPromise) await backupPromise;
    const retentionDays = parseBackupRetentionDays(input.retentionDays ?? input.backupRetentionDays);
    ensureDataDir();
    const current = loadDatabaseConfig();
    const next = normalizeConfig({ ...current, backupRetentionDays: retentionDays });
    if (!['sqlite', 'mysql'].includes(dialectName(next))) {
        throw new Error('当前数据库类型暂不支持本地文件备份保留策略');
    }
    writeDatabaseConfig(next);
    if (activeConfig) activeConfig = { ...activeConfig, backupRetentionDays: retentionDays };
    const cleanup = pruneDatabaseBackups({ retentionDays, reason: 'policy-save' });
    return {
        config: { retentionDays },
        cleanup,
        status: getDatabaseBackupStatus()
    };
}

function dialectName(config = activeConfig || loadDatabaseConfig()) {
    const type = String(config.type || 'mysql').toLowerCase();
    if (type === 'postgresql') return 'postgres';
    if (type === 'mssql') return 'sqlserver';
    if (type === 'mariadb') return 'mysql';
    return type;
}

function quoteIdentifier(name, config = activeConfig || loadDatabaseConfig()) {
    const dialect = dialectName(config);
    const value = String(name);
    if (dialect === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
    if (dialect === 'sqlserver') return '[' + value.replace(/]/g, ']]') + ']';
    return `"${value.replace(/"/g, '""')}"`;
}

function tableName(name) {
    return quoteIdentifier(name);
}

function normalizeSql(sql, params = []) {
    const dialect = dialectName();
    let text = sql.replace(/`([^`]+)`/g, (_, name) => quoteIdentifier(name));

    if (dialect === 'postgres') {
        let idx = 0;
        text = text.replace(/\?/g, () => `$${++idx}`);
    } else if (dialect === 'sqlserver') {
        text = normalizeSqlServerLimit(text);
        let idx = 0;
        text = text.replace(/\?/g, () => `@p${++idx}`);
    }

    return { text, params };
}

function normalizeSqlServerLimit(text) {
    const limitMatch = text.match(/\s+LIMIT\s+(\d+)\s*$/i);
    if (!limitMatch) return text;
    const limit = limitMatch[1];
    const withoutLimit = text.replace(/\s+LIMIT\s+\d+\s*$/i, '');
    return withoutLimit.replace(/^SELECT\s+/i, `SELECT TOP ${limit} `);
}

async function createDatabaseIfNeeded(config) {
    const dialect = dialectName(config);
    if (dialect === 'sqlite') return;

    if (dialect === 'mysql') {
        const mysql = getMysql();
        const connection = await mysql.createConnection({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            connectTimeout: databaseConnectionTimeout(config),
            multipleStatements: false
        });
        let failed = false;
        try {
            await connection.query({
                sql: `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(config.database, config)}
                    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
                timeout: databaseQueryTimeout(config)
            });
        } catch (error) {
            failed = true;
            connection.destroy();
            throw error;
        } finally {
            if (!failed) await connection.end();
        }
        return;
    }

    if (dialect === 'postgres') {
        const PgPool = getPgPool();
        const adminPool = new PgPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.adminDatabase || 'postgres',
            connectionTimeoutMillis: databaseConnectionTimeout(config),
            query_timeout: databaseQueryTimeout(config),
            statement_timeout: databaseQueryTimeout(config)
        });
        try {
            const result = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [config.database]);
            if (result.rowCount === 0) {
                await adminPool.query(`CREATE DATABASE ${quoteIdentifier(config.database, config)} ENCODING 'UTF8'`);
            }
        } finally {
            await adminPool.end();
        }
        return;
    }

    if (dialect === 'sqlserver') {
        const sqlserver = getSqlServer();
        const connection = new sqlserver.ConnectionPool(sqlServerConnectionConfig(config, 'master'));
        try {
            await connection.connect();
            await connection.request().query(
                `IF DB_ID(N'${String(config.database).replace(/'/g, "''")}') IS NULL CREATE DATABASE ${quoteIdentifier(config.database, config)}`
            );
        } finally {
            await connection.close();
        }
    }
}

function sqlServerConnectionConfig(config, database = config.database) {
    return {
        server: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database,
        connectionTimeout: databaseConnectionTimeout(config),
        requestTimeout: databaseQueryTimeout(config),
        options: {
            encrypt: !!config.encrypt,
            trustServerCertificate: config.trustServerCertificate !== false
        }
    };
}

async function initDb() {
    activeConfig = loadDatabaseConfig();
    await createDatabaseIfNeeded(activeConfig);

    const dialect = dialectName(activeConfig);
    if (dialect === 'mysql') {
        const mysql = getMysql();
        pool = mysql.createPool({
            host: activeConfig.host,
            port: activeConfig.port,
            user: activeConfig.user,
            password: activeConfig.password,
            connectTimeout: databaseConnectionTimeout(activeConfig),
            database: activeConfig.database,
            waitForConnections: true,
            connectionLimit: Number(activeConfig.connectionLimit || 10),
            queueLimit: 0,
            charset: 'utf8mb4'
        });
        await pool.query('SET time_zone = "+08:00"');
    } else if (dialect === 'postgres') {
        const PgPool = getPgPool();
        pool = new PgPool({
            host: activeConfig.host,
            port: activeConfig.port,
            user: activeConfig.user,
            password: activeConfig.password,
            database: activeConfig.database,
            connectionTimeoutMillis: databaseConnectionTimeout(activeConfig),
            query_timeout: databaseQueryTimeout(activeConfig),
            statement_timeout: databaseQueryTimeout(activeConfig),
            max: Number(activeConfig.connectionLimit || 10)
        });
    } else if (dialect === 'sqlserver') {
        const sqlserver = getSqlServer();
        pool = new sqlserver.ConnectionPool(sqlServerConnectionConfig(activeConfig));
        await pool.connect();
    } else if (dialect === 'sqlite') {
        ensureDataDir();
        sqliteDb = await openSqliteWithRecovery(activeConfig.filename || DEFAULT_CONFIG.filename);
    } else {
        throw new Error(`不支持的数据库类型: ${activeConfig.type}`);
    }

    await initTables();
    await seedDefaults();
    lastInitError = null;
}

async function getDb() {
    if (closePromise) await closePromise;
    if (!initPromise) {
        initPromise = initDb().catch(async (error) => {
            lastInitError = error;
            try { await disposeDatabaseConnections(); } catch (closeError) {
                console.warn('[DB] 初始化失败后的连接清理失败:', closeError.message);
            }
            initPromise = null;
            console.error('[DB] 初始化失败:', error.message);
            throw error;
        });
    }
    await initPromise;
    return makeDbClient();
}

function getDbStatus() {
    return {
        type: dialectName(activeConfig || loadDatabaseConfig()),
        config: publicDatabaseConfig(activeConfig || loadDatabaseConfig()),
        connected: !!(pool || sqliteDb) && !lastInitError,
        error: lastInitError ? lastInitError.message : null
    };
}

async function closeDb() {
    if (sqliteTransactionContext.getStore()?.active) {
        throw new Error('不能在尚未结束的 SQLite 事务中关闭数据库');
    }
    if (closePromise) return closePromise;
    const pendingInitialization = initPromise;
    closePromise = (async () => {
        if (pendingInitialization) await pendingInitialization.catch(() => {});
        await disposeDatabaseConnections();
        initPromise = null;
    })();
    try {
        await closePromise;
    } finally {
        closePromise = null;
    }
}

async function disposeDatabaseConnections() {
    if (pool) {
        const connectionPool = pool;
        pool = null;
        const dialect = dialectName();
        if (dialect === 'mysql' || dialect === 'postgres') await connectionPool.end();
        if (dialect === 'sqlserver') await connectionPool.close();
    }
    await enqueueSqliteOperation(() => {
        if (sqliteDb) {
            sqliteDb.close();
            sqliteDb = null;
        }
    });
}

async function reconnectDb() {
    await closeDb();
    return getDb();
}

function databaseBackupRetentionDays(config = activeConfig || loadDatabaseConfig()) {
    return boundedInteger(
        config?.backupRetentionDays,
        BACKUP_RETENTION_DAYS_DEFAULT,
        BACKUP_RETENTION_DAYS_MIN,
        BACKUP_RETENTION_DAYS_MAX
    );
}

function protectedDatabaseBackupNames(backups) {
    const names = new Set(protectedBackupFiles);
    if (backups[0]?.filename) names.add(backups[0].filename);
    const latestValid = backups.find(backup => backup.valid === true);
    if (latestValid?.filename) names.add(latestValid.filename);
    return names;
}

function pruneDatabaseBackups(options = {}) {
    const retentionDays = boundedInteger(
        options.retentionDays,
        databaseBackupRetentionDays(),
        BACKUP_RETENTION_DAYS_MIN,
        BACKUP_RETENTION_DAYS_MAX
    );
    const cutoffMs = Date.now() - retentionDays * DAY_MS;
    const backups = listDatabaseBackups({ validate: true });
    const protectedNames = protectedDatabaseBackupNames(backups);
    const deletedNames = new Set();
    const deleted = [];
    const errors = [];

    const remainingBackups = () => backups.filter(backup => !deletedNames.has(backup.filename));
    const removeBackup = (backup, cause) => {
        if (!backup || protectedNames.has(backup.filename) || deletedNames.has(backup.filename)) return false;
        const removed = removeDatabaseBackupArtifacts(path.join(BACKUP_DIR, backup.filename));
        if (!removed.primaryExists) {
            deletedNames.add(backup.filename);
            deleted.push({ filename: backup.filename, size: removed.bytes, cause });
            errors.push(...removed.errors);
            return true;
        }
        errors.push(...removed.errors, { filename: backup.filename, error: '主备份文件删除后仍存在' });
        return false;
    };

    for (const backup of [...backups].reverse()) {
        const createdAt = Date.parse(backup.createdAt);
        if (Number.isFinite(createdAt) && createdAt < cutoffMs) removeBackup(backup, 'expired');
    }

    let retained = remainingBackups();
    for (const backup of [...retained].reverse()) {
        if (retained.length <= BACKUP_RETENTION) break;
        if (removeBackup(backup, 'count-limit')) retained = remainingBackups();
    }

    retained = remainingBackups();
    let totalBytes = retained.reduce((sum, backup) => sum + Number(backup.size || 0), 0);
    for (const backup of [...retained].reverse()) {
        if (totalBytes <= BACKUP_MAX_TOTAL_BYTES) break;
        if (removeBackup(backup, 'size-limit')) totalBytes -= Number(backup.size || 0);
    }

    const orphanCleanup = backupPromise ? { deletedCount: 0, deletedBytes: 0, errors: [] } : pruneOrphanBackupArtifacts();
    const remaining = remainingBackups();
    lastBackupCleanup = {
        at: new Date().toISOString(),
        reason: String(options.reason || 'automatic'),
        retentionDays,
        deletedCount: deleted.length,
        deletedBytes: deleted.reduce((sum, backup) => sum + backup.size, 0),
        orphanDeletedCount: orphanCleanup.deletedCount,
        orphanDeletedBytes: orphanCleanup.deletedBytes,
        remainingCount: remaining.length,
        remainingBytes: remaining.reduce((sum, backup) => sum + Number(backup.size || 0), 0),
        deleted,
        errors: [...errors, ...orphanCleanup.errors]
    };
    if (errors.length) {
        console.warn(`[DB] 有 ${errors.length} 个过期备份清理失败: ${errors.map(item => `${item.filename}: ${item.error}`).join('；')}`);
    }
    return lastBackupCleanup;
}

async function createDatabaseBackup(reason = 'manual') {
    if (backupPromise) return backupPromise;

    backupPromise = (async () => {
        await getDb();
        ensureDirectory(BACKUP_DIR);
        ensureBackupDiskSpace(BACKUP_DIR);
        const safeReason = sanitizeBackupReason(reason);
        const isMysql = dialectName() === 'mysql';
        if (!isMysql && (dialectName() !== 'sqlite' || !sqliteDb)) {
            throw new Error('自动文件备份当前支持 SQLite 和 MySQL 数据库');
        }
        const filename = `factory-${timestampToken()}-${safeReason}${isMysql ? '.sql.gz' : '.db'}`;
        const destination = path.join(BACKUP_DIR, filename);
        const temporary = `${destination}.${process.pid}.tmp`;
        fs.rmSync(temporary, { force: true });

        try {
            let verification;
            if (isMysql) {
                let serverVersion = '';
                try { serverVersion = String((await makeDbClient().get('SELECT VERSION() AS version'))?.version || ''); } catch (error) { /* tool selection can fall back */ }
                await createMysqlDump(activeConfig, temporary, { serverVersion });
                verification = await verifyMysqlDumpFile(temporary);
            } else {
                await withSqliteConnection(connection => connection.backup(temporary));
                verification = verifySqliteFile(temporary);
            }
            if (!verification.valid) throw new Error(verification.error);
            fs.renameSync(temporary, destination);
            pruneDatabaseBackups({ reason: `backup-${safeReason}` });
            lastBackup = {
                ...backupDescriptor(destination, { valid: true }),
                reason: safeReason
            };
            lastBackupError = null;
            console.log(`[DB] ${isMysql ? 'MySQL' : 'SQLite'} 备份完成: ${destination}`);
            return lastBackup;
        } catch (error) {
            lastBackupError = { at: new Date().toISOString(), reason: safeReason, error: error.message };
            throw error;
        } finally {
            removeDatabaseBackupArtifacts(temporary);
        }
    })().finally(() => {
        backupPromise = null;
    });

    return backupPromise;
}

async function importDatabaseBackupFile(sourceFilename, reason = 'site-import') {
    await getDb();
    const source = path.resolve(String(sourceFilename || ''));
    const isMysql = dialectName() === 'mysql';
    if (!isMysql && dialectName() !== 'sqlite') {
        throw new Error('外部文件恢复当前支持 SQLite 和 MySQL 数据库');
    }
    const expectedExtension = isMysql ? '.sql.gz' : '.db';
    if (!source.toLowerCase().endsWith(expectedExtension)) {
        throw new Error(`导入备份格式与当前 ${isMysql ? 'MySQL' : 'SQLite'} 数据库不匹配`);
    }
    const verification = isMysql ? await verifyMysqlDumpFile(source) : verifySqliteFile(source);
    if (!verification.valid) throw new Error(`导入数据库完整性检查失败: ${verification.error}`);

    ensureDirectory(BACKUP_DIR);
    ensureBackupDiskSpace(BACKUP_DIR);
    const safeReason = sanitizeBackupReason(reason);
    const filename = `factory-${timestampToken()}-${safeReason}${expectedExtension}`;
    const destination = path.join(BACKUP_DIR, filename);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.rmSync(temporary, { force: true });

    try {
        fs.copyFileSync(source, temporary);
        const copiedVerification = isMysql ? await verifyMysqlDumpFile(temporary) : verifySqliteFile(temporary);
        if (!copiedVerification.valid) throw new Error(copiedVerification.error);
        fs.renameSync(temporary, destination);
        pruneDatabaseBackups({ reason: `import-${safeReason}` });
        return {
            ...backupDescriptor(destination, { valid: true }),
            reason: safeReason
        };
    } finally {
        removeDatabaseBackupArtifacts(temporary);
    }
}

async function restoreMysqlDatabaseBackup(filename) {
    const source = resolveDatabaseBackupPath(filename);
    const verification = await verifyMysqlDumpFile(source);
    if (!verification.valid) throw new Error(`备份完整性检查失败: ${verification.error}`);

    const config = { ...activeConfig };
    ensureDirectory(RECOVERY_DIR);
    const restoreSource = path.join(RECOVERY_DIR, `restore-source-${timestampToken()}-${process.pid}.sql.gz`);
    fs.rmSync(restoreSource, { force: true });
    let protectedRollbackName;

    try {
        fs.copyFileSync(source, restoreSource);
        const copiedVerification = await verifyMysqlDumpFile(restoreSource);
        if (!copiedVerification.valid) throw new Error(`恢复源复制后校验失败: ${copiedVerification.error}`);

        const rollback = await createDatabaseBackup('before-restore');
        protectedRollbackName = rollback.filename;
        protectedBackupFiles.add(protectedRollbackName);
        const rollbackSource = path.join(BACKUP_DIR, rollback.filename);
        let serverVersion = '';
        try { serverVersion = String((await makeDbClient().get('SELECT VERSION() AS version'))?.version || ''); } catch (error) { /* tool selection can fall back */ }
        await closeDb();

        try {
            await restoreMysqlDump(config, restoreSource, { serverVersion });
            await getDb();
            const requiredTable = await makeDbClient().get('SELECT COUNT(*) AS cnt FROM settings');
            if (!requiredTable || Number(requiredTable.cnt) < 1) throw new Error('恢复后的 MySQL 数据库缺少系统设置');
            lastRecovery = {
                reason: 'manual_restore',
                sourceType: 'backup',
                source: path.basename(source),
                recoveredAt: new Date().toISOString()
            };
            return { success: true, recovery: lastRecovery, rollback };
        } catch (error) {
            await closeDb();
            try {
                await restoreMysqlDump(config, rollbackSource, { serverVersion });
                await getDb();
            } catch (rollbackError) {
                throw new Error(`${error.message}；自动回滚也失败：${rollbackError.message}`);
            }
            throw error;
        }
    } finally {
        if (protectedRollbackName) protectedBackupFiles.delete(protectedRollbackName);
        fs.rmSync(restoreSource, { force: true });
    }
}

async function restoreDatabaseBackup(filename) {
    if (databaseRestoreActive) throw new Error('数据库正在恢复，请稍后再试');
    databaseRestoreActive = true;
    const protectedName = path.basename(String(filename || ''));
    let protectedRollbackName;
    if (protectedName && protectedName === filename) protectedBackupFiles.add(protectedName);
    try {
        await getDb();
        if (dialectName() === 'mysql') return await restoreMysqlDatabaseBackup(filename);
        if (dialectName() !== 'sqlite') throw new Error('文件恢复当前支持 SQLite 和 MySQL 数据库');

        if (backupPromise) await backupPromise;
        const source = resolveDatabaseBackupPath(filename);
        const verification = verifySqliteFile(source, { requireApplicationSchema: true });
        if (!verification.valid) throw new Error(`备份完整性检查失败: ${verification.error}`);

        const target = path.resolve(activeConfig.filename || DEFAULT_CONFIG.filename);
        ensureDirectory(RECOVERY_DIR);
        const restoreSource = path.join(RECOVERY_DIR, `restore-source-${timestampToken()}-${process.pid}.db`);
        fs.rmSync(restoreSource, { force: true });

        try {
            // Keep the selected source outside the rotating backup directory. With a
            // retention of 1, creating the rollback backup below would otherwise
            // prune the very file we are about to restore.
            fs.copyFileSync(source, restoreSource);
            const copiedVerification = verifySqliteFile(restoreSource);
            if (!copiedVerification.valid) throw new Error(`恢复源复制后校验失败: ${copiedVerification.error}`);

            const rollback = await createDatabaseBackup('before-restore');
            protectedRollbackName = rollback.filename;
            protectedBackupFiles.add(protectedRollbackName);
            await closeDb();

            try {
                quarantineSqliteFiles(target, 'before-restore');
                installSqliteCopy(restoreSource, target);
                await getDb();
                lastRecovery = {
                    reason: 'manual_restore',
                    sourceType: 'backup',
                    source: path.basename(source),
                    recoveredAt: new Date().toISOString()
                };
                return { success: true, recovery: lastRecovery, rollback };
            } catch (error) {
                await closeDb();
                installSqliteCopy(path.join(BACKUP_DIR, rollback.filename), target);
                await getDb();
                throw error;
            }
        } finally {
            fs.rmSync(restoreSource, { force: true });
        }
    } finally {
        if (protectedName) protectedBackupFiles.delete(protectedName);
        if (protectedRollbackName) protectedBackupFiles.delete(protectedRollbackName);
        databaseRestoreActive = false;
    }
}

function getDatabaseBackupStatus() {
    const config = activeConfig || loadDatabaseConfig();
    const type = dialectName(config);
    const mysqlTools = type === 'mysql' ? resolveMysqlTools() : null;
    const supported = type === 'sqlite' || (type === 'mysql' && mysqlTools.available);
    const retentionDays = databaseBackupRetentionDays(config);
    const backups = supported ? listDatabaseBackups({ validate: true }) : [];
    const totalBackupBytes = backups.reduce((sum, backup) => sum + Number(backup.size || 0), 0);
    const cutoffMs = Date.now() - retentionDays * DAY_MS;
    const protectedNames = protectedDatabaseBackupNames(backups);
    const expiredCount = backups.filter(backup => {
        const createdAt = Date.parse(backup.createdAt);
        return Number.isFinite(createdAt) && createdAt < cutoffMs && !protectedNames.has(backup.filename);
    }).length;
    return {
        type,
        supported,
        automatic: supported,
        intervalMs: BACKUP_INTERVAL_MS,
        retention: BACKUP_RETENTION,
        retentionDays,
        retentionDaysMin: BACKUP_RETENTION_DAYS_MIN,
        retentionDaysMax: BACKUP_RETENTION_DAYS_MAX,
        cleanupIntervalMs: BACKUP_PRUNE_INTERVAL_MS,
        maxTotalBytes: BACKUP_MAX_TOTAL_BYTES,
        totalBackupBytes,
        expiredCount,
        newestBackup: backups[0] || null,
        oldestBackup: backups[backups.length - 1] || null,
        directory: BACKUP_DIR,
        lastBackup,
        lastBackupError,
        lastCleanup: lastBackupCleanup,
        lastRecovery,
        toolAvailable: type !== 'mysql' || mysqlTools.available,
        toolError: type === 'mysql' ? mysqlTools.error : null,
        backups
    };
}

function databaseConnectionTimeout(config) {
    return boundedInteger(config.connectTimeoutMs ?? process.env.DB_CONNECT_TIMEOUT_MS, 8000, 1000, 30000);
}

function databaseQueryTimeout(config) {
    return boundedInteger(config.queryTimeoutMs ?? process.env.DB_QUERY_TIMEOUT_MS, 10000, 1000, 60000);
}

async function startDatabaseMaintenance() {
    await getDb();
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = null;
    if (dialectName() === 'sqlite' || dialectName() === 'mysql') {
        pruneDatabaseBackups({ reason: 'startup' });
        backupTimer = setInterval(() => {
            try {
                pruneDatabaseBackups({ reason: 'scheduled' });
            } catch (error) {
                console.error('[DB] 定时清理过期备份失败:', error.message);
            }
        }, BACKUP_PRUNE_INTERVAL_MS);
        backupTimer.unref?.();
    }
    // 自动备份的连接选择、周期和外部只读库统一由 dataSources 服务调度。
    // 这里仍保留手工备份、恢复、退出前一致性备份，以及过期文件清理能力。
    return getDatabaseBackupStatus();
}

async function stopDatabaseMaintenance(options = {}) {
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
    }
    if (options.backup !== false && sqliteDb && dialectName() === 'sqlite') {
        try {
            await createDatabaseBackup(options.reason || 'shutdown');
        } catch (error) {
            console.error('[DB] 退出备份失败:', error.message);
        }
    } else if (options.backup !== false && pool && dialectName() === 'mysql') {
        try {
            await createDatabaseBackup(options.reason || 'shutdown');
        } catch (error) {
            console.error('[DB] 退出备份失败:', error.message);
        }
    }
    if (backupPromise) await backupPromise;
}

async function testDatabaseConfig(input) {
    const config = normalizeConfig({
        ...loadDatabaseConfig(),
        ...input,
        password: input.password === '******' ? loadDatabaseConfig().password : (input.password ?? loadDatabaseConfig().password)
    });
    await createDatabaseIfNeeded(config);
    const dialect = dialectName(config);

    if (dialect === 'mysql') {
        const mysql = getMysql();
        const connection = await mysql.createConnection({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            connectTimeout: databaseConnectionTimeout(config)
        });
        let failed = false;
        try {
            await connection.query({ sql: 'SELECT 1', timeout: databaseQueryTimeout(config) });
        } catch (error) {
            failed = true;
            connection.destroy();
            throw error;
        } finally {
            if (!failed) await connection.end();
        }
        return true;
    }
    if (dialect === 'postgres') {
        const PgPool = getPgPool();
        const testPool = new PgPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            connectionTimeoutMillis: databaseConnectionTimeout(config),
            query_timeout: databaseQueryTimeout(config),
            statement_timeout: databaseQueryTimeout(config)
        });
        try {
            await testPool.query('SELECT 1');
        } finally {
            await testPool.end();
        }
        return true;
    }
    if (dialect === 'sqlserver') {
        const sqlserver = getSqlServer();
        const connection = new sqlserver.ConnectionPool(sqlServerConnectionConfig(config));
        try {
            await connection.connect();
            await connection.request().query('SELECT 1 AS ok');
        } finally {
            await connection.close();
        }
        return true;
    }
    if (dialect === 'sqlite') {
        const Database = getSqliteDatabase();
        ensureDataDir();
        const db = new Database(config.filename || DEFAULT_CONFIG.filename);
        try {
            db.prepare('SELECT 1').get();
            sqliteQuickCheck(db);
        } finally {
            db.close();
        }
        return true;
    }
    throw new Error(`不支持的数据库类型: ${config.type}`);
}

function makeDbClient() {
    return {
        all: executeAll,
        get: executeGet,
        run: executeRun,
        transaction,
        insertIgnore: (table, data, key) => insertIgnoreWithClient(makeDbClient(), table, data, key),
        upsert: (table, data, key) => upsertWithClient(makeDbClient(), table, data, key),
        q: quoteIdentifier
    };
}

// better-sqlite3 has one connection. Awaiting inside BEGIN must not let a
// different HTTP request accidentally read/write inside that transaction.
function enqueueSqliteOperation(operation) {
    const result = sqliteOperationQueue.then(operation);
    sqliteOperationQueue = result.catch(() => {});
    return result;
}

function withSqliteConnection(operation) {
    const context = sqliteTransactionContext.getStore();
    if (context) {
        if (!context.active || context.connection !== sqliteDb) {
            return Promise.reject(new Error('SQLite 事务已经结束，不能继续执行操作'));
        }
        return Promise.resolve().then(() => operation(context.connection));
    }
    return enqueueSqliteOperation(() => {
        if (!sqliteDb) throw new Error('SQLite 数据库连接已关闭');
        return operation(sqliteDb);
    });
}

function makeSqliteTransactionClient(context) {
    const invoke = (operation, ...args) => sqliteTransactionContext.run(context, () => operation(...args));
    const client = {
        all: (...args) => invoke(executeAll, ...args),
        get: (...args) => invoke(executeGet, ...args),
        run: (...args) => invoke(executeRun, ...args),
        transaction: (...args) => invoke(transaction, ...args),
        q: quoteIdentifier
    };
    client.insertIgnore = (table, data, key) => insertIgnoreWithClient(client, table, data, key);
    client.upsert = (table, data, key) => upsertWithClient(client, table, data, key);
    return client;
}

async function executeAll(sql, params = []) {
    const dialect = dialectName();
    const normalized = normalizeSql(sql, params);
    if (dialect === 'mysql') {
        const [rows] = await pool.execute(normalized.text, normalized.params);
        return rows;
    }
    if (dialect === 'postgres') {
        const result = await pool.query(normalized.text, normalized.params);
        return result.rows;
    }
    if (dialect === 'sqlserver') {
        const request = pool.request();
        normalized.params.forEach((value, index) => request.input(`p${index + 1}`, value));
        const result = await request.query(normalized.text);
        return result.recordset || [];
    }
    return withSqliteConnection(connection => connection.prepare(normalized.text).all(normalized.params));
}

async function executeGet(sql, params = []) {
    const rows = await executeAll(sql, params);
    return rows[0] || null;
}

async function executeRun(sql, params = []) {
    const dialect = dialectName();
    const normalized = normalizeSql(sql, params);
    if (dialect === 'mysql') {
        const [result] = await pool.execute(normalized.text, normalized.params);
        return normalizeRunResult(result);
    }
    if (dialect === 'postgres') {
        const result = await pool.query(normalized.text, normalized.params);
        return { lastInsertRowid: null, insertId: null, changes: result.rowCount, affectedRows: result.rowCount };
    }
    if (dialect === 'sqlserver') {
        const request = pool.request();
        normalized.params.forEach((value, index) => request.input(`p${index + 1}`, value));
        const result = await request.query(normalized.text);
        const rowsAffected = result.rowsAffected?.[0] || 0;
        return { lastInsertRowid: null, insertId: null, changes: rowsAffected, affectedRows: rowsAffected };
    }
    return withSqliteConnection(connection => {
        const result = connection.prepare(normalized.text).run(normalized.params);
        return { lastInsertRowid: result.lastInsertRowid, insertId: result.lastInsertRowid, changes: result.changes, affectedRows: result.changes };
    });
}

function normalizeRunResult(result) {
    return {
        lastInsertRowid: result.insertId,
        insertId: result.insertId,
        changes: result.affectedRows,
        affectedRows: result.affectedRows
    };
}

async function transaction(callback) {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const tx = makeConnectionClient(connection);
            const result = await callback(tx);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
    if (dialect === 'postgres') {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const tx = makeConnectionClient(client);
            const result = await callback(tx);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    if (dialect === 'sqlite') {
        if (sqliteTransactionContext.getStore()) {
            throw new Error('不支持嵌套 SQLite 事务，请复用当前事务客户端');
        }
        return withSqliteConnection(async connection => {
            connection.prepare('BEGIN IMMEDIATE').run();
            const context = { connection, active: true };
            try {
                const result = await sqliteTransactionContext.run(context, () => callback(makeSqliteTransactionClient(context)));
                connection.prepare('COMMIT').run();
                return result;
            } catch (error) {
                try { if (connection.inTransaction) connection.prepare('ROLLBACK').run(); } catch (rollbackError) {
                    console.error('[DB] SQLite 事务回滚失败:', rollbackError.message);
                }
                throw error;
            } finally {
                context.active = false;
            }
        });
    }
    const sqlserver = getSqlServer();
    const tx = new sqlserver.Transaction(pool);
    await tx.begin();
    try {
        const result = await callback(makeSqlServerTransactionClient(tx));
        await tx.commit();
        return result;
    } catch (error) {
        await tx.rollback();
        throw error;
    }
}

function makeConnectionClient(connection) {
    const client = {
        async all(sql, params = []) {
            const dialect = dialectName();
            const normalized = normalizeSql(sql, params);
            if (dialect === 'mysql') {
                const [rows] = await connection.execute(normalized.text, normalized.params);
                return rows;
            }
            const result = await connection.query(normalized.text, normalized.params);
            return result.rows;
        },
        async get(sql, params = []) {
            const rows = await this.all(sql, params);
            return rows[0] || null;
        },
        async run(sql, params = []) {
            const dialect = dialectName();
            const normalized = normalizeSql(sql, params);
            if (dialect === 'mysql') {
                const [result] = await connection.execute(normalized.text, normalized.params);
                return normalizeRunResult(result);
            }
            const result = await connection.query(normalized.text, normalized.params);
            return { lastInsertRowid: null, insertId: null, changes: result.rowCount, affectedRows: result.rowCount };
        },
        q: quoteIdentifier
    };
    client.insertIgnore = (table, data, key) => insertIgnoreWithClient(client, table, data, key);
    client.upsert = (table, data, key) => upsertWithClient(client, table, data, key);
    return client;
}

function makeSqlServerTransactionClient(tx) {
    const client = {
        all: (sql, params = []) => executeSqlServerInTransaction(tx, sql, params, true),
        get: async (sql, params = []) => (await executeSqlServerInTransaction(tx, sql, params, true))[0] || null,
        run: (sql, params = []) => executeSqlServerInTransaction(tx, sql, params, false),
        q: quoteIdentifier
    };
    client.insertIgnore = (table, data, key) => insertIgnoreWithClient(client, table, data, key);
    client.upsert = (table, data, key) => upsertWithClient(client, table, data, key);
    return client;
}

async function executeSqlServerInTransaction(tx, sql, params, returnRows) {
    const normalized = normalizeSql(sql, params);
    const sqlserver = getSqlServer();
    const request = new sqlserver.Request(tx);
    normalized.params.forEach((value, index) => request.input(`p${index + 1}`, value));
    const result = await request.query(normalized.text);
    if (returnRows) return result.recordset || [];
    const rowsAffected = result.rowsAffected?.[0] || 0;
    return { lastInsertRowid: null, insertId: null, changes: rowsAffected, affectedRows: rowsAffected };
}

async function insertIgnore(table, data, key) {
    return insertIgnoreWithClient(makeDbClient(), table, data, key);
}

async function insertIgnoreWithClient(client, table, data, key) {
    return conflictSafeInsert(client, table, data, key, false);
}

async function upsert(table, data, key) {
    return upsertWithClient(makeDbClient(), table, data, key);
}

async function upsertWithClient(client, table, data, key) {
    return conflictSafeInsert(client, table, data, key, true);
}

async function conflictSafeInsert(client, table, data, key, updateExisting) {
    const columns = Object.keys(data);
    const values = columns.map(column => data[column]);
    const updates = updateExisting ? columns.filter(column => column !== key) : [];
    const quotedColumns = columns.map(column => quoteIdentifier(column));
    const keyColumn = quoteIdentifier(key);
    const targetTable = tableName(table);
    const dialect = dialectName();
    if (dialect === 'mysql') {
        // MySQL's ON DUPLICATE KEY matches every UNIQUE index, not only our
        // requested key. Never update a different row on an unrelated unique
        // collision; retry only the intended key when another writer wins.
        const update = () => updates.length
            ? client.run(`UPDATE ${targetTable} SET ${updates.map(column => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE ${keyColumn} = ?`, [...updates.map(column => data[column]), data[key]])
            : { changes: 0, affectedRows: 0 };
        const existing = await client.get(`SELECT ${keyColumn} FROM ${targetTable} WHERE ${keyColumn} = ?`, [data[key]]);
        if (existing) return update();
        try {
            return await insertRowWithClient(client, table, data);
        } catch (error) {
            if (error.code !== 'ER_DUP_ENTRY' && Number(error.errno) !== 1062) throw error;
            const concurrent = await client.get(`SELECT ${keyColumn} FROM ${targetTable} WHERE ${keyColumn} = ?`, [data[key]]);
            if (!concurrent) throw error;
            return update();
        }
    }
    if (dialect === 'sqlserver') {
        const source = columns.map(column => `? AS ${quoteIdentifier(column)}`).join(', ');
        const matched = updates.length
            ? `WHEN MATCHED THEN UPDATE SET ${updates.map(column => `target.${quoteIdentifier(column)} = source.${quoteIdentifier(column)}`).join(', ')} `
            : '';
        return client.run(`MERGE ${targetTable} WITH (HOLDLOCK) AS target
            USING (SELECT ${source}) AS source ON target.${keyColumn} = source.${keyColumn}
            ${matched}WHEN NOT MATCHED THEN INSERT (${quotedColumns.join(', ')})
            VALUES (${quotedColumns.map(column => `source.${column}`).join(', ')});`, values);
    }
    let sql = `INSERT INTO ${targetTable} (${quotedColumns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    sql += ` ON CONFLICT (${keyColumn}) DO ${updates.length
        ? `UPDATE SET ${updates.map(column => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(', ')}`
        : 'NOTHING'}`;
    return client.run(sql, values);
}

async function insertRow(table, data) {
    return insertRowWithClient(makeDbClient(), table, data);
}

async function insertRowWithClient(client, table, data) {
    const columns = Object.keys(data);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${tableName(table)} (${columns.map(column => quoteIdentifier(column)).join(', ')}) VALUES (${placeholders})`;
    return client.run(sql, columns.map(column => data[column]));
}

function schemaTypes() {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        return {
            text: 'TEXT',
            string: n => `VARCHAR(${n})`,
            int: 'INT',
            bool: 'TINYINT',
            double: 'DOUBLE',
            datetime: 'DATETIME',
            json: 'JSON',
            autoId: 'INT AUTO_INCREMENT PRIMARY KEY',
            options: 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        };
    }
    if (dialect === 'postgres') {
        return {
            text: 'TEXT',
            string: n => `VARCHAR(${n})`,
            int: 'INTEGER',
            bool: 'SMALLINT',
            double: 'DOUBLE PRECISION',
            datetime: 'TIMESTAMP',
            json: 'JSONB',
            autoId: 'SERIAL PRIMARY KEY',
            options: ''
        };
    }
    if (dialect === 'sqlserver') {
        return {
            text: 'NVARCHAR(MAX)',
            string: n => `NVARCHAR(${n})`,
            int: 'INT',
            bool: 'TINYINT',
            double: 'FLOAT',
            datetime: 'DATETIME',
            json: 'NVARCHAR(MAX)',
            autoId: 'INT IDENTITY(1,1) PRIMARY KEY',
            options: ''
        };
    }
    return {
        text: 'TEXT',
        string: n => `TEXT`,
        int: 'INTEGER',
        bool: 'INTEGER',
        double: 'REAL',
        datetime: 'DATETIME',
        json: 'TEXT',
        autoId: 'INTEGER PRIMARY KEY AUTOINCREMENT',
        options: ''
    };
}

async function createTable(name, bodySql) {
    const dialect = dialectName();
    const suffix = schemaTypes().options;
    if (dialect === 'sqlserver') {
        await rawQuery(`IF OBJECT_ID(N'${name}', N'U') IS NULL BEGIN CREATE TABLE ${tableName(name)} (${bodySql}) END`);
        return;
    }
    await rawQuery(`CREATE TABLE IF NOT EXISTS ${tableName(name)} (${bodySql}) ${suffix}`);
}

async function columnExists(table, column) {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
            [activeConfig.database, table, column]
        );
        return rows[0].cnt > 0;
    }
    if (dialect === 'postgres') {
        const result = await pool.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
            [table, column]
        );
        return result.rowCount > 0;
    }
    if (dialect === 'sqlserver') {
        const result = await pool.request().query(
            `SELECT 1 FROM sys.columns
             WHERE object_id = OBJECT_ID(N'${table}') AND name = N'${column}'`
        );
        return result.recordset.length > 0;
    }
    const rows = sqliteDb.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
    return rows.some(row => row.name === column);
}

async function ensureColumn(table, column, definitionSql) {
    if (await columnExists(table, column)) return;
    await rawQuery(`ALTER TABLE ${tableName(table)} ADD ${quoteIdentifier(column)} ${definitionSql}`);
}

async function ensureSchemaColumns() {
    const t = schemaTypes();

    await ensureColumn('workshops', 'layout_json', `${t.json}`);
    await ensureColumn('lines', 'layout_json', `${t.json}`);

    await ensureColumn('devices', 'coordinate_space', `${t.string(32)} DEFAULT 'legacy_world'`);
    await ensureColumn('devices', 'plc_enabled', `${t.bool} DEFAULT 0`);
    await ensureColumn('devices', 'plc_protocol', `${t.string(32)} DEFAULT 'S7'`);
    await ensureColumn('devices', 'plc_ip', `${t.string(128)} DEFAULT ''`);
    await ensureColumn('devices', 'plc_port', `${t.int} DEFAULT 102`);
    await ensureColumn('devices', 'plc_options', `${t.json}`);
    await ensureColumn('devices', 'plc_rack', `${t.int} DEFAULT 0`);
    await ensureColumn('devices', 'plc_slot', `${t.int} DEFAULT 1`);
    await ensureColumn('devices', 'plc_timeout', `${t.int} DEFAULT 5000`);
    await ensureColumn('devices', 'plc_retry_interval', `${t.int} DEFAULT 10000`);
    await ensureColumn('devices', 'plc_max_retries', `${t.int} DEFAULT 0`);

    await ensureColumn('data_points', 'sample_interval_ms', `${t.int} DEFAULT 1000`);
    await ensureColumn('data_points', 'access_type', `${t.string(32)} DEFAULT 'READ'`);
    await ensureColumn('data_points', 'db_number', `${t.int} NULL`);
    await ensureColumn('data_points', 'db_byte_offset', `${t.int} NULL`);
    await ensureColumn('data_points', 'bit_offset', `${t.int} NULL`);
    await ensureColumn('data_points', 'point_kind', `${t.string(32)} DEFAULT 'normal'`);
    await ensureColumn('data_points', 'alarm_record_role', `${t.string(64)} DEFAULT ''`);
    await ensureColumn('data_points', 'alarm_text', `${t.text}`);
    await ensureColumn('data_points', 'alarm_level', `${t.string(32)} DEFAULT 'WARNING'`);
    await ensureColumn('data_points', 'alarm_condition', `${t.string(64)} DEFAULT '=1'`);
    await ensureColumn('data_points', 'voice_config', `${t.text}`);

    await ensureColumn('scenes', 'draft_json', `${t.json}`);
    await ensureColumn('scenes', 'draft_revision', `${t.int} DEFAULT 0`);
    await ensureColumn('scenes', 'published_release_id', `${t.string(128)} NULL`);

    await ensureColumn('releases', 'scene_id', `${t.string(128)} NULL`);
    await ensureColumn('releases', 'notes', `${t.text}`);
    await ensureColumn('releases', 'schema_version', `${t.int} DEFAULT 1`);
    await ensureColumn('releases', 'draft_revision', `${t.int} DEFAULT 0`);
}

async function rawQuery(sql) {
    const dialect = dialectName();
    if (dialect === 'mysql') return pool.query(sql);
    if (dialect === 'postgres') return pool.query(sql);
    if (dialect === 'sqlserver') return pool.request().query(sql);
    return withSqliteConnection(connection => connection.exec(sql));
}

async function initTables() {
    const t = schemaTypes();
    await createTable('workshops', `
        id ${t.string(64)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        sort_order ${t.int} DEFAULT 0,
        layout_json ${t.json},
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('lines', `
        id ${t.string(64)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        workshop_id ${t.string(64)},
        layout_json ${t.json},
        sort_order ${t.int} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('devices', `
        id ${t.string(64)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        line_id ${t.string(64)},
        model_type ${t.string(128)} DEFAULT 'builtin_furnace',
        model_file ${t.text},
        template_id ${t.string(128)} DEFAULT '',
        instance_config ${t.json},
        pos_x ${t.double} DEFAULT 0,
        pos_y ${t.double} DEFAULT 0,
        pos_z ${t.double} DEFAULT 0,
        rotation_y ${t.double} DEFAULT 0,
        scale ${t.double} DEFAULT 1,
        coordinate_space ${t.string(32)} DEFAULT 'line_local',
        sort_order ${t.int} DEFAULT 0,
        plc_enabled ${t.bool} DEFAULT 0,
        plc_protocol ${t.string(32)} DEFAULT 'S7',
        plc_ip ${t.string(128)} DEFAULT '',
        plc_port ${t.int} DEFAULT 102,
        plc_options ${t.json},
        plc_rack ${t.int} DEFAULT 0,
        plc_slot ${t.int} DEFAULT 1,
        plc_timeout ${t.int} DEFAULT 5000,
        plc_retry_interval ${t.int} DEFAULT 10000,
        plc_max_retries ${t.int} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('data_points', `
        id ${t.autoId},
        device_id ${t.string(64)},
        name ${t.string(128)} NOT NULL,
        label ${t.string(255)} NOT NULL,
        plc_tag ${t.string(255)} NOT NULL,
        data_type ${t.string(32)} DEFAULT 'WORD',
        category ${t.string(64)} DEFAULT '',
        value_role ${t.string(128)} DEFAULT '',
        quality ${t.string(32)} DEFAULT 'good',
        scale ${t.double} DEFAULT 1,
        offset ${t.double} DEFAULT 0,
        expression ${t.text},
        display_format ${t.string(64)} DEFAULT '',
        unit ${t.string(32)} DEFAULT '',
        sample_interval_ms ${t.int} DEFAULT 1000,
        access_type ${t.string(32)} DEFAULT 'READ',
        db_number ${t.int} NULL,
        db_byte_offset ${t.int} NULL,
        bit_offset ${t.int} NULL,
        point_kind ${t.string(32)} DEFAULT 'normal',
        alarm_record_role ${t.string(64)} DEFAULT '',
        alarm_text ${t.text},
        alarm_level ${t.string(32)} DEFAULT 'WARNING',
        alarm_condition ${t.string(64)} DEFAULT '=1',
        voice_config ${t.text},
        alarm_high ${t.double} NULL,
        alarm_low ${t.double} NULL
    `);
    await createTable('models', `
        id ${t.string(128)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        file_path ${t.text} NOT NULL,
        asset_type ${t.string(64)} DEFAULT 'model',
        tags ${t.json},
        thumbnail ${t.text},
        default_scale ${t.double} DEFAULT 1,
        metadata ${t.json},
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('projects', `
        id ${t.string(128)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        description ${t.text},
        is_active ${t.bool} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        updated_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('scenes', `
        id ${t.string(128)} PRIMARY KEY,
        project_id ${t.string(128)},
        name ${t.string(255)} NOT NULL,
        scene_type ${t.string(64)} DEFAULT 'factory_overview',
        layout_json ${t.json},
        camera_json ${t.json},
        theme_json ${t.json},
        is_active ${t.bool} DEFAULT 0,
        sort_order ${t.int} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        updated_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('device_templates', `
        id ${t.string(128)} PRIMARY KEY,
        name ${t.string(255)} NOT NULL,
        model_type ${t.string(128)} DEFAULT 'builtin_furnace',
        default_config ${t.json},
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('datapoint_templates', `
        id ${t.string(128)} PRIMARY KEY,
        device_template_id ${t.string(128)},
        name ${t.string(128)} NOT NULL,
        label ${t.string(255)} NOT NULL,
        category ${t.string(64)} DEFAULT '',
        value_role ${t.string(128)} DEFAULT '',
        data_type ${t.string(32)} DEFAULT 'WORD',
        unit ${t.string(32)} DEFAULT '',
        scale ${t.double} DEFAULT 1,
        offset ${t.double} DEFAULT 0,
        expression ${t.text},
        display_format ${t.string(64)} DEFAULT '',
        sort_order ${t.int} DEFAULT 0
    `);
    await createTable('widgets', `
        id ${t.string(128)} PRIMARY KEY,
        scene_id ${t.string(128)},
        widget_type ${t.string(64)} NOT NULL,
        title ${t.string(255)} DEFAULT '',
        config_json ${t.json},
        binding_json ${t.json},
        x ${t.double} DEFAULT 0,
        y ${t.double} DEFAULT 0,
        w ${t.double} DEFAULT 1,
        h ${t.double} DEFAULT 1,
        sort_order ${t.int} DEFAULT 0,
        visible ${t.bool} DEFAULT 1
    `);
    await createTable('bindings', `
        id ${t.string(128)} PRIMARY KEY,
        widget_id ${t.string(128)},
        source_type ${t.string(64)} DEFAULT 'device',
        source_id ${t.string(128)} DEFAULT '',
        path ${t.string(255)} DEFAULT '',
        transform ${t.text},
        fallback ${t.text}
    `);
    await createTable('releases', `
        id ${t.string(128)} PRIMARY KEY,
        project_id ${t.string(128)},
        version ${t.string(64)} NOT NULL,
        snapshot_json ${t.json},
        is_current ${t.bool} DEFAULT 0,
        created_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP
    `);
    await createTable('event_logs', `
        id ${t.autoId},
        event_type ${t.string(64)} DEFAULT 'alarm',
        level ${t.string(32)} DEFAULT 'info',
        source_id ${t.string(128)} DEFAULT '',
        title ${t.string(255)} NOT NULL,
        message ${t.text},
        value ${t.text},
        quality ${t.string(32)} DEFAULT 'good',
        occurred_at ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        acknowledged ${t.bool} DEFAULT 0
    `);
    await createTable('metric_snapshots', `
        id ${t.autoId},
        snapshot_time ${t.datetime} DEFAULT CURRENT_TIMESTAMP,
        current_output ${t.int} DEFAULT 0,
        daily_target ${t.int} DEFAULT 0,
        overall_oee ${t.double} DEFAULT 0,
        energy_consumption ${t.double} DEFAULT 0,
        running_devices ${t.int} DEFAULT 0,
        alarm_devices ${t.int} DEFAULT 0,
        online_devices ${t.int} DEFAULT 0,
        total_devices ${t.int} DEFAULT 0
    `);
    await createTable('settings', `
        ${quoteIdentifier('key')} ${t.string(128)} PRIMARY KEY,
        value ${t.text} NOT NULL
    `);

    await ensureSchemaColumns();

    await createIndex('idx_lines_workshop', 'lines', `${quoteIdentifier('workshop_id')}, ${quoteIdentifier('sort_order')}`);
    await createIndex('idx_devices_line', 'devices', `${quoteIdentifier('line_id')}, ${quoteIdentifier('sort_order')}`);
    await createIndex('idx_data_points_device', 'data_points', quoteIdentifier('device_id'));
    await createIndex('idx_widgets_scene', 'widgets', `${quoteIdentifier('scene_id')}, ${quoteIdentifier('sort_order')}`);
    await createIndex('idx_releases_project_current', 'releases', `${quoteIdentifier('project_id')}, ${quoteIdentifier('is_current')}`);
    await createIndex('idx_event_logs_time', 'event_logs', `${quoteIdentifier('occurred_at')} DESC, ${quoteIdentifier('id')} DESC`);
    await createIndex('idx_metric_snapshots_time', 'metric_snapshots', `${quoteIdentifier('snapshot_time')} DESC, ${quoteIdentifier('id')} DESC`);
}

async function createIndex(indexName, table, columnsSql) {
    const dialect = dialectName();
    if (dialect === 'mysql') {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?`,
            [activeConfig.database, table, indexName]
        );
        if (rows[0].cnt > 0) return;
    } else if (dialect === 'postgres') {
        const result = await pool.query('SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1', [indexName]);
        if (result.rowCount > 0) return;
    } else if (dialect === 'sqlserver') {
        const result = await pool.request().query(
            `SELECT 1 FROM sys.indexes WHERE name = N'${indexName}' AND object_id = OBJECT_ID(N'${table}')`
        );
        if (result.recordset.length > 0) return;
    } else {
        const row = sqliteDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName);
        if (row) return;
    }
    await rawQuery(`CREATE INDEX ${quoteIdentifier(indexName)} ON ${tableName(table)} (${columnsSql})`);
}

async function seedDefaults() {
    const db = makeDbClient();
    const rows = [
        ['factory_name', '智能热处理数字孪生控制中心'],
        ['data_mode', 'integrated_plc'],
        ['simulation_interval_ms', '2000'],
        ['realtime_stale_ms', '6000'],
        ['native_quality_profile', 'auto'],
        ['native_environment_config', JSON.stringify({
            version: 1,
            preset: 'neutral_factory',
            sceneBrightness: 1.05,
            ambientIntensity: 1.05,
            keyLightIntensity: 1.25,
            fillLightIntensity: 0.58,
            reflectionIntensity: 0.96,
            postExposure: 0.34,
            contrast: 1,
            saturation: 0,
            bloomIntensity: 0.02,
            vignetteIntensity: 0.02,
            fogEnabled: true,
            fogStart: 120,
            fogEnd: 430,
            showGrid: true,
            showBackdrop: false,
            skyColor: '#696969',
            horizonColor: '#464646',
            fogColor: '#565656',
            keyLightColor: '#F2F2F2',
            fillLightColor: '#EAEAEA',
            floorColor: '#5B5B5B',
            gridColor: '#777777',
            wallColor: '#5A5A5A',
            frameColor: '#9A9A9A'
        })],
        ['native_dashboard_config', JSON.stringify({
            version: 1,
            uiScale: 1,
            sideMargin: 24,
            showHeader: true,
            showWorldLabels: true,
            overview: {
                left: { visible: true, width: 326, height: 824, opacity: 1 },
                right: { visible: true, width: 326, height: 824, opacity: 1, maxDevices: 20 }
            },
            detail: {
                left: { visible: true, width: 326, height: 742, opacity: 1, maxPoints: 6 },
                right: { visible: true, width: 326, height: 742, opacity: 1, maxPoints: 24 },
                trends: { visible: true, height: 192, opacity: 1, maxCharts: 3 }
            },
            deviceOverrides: {}
        })]
    ];
    for (const [key, value] of rows) {
        await db.insertIgnore('settings', { key, value }, 'key');
    }

    await seedModelAssets(db);
    await seedFactoryDefaults(db);
    await migrateSpatialHierarchyV2(db);
    await seedPlatformDefaults(db);
    await migrateDefaultFurnacesToNativeModel(db);
}

const NATIVE_FURNACE_MODEL_ID = 'photo_multipurpose_furnace_v6';

async function seedFactoryDefaults(db) {
    const workshopsCount = await db.get('SELECT COUNT(*) AS cnt FROM workshops');
    if (workshopsCount.cnt === 0) {
        await db.insertIgnore('workshops', { id: 'ws_1', name: '默认车间 1', sort_order: 0 }, 'id');
    }

    const linesCount = await db.get('SELECT COUNT(*) AS cnt FROM `lines`');
    if (linesCount.cnt > 0) return;

    const lineNames = ['A 产线', 'B 产线', 'C 产线', 'D 产线'];
    for (let li = 0; li < lineNames.length; li++) {
        const lineId = `line_${String.fromCharCode(97 + li)}`;
        await db.insertIgnore('lines', {
            id: lineId,
            name: lineNames[li],
            workshop_id: 'ws_1',
            layout_json: JSON.stringify({
                version: 2,
                coordinateSpace: 'workshop_local',
                transform: { x: 0, y: 0, z: -li * 16, rotationY: 0 },
                lanes: [{ id: 'lane_1', name: '设备线 1', type: 'device_lane', offsetZ: 0, length: 60, sort_order: 0 }],
                rails: []
            }),
            sort_order: li
        }, 'id');

        for (let di = 0; di < 5; di++) {
            const globalIdx = li * 5 + di;
            await db.insertIgnore('devices', {
                id: `Furnace_${String(globalIdx + 1).padStart(2, '0')}`,
                name: `${globalIdx + 1}# 多用炉`,
                line_id: lineId,
                model_type: NATIVE_FURNACE_MODEL_ID,
                model_file: null,
                template_id: '',
                instance_config: '{}',
                pos_x: (di - 2) * 14,
                pos_y: 0,
                pos_z: 0,
                rotation_y: 0,
                scale: 1,
                coordinate_space: 'line_local',
                sort_order: di
            }, 'id');
        }
    }
}

async function seedModelAssets(db) {
    const deletedSeed = await db.get('SELECT value FROM settings WHERE `key` = ?', ['deleted_seed_model_box_atmosphere_furnace']);
    if (String(deletedSeed?.value || '') === '1') return;

    await db.insertIgnore('models', {
        id: 'box_atmosphere_furnace',
        name: '箱式气氛多用炉低模',
        file_path: '/assets/models/box_atmosphere_furnace.glb',
        asset_type: 'model',
        tags: JSON.stringify(['heat_treatment', 'atmosphere_furnace', 'low_poly']),
        thumbnail: null,
        default_scale: 1,
        metadata: JSON.stringify({
            source: 'generated',
            polygonProfile: 'low_poly',
            intendedUse: 'realtime_dashboard',
            batchable: true
        })
    }, 'id');
}

async function seedPlatformDefaults(db) {
    const projectCount = await db.get('SELECT COUNT(*) AS cnt FROM projects');
    if (projectCount.cnt === 0) {
        await db.insertIgnore('projects', {
            id: 'project_default',
            name: '热处理车间大屏项目',
            description: '默认项目，可在现场编排器中继续扩展。',
            is_active: 1
        }, 'id');
    }

    const sceneCount = await db.get('SELECT COUNT(*) AS cnt FROM scenes');
    if (sceneCount.cnt === 0) {
        await db.insertIgnore('scenes', {
            id: 'scene_factory_overview',
            project_id: 'project_default',
            name: '工厂总览',
            scene_type: 'factory_overview',
            layout_json: JSON.stringify({ grid: { columns: 24, rows: 12 }, panels: ['navigation', 'metrics', 'trend', 'alarms', 'marquee'] }),
            camera_json: JSON.stringify({ mode: 'auto', staleMs: 6000 }),
            theme_json: JSON.stringify({ preset: 'industrial_twin' }),
            is_active: 1,
            sort_order: 0
        }, 'id');
    }

    const templateCount = await db.get('SELECT COUNT(*) AS cnt FROM device_templates');
    if (templateCount.cnt === 0) {
        await db.insertIgnore('device_templates', {
            id: 'tpl_multipurpose_furnace',
            name: '多用炉模板',
            model_type: NATIVE_FURNACE_MODEL_ID,
            default_config: JSON.stringify({ category: 'furnace', realtimeProfile: 'heat_treatment' })
        }, 'id');
    }

    const widgetCount = await db.get('SELECT COUNT(*) AS cnt FROM widgets');
    if (widgetCount.cnt === 0) {
        const widgets = [
            ['widget_navigation', 'navigation', '层级导航', '{}', '{}', 0, 0, 5, 5, 0],
            ['widget_metrics', 'metrics', '生产指标', JSON.stringify({ compact: true }), '{}', 0, 5, 5, 5, 1],
            ['widget_trend', 'trend', '历史趋势', JSON.stringify({ metric: 'avg_temp' }), '{}', 19, 0, 5, 5, 2],
            ['widget_alarms', 'alarm_list', '报警履历', JSON.stringify({ limit: 5 }), '{}', 19, 5, 5, 5, 3],
            ['widget_marquee', 'marquee', '实时日志', JSON.stringify({ speed: 30, limit: 20, eventWindowHours: 24 }), '{}', 3, 11, 18, 1, 4]
        ];
        for (const [id, widget_type, title, config_json, binding_json, x, y, w, h, sort_order] of widgets) {
            await db.insertIgnore('widgets', {
                id,
                scene_id: 'scene_factory_overview',
                widget_type,
                title,
                config_json,
                binding_json,
                x,
                y,
                w,
                h,
                sort_order,
                visible: 1
            }, 'id');
        }
    }

    await mergeWidgetDefaultConfig(db, 'widget_marquee', { speed: 30, limit: 20, eventWindowHours: 24 });

    const platformProject = await db.get('SELECT * FROM projects WHERE id = ?', ['project_default']);
    const platformScene = await db.get('SELECT * FROM scenes WHERE id = ?', ['scene_factory_overview']);
    const platformWidgets = await db.all('SELECT * FROM widgets WHERE scene_id = ? ORDER BY sort_order ASC', ['scene_factory_overview']);
    const platformDocument = buildDocumentFromLegacy({
        project: platformProject,
        scene: platformScene,
        widgets: platformWidgets
    });

    if (!isCanonicalDocument(platformScene?.draft_json)) {
        await db.run('UPDATE scenes SET draft_json = ?, draft_revision = ? WHERE id = ?', [
            JSON.stringify(platformDocument),
            Math.max(1, Number(platformScene?.draft_revision || 0)),
            'scene_factory_overview'
        ]);
    }

    const releaseCount = await db.get('SELECT COUNT(*) AS cnt FROM releases');
    if (releaseCount.cnt === 0) {
        await db.insertIgnore('releases', {
            id: 'release_default_v1',
            project_id: 'project_default',
            scene_id: 'scene_factory_overview',
            version: '1.0.0',
            snapshot_json: JSON.stringify(platformDocument),
            is_current: 1,
            notes: '系统初始化发布版本',
            schema_version: 1,
            draft_revision: Math.max(1, Number(platformScene?.draft_revision || 0))
        }, 'id');
    }

    const currentRelease = await db.get(
        'SELECT * FROM releases WHERE project_id = ? AND is_current = 1 ORDER BY created_at DESC LIMIT 1',
        ['project_default']
    ) || await db.get(
        'SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
        ['project_default']
    );
    if (currentRelease) {
        const releaseDocument = parseDashboardJson(currentRelease.snapshot_json, {});
        if (!isCanonicalDocument(releaseDocument)) {
            await db.run(`UPDATE releases SET scene_id = ?, snapshot_json = ?, schema_version = ?,
                draft_revision = ?, is_current = 1 WHERE id = ?`, [
                'scene_factory_overview',
                JSON.stringify(platformDocument),
                1,
                Math.max(1, Number(platformScene?.draft_revision || 0)),
                currentRelease.id
            ]);
        }
        await db.run('UPDATE scenes SET published_release_id = ? WHERE id = ?', [
            currentRelease.id,
            'scene_factory_overview'
        ]);
    }

    await ensureAllDashboardDocuments(db);
}

async function ensureAllDashboardDocuments(db) {
    const projects = await db.all('SELECT * FROM projects ORDER BY created_at ASC');
    for (const project of projects) {
        const scenes = await db.all('SELECT * FROM scenes WHERE project_id = ? ORDER BY is_active DESC, sort_order ASC', [project.id]);
        for (const scene of scenes) {
            const widgets = await db.all('SELECT * FROM widgets WHERE scene_id = ? ORDER BY sort_order ASC', [scene.id]);
            const legacyDocument = buildDocumentFromLegacy({ project, scene, widgets });
            const storedDraft = parseDashboardJson(scene.draft_json, null);
            if (!isCanonicalDocument(storedDraft)) {
                const revision = Math.max(1, Number(scene.draft_revision || 0));
                legacyDocument.metadata = { ...legacyDocument.metadata, revision };
                await db.run('UPDATE scenes SET draft_json = ?, draft_revision = ? WHERE id = ?', [
                    JSON.stringify(legacyDocument), revision, scene.id
                ]);
                scene.draft_json = JSON.stringify(legacyDocument);
                scene.draft_revision = revision;
            }
        }

        const activeScene = scenes.find(scene => !!scene.is_active) || scenes[0];
        if (!activeScene) continue;
        const activeWidgets = await db.all('SELECT * FROM widgets WHERE scene_id = ? ORDER BY sort_order ASC', [activeScene.id]);
        const activeDocument = isCanonicalDocument(activeScene.draft_json)
            ? parseDashboardJson(activeScene.draft_json, {})
            : buildDocumentFromLegacy({ project, scene: activeScene, widgets: activeWidgets });
        const releases = await db.all('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC', [project.id]);
        let current = releases.find(release => !!release.is_current) || null;
        if (!current) {
            let patch = releases.length;
            let version = `1.0.${patch}`;
            const versions = new Set(releases.map(release => String(release.version)));
            while (versions.has(version)) version = `1.0.${++patch}`;
            const id = `release_seed_${String(project.id).replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            await db.insertIgnore('releases', {
                id,
                project_id: project.id,
                scene_id: activeScene.id,
                version,
                snapshot_json: JSON.stringify(activeDocument),
                is_current: 1,
                notes: '自动迁移的初始发布版本',
                schema_version: 1,
                draft_revision: Number(activeScene.draft_revision || 0)
            }, 'id');
            current = await db.get('SELECT * FROM releases WHERE id = ?', [id]);
        } else if (!isCanonicalDocument(parseDashboardJson(current.snapshot_json, null))) {
            await db.run(`UPDATE releases SET scene_id = ?, snapshot_json = ?, schema_version = ?,
                draft_revision = ? WHERE id = ?`, [
                activeScene.id,
                JSON.stringify(activeDocument),
                1,
                Number(activeScene.draft_revision || 0),
                current.id
            ]);
        }
        if (current) {
            const releaseSceneId = current.scene_id
                || parseDashboardJson(current.snapshot_json, {})?.sceneId
                || activeScene.id;
            await db.run('UPDATE scenes SET published_release_id = ? WHERE id = ?', [current.id, releaseSceneId]);
        }
    }
}

function roundSpatialNumber(value, digits = 6) {
    const factor = 10 ** digits;
    return Math.round(finiteNumber(value, 0) * factor) / factor;
}

function hasSpatialLayout(value) {
    const source = safeObject(value);
    return Number(source.version || 0) >= 2 && source.transform && typeof source.transform === 'object';
}

function addSpatialPoint(bounds, point) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.z))) return bounds;
    const x = Number(point.x);
    const z = Number(point.z);
    if (!bounds) return { minX: x, maxX: x, minZ: z, maxZ: z };
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
    return bounds;
}

function derivedWorkshopLayout(bounds) {
    if (!bounds) return defaultWorkshopLayout();
    const centerX = (bounds.minX + bounds.maxX) * 0.5;
    const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
    const width = Math.max(100, Math.ceil(((bounds.maxX - bounds.minX) + 24) / 10) * 10);
    const depth = Math.max(80, Math.ceil(((bounds.maxZ - bounds.minZ) + 24) / 10) * 10);
    return normalizeWorkshopLayout({
        version: 2,
        transform: { x: centerX, y: 0, z: centerZ, rotationY: 0 },
        size: { width, depth, height: 8 },
        boundary: { enabled: true }
    });
}

async function migrateSpatialHierarchyV2(db) {
    const workshops = await db.all('SELECT * FROM workshops ORDER BY sort_order ASC, id ASC');
    const lines = await db.all('SELECT * FROM `lines` ORDER BY sort_order ASC, id ASC');
    const devices = await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC, id ASC');
    if (!workshops.length) return;

    const firstWorkshopId = workshops[0].id;
    const workshopById = new Map(workshops.map(workshop => [String(workshop.id), workshop]));
    const lineById = new Map(lines.map(line => [String(line.id), line]));
    const initialWorkshopTransforms = new Map();
    const initialLineWorldTransforms = new Map();
    const lineLayoutSources = new Map();

    workshops.forEach((workshop) => {
        initialWorkshopTransforms.set(
            String(workshop.id),
            hasSpatialLayout(workshop.layout_json)
                ? normalizeWorkshopLayout(workshop.layout_json).transform
                : normalizeSpatialTransform({})
        );
    });

    lines.forEach((line, index) => {
        const source = safeObject(line.layout_json);
        lineLayoutSources.set(String(line.id), source);
        const workshopTransform = initialWorkshopTransforms.get(String(line.workshop_id))
            || normalizeSpatialTransform({});
        const lineTransform = hasSpatialLayout(source)
            ? normalizeLineLayout(source).transform
            : { x: 0, y: 0, z: -index * 16, rotationY: 0 };
        initialLineWorldTransforms.set(
            String(line.id),
            composeSpatialTransforms(workshopTransform, lineTransform)
        );
    });

    const boundsByWorkshop = new Map(workshops.map(workshop => [String(workshop.id), null]));
    lines.forEach((line) => {
        const workshopId = String(line.workshop_id || firstWorkshopId);
        const lineWorld = initialLineWorldTransforms.get(String(line.id)) || normalizeSpatialTransform({});
        let bounds = boundsByWorkshop.get(workshopId) || null;
        bounds = addSpatialPoint(bounds, lineWorld);
        const layout = normalizeLineLayout(line.layout_json);
        for (const item of [...layout.lanes, ...layout.rails]) {
            const halfLength = finiteNumber(item.length, 60, 1, 10000) * 0.5;
            bounds = addSpatialPoint(bounds, localToParentPoint({ x: -halfLength, y: 0, z: item.offsetZ }, lineWorld));
            bounds = addSpatialPoint(bounds, localToParentPoint({ x: halfLength, y: 0, z: item.offsetZ }, lineWorld));
        }
        boundsByWorkshop.set(workshopId, bounds);
    });

    devices.forEach((device) => {
        const effectiveLineId = effectiveDeviceLineId(device);
        const line = lineById.get(effectiveLineId);
        const workshopId = String(line?.workshop_id || configuredDeviceWorkshopId(device) || firstWorkshopId);
        const coordinateSpace = String(device.coordinate_space || 'legacy_world');
        const localPoint = { x: device.pos_x, y: device.pos_y, z: device.pos_z };
        let worldPoint = localPoint;
        if (coordinateSpace === 'line_local' && line) {
            worldPoint = localToParentPoint(localPoint, initialLineWorldTransforms.get(effectiveLineId));
        } else if (coordinateSpace === 'workshop_local') {
            worldPoint = localToParentPoint(
                localPoint,
                initialWorkshopTransforms.get(workshopId) || normalizeSpatialTransform({})
            );
        }
        boundsByWorkshop.set(workshopId, addSpatialPoint(boundsByWorkshop.get(workshopId) || null, worldPoint));
    });

    const finalWorkshopLayouts = new Map();
    workshops.forEach((workshop) => {
        const workshopId = String(workshop.id);
        finalWorkshopLayouts.set(
            workshopId,
            hasSpatialLayout(workshop.layout_json)
                ? normalizeWorkshopLayout(workshop.layout_json)
                : derivedWorkshopLayout(boundsByWorkshop.get(workshopId))
        );
    });

    const finalLineLayouts = new Map();
    const finalLineWorldTransforms = new Map();
    lines.forEach((line) => {
        const lineId = String(line.id);
        const workshopLayout = finalWorkshopLayouts.get(String(line.workshop_id)) || defaultWorkshopLayout();
        const source = lineLayoutSources.get(lineId) || {};
        let lineLayout;
        if (hasSpatialLayout(source) && hasSpatialLayout(workshopById.get(String(line.workshop_id))?.layout_json)) {
            lineLayout = normalizeLineLayout(source);
        } else {
            const initialWorld = initialLineWorldTransforms.get(lineId) || normalizeSpatialTransform({});
            const localPosition = parentToLocalPoint(initialWorld, workshopLayout.transform);
            lineLayout = normalizeLineLayout(source, {
                x: localPosition.x,
                y: localPosition.y,
                z: localPosition.z,
                rotationY: normalizeAngleDegrees(initialWorld.rotationY - workshopLayout.transform.rotationY)
            });
        }
        finalLineLayouts.set(lineId, lineLayout);
        finalLineWorldTransforms.set(
            lineId,
            composeSpatialTransforms(workshopLayout.transform, lineLayout.transform)
        );
    });

    const environmentRow = await db.get('SELECT value FROM settings WHERE `key` = ?', ['native_environment_config']);
    const environment = safeObject(environmentRow?.value);
    const normalizedWalls = (Array.isArray(environment.walls) ? environment.walls : []).map((rawWall, index) => {
        const wall = rawWall && typeof rawWall === 'object' ? { ...rawWall } : {};
        const existingWorkshopId = String(wall.workshopId || wall.workshop_id || '').trim();
        let workshopId = workshopById.has(existingWorkshopId) ? existingWorkshopId : '';
        let worldPoint = { x: wall.x, y: wall.baseY, z: wall.z };
        let worldRotation = finiteNumber(wall.rotationY, 0, -100000, 100000);

        if (workshopId && wall.coordinateSpace === 'workshop_local') {
            const layout = finalWorkshopLayouts.get(workshopId) || defaultWorkshopLayout();
            worldPoint = localToParentPoint(worldPoint, layout.transform);
            worldRotation += layout.transform.rotationY;
        }

        if (!workshopId) {
            const candidates = workshops.map((workshop) => {
                const layout = finalWorkshopLayouts.get(String(workshop.id)) || defaultWorkshopLayout();
                const local = parentToLocalPoint(worldPoint, layout.transform);
                const inside = Math.abs(local.x) <= layout.size.width * 0.5
                    && Math.abs(local.z) <= layout.size.depth * 0.5;
                return {
                    id: String(workshop.id),
                    layout,
                    local,
                    inside,
                    score: inside
                        ? layout.size.width * layout.size.depth
                        : Math.hypot(local.x, local.z) + 1000000
                };
            }).sort((a, b) => a.score - b.score);
            workshopId = candidates[0]?.id || firstWorkshopId;
        }

        const workshopLayout = finalWorkshopLayouts.get(workshopId) || defaultWorkshopLayout();
        const localPoint = parentToLocalPoint(worldPoint, workshopLayout.transform);
        return {
            ...wall,
            id: String(wall.id || `wall_${index + 1}`),
            workshopId,
            coordinateSpace: 'workshop_local',
            x: roundSpatialNumber(localPoint.x),
            baseY: roundSpatialNumber(localPoint.y),
            z: roundSpatialNumber(localPoint.z),
            rotationY: normalizeAngleDegrees(worldRotation - workshopLayout.transform.rotationY)
        };
    });

    await db.transaction(async (tx) => {
        for (const workshop of workshops) {
            const layout = finalWorkshopLayouts.get(String(workshop.id)) || defaultWorkshopLayout();
            await tx.run('UPDATE workshops SET layout_json = ? WHERE id = ?', [JSON.stringify(layout), workshop.id]);
        }
        for (const line of lines) {
            const layout = finalLineLayouts.get(String(line.id)) || normalizeLineLayout(line.layout_json);
            await tx.run('UPDATE `lines` SET layout_json = ? WHERE id = ?', [JSON.stringify(layout), line.id]);
        }
        for (const device of devices) {
            const inferredLineId = effectiveDeviceLineId(device);
            const line = lineById.get(inferredLineId);
            const workshopId = String(line?.workshop_id || configuredDeviceWorkshopId(device) || firstWorkshopId);
            const initialWorkshopTransform = initialWorkshopTransforms.get(workshopId) || normalizeSpatialTransform({});
            const finalWorkshopLayout = finalWorkshopLayouts.get(workshopId) || defaultWorkshopLayout();
            const currentCoordinateSpace = String(device.coordinate_space || 'legacy_world');
            const currentPoint = { x: device.pos_x, y: device.pos_y, z: device.pos_z };
            let worldPoint = currentPoint;
            let worldYaw = deviceYawToDegrees(device.rotation_y);

            if (currentCoordinateSpace === 'line_local' && line) {
                const parent = initialLineWorldTransforms.get(inferredLineId) || normalizeSpatialTransform({});
                worldPoint = localToParentPoint(currentPoint, parent);
                worldYaw += parent.rotationY;
            } else if (currentCoordinateSpace === 'workshop_local') {
                worldPoint = localToParentPoint(currentPoint, initialWorkshopTransform);
                worldYaw += initialWorkshopTransform.rotationY;
            }

            const parentTransform = line
                ? (finalLineWorldTransforms.get(inferredLineId) || finalWorkshopLayout.transform)
                : finalWorkshopLayout.transform;
            const localPoint = parentToLocalPoint(worldPoint, parentTransform);
            const coordinateSpace = line ? 'line_local' : 'workshop_local';
            const instanceConfig = safeObject(device.instance_config);
            if (!line && !configuredDeviceWorkshopId(device)) instanceConfig.workshop_id = workshopId;

            await tx.run(`UPDATE devices SET line_id = ?, pos_x = ?, pos_y = ?, pos_z = ?,
                rotation_y = ?, coordinate_space = ?, instance_config = ? WHERE id = ?`, [
                line ? inferredLineId : (device.line_id || null),
                roundSpatialNumber(localPoint.x),
                roundSpatialNumber(localPoint.y),
                roundSpatialNumber(localPoint.z),
                roundSpatialNumber(deviceYawFromDegrees(worldYaw - parentTransform.rotationY, device.rotation_y)),
                coordinateSpace,
                JSON.stringify(instanceConfig),
                device.id
            ]);
        }
        await tx.run('UPDATE settings SET value = ? WHERE `key` = ?', [
            JSON.stringify({ ...environment, version: 3, walls: normalizedWalls }),
            'native_environment_config'
        ]);
    });
}

async function migrateDefaultFurnacesToNativeModel(db) {
    const migrationKey = 'native_model_default_furnace_migrated';
    const migrated = await db.get('SELECT value FROM settings WHERE `key` = ?', [migrationKey]);
    if (String(migrated?.value || '') === '1') return;

    // Only replace the untouched factory seed devices. Uploaded models, renamed IDs and
    // devices with instance-specific configuration remain exactly as the engineer set them.
    await db.run(`UPDATE devices SET model_type = ?
        WHERE model_type IN ('box_atmosphere_furnace', 'builtin_furnace', 'photo_multipurpose_furnace_v5')
        AND id LIKE 'Furnace_%'
        AND (model_file IS NULL OR model_file = '')
        AND (instance_config IS NULL OR instance_config = '' OR instance_config = '{}')`, [NATIVE_FURNACE_MODEL_ID]);
    await db.run(`UPDATE device_templates SET model_type = ?
        WHERE id = 'tpl_multipurpose_furnace'
        AND model_type IN ('box_atmosphere_furnace', 'builtin_furnace', 'photo_multipurpose_furnace_v5')`, [NATIVE_FURNACE_MODEL_ID]);
    await db.upsert('settings', { key: migrationKey, value: '1' }, 'key');
}

async function mergeWidgetDefaultConfig(db, widgetId, defaults) {
    const widget = await db.get('SELECT config_json FROM widgets WHERE id = ?', [widgetId]);
    if (!widget) return;

    const current = parseJsonObject(widget.config_json, {});
    const merged = { ...defaults, ...current };
    const changed = Object.keys(defaults).some(key => current[key] === undefined);
    if (!changed) return;

    await db.run('UPDATE widgets SET config_json = ? WHERE id = ?', [JSON.stringify(merged), widgetId]);
}

module.exports = {
    getDb,
    closeDb,
    reconnectDb,
    getDbStatus,
    createDatabaseBackup,
    importDatabaseBackupFile,
    restoreDatabaseBackup,
    deleteDatabaseBackup,
    getDatabaseBackupStatus,
    saveDatabaseBackupPolicy,
    resolveDatabaseBackupPath,
    startDatabaseMaintenance,
    stopDatabaseMaintenance,
    verifySqliteFile,
    verifyDatabaseBackupFile: async (filename) => dialectName() === 'mysql'
        ? verifyMysqlDumpFile(filename)
        : verifySqliteFile(filename),
    loadDatabaseConfig,
    saveDatabaseConfig,
    publicDatabaseConfig,
    testDatabaseConfig
};
