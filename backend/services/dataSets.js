// Reusable, factory-scoped read definitions. Credentials belong to connections,
// never datasets or published widgets. Existing legacy bindings remain valid.
const crypto = require('node:crypto');
const { getDb } = require('../db/database');
const { parseDataPath, readDataPath, appendDataPath } = require('../utils/externalDataPayload');
const { BoundedTtlCache } = require('../utils/boundedTtlCache');
const { isParameterKey } = require('../../shared/dashboardParameters.mjs');
const KEY = 'external_dataset_config';
const CONTEXT_KEYS = ['deviceId', 'lineId', 'workshopId', 'partId', 'viewId'];
const cache = new BoundedTtlCache(), pending = new Map();
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const forbidden = /^(?:__proto__|prototype|constructor)$/;
const secret = /password|passwd|secret|authorization|api[_-]?key|token|cookie/i;
const text = (v, n = 255) => String(v ?? '').trim().slice(0, n);
function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function dataPath(value, optional = false) { const result = text(value); if (result || !optional) parseDataPath(result); return result; }
function number(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) && value !== '' && value != null ? Math.max(min, Math.min(max, n)) : fallback; }
function normalizeDataSet(input = {}) {
    const name = text(input.name, 100), connectionId = text(input.connectionId, 80);
    if (!name || !idPattern.test(connectionId)) throw error('请填写数据集名称并选择连接');
    const source = input.source === 'database' ? 'database' : 'http';
    const columns = (Array.isArray(input.columns) ? input.columns : []).slice(0, 32).map(c => {
        const name = text(c.name, 64);
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name) || forbidden.test(name)) throw error('字段标识请使用字母、数字和下划线');
        return { name, path: dataPath(c.path), label: text(c.label || name, 100), type: ['number','string','boolean'].includes(c.type) ? c.type : 'string',
            role: ['value','category','time'].includes(c.role) ? c.role : '', unit: text(c.unit, 32),
            scale: number(c.scale, 1, -1e12, 1e12), offset: number(c.offset, 0, -1e12, 1e12) };
    });
    if (!columns.length || new Set(columns.map(c => c.name)).size !== columns.length) throw error('请配置至少一个字段，字段标识不能重复');
    for (const role of ['value','category','time']) if (columns.filter(c => c.role === role).length > 1) throw error('每种字段角色只能指定一次');
    const request = input.request || {}, method = request.method || 'GET';
    if (!['GET', 'POST'].includes(method)) throw error('数据集仅支持 GET 或 POST 查询');
    const path = text(request.path || '/', 1024);
    if (path.startsWith('//') || /^[a-z]+:/i.test(path) || /[\\\u0000-\u001f\u007f]/.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) throw error('请求路径必须位于所选连接内');
    if (source === 'http' && method === 'POST' && request.readOnly !== true) throw error('POST 必须确认接口仅用于只读查询');
    const parameters = (Array.isArray(request.parameters) ? request.parameters : []).slice(0, 24).map(p => {
        const name = text(p.name, 80), location = ['query','body','header','path'].includes(p.in) ? p.in : 'query';
        if (!/^[a-zA-Z_][\w-]{0,79}$/.test(name) || forbidden.test(name) || secret.test(name)) throw error('参数名称无效；认证信息请在连接中配置');
        if (location === 'header' && /^(host|connection|content-length|transfer-encoding|upgrade|trailer|te|expect|content-type)$/i.test(name)) throw error('不允许覆盖协议请求头');
        if (method === 'GET' && location === 'body') throw error('GET 参数请放在 Query 中');
        const source = ['context','parameter'].includes(p.source) ? p.source : 'literal', key = text(p.key, 40);
        if (source === 'context' && !CONTEXT_KEYS.includes(key)) throw error('请选择有效的当前对象参数');
        if (source === 'parameter' && !isParameterKey(key)) throw error('请选择有效的大屏参数');
        return { name, in: location, source, key: source !== 'literal' ? key : '', value: source === 'literal' ? text(p.value, 1000) : '',
            required: p.required !== false, type: ['number','boolean'].includes(p.type) ? p.type : 'string' };
    });
    if (new Set(parameters.map(p => `${p.in}:${p.name.toLowerCase()}`)).size !== parameters.length) throw error('同一位置的参数不能重名');
    const match = input.match?.field ? { field: dataPath(input.match.field), contextKey: text(input.match.contextKey, 40) } : null;
    if (match && ![...CONTEXT_KEYS,'parameter'].includes(match.contextKey)) throw error('记录匹配需要选择当前对象');
    if (match?.contextKey === 'parameter') {
        if (!isParameterKey(input.match.parameterKey)) throw error('请填写记录匹配的参数标识');
        match.parameterKey=input.match.parameterKey;
        match.parameterType=['number','boolean'].includes(input.match.parameterType)?input.match.parameterType:'string';
    }
    const database = { schema: text(input.database?.schema), table: text(input.database?.table), orderBy: text(input.database?.orderBy), orderDirection: input.database?.orderDirection === 'asc' ? 'asc' : 'desc' };
    if (source === 'database' && !database.table) throw error('请选择数据表');
    return { id: idPattern.test(input.id || '') ? input.id : `dataset_${crypto.randomUUID()}`, name, connectionId, source,
        enabled: input.enabled !== false, refreshMs: Math.round(number(input.refreshMs, 5000, 1000, 3600000)),
        request: { method, path, readOnly: true, parameters }, rootPath: source === 'http' ? dataPath(input.rootPath, true) : '',
        match, columns, database, revision: text(input.revision, 80) };
}
async function store(factoryId) {
    const db = await getDb(), row = await db.get('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', [factoryId, KEY]);
    if (!row || !row.value) return { db, value: row?.value ?? null, datasets: [] };
    let data; try { data = JSON.parse(row.value); } catch { throw error('数据集配置损坏，请从备份恢复', 500); }
    if (!Array.isArray(data.datasets)) throw error('数据集配置格式无效', 500);
    return { db, value: row.value, datasets: data.datasets };
}
async function listDataSets(factoryId) { return (await store(factoryId)).datasets; }
async function commit(state, datasets, factoryId) {
    const value = JSON.stringify({ version: 1, datasets });
    if (Buffer.byteLength(value) > 1024 * 1024) throw error('数据集配置超过 1 MB');
    if (state.value === null) {
        try { await state.db.run('INSERT INTO factory_settings (factory_id,`key`,value) VALUES (?,?,?)', [factoryId, KEY, value]); }
        catch { throw error('配置已更新，请重新载入', 409); }
    } else {
        const result = await state.db.run('UPDATE factory_settings SET value=? WHERE factory_id=? AND `key`=? AND value=?', [value, factoryId, KEY, state.value]);
        if (!result.changes) throw error('配置已更新，请重新载入', 409);
    }
    cache.clear();
}
async function saveDataSet(input, factoryId) {
    const definition = normalizeDataSet(input), state = await store(factoryId);
    const current = state.datasets.find(d => d.id === definition.id);
    if (!current && input.revision) throw error('数据集已被删除，请重新载入', 409);
    if (current && current.revision !== input.revision) throw error('数据集已被其他页面更新，请重新载入', 409);
    if (!current && state.datasets.length >= 128) throw error('每个工厂最多配置 128 个数据集');
    const connection = require('./dataSources').resolveConnection(definition.connectionId, factoryId);
    if ((definition.source === 'http') !== (connection.sourceType === 'http_api')) throw error('数据集与连接类型不一致');
    if (definition.source === 'http' && (connection.connector || 'http') !== 'http' && (definition.request.method !== 'GET' || definition.request.parameters.length)) throw error('此协议不使用 HTTP 请求参数');
    definition.revision = crypto.randomUUID();
    await commit(state, [...state.datasets.filter(d => d.id !== definition.id), definition], factoryId);
    return definition;
}
async function deleteDataSet(id, revision, factoryId) {
    const state = await store(factoryId), current = state.datasets.find(d => d.id === id);
    if (!current) throw error('数据集不存在', 404);
    if (current.revision !== revision) throw error('数据集已更新，请重新载入', 409);
    await commit(state, state.datasets.filter(d => d.id !== id), factoryId);
}
function resolveRequest(definition, context) {
    let path = definition.request.path; const query = {}, body = {}, headers = {};
    for (const p of definition.request.parameters) {
        let value = p.source === 'context' ? context[p.key] : p.source === 'parameter' ? context.parameters?.[p.key] : p.value;
        if (value === undefined || value === null || value === '') { if (p.required) throw error(`缺少参数：${p.name}`); else continue; }
        if (p.type === 'number') { value = Number(value); if (!Number.isFinite(value)) throw error(`参数 ${p.name} 不是数值`); }
        if (p.type === 'boolean') { if (!['true','false','1','0'].includes(String(value))) throw error(`参数 ${p.name} 不是布尔值`); value = ['true','1'].includes(String(value)); }
        if (p.in === 'path') path = path.split(`{${p.name}}`).join(encodeURIComponent(String(value)));
        else (p.in === 'body' ? body : p.in === 'header' ? headers : query)[p.name] = value;
    }
    if (/\{[^}]+\}/.test(path)) throw error('请求路径有未配置的参数');
    return { apiPath: path, method: definition.request.method, query, body, headers };
}
function convert(value, column) {
    if (value === undefined || value === null || value === '') return null;
    if (column.type === 'number') { const n = Number(value); return Number.isFinite(n) ? n * column.scale + column.offset : null; }
    if (column.type === 'boolean') return value === true || value === 1 || value === '1' || value === 'true' ? true : value === false || value === 0 || value === '0' || value === 'false' ? false : null;
    return value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value).slice(0, 2000) : String(value).slice(0, 2000);
}
function mapRows(payload, definition, context) {
    let root = definition.rootPath ? readDataPath(payload, definition.rootPath) : payload;
    if (root === undefined) throw error('结果中找不到根节点');
    let rows = root == null ? [] : Array.isArray(root) ? root : [root];
    if (definition.match) {
        const value = matchValue(definition,context);
        if (value === '' || value == null) throw error('请先选择要查看的对象');
        rows = rows.filter(row => typeof value==='boolean' ? convert(readDataPath(row,definition.match.field),{type:'boolean'})===value : String(readDataPath(row, definition.match.field)) === String(value));
        if (rows.length > 1) throw error('当前对象匹配多条记录，请检查匹配字段');
    }
    const invalid = new Set();
    const mapped = rows.slice(0, 100).map(row => Object.fromEntries(definition.columns.map(c => {
        const raw = c.path === '$' ? row : readDataPath(row, c.path), value = convert(raw, c);
        if (raw === undefined || (raw !== null && raw !== '' && value === null)) invalid.add(c.label);
        return [c.name, value];
    })));
    return { rows: mapped, columns: definition.columns, quality: invalid.size ? 'bad' : mapped.length ? 'good' : 'empty', fetchedAt: new Date().toISOString(), error: invalid.size ? `字段缺失或类型不符：${[...invalid].join('、')}` : '', datasetId: definition.id, revision: definition.revision };
}
async function readDefinition(input, context, factoryId, force = false, inspect = false) {
    const definition = normalizeDataSet(input);
    if (!definition.enabled) throw error('数据集已停用');
    const sources = require('./dataSources'), connection = sources.resolveConnection(definition.connectionId, factoryId);
    if (inspect && definition.source === 'database') {
        const columns = await sources.listColumns(definition.connectionId, definition.database.schema, definition.database.table, factoryId);
        return { fields: columns.map(c=>({path:appendDataPath('',c.name),name:c.name,kind:/int|float|double|decimal|numeric|real/i.test(c.dataType)?'number':'string',sample:c.dataType})), roots:[], fetchedAt:new Date().toISOString() };
    }
    // Validate required row context before opening a connection or issuing SQL.
    if (!inspect && definition.match && (matchValue(definition,context) == null || matchValue(definition,context) === '')) throw error('请先选择要查看的对象或参数');
    const request = definition.source === 'http' ? resolveRequest(definition, context) : null;
    const key = crypto.createHash('sha256').update(JSON.stringify([factoryId, connection, definition.source, definition.refreshMs, request, definition.source === 'database' ? [definition.database, definition.columns, definition.match, context] : null])).digest('hex');
    let payload = force ? undefined : cache.get(key);
    if (payload === undefined) {
        if (!pending.has(key)) {
            if (pending.size >= 32) throw error('数据请求繁忙，请稍后再试', 429);
            const version = cache.version;
            const work = (definition.source === 'http' ? sources.fetchHttpApiPayload({ connectionId: definition.connectionId, ...request }, factoryId)
                : sources.readDataSetTable(definition, context, factoryId)).then(value => { const record = { payload: value, fetchedAt: new Date().toISOString() }; cache.set(key, record, Date.now() + definition.refreshMs, version); return record; }).finally(() => pending.delete(key));
            pending.set(key, work);
        }
        payload = await pending.get(key);
    }
    if (inspect) {
        const fields=[], roots=[];
        function walk(value,path='',depth=0,list=fields) {
            if (depth>5 || list.length>=80) return;
            if (Array.isArray(value)) { if(path) roots.push(path);if(value.length) walk(value[0],appendDataPath(path,0),depth+1,list); }
            else if(value && typeof value==='object') for(const [key,item] of Object.entries(value).slice(0,40)) walk(item,appendDataPath(path,key),depth+1,list);
            else list.push({path:path || '$',name:path.split('.').at(-1) || 'value',kind:value===null?'null':typeof value,sample:String(value??'null').slice(0,80)});
        }
        walk(payload.payload,'',0,[]);
        const selected=definition.rootPath?readDataPath(payload.payload,definition.rootPath):payload.payload;
        if(selected===undefined) throw error('结果中找不到根节点');
        walk(Array.isArray(selected)?selected[0]:selected);
        return {fields,roots:[...new Set(roots)],fetchedAt:payload.fetchedAt};
    }
    return { ...mapRows(payload.payload, definition, context), fetchedAt: payload.fetchedAt };
}
function bindingResult(result, binding) {
    const field = binding.datasetField, column = result.columns.find(c => c.name === field);
    if (!column) throw error('绑定字段不存在，请重新选择');
    const category = result.columns.find(c => c.role === 'category' || c.role === 'time');
    const rows = result.rows.map((row, index) => ({ ...row, value: row[field], time: category ? row[category.name] : index + 1, label: category ? String(row[category.name] ?? '') : String(index + 1) }));
    const valid = rows.map(row => row.value).filter(value => typeof value === 'number' && Number.isFinite(value));
    const mode = binding.datasetMode || 'first'; let value = rows[0]?.value ?? null;
    if (mode === 'count') value = rows.length;
    else if (['sum','avg','min','max'].includes(mode)) value = !valid.length ? null : mode === 'sum' || mode === 'avg' ? valid.reduce((a,b) => a+b, 0) / (mode === 'avg' ? valid.length : 1) : Math[mode](...valid);
    return { ...result, rows, value: result.quality === 'bad' ? null : value, unit: column.unit, series: [{ id: field, label: column.label, value, rows }] };
}
async function readDataSetBindings(widgets, context) {
    const definitions = await listDataSets(context.factoryId), result = {};
    // Bound work, including invalid bindings. Shared requests join the same promise.
    const targets = widgets.filter(w => w.data?.mode === 'dataset').slice(0, 100); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (next < targets.length) {
            const widget = targets[next++], binding = widget.data;
            try {
                const definition = definitions.find(d => d.id === binding.datasetId);
                if (!definition) throw error('数据集未配置，请重新绑定');
                const scoped = { ...context, ...(binding.deviceScope === 'fixed' ? { deviceId: binding.deviceId || '' } : {}) };
                result[widget.id] = bindingResult(await readDefinition(definition, scoped, context.factoryId), binding);
            } catch (cause) { result[widget.id] = { value: null, rows: [], series: [], quality: 'bad', error: cause.message, fetchedAt: new Date().toISOString() }; }
        }
    }));
    return result;
}
function matchValue(definition,context) { return definition.match?.contextKey === 'parameter' ? context.parameters?.[definition.match.parameterKey] : context[definition.match?.contextKey]; }
module.exports = { KEY, CONTEXT_KEYS, normalizeDataSet, listDataSets, saveDataSet, deleteDataSet, readDefinition, readDataSetBindings, bindingResult, mapRows, matchValue };
