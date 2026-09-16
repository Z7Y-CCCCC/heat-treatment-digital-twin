const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { validateHeaderName, validateHeaderValue } = require('http');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
    createDatabaseBackup,
    loadDatabaseConfig
} = require('../db/database');
const { createMysqlDump, resolveMysqlTools } = require('./mysqlBackup');
const { evaluateVariableExpression } = require('../utils/mathExpression');

const DATA_DIR = process.env.APP_DATA_DIR
    ? path.resolve(process.env.APP_DATA_DIR)
    : path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'data-sources.json');
const BACKUP_ROOT = path.resolve(process.env.DATA_SOURCE_BACKUP_DIR || path.join(DATA_DIR, 'data-source-backups'));
const PRIMARY_ID = 'primary';
const MASKED_PASSWORD = '******';
const DEFAULT_BACKUP_CONFIG = Object.freeze({
    autoEnabled: true,
    startupEnabled: true,
    scheduledEnabled: true,
    shutdownEnabled: true,
    intervalHours: 6,
    retention: 10,
    selectedConnectionIds: [PRIMARY_ID]
});
const SUPPORTED_TYPES = new Set(['mysql', 'postgres', 'sqlserver', 'sqlite']);
const SUPPORTED_SOURCE_TYPES = new Set(['database', 'http_api']);
const SUPPORTED_HTTP_AUTH_TYPES = new Set(['none', 'api_key', 'bearer', 'basic']);
const HEALTH_STATUSES = new Set(['unknown', 'healthy', 'auth_failed', 'http_error', 'network_error', 'timeout', 'config_error']);
const FORBIDDEN_AUTH_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'trailer', 'te', 'keep-alive', 'expect']);
const HEALTH_TOKEN_TTL_MS = 15 * 60 * 1000;
const healthTokens = new Map();
const latestHealthChecks = new Map();
let lastHealthCheckTime = 0;
const VALUE_MODES = new Set(['latest', 'first', 'list', 'count', 'sum', 'avg', 'min', 'max']);

let mysqlDriver;
let pgDriver;
let sqlServerDriver;
let sqliteDriver;
let maintenanceTimer = null;
let startupBackupHandle = null;
let maintenanceStarted = false;
let backupPromise = null;
const activeConnectionBackups = new Map();
let lastBackupRun = null;
let lastBackupError = null;
const runtimeCache = new Map();

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

function getMysql() {
    if (!mysqlDriver) mysqlDriver = require('mysql2/promise');
    return mysqlDriver;
}

function getPgClient() {
    if (!pgDriver) pgDriver = require('pg').Client;
    return pgDriver;
}

function getSqlServer() {
    if (!sqlServerDriver) sqlServerDriver = require('mssql');
    return sqlServerDriver;
}

function getSqlite() {
    if (!sqliteDriver) sqliteDriver = require('better-sqlite3');
    return sqliteDriver;
}

function shortText(value, fallback = '', max = 255) {
    const text = String(value ?? fallback).trim();
    return (text || fallback).slice(0, max);
}

