'use strict';
// Native read-only MongoDB adapter. No user-supplied command, pipeline or JS.
const net = require('node:net');
const { MongoClient, BSON } = require('mongodb');
const { parseDataPath, readDataPath, appendDataPath } = require('../utils/externalDataPayload');
const LIMIT = 262144;
const safe = message => Object.assign(new Error(message), { userSafe: true });
function databaseName(value) {
    if (!value || /[\s/\\.\0"$*<>:|?]/.test(value) || Buffer.byteLength(value) > 63) throw safe('MongoDB 数据库名称无效');
    return value;
}
function validate(connection) {
    const host = String(connection.host || '').replace(/^\[|\]$/g, '');
    if (!net.isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))
        throw safe('MongoDB 主机请填写域名或 IP，不包含协议、账号或连接参数');
    databaseName(connection.database);
    if (connection.defaultSchema) databaseName(connection.defaultSchema);
    if (Boolean(connection.user) !== Boolean(connection.password)) throw safe('MongoDB 用户名和密码请同时填写，或同时留空');
    if (connection.trustServerCertificate !== false) throw safe('MongoDB 不允许跳过 TLS 证书校验');
    return host;
}
function collectionName(handle, schema, table) {
    if (schema && schema !== handle.connection.database) throw safe('只能读取所选连接的数据库');
    if (!table || table.length > 120 || /[\0$]/.test(table) || table.startsWith('system.') || table.endsWith('.')) throw safe('MongoDB 集合名称无效或为系统集合');
    return table;
}
function nativeField(path) {
    const parts = parseDataPath(path);
    if (parts.some(key => typeof key !== 'string' || /[.$\0]/.test(key))) throw safe('MongoDB 字段不支持操作符、数组下标或含点的键名');
    return parts.join('.');
}
function valueOf(value, depth = 0) {
    if (depth > 8) throw safe('MongoDB 文档层级过深');
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value instanceof Date) return value.toISOString();
    if (value._bsontype === 'ObjectId') return value.toHexString();
    if (value._bsontype === 'Long') { const n = value.toBigInt(); return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : String(n); }
    if (['Decimal128', 'Timestamp'].includes(value._bsontype)) return value.toString();
    if (value._bsontype || Buffer.isBuffer(value)) throw safe('MongoDB 所选字段包含不支持的 BSON 类型，请在源端转换为标量');
    if (Array.isArray(value)) return value.map(item => valueOf(item, depth + 1));
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'prototype', 'constructor'].includes(key)).map(([key, item]) => [key, valueOf(item, depth + 1)]));
}
async function withMongo(connection, callback) {
    const host = validate(connection), timeout = connection.queryTimeoutMs || 8000;
    const client = new MongoClient(`mongodb://${net.isIP(host) === 6 ? `[${host}]` : host}:${connection.port || 27017}`, {
        dbName: connection.database, authSource: connection.defaultSchema || connection.database,
        ...(connection.user ? { auth: { username: connection.user, password: connection.password } } : {}),
        tls: connection.encrypt === true, maxPoolSize: 2, minPoolSize: 0, maxConnecting: 1,
        connectTimeoutMS: timeout, serverSelectionTimeoutMS: timeout, socketTimeoutMS: timeout,
        retryReads: false, appName: 'HeatTreatmentReadOnly'
    });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
    try {
        await client.connect(); controller.signal.throwIfAborted();
        return await callback({ type: 'mongodb', client, database: client.db(connection.database), connection, signal: controller.signal });
    } catch (error) {
        if (error.userSafe) throw error;
        if (error.code === 18) throw Object.assign(safe('MongoDB 认证失败，请检查账号、密码与认证数据库'), { code: 'AUTH_FAILED' });
        if (error.code === 13) throw safe('MongoDB 账号没有所选集合的只读权限');
        if (controller.signal.aborted || /timeout|timed out/i.test(error.name + error.message)) throw Object.assign(safe('MongoDB 读取超时，请检查数据库状态与网络'), { code: 'TIMEOUT' });
        throw safe('MongoDB 连接或读取失败，请检查主机、TLS、数据库及字段配置');
    } finally { clearTimeout(timer); await client.close(); }
}
async function collect(cursor, limit = 100, raw = false) {
    const rows = []; let size = 0;
    try {
        for await (const doc of cursor) {
            const row = raw ? doc : valueOf(doc); size += raw ? BSON.calculateObjectSize(doc) : Buffer.byteLength(JSON.stringify(row));
            if (size > LIMIT) throw safe('MongoDB 结果超过 256 KB，请减少字段或缩小查询范围');
            rows.push(row);
            if (rows.length >= limit) break;
        }
        return rows;
    } finally { await cursor.close(); }
}
function options(handle) { return { signal: handle.signal, maxTimeMS: handle.connection.queryTimeoutMs || 8000, batchSize: 1 }; }
async function tables(handle) {
    const cursor = handle.database.listCollections({}, { nameOnly: true, authorizedCollections: true, ...options(handle) });
    const rows = await collect(cursor, 2000);
    return rows.filter(row => !row.name.startsWith('system.')).map(row => ({ schema: handle.connection.database, name: row.name, type: row.type === 'view' ? 'VIEW' : 'COLLECTION' })).sort((a, b) => a.name.localeCompare(b.name));
}
async function columns(handle, schema, table) {
    const docs = await collect(handle.database.collection(collectionName(handle, schema, table)).find({}, { ...options(handle), limit: 50 }), 50, true);
    const fields = new Map();
    function walk(value, path = '', depth = 0) {
        if (depth > 5 || fields.size >= 100) return;
        if (value && typeof value === 'object' && !Array.isArray(value) && !value._bsontype && !(value instanceof Date) && !Buffer.isBuffer(value)) {
            for (const [name, child] of Object.entries(value)) {
                if (/[.$\0]/.test(name)) continue;
                const next = appendDataPath(path, name); if (next) walk(child, next, depth + 1);
            }
        } else if (path) {
            const kind = value == null ? 'unknown' : typeof value === 'number' ? 'double' : typeof value === 'boolean' ? 'boolean' : Array.isArray(value) ? 'json' : value?._bsontype === 'Binary' ? 'binary (unsupported)' : 'string';
            const prior = fields.get(path);
            const dataType = !prior || prior.dataType === 'unknown' ? kind : kind === 'unknown' ? prior.dataType : prior.dataType === kind ? kind : 'string';
            fields.set(path, { name: path, path, dataType, nullable: path !== '_id', ordinal: prior?.ordinal || fields.size + 1, primaryKey: path === '_id', sampled: true });
        }
    }
    for (const doc of docs) walk(doc);
    return [...fields.values()].map(field => ({ ...field, dataType: field.dataType === 'unknown' ? 'string' : field.dataType }));
}
function contextFilter(field, value) {
    if (value === undefined || value === null || value === '') throw safe('请先选择要查看的对象或参数');
    if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw safe('MongoDB 匹配值只支持文本、数值或布尔值');
    return { [nativeField(field)]: { $eq: value } };
}
function projectionFor(fields) {
    const projection = {};
    for (const path of [...new Set(fields.map(nativeField))].sort((a, b) => a.length - b.length)) {
        if (!Object.keys(projection).some(parent => path === parent || path.startsWith(parent + '.'))) projection[path] = 1;
    }
    if (!Object.hasOwn(projection, '_id')) projection._id = 0;
    return projection;
}
async function dataset(handle, definition, context) {
    const fields = [...new Set([...definition.columns.map(c => c.path), ...(definition.match ? [definition.match.field] : [])])];
    const projection = projectionFor(fields);
    const filter = definition.match ? contextFilter(definition.match.field, require('./dataSets').matchValue(definition, context)) : {};
    const order = definition.database.orderBy ? { [nativeField(definition.database.orderBy)]: definition.database.orderDirection === 'asc' ? 1 : -1 } : { _id: 1 };
    return collect(handle.database.collection(collectionName(handle, definition.database.schema, definition.database.table)).find(filter, { ...options(handle), projection, sort: order, limit: definition.match ? 2 : 100 }), definition.match ? 2 : 100);
}
async function binding(handle, binding, context) {
    const collection = handle.database.collection(collectionName(handle, binding.schema, binding.table));
    const filter = binding.contextField ? contextFilter(binding.contextField, context[binding.contextKey]) : {};
    if (['count', 'sum', 'avg', 'min', 'max'].includes(binding.valueMode)) {
        const expression = binding.valueMode === 'count' ? { $sum: 1 } : { ['$' + binding.valueMode]: '$' + nativeField(binding.field) };
        const rows = await collect(collection.aggregate([{ $match: filter }, { $group: { _id: null, value: expression } }, { $project: { _id: 0, value: 1 } }], options(handle)), 1);
        return rows.length ? rows : [{ value: binding.valueMode === 'count' ? 0 : null }];
    }
    const fields = [binding.field, ...(binding.timeField ? [binding.timeField] : [])];
    const projection = projectionFor(fields);
    const limit = binding.valueMode === 'list' ? Math.min(binding.rowLimit, 100) : 1;
    const sort = { [binding.orderBy ? nativeField(binding.orderBy) : '_id']: binding.orderDirection === 'asc' ? 1 : -1 };
    const rows = await collect(collection.find(filter, { ...options(handle), projection, sort, limit }), limit);
    return rows.map((row, index) => ({ value: readDataPath(row, binding.field) ?? null, time: binding.timeField ? readDataPath(row, binding.timeField) : index + 1 }));
}
module.exports = { validate, withMongo, tables, columns, dataset, binding, nativeField, valueOf };