function safeId(value, fallback = '') {
    return shortText(value, fallback, 80).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function finiteInteger(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeType(value) {
    const type = String(value || 'mysql').toLowerCase();
    if (type === 'mariadb') return 'mysql';
    if (type === 'postgresql') return 'postgres';
    if (type === 'mssql') return 'sqlserver';
    return SUPPORTED_TYPES.has(type) ? type : 'mysql';
}

function normalizeSourceType(value) {
    const type = String(value || '').toLowerCase();
    if (type === 'api' || type === 'http' || type === 'http-api') return 'http_api';
    return SUPPORTED_SOURCE_TYPES.has(type) ? type : 'database';
}

function normalizeHttpAuthType(value) {
    const type = String(value || 'none').trim().toLowerCase();
    return type === 'api-key' ? 'api_key' : type;
}

function normalizeSecret(value, current = '') {
    return value === undefined || value === MASKED_PASSWORD ? String(current || '') : String(value ?? '');
}

function normalizeHealth(health) {
    if (!health || typeof health !== 'object') return null;
    const checkedAt = health.checkedAt ? new Date(health.checkedAt) : null;
    const optionalNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
    const responseTimeMs = optionalNumber(health.responseTimeMs);
    const httpStatus = optionalNumber(health.httpStatus);
    return {
        status: HEALTH_STATUSES.has(health.status) ? health.status : 'unknown',
        message: shortText(health.message, '', 500),
        responseTimeMs: responseTimeMs === null ? null : Math.max(0, Math.round(responseTimeMs)),
        httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
        checkedAt: checkedAt && !Number.isNaN(checkedAt.getTime()) ? checkedAt.toISOString() : null
    };
}

function defaultPort(type) {
    if (type === 'postgres') return 5432;
    if (type === 'sqlserver') return 1433;
    if (type === 'mysql') return 3306;
    return 0;
}

function normalizeConnection(source = {}, current = {}) {
    const currentSourceType = normalizeSourceType(current.sourceType ?? (current.type === 'http_api' ? 'http_api' : 'database'));
    const sourceType = normalizeSourceType(source.sourceType ?? (
        source.type || source.dbType ? (source.type === 'http_api' ? 'http_api' : 'database') : currentSourceType
    ));
    const sameSourceType = sourceType === currentSourceType;
    const previous = sameSourceType ? current : {};
    const type = sourceType === 'http_api'
        ? 'http_api'
        : normalizeType(source.dbType ?? source.type ?? previous.dbType ?? previous.type);
    const id = safeId(source.id ?? current.id, `source_${crypto.randomUUID()}`);
    const common = {
        id,
        name: shortText(source.name ?? current.name, `外部数据源 ${id}`, 100),
        sourceType,
        type,
        enabled: source.enabled ?? current.enabled ?? true ? true : false,
        readOnly: true,
        // Only stored/server-generated health is trusted; POSTed health is not evidence.
        health: normalizeHealth(current.health),
        createdAt: current.createdAt || new Date().toISOString(),
        updatedAt: current.updatedAt || new Date().toISOString(),
        configRevision: current.configRevision || ''
    };
    if (sourceType === 'http_api') {
        const authType = normalizeHttpAuthType(source.authType ?? previous.authType);
        const credentials = authType === normalizeHttpAuthType(previous.authType) ? previous : {};
        return {
            ...common,
            baseUrl: shortText(source.baseUrl ?? previous.baseUrl, '', 2048),
            healthPath: shortText(source.healthPath ?? previous.healthPath, '/health', 1024),
            method: 'GET',
            authType,
            apiKeyHeader: authType === 'api_key' ? shortText(source.apiKeyHeader ?? credentials.apiKeyHeader, 'X-API-Key', 100) : 'X-API-Key',
            apiKey: authType === 'api_key' ? normalizeSecret(source.apiKey, credentials.apiKey) : '',
            token: authType === 'bearer' ? normalizeSecret(source.token, credentials.token) : '',
            user: authType === 'basic' ? shortText(source.user ?? credentials.user, '', 255) : '',
            password: authType === 'basic' ? normalizeSecret(source.password, credentials.password) : '',
            requestTimeoutMs: finiteInteger(source.requestTimeoutMs ?? previous.requestTimeoutMs, 8000, 1000, 60000)
        };
    }
    return {
        ...common,
        host: shortText(source.host ?? previous.host, '127.0.0.1', 255),
        port: type === 'sqlite' ? 0 : finiteInteger(source.port ?? previous.port, defaultPort(type), 1, 65535),
        user: shortText(source.user ?? previous.user, '', 255),
        password: normalizeSecret(source.password, previous.password),
        database: shortText(source.database ?? previous.database, '', 255),
        filename: shortText(source.filename ?? previous.filename, '', 2048),
        defaultSchema: shortText(source.defaultSchema ?? previous.defaultSchema, type === 'postgres' ? 'public' : '', 255),
        encrypt: source.encrypt ?? previous.encrypt ?? false ? true : false,
        trustServerCertificate: source.trustServerCertificate ?? previous.trustServerCertificate ?? true ? true : false,
        queryTimeoutMs: finiteInteger(source.queryTimeoutMs ?? previous.queryTimeoutMs, 8000, 1000, 60000)
    };
}

function normalizeBackupConfig(source = {}) {
    const selected = Array.isArray(source.selectedConnectionIds)
        ? source.selectedConnectionIds.map(item => safeId(item)).filter(Boolean)
        : DEFAULT_BACKUP_CONFIG.selectedConnectionIds;
    const legacyAutoEnabled = source.autoEnabled !== false;
    const startupEnabled = source.startupEnabled === undefined
        ? legacyAutoEnabled
        : source.startupEnabled !== false;
    const scheduledEnabled = source.scheduledEnabled === undefined
        ? legacyAutoEnabled
        : source.scheduledEnabled !== false;
    const shutdownEnabled = source.shutdownEnabled === undefined
        ? DEFAULT_BACKUP_CONFIG.shutdownEnabled
        : source.shutdownEnabled !== false;
    return {
        // 保留 autoEnabled 兼容旧安装包和旧整站备份；新界面使用三个独立触发开关。
        autoEnabled: startupEnabled || scheduledEnabled,
        startupEnabled,
        scheduledEnabled,
        shutdownEnabled,
        intervalHours: finiteInteger(source.intervalHours, DEFAULT_BACKUP_CONFIG.intervalHours, 1, 168),
        retention: finiteInteger(source.retention, DEFAULT_BACKUP_CONFIG.retention, 1, 100),
        selectedConnectionIds: [...new Set(selected)]
    };
}

function defaultConfig() {
    return { version: 1, connections: [], backup: { ...DEFAULT_BACKUP_CONFIG } };
}

function loadStoredConfig() {
    ensureDirectory(DATA_DIR);
    if (!fs.existsSync(CONFIG_PATH)) return defaultConfig();
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const connections = Array.isArray(raw.connections)
            ? raw.connections.map(item => normalizeConnection(item, item)).filter(item => item.id && item.id !== PRIMARY_ID)
            : [];
        const backup = normalizeBackupConfig(raw.backup);
        const databaseIds = new Set([PRIMARY_ID, ...connections.filter(item => !isHttpApiSource(item)).map(item => item.id)]);
        backup.selectedConnectionIds = backup.selectedConnectionIds.filter(id => databaseIds.has(id));
        return { version: 1, connections, backup };
    } catch (error) {
        console.warn('[DataSources] 配置读取失败，使用默认配置:', error.message);
        return defaultConfig();
    }
}

function saveStoredConfig(config) {
    ensureDirectory(DATA_DIR);
    const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, CONFIG_PATH);
}

function publicConnection(connection, extra = {}) {
    const { configRevision, ...visibleConnection } = connection;
    const publicValue = {
        ...visibleConnection,
        ...extra,
        password: connection.password ? MASKED_PASSWORD : '',
        readOnly: extra.primary ? false : true
    };
    if (publicValue.health) {
        publicValue.health = { ...publicValue.health, message: redactCredentials(publicValue.health.message, connection) };
    }
    if (connection.sourceType === 'http_api') {
        publicValue.apiKey = connection.apiKey ? MASKED_PASSWORD : '';
        publicValue.token = connection.token ? MASKED_PASSWORD : '';
        publicValue.baseUrl = publicHttpUrl(connection.baseUrl);
        publicValue.healthPath = publicHttpUrl(connection.healthPath);
    }
    return publicValue;
}

function primaryConnection() {
    const config = loadDatabaseConfig();
    return {
        id: PRIMARY_ID,
        name: '主业务数据库',
        sourceType: 'database',
        type: normalizeType(config.type),
        host: config.host || '',
        port: Number(config.port || defaultPort(normalizeType(config.type))),
        user: config.user || '',
        password: config.password || '',
        database: config.database || '',
        filename: config.filename || '',
        defaultSchema: normalizeType(config.type) === 'postgres' ? 'public' : '',
        encrypt: !!config.encrypt,
        trustServerCertificate: config.trustServerCertificate !== false,
        enabled: true,
        readOnly: false,
        queryTimeoutMs: 8000,
        primary: true
    };
}

function listDataSources() {
    const stored = loadStoredConfig();
    return {
        connections: [publicConnection(primaryConnection(), { primary: true }), ...stored.connections.map(item => publicConnection(item))],
        backup: stored.backup
    };
}

function resolveConnection(id) {
    const normalizedId = safeId(id);
    if (normalizedId === PRIMARY_ID) return primaryConnection();
    const connection = loadStoredConfig().connections.find(item => item.id === normalizedId);
    if (!connection) throw new Error('数据源连接不存在');
    if (!connection.enabled) throw new Error('数据源连接已停用');
    return connection;
}

function isHttpApiSource(connection) {
    return connection?.sourceType === 'http_api' || connection?.type === 'http_api';
}

function connectionFingerprint(connection) {
    const fields = isHttpApiSource(connection)
        ? ['sourceType', 'type', 'enabled', 'baseUrl', 'healthPath', 'method', 'authType', 'apiKeyHeader', 'apiKey', 'token', 'user', 'password', 'requestTimeoutMs']
        : ['sourceType', 'type', 'enabled', 'host', 'port', 'user', 'password', 'database', 'filename', 'defaultSchema', 'encrypt', 'trustServerCertificate', 'queryTimeoutMs'];
    return crypto.createHash('sha256').update(JSON.stringify(fields.map(field => connection[field]))).digest('hex');
}

function redactCredentials(message, connection) {
    let safe = String(message || '');
    const secrets = [connection.apiKey, connection.token, connection.password].filter(Boolean).sort((left, right) => right.length - left.length);
    for (const secret of secrets) safe = safe.split(secret).join(MASKED_PASSWORD);
    return safe.slice(0, 500);
}

function publicHttpUrl(value) {
    let safe = String(value || '');
    try {
        const parsed = new URL(safe);
        if (parsed.username || parsed.password) {
            parsed.username = '';
            parsed.password = '';
            safe = parsed.href;
        }
    } catch { /* A health path is normally relative. */ }
    // Also cover malformed/rejected URLs in a config_error test response.
    safe = safe.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/?#]*@/i, '$1');
    return safe;
}

function issueHealthToken(connection, health) {
    const now = Date.now();
    for (const [token, result] of healthTokens) {
        if (result.expiresAt <= now) healthTokens.delete(token);
    }
    // Keep uncommitted draft tests bounded; tokens disappear safely on restart.
    while (healthTokens.size >= 512) healthTokens.delete(healthTokens.keys().next().value);
    const token = crypto.randomBytes(32).toString('base64url');
    healthTokens.set(token, { fingerprint: connectionFingerprint(connection), health: { ...health }, expiresAt: now + HEALTH_TOKEN_TTL_MS });
    return token;
}

function saveDataSource(input = {}) {
    const stored = loadStoredConfig();
    const requestedId = safeId(input.id, `source_${crypto.randomUUID()}`);
    if (requestedId === PRIMARY_ID) throw new Error('主业务数据库请在上方专用区域修改');
    const index = stored.connections.findIndex(item => item.id === requestedId);
    const current = index >= 0 ? stored.connections[index] : {};
    const next = normalizeConnection({ ...input, id: requestedId }, current);
    if (isHttpApiSource(next)) {
        normalizeHttpUrl(next.baseUrl, next.healthPath);
        httpAuthHeaders(next);
    }
    const fingerprint = connectionFingerprint(next);
    next.health = current.id && connectionFingerprint(current) === fingerprint ? current.health : null;
    const tested = healthTokens.get(input.healthToken);
    if (tested && tested.expiresAt > Date.now() && tested.fingerprint === fingerprint
        && (!next.health || new Date(tested.health.checkedAt) >= new Date(next.health.checkedAt))) {
        next.health = { ...tested.health };
    }
    next.updatedAt = new Date().toISOString();
    next.configRevision = crypto.randomUUID();
    if (index >= 0) stored.connections[index] = next;
    else stored.connections.push(next);
    if (isHttpApiSource(next)) stored.backup.selectedConnectionIds = stored.backup.selectedConnectionIds.filter(id => id !== requestedId);
    saveStoredConfig(stored);
    runtimeCache.clear();
    return publicConnection(next);
}

function deleteDataSource(id) {
    const normalizedId = safeId(id);
    if (!normalizedId || normalizedId === PRIMARY_ID) throw new Error('主业务数据库不能在这里删除');
    const stored = loadStoredConfig();
    const before = stored.connections.length;
    stored.connections = stored.connections.filter(item => item.id !== normalizedId);
    if (stored.connections.length === before) throw new Error('数据源连接不存在');
    stored.backup.selectedConnectionIds = stored.backup.selectedConnectionIds.filter(item => item !== normalizedId);
    saveStoredConfig(stored);
    latestHealthChecks.delete(normalizedId);
    runtimeCache.clear();
    return { success: true };
}

function resolveInputConnection(input = {}) {
    const id = safeId(input.id);
    const current = id === PRIMARY_ID ? primaryConnection() : (id ? loadStoredConfig().connections.find(item => item.id === id) : null);
    // Manual tests may check a disabled connection, but never lose its masked credentials.
    if (current) return normalizeConnection({ ...input, id }, current);
    if (id && !input.sourceType && !input.type && !input.dbType) throw new Error('数据源连接不存在');
    return normalizeConnection(input);
}

function normalizeHttpUrl(baseUrl, healthPath) {
    const rawBase = String(baseUrl || '').trim();
    if (!rawBase) throw new Error('请填写 API 根地址');
    let base;
    try { base = new URL(rawBase); } catch { throw new Error('API 根地址格式不正确'); }
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('API 根地址只支持 http 或 https');
    if (/[\u0000-\u001f\u007f]/.test(rawBase)) throw new Error('API 根地址包含非法字符');
    if (base.username || base.password) throw new Error('API 根地址不能包含用户名或密码，请使用认证配置');
    if (base.search || base.hash) throw new Error('API 根地址不能包含查询参数或片段，请将查询参数放入健康检查路径');
    const pathValue = String(healthPath || '/health').trim() || '/health';
    if (/[\u0000-\u001f\u007f\\]/.test(pathValue)) throw new Error('健康检查路径包含非法字符');
    if (pathValue.startsWith('//')) throw new Error('健康检查地址必须使用当前 API 根地址');
    let target;
    try {
        // A root such as https://host/api/v1 is a prefix, not a filename.
        const directory = new URL(base);
        if (!directory.pathname.endsWith('/')) directory.pathname += '/';
        target = new URL(pathValue.replace(/^\/(?!\/)/, ''), directory);
    } catch { throw new Error('健康检查地址格式不正确'); }
    if (target.origin !== base.origin) throw new Error('健康检查地址必须与 API 根地址使用同一域名');
    if (target.username || target.password) throw new Error('健康检查地址不能包含用户名或密码，请使用认证配置');
    if (target.hash) throw new Error('健康检查路径不能包含片段');
    return { base, target };
}

function httpAuthHeaders(connection) {
    const authType = normalizeHttpAuthType(connection.authType);
    if (!SUPPORTED_HTTP_AUTH_TYPES.has(authType)) throw new Error('不支持的 HTTP API 认证方式');
    if (authType === 'none') return {};
    if (authType === 'api_key') {
        if (!String(connection.apiKey || '').trim()) throw new Error('API Key 认证未填写密钥');
        const header = String(connection.apiKeyHeader || 'X-API-Key').trim();
        try { validateHeaderName(header); } catch { throw new Error('API Key 请求头名称不合法'); }
        if (header.length > 100 || FORBIDDEN_AUTH_HEADERS.has(header.toLowerCase()) || /^proxy-/i.test(header)) {
            throw new Error('API Key 不能使用连接控制或代理请求头');
        }
        try { validateHeaderValue(header, connection.apiKey); } catch { throw new Error('API Key 包含不能用于请求头的字符'); }
        return { [header]: connection.apiKey };
    }
    if (authType === 'bearer') {
        if (!String(connection.token || '').trim()) throw new Error('Bearer Token 认证未填写令牌');
        try { validateHeaderValue('Authorization', `Bearer ${connection.token}`); } catch { throw new Error('Bearer Token 包含不能用于请求头的字符'); }
        return { Authorization: `Bearer ${connection.token}` };
    }
    if (!connection.user || !connection.password) throw new Error('Basic 认证需要填写用户名和密码');
    if (/[:\u0000-\u001f\u007f]/.test(connection.user)) throw new Error('Basic 用户名不能包含冒号或控制字符');
    return { Authorization: `Basic ${Buffer.from(`${connection.user}:${connection.password}`, 'utf8').toString('base64')}` };
}

async function testHttpApiSource(connection, checkedAt) {
    const { target } = normalizeHttpUrl(connection.baseUrl, connection.healthPath);
    // Validation belongs outside the network catch; malformed headers must be
    // config_error, and native error strings can contain an entire credential.
    const headers = new Headers({ Accept: 'application/json, text/plain, */*' });
    for (const [name, value] of Object.entries(httpAuthHeaders(connection))) headers.set(name, value);
    const startedAt = Date.now();
    const health = {
        status: 'unknown',
        message: '',
        responseTimeMs: null,
        httpStatus: null,
        checkedAt
    };
    try {
        const response = await fetch(target, {
            method: 'GET',
            headers,
            // Never forward custom API keys to a redirect destination.
            redirect: 'manual',
            signal: AbortSignal.timeout(connection.requestTimeoutMs)
        });
        health.responseTimeMs = Date.now() - startedAt;
        health.httpStatus = response.status;
        if (response.status === 401 || response.status === 403) {
            health.status = 'auth_failed';
            health.message = `接口拒绝访问（HTTP ${response.status}），请检查认证方式和凭据。`;
        } else if (response.ok) {
            health.status = 'healthy';
            health.message = `接口可访问（HTTP ${response.status}）。`;
        } else {
            health.status = 'http_error';
            health.message = response.status >= 300 && response.status < 400
                ? `接口返回重定向（HTTP ${response.status}），为保护认证凭据未跟随跳转，请填写最终健康检查地址。`
                : `接口返回异常状态（HTTP ${response.status}）。`;
        }
        // Health checks need only the status; do not retain streaming bodies or sockets.
        if (response.body) await response.body.cancel().catch(() => {});
    } catch (error) {
        health.responseTimeMs = Date.now() - startedAt;
        health.status = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error';
        health.message = health.status === 'timeout'
            ? `接口请求超过 ${connection.requestTimeoutMs}ms 未响应。`
            : '接口无法访问，请检查地址、网络、证书及目标服务是否运行。';
    }
    return health;
}

function persistHealth(connection, health, checkId) {
    const normalizedId = safeId(connection.id);
    if (!normalizedId || normalizedId === PRIMARY_ID || latestHealthChecks.get(normalizedId) !== checkId) return null;
    const stored = loadStoredConfig();
    const index = stored.connections.findIndex(item => item.id === normalizedId);
    if (index < 0) return null;
    const current = stored.connections[index];
    if (current.configRevision !== connection.configRevision || current.createdAt !== connection.createdAt
        || connectionFingerprint(current) !== connectionFingerprint(connection)) return null;
    stored.connections[index] = { ...current, health: normalizeHealth(health) };
    saveStoredConfig(stored);
    return stored.connections[index];
}

function quoteIdentifier(value, type) {
    const name = String(value || '');
    if (!name || name.length > 255 || /[\u0000-\u001f]/.test(name)) throw new Error('数据库标识符不合法');
    if (type === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
    if (type === 'sqlserver') return `[${name.replace(/]/g, ']]')}]`;
    return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTable(connection, schema, table) {
    const type = normalizeType(connection.type);
    const tablePart = quoteIdentifier(table, type);
    if (type === 'sqlite' || !schema) return tablePart;
    return `${quoteIdentifier(schema, type)}.${tablePart}`;
}

async function withConnection(connection, callback) {
    if (isHttpApiSource(connection)) throw new Error('HTTP API 数据源不能执行数据库结构读取或数据库备份');
    const type = normalizeType(connection.type);
    if (type === 'mysql') {
        const client = await getMysql().createConnection({
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            database: connection.database,
            connectTimeout: connection.queryTimeoutMs,
            multipleStatements: false,
            charset: 'utf8mb4'
        });
        try { return await callback({ type, client, connection }); }
        finally { await client.end(); }
    }
    if (type === 'postgres') {
        const Client = getPgClient();
        const client = new Client({
            host: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            database: connection.database,
            connectionTimeoutMillis: connection.queryTimeoutMs,
            statement_timeout: connection.queryTimeoutMs,
            query_timeout: connection.queryTimeoutMs
        });
        try {
            await client.connect();
            await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
            return await callback({ type, client, connection });
        } finally { await client.end(); }
    }
    if (type === 'sqlserver') {
        const sql = getSqlServer();
        const pool = new sql.ConnectionPool({
            server: connection.host,
            port: connection.port,
            user: connection.user,
            password: connection.password,
            database: connection.database,
            requestTimeout: connection.queryTimeoutMs,
            connectionTimeout: connection.queryTimeoutMs,
            pool: { max: 2, min: 0, idleTimeoutMillis: 5000 },
            options: {
                encrypt: !!connection.encrypt,
                trustServerCertificate: connection.trustServerCertificate !== false
            }
        });
        try {
            await pool.connect();
            return await callback({ type, client: pool, connection });
        }
        finally { await pool.close(); }
    }
    if (type === 'sqlite') {
        const filename = path.resolve(connection.filename || '');
        if (!filename || !fs.existsSync(filename)) throw new Error('SQLite 文件不存在');
        const client = new (getSqlite())(filename, { readonly: true, fileMustExist: true, timeout: connection.queryTimeoutMs });
        try { return await callback({ type, client, connection }); }
        finally { client.close(); }
    }
    throw new Error(`不支持的数据源类型：${type}`);
}

async function executeRows(handle, sql, params = []) {
    if (handle.type === 'mysql') {
        const [rows] = await handle.client.query({ sql, timeout: handle.connection.queryTimeoutMs }, params);
        return Array.isArray(rows) ? rows : [];
    }
    if (handle.type === 'postgres') return (await handle.client.query(sql, params)).rows || [];
    if (handle.type === 'sqlserver') {
        const request = handle.client.request();
        params.forEach((value, index) => request.input(`p${index + 1}`, value));
        return (await request.query(sql)).recordset || [];
    }
    return handle.client.prepare(sql).all(...params);
}

/**
 * Execute a parameterised read-only query against a configured external data source.
 *
 * The digital-twin display must never write to the scheduling/production system.
 * Keep this guard at the shared connector boundary so future business-data
 * adapters cannot accidentally introduce INSERT/UPDATE/DELETE statements.
 */
async function executeReadOnlyQuery(connectionId, sql, params = []) {
    const statement = String(sql || '').trim();
    if (!statement) throw new Error('只读查询不能为空');
    if (!/^(select|with)\b/i.test(statement)) throw new Error('外部业务数据只允许 SELECT 查询');
    if (statement.includes(';')) throw new Error('只读查询不允许多语句执行');
    if (/\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|set)\b/i.test(statement)) {
        throw new Error('只读查询包含被禁止的写入或管理关键字');
    }
    const connection = resolveConnection(connectionId);
    return withConnection(connection, handle => executeRows(handle, statement, params));
}

async function testDataSource(input = {}) {
    const connection = resolveInputConnection(input);
    const checkId = crypto.randomUUID();
    const persistedId = input.id ? safeId(input.id) : '';
    if (persistedId) latestHealthChecks.set(persistedId, checkId);
    lastHealthCheckTime = Math.max(Date.now(), lastHealthCheckTime + 1);
    const checkedAt = new Date(lastHealthCheckTime).toISOString();
    const startedAt = Date.now();
    let health;
    try {
        if (isHttpApiSource(connection)) {
            try {
                health = await testHttpApiSource(connection, checkedAt);
            } catch (error) {
                health = {
                    status: 'config_error',
                    message: redactCredentials(error.message || String(error), connection),
                    responseTimeMs: 0,
                    httpStatus: null,
                    checkedAt
                };
            }
        } else {
            try {
                await withConnection(connection, handle => executeRows(handle, 'SELECT 1 AS ok'));
                health = {
                    status: 'healthy',
                    message: '数据库连接成功，可读取数据库结构。',
                    responseTimeMs: Date.now() - startedAt,
                    httpStatus: null,
                    checkedAt
                };
            } catch (error) {
                health = {
                    status: 'network_error',
                    message: redactCredentials(`数据库连接失败：${error.message || String(error)}`, connection),
                    responseTimeMs: Date.now() - startedAt,
                    httpStatus: null,
                    checkedAt
                };
            }
        }
        if (persistedId) persistHealth(connection, health, checkId);
        return {
            success: health.status === 'healthy',
            health,
            healthToken: issueHealthToken(connection, health),
            // Return exactly the configuration that was tested, never a later saved edit.
            connection: publicConnection({ ...connection, health }, { primary: connection.id === PRIMARY_ID }),
            error: health.status === 'healthy' ? undefined : health.message
        };
    } finally {
        if (latestHealthChecks.get(persistedId) === checkId) latestHealthChecks.delete(persistedId);
    }
}

async function listTables(id) {
    const connection = resolveConnection(id);
    return withConnection(connection, async handle => {
        let rows;
        if (handle.type === 'sqlite') {
            rows = await executeRows(handle, `SELECT '' AS table_schema, name AS table_name, type AS table_type
                FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
        } else if (handle.type === 'mysql') {
            rows = await executeRows(handle, `SELECT table_schema, table_name, table_type FROM information_schema.tables
                WHERE table_schema = ? ORDER BY table_name`, [connection.database]);
        } else if (handle.type === 'postgres') {
            rows = await executeRows(handle, `SELECT table_schema, table_name, table_type FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name`);
        } else {
            rows = await executeRows(handle, `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name, TABLE_TYPE AS table_type
                FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME`);
        }
        return rows.slice(0, 2000).map(row => ({
            schema: String(row.table_schema || ''),
            name: String(row.table_name || ''),
            type: String(row.table_type || 'TABLE')
        }));
    });
}

async function listColumns(id, schema, table) {
    const connection = resolveConnection(id);
    const tableName = shortText(table, '', 255);
    if (!tableName) throw new Error('请选择数据库表');
    return withConnection(connection, async handle => {
        let rows;
        if (handle.type === 'sqlite') {
            rows = await executeRows(handle, `PRAGMA table_info(${quoteIdentifier(tableName, 'sqlite')})`);
            return rows.map(row => ({
                name: String(row.name || ''),
                dataType: String(row.type || ''),
                nullable: !row.notnull,
                ordinal: Number(row.cid || 0) + 1,
                primaryKey: !!row.pk
            }));
        }
        if (handle.type === 'mysql') {
            rows = await executeRows(handle, `SELECT column_name, data_type, is_nullable, ordinal_position, column_key
                FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
            [schema || connection.database, tableName]);
        } else if (handle.type === 'postgres') {
            rows = await executeRows(handle, `SELECT column_name, data_type, is_nullable, ordinal_position, '' AS column_key
                FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
            [schema || connection.defaultSchema || 'public', tableName]);
        } else {
            const request = handle.client.request();
            request.input('schema', schema || connection.defaultSchema || 'dbo');
            request.input('table', tableName);
            const result = await request.query(`SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
                IS_NULLABLE AS is_nullable, ORDINAL_POSITION AS ordinal_position, '' AS column_key
                FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION`);
            rows = result.recordset || [];
        }
        return rows.slice(0, 1000).map(row => ({
            name: String(row.column_name || ''),
            dataType: String(row.data_type || ''),
            nullable: String(row.is_nullable || '').toUpperCase() === 'YES',
            ordinal: Number(row.ordinal_position || 0),
            primaryKey: String(row.column_key || '').toUpperCase() === 'PRI'
        }));
    });
}

function normalizeBinding(source = {}) {
    const valueMode = VALUE_MODES.has(source.valueMode) ? source.valueMode : 'latest';
    return {
        connectionId: safeId(source.connectionId || source.connection_id),
        schema: shortText(source.schema, '', 255),
        table: shortText(source.table, '', 255),
        field: shortText(source.field, '', 255),
        timeField: shortText(source.timeField, '', 255),
        orderBy: shortText(source.orderBy || source.timeField, '', 255),
        orderDirection: String(source.orderDirection || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
        valueMode,
        rowLimit: finiteInteger(source.rowLimit, 50, 1, 500),
        refreshMs: finiteInteger(source.refreshMs, 5000, 1000, 3600000),
        alias: safeId(source.alias, 'a').toLowerCase(),
        label: shortText(source.label, source.alias || '数据项', 100),
        color: shortText(source.color, '#55c7ff', 64),
        contextField: shortText(source.contextField, '', 255),
        contextKey: ['deviceId', 'lineId', 'workshopId', 'viewId', 'partId'].includes(source.contextKey) ? source.contextKey : ''
    };
}

function normalizeCompositeBinding(source = {}) {
    const raw = Array.isArray(source.datasets) && source.datasets.length ? source.datasets : [source];
    const usedAliases = new Set();
    const datasets = raw.slice(0, 12).map((item, index) => {
        const binding = normalizeBinding({ ...source, ...item, alias: item.alias || String.fromCharCode(97 + index) });
        let alias = binding.alias || `data_${index + 1}`;
        if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) alias = `data_${index + 1}`;
        while (usedAliases.has(alias)) alias = `${alias}_${index + 1}`;
        usedAliases.add(alias);
        return { ...binding, alias };
    });
    return {
        datasets,
        formula: shortText(source.formula, '', 256),
        formulaLabel: shortText(source.formulaLabel, '计算结果', 100),
        formulaColor: shortText(source.formulaColor, '#45df9b', 64),
        refreshMs: datasets.reduce((minimum, item) => Math.min(minimum, item.refreshMs), 3600000)
    };
}

function bindingSelectSql(handle, binding, context = {}) {
    if (!binding.connectionId || !binding.table) throw new Error('数据库绑定缺少连接或表');
    if (binding.valueMode !== 'count' && !binding.field) throw new Error('数据库绑定缺少字段');
    const type = handle.type;
    const table = qualifiedTable(handle.connection, binding.schema, binding.table);
    const field = binding.field ? quoteIdentifier(binding.field, type) : '';
    const order = binding.orderBy
        ? ` ORDER BY ${quoteIdentifier(binding.orderBy, type)} ${binding.orderDirection.toUpperCase()}`
        : '';
    const contextValue = binding.contextKey ? context?.[binding.contextKey] : '';
    const params = [];
    let where = '';
    if (binding.contextField && contextValue !== undefined && contextValue !== null && String(contextValue) !== '') {
        params.push(contextValue);
        const placeholder = type === 'postgres' ? '$1' : (type === 'sqlserver' ? '@p1' : '?');
        where = ` WHERE ${quoteIdentifier(binding.contextField, type)} = ${placeholder}`;
    }
    if (['count', 'sum', 'avg', 'min', 'max'].includes(binding.valueMode)) {
        const expression = binding.valueMode === 'count'
            ? 'COUNT(*)'
            : `${binding.valueMode.toUpperCase()}(${field})`;
        return { sql: `SELECT ${expression} AS value FROM ${table}${where}`, params };
    }
    const aliases = [`${field} AS value`];
    if (binding.timeField && binding.timeField !== binding.field) aliases.push(`${quoteIdentifier(binding.timeField, type)} AS time`);
    const limit = binding.valueMode === 'list' ? binding.rowLimit : 1;
    if (type === 'sqlserver') return { sql: `SELECT TOP ${limit} ${aliases.join(', ')} FROM ${table}${where}${order}`, params };
    return { sql: `SELECT ${aliases.join(', ')} FROM ${table}${where}${order} LIMIT ${limit}`, params };
}

function normalizeDatabaseRows(rows) {
    return rows.map((row, index) => ({
        ...row,
        value: row.value,
        time: row.time instanceof Date ? row.time.toISOString() : (row.time ?? index + 1),
        title: row.title ?? row.value,
        msg: row.msg ?? row.title ?? row.value
    }));
}

async function queryBindingWithHandle(handle, source, context = {}) {
    const binding = normalizeBinding(source);
    const query = bindingSelectSql(handle, binding, context);
    const rows = normalizeDatabaseRows(await executeRows(handle, query.sql, query.params));
    const list = binding.valueMode === 'list' ? rows : [];
    return {
        value: binding.valueMode === 'list' ? (rows[0]?.value ?? null) : (rows[0]?.value ?? null),
        rows: list,
        quality: 'good',
        fetchedAt: new Date().toISOString(),
        binding
    };
}

function compositeRows(composite, results) {
    if (!composite.formula) return results[0]?.rows || [];
    const length = Math.max(0, ...results.map(result => result.rows.length));
    return Array.from({ length }, (_, index) => {
        const variables = {};
        let time = index + 1;
        results.forEach(result => {
            const row = result.rows[index];
            variables[result.binding.alias] = row?.value ?? result.value;
            if (row?.time !== undefined && time === index + 1) time = row.time;
        });
        return { time, value: evaluateVariableExpression(composite.formula, variables, '数据 ') };
    });
}

function composeBindingResult(composite, results) {
    const variables = Object.fromEntries(results.map(result => [result.binding.alias, result.value]));
    const formulaValue = composite.formula
        ? evaluateVariableExpression(composite.formula, variables, '数据 ')
        : results[0]?.value;
    const rows = compositeRows(composite, results);
    const series = results.map(result => ({
        id: result.binding.alias,
        label: result.binding.label,
        color: result.binding.color,
        value: result.value,
        rows: result.rows
    }));
    if (composite.formula) {
        series.push({ id: '__formula', label: composite.formulaLabel, color: composite.formulaColor, value: formulaValue, rows });
    }
    return {
        value: formulaValue ?? null,
        rows,
        series,
        variables,
        formula: composite.formula,
        quality: 'good',
        fetchedAt: new Date().toISOString(),
        binding: composite
    };
}

async function queryCompositeBinding(source = {}, context = {}) {
    const composite = normalizeCompositeBinding(source);
    if (!composite.datasets.length) throw new Error('请至少添加一个数据项');
    const results = await Promise.all(composite.datasets.map(binding => {
        const connection = resolveConnection(binding.connectionId);
        return withConnection(connection, handle => queryBindingWithHandle(handle, binding, context));
    }));
    return composeBindingResult(composite, results);
}

async function previewBinding(source = {}) {
    return queryCompositeBinding(source, source.context || {});
}

function cacheKey(binding) {
    return JSON.stringify(binding);
}

async function readRuntimeBindings(widgets = [], context = {}) {
    const targets = widgets
        .filter(widget => widget?.data?.mode === 'database')
        .slice(0, 100)
        .map(widget => ({ widgetId: String(widget.id), binding: normalizeCompositeBinding(widget.data) }));
    const values = {};
    const now = Date.now();
    const pending = [];
    targets.forEach(target => {
        const key = cacheKey({ binding: target.binding, context });
        const cached = runtimeCache.get(key);
        if (cached && cached.expiresAt > now) {
            values[target.widgetId] = cached.value;
            return;
        }
        pending.push({ ...target, key, results: new Array(target.binding.datasets.length), error: null });
    });

    const jobsByConnection = new Map();
    pending.forEach(target => target.binding.datasets.forEach((binding, index) => {
        if (!jobsByConnection.has(binding.connectionId)) jobsByConnection.set(binding.connectionId, []);
        jobsByConnection.get(binding.connectionId).push({ target, binding, index });
    }));

    await Promise.all([...jobsByConnection.entries()].map(async ([connectionId, jobs]) => {
        try {
            const connection = resolveConnection(connectionId);
            await withConnection(connection, async handle => {
                for (const job of jobs) {
                    try {
                        job.target.results[job.index] = await queryBindingWithHandle(handle, job.binding, context);
                    } catch (error) {
                        job.target.error ||= error;
                    }
                }
            });
        } catch (error) {
            jobs.forEach(job => { job.target.error ||= error; });
        }
    }));

    pending.forEach(target => {
        try {
            if (target.error) throw target.error;
            const result = composeBindingResult(target.binding, target.results);
            values[target.widgetId] = result;
            runtimeCache.set(target.key, {
                value: result,
                expiresAt: Date.now() + target.binding.refreshMs
            });
        } catch (error) {
            values[target.widgetId] = { value: null, rows: [], series: [], quality: 'bad', error: error.message, fetchedAt: new Date().toISOString() };
        }
    });
    return values;
}

function saveBackupConfig(input = {}) {
    const stored = loadStoredConfig();
    const validIds = new Set([
        PRIMARY_ID,
        ...stored.connections.filter(item => !isHttpApiSource(item)).map(item => item.id)
    ]);
    const next = normalizeBackupConfig(input);
    next.selectedConnectionIds = next.selectedConnectionIds.filter(id => validIds.has(id));
    stored.backup = next;
    saveStoredConfig(stored);
    restartMaintenanceTimer();
    return next;
}

function timestampToken(date = new Date()) {
    return date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, 'Z');
}

function backupDirectory(connectionId) {
    const directory = path.join(BACKUP_ROOT, safeId(connectionId, 'unknown'));
    ensureDirectory(directory);
    return directory;
}

function listConnectionBackups(connectionId) {
    const directory = backupDirectory(connectionId);
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.(sql|json|db)\.gz$/i.test(entry.name))
        .map(entry => {
            const filename = path.join(directory, entry.name);
            const stat = fs.statSync(filename);
            return { connectionId, filename: entry.name, size: stat.size, createdAt: stat.mtime.toISOString() };
        })
        .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
}

function pruneConnectionBackups(connectionId, retention) {
    const directory = backupDirectory(connectionId);
    listConnectionBackups(connectionId).slice(retention).forEach(item => {
        fs.rmSync(path.join(directory, item.filename), { force: true });
    });
}

function jsonReplacer(key, value) {
    if (typeof value === 'bigint') return value.toString();
    if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
    return value;
}

async function genericCompressedBackup(connection, destination) {
    return withConnection(connection, async handle => {
        async function* rowsToExport() {
            yield `${JSON.stringify({
                format: 'heat-treatment-readonly-database-export',
                version: 1,
                createdAt: new Date().toISOString(),
                source: { id: connection.id, name: connection.name, type: connection.type, database: connection.database }
            }, jsonReplacer)}\n`;
            const tables = await listTablesWithHandle(handle);
            for (const table of tables) {
                yield `${JSON.stringify({ type: 'table', schema: table.schema, name: table.name }, jsonReplacer)}\n`;
                let offset = 0;
                while (true) {
                    const qualified = qualifiedTable(connection, table.schema, table.name);
                    let sql;
                    if (handle.type === 'sqlserver') {
                        sql = `SELECT * FROM ${qualified} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT 1000 ROWS ONLY`;
                    } else {
                        sql = `SELECT * FROM ${qualified} LIMIT 1000 OFFSET ${offset}`;
                    }
                    const rows = await executeRows(handle, sql);
                    for (const row of rows) {
                        yield `${JSON.stringify({ type: 'row', table: table.name, schema: table.schema, data: row }, jsonReplacer)}\n`;
                    }
                    if (rows.length < 1000) break;
                    offset += rows.length;
                }
            }
        }
        await pipeline(Readable.from(rowsToExport()), zlib.createGzip({ level: 6 }), fs.createWriteStream(destination, { flags: 'wx' }));
    });
}

async function listTablesWithHandle(handle) {
    const connection = handle.connection;
    let rows;
    if (handle.type === 'sqlite') {
        rows = await executeRows(handle, `SELECT '' AS table_schema, name AS table_name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    } else if (handle.type === 'mysql') {
        rows = await executeRows(handle, `SELECT table_schema, table_name FROM information_schema.tables
            WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`, [connection.database]);
    } else if (handle.type === 'postgres') {
        rows = await executeRows(handle, `SELECT table_schema, table_name FROM information_schema.tables
            WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name`);
    } else {
        rows = await executeRows(handle, `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name
            FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME`);
    }
    return rows.map(row => ({ schema: String(row.table_schema || ''), name: String(row.table_name || '') }));
}

async function createExternalBackup(connection, reason) {
    if (isHttpApiSource(connection)) throw new Error('HTTP API 数据源不参与数据库备份');
    const directory = backupDirectory(connection.id);
    const type = normalizeType(connection.type);
    const mysqlDumpAvailable = type === 'mysql' && resolveMysqlTools().available;
    const extension = type === 'mysql' && mysqlDumpAvailable ? '.sql.gz' : (type === 'sqlite' ? '.db.gz' : '.json.gz');
    const filename = `${safeId(connection.id, 'source')}-${timestampToken()}-${safeId(reason, 'manual')}${extension}`;
    const destination = path.join(directory, filename);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.rmSync(temporary, { force: true });
    try {
        if (type === 'mysql' && mysqlDumpAvailable) {
            await createMysqlDump(connection, temporary);
        } else if (type === 'mysql') {
            await genericCompressedBackup(connection, temporary);
        } else if (type === 'sqlite') {
            const source = path.resolve(connection.filename || '');
            if (!fs.existsSync(source)) throw new Error('SQLite 文件不存在');
            const snapshot = `${temporary}.db`;
            const sqlite = new (getSqlite())(source, { readonly: true, fileMustExist: true });
            try {
                const integrity = sqlite.pragma('quick_check', { simple: true });
                if (String(integrity).toLowerCase() !== 'ok') throw new Error(`外部 SQLite 数据库完整性检查失败: ${integrity}`);
                await sqlite.backup(snapshot);
                await pipeline(fs.createReadStream(snapshot), zlib.createGzip({ level: 6 }), fs.createWriteStream(temporary, { flags: 'wx' }));
            } finally {
                sqlite.close();
                fs.rmSync(snapshot, { force: true });
            }
        } else {
            await genericCompressedBackup(connection, temporary);
        }
        fs.renameSync(temporary, destination);
        pruneConnectionBackups(connection.id, loadStoredConfig().backup.retention);
        return { connectionId: connection.id, connectionName: connection.name, filename, size: fs.statSync(destination).size, createdAt: new Date().toISOString(), reason };
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

async function createConnectionBackup(connectionId, reason = 'manual') {
    const id = safeId(connectionId);
    const connection = id === PRIMARY_ID ? null : resolveConnection(id);
    if (isHttpApiSource(connection)) throw new Error('HTTP API 数据源不参与数据库备份');
    if (activeConnectionBackups.has(id)) return activeConnectionBackups.get(id);
    const pending = (async () => {
        if (id === PRIMARY_ID) {
            const backup = await createDatabaseBackup(reason);
            return { ...backup, connectionId: PRIMARY_ID, connectionName: '主业务数据库' };
        }
        return createExternalBackup(connection, reason);
    })();
    activeConnectionBackups.set(id, pending);
    try {
        return await pending;
    } finally {
        if (activeConnectionBackups.get(id) === pending) activeConnectionBackups.delete(id);
    }
}

async function runSelectedBackups(reason = 'scheduled') {
    if (backupPromise) return backupPromise;
    const config = loadStoredConfig();
    backupPromise = (async () => {
        const results = [];
        for (const connectionId of config.backup.selectedConnectionIds) {
            try {
                results.push({ success: true, backup: await createConnectionBackup(connectionId, reason) });
            } catch (error) {
                results.push({ success: false, connectionId, error: error.message });
            }
        }
        lastBackupRun = { at: new Date().toISOString(), reason, results };
        lastBackupError = results.some(item => !item.success)
            ? { at: lastBackupRun.at, error: results.filter(item => !item.success).map(item => `${item.connectionId}: ${item.error}`).join('；') }
            : null;
        return results;
    })().finally(() => { backupPromise = null; });
    return backupPromise;
}

function restartMaintenanceTimer() {
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    if (!maintenanceStarted) return;
    const backup = loadStoredConfig().backup;
    if (!backup.scheduledEnabled) return;
    maintenanceTimer = setInterval(() => {
        runSelectedBackups('scheduled').catch(error => console.error('[DataSources] 定时备份失败:', error.message));
    }, backup.intervalHours * 60 * 60 * 1000);
    maintenanceTimer.unref?.();
}

function startDataSourceMaintenance() {
    maintenanceStarted = true;
    if (startupBackupHandle) clearImmediate(startupBackupHandle);
    startupBackupHandle = null;
    restartMaintenanceTimer();
    const backup = loadStoredConfig().backup;
    if (backup.startupEnabled) {
        startupBackupHandle = setImmediate(() => {
            startupBackupHandle = null;
            if (maintenanceStarted) runSelectedBackups('startup').catch(error => console.error('[DataSources] 启动备份失败:', error.message));
        });
    }
    return getBackupStatus();
}

function reloadDataSourceConfiguration() {
    runtimeCache.clear();
    restartMaintenanceTimer();
    return listDataSources();
}

async function stopDataSourceMaintenance(options = {}) {
    maintenanceStarted = false;
    if (startupBackupHandle) clearImmediate(startupBackupHandle);
    startupBackupHandle = null;
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    if (backupPromise) await backupPromise;
    await Promise.allSettled([...activeConnectionBackups.values()]);
    const backup = loadStoredConfig().backup;
    if (options.backup === true && backup.shutdownEnabled) {
        return runSelectedBackups(options.reason || 'shutdown');
    }
    return [];
}

function getBackupStatus() {
    const stored = loadStoredConfig();
    return {
        ...stored.backup,
        running: !!backupPromise,
        lastBackupRun,
        lastError: lastBackupError,
        connections: [primaryConnection(), ...stored.connections.filter(connection => !isHttpApiSource(connection))].map(connection => ({
            id: connection.id,
            name: connection.name,
            type: normalizeType(connection.type),
            selected: stored.backup.selectedConnectionIds.includes(connection.id),
            backups: connection.id === PRIMARY_ID ? [] : listConnectionBackups(connection.id).slice(0, 5)
        }))
    };
}

module.exports = {
    PRIMARY_ID,
    MASKED_PASSWORD,
    createConnectionBackup,
    deleteDataSource,
    executeReadOnlyQuery,
    getBackupStatus,
    listColumns,
    listDataSources,
    listTables,
    previewBinding,
    readRuntimeBindings,
    reloadDataSourceConfiguration,
    resolveConnection,
    runSelectedBackups,
    saveBackupConfig,
    saveDataSource,
    startDataSourceMaintenance,
    stopDataSourceMaintenance,
    testDataSource
};
