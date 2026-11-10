// A catalog of existing bindings, not a second acquisition engine. Only display
// metadata is stored here; deleting a category cannot delete a PLC point/table.
const crypto = require('node:crypto');
const { getDb } = require('../db/database');
const { listDataSets } = require('./dataSets');
const { mergeBuiltinModels } = require('./builtinModels');
const { effectiveInspection } = require('./deviceInspection');
const { deviceLineId } = require('./deviceLineUnits');
const { normalizeRecordTimestamp: timestamp } = require('./dataRecordTime');
const KEY = 'data_center_catalog_v1';
const DEFAULT_CATEGORIES = Object.freeze([
    { id: 'device', name: '设备资料', builtin: true },
    { id: 'realtime', name: '实时采集', builtin: true },
    { id: 'production', name: '生产业务', builtin: true },
    { id: 'alarms', name: '报警信息', builtin: true },
    { id: 'parts', name: '部件信息', builtin: true },
    { id: 'uncategorized', name: '未分类', builtin: true, protected: true }
]);
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const parseObject = value => { try { const result = typeof value === 'string' ? JSON.parse(value || '{}') : value; return object(result) ? result : {}; } catch { return {}; } };
const clone = value => JSON.parse(JSON.stringify(value));
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const stableId = (prefix, ...parts) => `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
const revisionOf = value => crypto.createHash('sha256').update(value ?? 'initial').digest('hex');
function deviceStatusText(status = {}) {
    if (status.quality === 'bad') return '数据异常 / 未连接';
    if (status.quality === 'stale') return '数据已过期';
    if (status.online === false) return '数据异常 / 未连接';
    return status.quality === 'good' ? '数据正常' : '暂无实时数据';
}
function previewQuality(live, point, frame) {
    let quality = ['good','bad','stale','unknown','disabled','empty'].includes(live?.quality) ? live.quality : 'unknown';
    if (frame?.deviceStatus?.online === false || frame?.deviceStatus?.quality === 'bad') quality = 'bad';
    else if (frame?.deviceStatus?.quality === 'stale') quality = 'stale';
    const updatedAt = timestamp(live?.lastReadAt);
    if (quality === 'good' && (!updatedAt || Date.parse(updatedAt) > Date.now() + 5000)) quality = 'unknown';
    else if (quality === 'good' && Date.now() - Date.parse(updatedAt) > Math.max(6000, Number(point.sample_interval_ms || 1000) * 3)) quality = 'stale';
    return { quality, lastReadAt: updatedAt };
}
function displayName(value, label = '名称') {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw error(`${label}请填写 1–100 个字符`);
    return value.trim();
}
function validateConfig(config) {
    if (!object(config) || config.version !== 1 || !Array.isArray(config.categories) || config.categories.length > 64
        || !object(config.overrides) || Object.keys(config.overrides).length > 32768) throw error('数据中心分类配置损坏，请从备份恢复', 500);
    const ids = new Set(), names = new Set();
    for (const c of config.categories) {
        if (!object(c) || Object.keys(c).some(k => !['id','name','builtin','protected'].includes(k)) || !idPattern.test(c.id) || ids.has(c.id)
            || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100 || /[\u0000-\u001f\u007f]/.test(c.name)
            || names.has(c.name.trim().toLocaleLowerCase()) || typeof c.builtin !== 'boolean' || c.protected != null && typeof c.protected !== 'boolean') throw error('数据中心分类配置损坏，请从备份恢复', 500);
        ids.add(c.id); names.add(c.name.trim().toLocaleLowerCase());
    }
    if (!config.categories.some(c => c.id === 'uncategorized' && c.protected === true)) throw error('数据中心缺少未分类保留分组，请从备份恢复', 500);
    for (const [id, value] of Object.entries(config.overrides)) if (!idPattern.test(id) || !object(value)
        || Object.keys(value).some(k => !['categoryId','label'].includes(k))
        || own(value, 'categoryId') && !ids.has(value.categoryId) || own(value, 'label') && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100 || /[\u0000-\u001f\u007f]/.test(value.label))) throw error('数据中心字段分类配置损坏，请从备份恢复', 500);
    return config;
}
async function store(factoryId, database = null) {
    const db = database || await getDb();
    const row = await db.get('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', [factoryId, KEY]);
    if (!row) return { db, value: null, revision: revisionOf(null), config: { version: 1, categories: clone(DEFAULT_CATEGORIES), overrides: {} } };
    let config;
    try { config = JSON.parse(row.value); } catch { throw error('数据中心分类配置损坏，请从备份恢复', 500); }
    return { db, value: row.value, revision: revisionOf(row.value), config: validateConfig(config) };
}
function checkRevision(state, revision) {
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw error('请先读取数据中心分类再保存', 428);
    if (revision !== state.revision) throw error('数据中心分类已被其他页面更新，请刷新后重试', 409);
}
async function commit(state, factoryId) {
    validateConfig(state.config);
    const value = JSON.stringify(state.config);
    if (Buffer.byteLength(value) > 1024 * 1024) throw error('数据中心分类配置超过 1 MB');
    if (state.value === null) {
        try { await state.db.run('INSERT INTO factory_settings (factory_id,`key`,value) VALUES (?,?,?)', [factoryId, KEY, value]); }
        catch { throw error('数据中心分类已更新，请刷新后重试', 409); }
    } else {
        const result = await state.db.run('UPDATE factory_settings SET value=? WHERE factory_id=? AND `key`=? AND value=?', [value, factoryId, KEY, state.value]);
        if (!result.changes && !result.affectedRows) throw error('数据中心分类已更新，请刷新后重试', 409);
    }
    return revisionOf(value);
}
async function scopedDevices(db, factoryId, deviceId = '') {
    const workshops = await db.all('SELECT id,name FROM workshops WHERE factory_id=? ORDER BY sort_order,id', [factoryId]);
    const lines = await db.all('SELECT l.id,l.name,l.workshop_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? ORDER BY l.sort_order,l.id', [factoryId]);
    const byWorkshop = new Map(workshops.map(w => [String(w.id), w])), byLine = new Map(lines.map(l => [String(l.id), l]));
    const rows = deviceId ? [await db.get('SELECT * FROM devices WHERE id=?', [deviceId])].filter(Boolean)
        : await db.all('SELECT * FROM devices ORDER BY line_id,sort_order,id');
    const devices = rows.flatMap(d => {
        const instance = parseObject(d.instance_config), lineId = deviceLineId(d, instance);
        // Primary/rail/lane association follows the same precedence as the scene.
        // A foreign association can never be rescued by a local workshop override.
        if (lineId && !byLine.has(String(lineId))) return [];
        const line = byLine.get(String(lineId));
        const workshop = byWorkshop.get(String(line?.workshop_id || instance.workshop_id || instance.workshopId || ''));
        return workshop ? [{ ...d, id: String(d.id), lineId: String(line?.id || ''), lineName: line?.name || '', workshopId: String(workshop.id), workshopName: workshop.name }] : [];
    }).slice(0, 5000);
    if (deviceId && !devices.length) throw error('设备不存在或不属于当前工厂', 404);
    return devices;
}
async function buildCatalog(factoryId, deviceId = '', state = null, previewDeviceId = '', options = {}) {
    state ||= await store(factoryId);
    const db = state.db, devices = await scopedDevices(db, factoryId, deviceId);
    const previewDevice = previewDeviceId ? devices.find(d => d.id === String(previewDeviceId)) : devices[0] || null;
    if (previewDeviceId && !previewDevice) throw error('预览设备不存在或不属于当前工厂 / 范围', 404);
    const tables = [], items = [], tableIds = new Set();
    const categoryIds = new Set(state.config.categories.map(c => c.id));
    const category = id => categoryIds.has(id) ? id : 'uncategorized';
    function table(value) { tableIds.add(value.id); tables.push({ enabled: true, description: '', ...value, categoryId: category(value.categoryId) }); }
    function item(value) {
        const override = state.config.overrides[value.id] || {};
        items.push({ previewValue: null, quality: 'unknown', unit: '', enabled: true, ...value,
            sourceLabel: value.sourceLabel || (value.sourceType === 'plc' ? '设备采集' : value.sourceType === 'dataset' ? '外部数据表' : '内部资料'),
            label: override.label || value.label, categoryId: category(override.categoryId || value.categoryId) });
    }
    table({ id:'internal_events', name:'报警／事件记录', sourceType:'internal', categoryId:'alarms', objectScope:'factory', description:'当前工厂已实际保存的报警及事件；只读，不生成示例报警' });
    item({ id:'internal_event_records', tableId:'internal_events', label:'报警／事件列表', categoryId:'alarms', sourceType:'internal', type:'array', objectScope:'factory',
        binding:{ mode:'runtime', path:'events', deviceScope:'global', readOnly:true } });
    if (devices.length) {
        table({ id: 'internal_devices', name: '设备资料', sourceType: 'internal', categoryId: 'device', objectScope: 'device', description: '来自设备管理，名称和所属关系随当前设备变化' });
        const fields = [
            ['name', '设备名称', 'deviceInfo.name', 'hover.device.name', previewDevice.name],
            ['id', '设备编号', 'deviceInfo.id', 'hover.device.id', previewDevice.id],
            ['model', '模型标识', 'deviceInfo.modelName', 'hover.device.modelName', previewDevice.model_type],
            ['workshop', '所属车间', 'deviceInfo.workshopName', 'hover.device.workshopName', previewDevice.workshopName],
            ['line', '所属产线', 'deviceInfo.lineName', 'hover.device.lineName', previewDevice.lineName]
        ];
        for (const [key, label, path, hoverPath, previewValue] of fields) item({ id: `internal_device_${key}`, tableId: 'internal_devices', label, categoryId: 'device', sourceType: 'internal', type: 'string', objectScope: 'device', previewValue: previewValue || null, quality: previewValue ? 'good' : 'empty',
            binding: { mode: 'runtime', path, deviceScope: 'current' }, tooltipBinding: { mode: 'runtime', path: hoverPath, deviceScope: 'current' } });
        table({ id: 'internal_connection', name: '设备连接状态', sourceType: 'internal', categoryId: 'realtime', objectScope: 'device', description: '数据质量由采集系统提供，不能改成固定文案' });
        item({ id: 'internal_device_status', tableId: 'internal_connection', label: '数据状态', categoryId: 'realtime', sourceType: 'internal', type: 'string', objectScope: 'device',
            binding: { mode: 'runtime', path: 'deviceInfo.dataStatus', deviceScope: 'current' }, tooltipBinding: { mode: 'runtime', path: 'hover.device.status', deviceScope: 'current' } });
    }
    const allPoints = [];
    for (let offset = 0; offset < devices.length; offset += 400) {
        const ids = devices.slice(offset, offset + 400).map(d => d.id);
        allPoints.push(...await db.all(`SELECT * FROM data_points WHERE device_id IN (${ids.map(() => '?').join(',')}) ORDER BY device_id,id`, ids));
    }
    const readable = allPoints.filter(p => String(p.access_type || 'READ').toUpperCase() === 'READ');
    const runtime = new Map();let previewFrame = null;
    // Fetch only the selected sample's existing owned live frame. Definitions'
    // saved quality/value are never evidence of a healthy current reading.
    if (options.runtimePreview !== false && previewDevice && global.dataEngine?.getPointRuntimeValues) {
        try {
            const frame = await global.dataEngine.getPointRuntimeValues(previewDevice.id, readable.filter(p => String(p.device_id) === previewDevice.id), factoryId);
            if (frame?.deviceStatus?.deviceId && String(frame.deviceStatus.deviceId) !== previewDevice.id) throw new Error('预览设备与采集帧不匹配');
            previewFrame = frame;
            for (const p of frame.points || []) if (String(p.device_id ?? previewDevice.id) === previewDevice.id) runtime.set(String(p.id), p);
            const status = items.find(i => i.id === 'internal_device_status');
            if (status) { status.previewValue = deviceStatusText(frame.deviceStatus); status.quality = frame.deviceStatus?.quality || 'unknown'; }
        } catch { /* The catalog remains available during acquisition outages. */ }
    }
    const byDevice = new Map(devices.map(d => [d.id, d]));
    for (const p of readable.slice(0, 20000)) {
        const device = byDevice.get(String(p.device_id));
        const pointKey = `${p.category || p.category_resolved || 'analog'}.${p.value_role || p.field_name || p.name}`;
        const categoryId = p.category === 'alarm' || /^alarm(?:_|$)/.test(p.point_kind || '') || p.alarm_record_role || /^bj\d+$/i.test(p.name || '') ? 'alarms' : 'realtime';
        const tableId = stableId('plc', device.id);
        if (!tableIds.has(tableId)) table({ id: tableId, name: `${device.name || device.id} · 采集点位`, sourceType: 'plc', categoryId: 'realtime', objectScope: 'device', deviceId: device.id, deviceName: device.name, description: `${device.workshopName}${device.lineName ? ' / ' + device.lineName : ''}` });
        const live = runtime.get(String(p.id)), { quality,lastReadAt } = previewQuality(live, p, String(p.device_id) === previewDevice?.id ? previewFrame : null);
        const pointDataType = String(p.data_type || '').toUpperCase();
        item({ id: stableId('point', p.id), tableId, label: p.label || p.display_name || p.name, categoryId, sourceType: 'plc', type: pointDataType === 'BOOL' ? 'boolean' : ['STRING','CHAR','DT','DTZ','DTL','DTLZ'].includes(pointDataType) ? 'string' : 'number', unit: p.unit || '', objectScope: 'device', deviceId: device.id, deviceName: device.name, pointKey,
            previewValue: quality === 'good' ? live?.value ?? null : null, quality, plcAddress:p.plc_tag || '', lastReadAt,
            binding: { mode: 'plc', pointId: String(p.id), deviceId: device.id, pointKey, path: pointKey, deviceScope: 'fixed', requireConfiguredPoint: true },
            tooltipBinding: { mode: 'plc', pointKey, path: pointKey, deviceScope: 'current', requireConfiguredPoint: true } });
    }
    const models = mergeBuiltinModels(await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id=?', [factoryId]));
    let previewPart = null;const catalogParts=[];
    for (const device of devices) {
        const model = models.find(m => String(m.id).toLowerCase() === String(device.model_type || '').toLowerCase()) || models.find(m => device.model_file && m.file_path === device.model_file);
        if (!model) continue;
        const metadata = parseObject(model.metadata), instance = parseObject(device.instance_config);
        try {
            const parts=effectiveInspection(metadata, instance).inspection.parts || [];
            catalogParts.push(...parts);
            if (device.id === previewDevice?.id) previewPart=parts[0] || null;
        } catch { /* Invalid authored inspection is not a data source. */ }
    }
    if (catalogParts.length) {
        table({ id: 'internal_parts', name: '部件资料', sourceType: 'internal', categoryId: 'parts', objectScope: 'part', description: '来自已有拆解模型，随当前悬停部件变化' });
        for (const [key, label] of [['name','部件名称'],['id','部件编号'],['group','部件分组'],['description','部件说明']]) item({ id: `internal_part_${key}`, tableId: 'internal_parts', label, categoryId: 'parts', sourceType: 'internal', type: 'string', objectScope: 'part', previewValue: previewPart?.[key] || null, quality: previewPart?.[key] ? 'good' : 'empty',
            binding: { mode: 'runtime', path: `selectedPart.${key}`, deviceScope: 'current' }, tooltipBinding: { mode: 'runtime', path: `hover.part.${key}`, deviceScope: 'current' } });
        const slots=Math.min(12,catalogParts.reduce((max,part)=>Math.max(max,(part.point_ids || part.pointIds || []).length),0));
        for(let index=0;index<slots;index++){
            const representative=catalogParts.map(part=>(part.point_ids || part.pointIds || [])[index]).map(id=>readable.find(point=>String(point.id)===String(id))).find(Boolean);
            item({id:`internal_part_point_${index}`,tableId:'internal_parts',label:`当前部件采集参数 ${index+1}`,categoryId:'parts',sourceType:'internal',type:pointTypeForPart(representative),objectScope:'part',description:'读取当前所选部件已配置点位的对应项；未配置时为空',
                binding:{mode:'runtime',path:`selectedPart.points.${index}.value`,unitPath:`selectedPart.points.${index}.unit`,deviceScope:'current'},tooltipBinding:{mode:'runtime',path:`hover.part.points.${index}.value`,unitPath:`hover.part.points.${index}.unit`,deviceScope:'current'}});
        }
    }
    const sourceConnections = new Map(require('./dataSources').listDataSources(factoryId).connections.map(connection => [connection.id, connection]));
    for (const dataset of await listDataSets(factoryId, db)) {
        // Never publish request headers, connection secrets or arbitrary paths
        // through the novice-facing catalog. Only prepared column metadata.
        const contextKeys = new Set([dataset.match?.contextKey, ...(dataset.request?.parameters || []).filter(p => p.source === 'context').map(p => p.key)].filter(Boolean));
        const objectScope = contextKeys.has('partId') ? 'part' : [...contextKeys].some(k => ['deviceId','lineId','workshopId'].includes(k)) ? 'device' : 'factory';
        const scope = objectScope === 'factory' ? 'global' : 'current';
        const connection = sourceConnections.get(dataset.connectionId);
        const compatible = connection && (dataset.source === 'http') === (connection.sourceType === 'http_api');
        // Configuration readiness is not a health claim. Listing never opens
        // the source, issues an HTTP request or labels configured data as good.
        const sourceReady = !!connection && connection.enabled !== false && compatible;
        const enabled = dataset.enabled !== false && sourceReady;
        const quality = dataset.enabled === false || connection?.enabled === false ? 'disabled' : sourceReady ? 'configured' : 'config_error';
        const sourceError = dataset.enabled === false ? '数据表已停用，可在数据表接入设置中启用'
            : !connection ? '来源连接未配置或已移除，请先在数据源中重新接入'
            : connection.enabled === false ? '来源连接已停用，请先在数据源中启用'
            : !compatible ? '数据表与来源连接类型不一致，请检查数据表接入设置' : '';
        // The catalog grant does not imply permission to read external records.
        // The selected table's UI can request a real sample through /records,
        // where the source-read grant and any required object scope are checked.
        const previewState = 'not_read';
        const previewHint = sourceError || (objectScope === 'part'
            ? '尚未读取实际样本；请选择设备和部件，并确认具有数据表读取权限'
            : objectScope === 'device'
                ? '尚未读取实际样本；请选择对应设备，并确认具有数据表读取权限'
                : '尚未读取实际样本；需具有数据表读取权限，实际值以读取结果为准');
        const tableId = stableId('dataset', dataset.id);
        table({ id: tableId, datasetId: dataset.id, datasetRevision: dataset.revision, name: dataset.name, sourceType: 'dataset', sourceLabel: dataset.source === 'http' ? '接口 / 文件' : '外部数据库', categoryId: 'uncategorized', objectScope, enabled, sourceReady, quality, sourceError, previewState, previewHint, description: sourceError || '已整理字段，可在设计器直接选取；对象参数沿用数据表映射，实际读取状态以预览为准' });
        for (const column of dataset.columns || []) item({ id: stableId('field', dataset.id, column.name), tableId, datasetId: dataset.id, datasetRevision: dataset.revision, label: column.label || column.name, fieldName: column.name, fieldRole: column.role || '', categoryId: 'uncategorized', sourceType: 'dataset', type: column.type, unit: column.unit || '', objectScope, enabled, sourceReady, sourceError, quality, previewState, previewHint,
            binding: { mode: 'dataset', datasetId: dataset.id, datasetField: column.name, datasetMode: 'first', deviceScope: scope },
            tooltipBinding: { mode: 'dataset', datasetId: dataset.id, datasetField: column.name, datasetMode: 'first', deviceScope: scope } });
    }
    const fieldCounts = new Map();
    for (const i of items) fieldCounts.set(i.tableId, (fieldCounts.get(i.tableId) || 0) + 1);
    for (const t of tables) t.fieldCount = fieldCounts.get(t.id) || 0;
    return { success: true, revision: state.revision, categories: clone(state.config.categories), tables, items,
        devices: devices.map(d => ({ id: d.id, name: d.name, workshopName: d.workshopName, lineName: d.lineName })),
        previewDevice: previewDevice ? { id: previewDevice.id, name: previewDevice.name } : null, factoryId };
}
function pointTypeForPart(point){const type=String(point?.data_type || '').toUpperCase();return type==='BOOL'?'boolean':['STRING','CHAR','DT','DTZ','DTL','DTLZ'].includes(type)?'string':'number'}
async function saveCategory(input, factoryId) {
    if (!object(input) || Object.keys(input).some(k => !['id','name','revision'].includes(k))) throw error('分类只允许修改名称');
    const state = await store(factoryId); checkRevision(state, input.revision);
    const name = displayName(input.name, '分类名称');
    const current = input.id ? state.config.categories.find(c => c.id === input.id) : null;
    if (input.id && !current) throw error('分类不存在', 404);
    if (current?.id === 'uncategorized') throw error('未分类是系统保留分类，不能修改');
    if (state.config.categories.some(c => c.name.toLocaleLowerCase() === name.toLocaleLowerCase() && c.id !== input.id)) throw error('分类名称已存在');
    if (!current && state.config.categories.length >= 64) throw error('每个工厂最多 64 个分类');
    const category = current || { id: `category_${crypto.randomUUID()}`, builtin: false };
    category.name = name;
    if (!current) state.config.categories.push(category);
    return { success: true, category: clone(category), categories: clone(state.config.categories), revision: await commit(state, factoryId) };
}
async function deleteCategory(id, revision, factoryId) {
    const state = await store(factoryId); checkRevision(state, revision);
    if (id === 'uncategorized') throw error('未分类是系统保留分类，不能删除');
    if (!state.config.categories.some(c => c.id === id)) throw error('分类不存在', 404);
    // Snapshot every affected field including automatic defaults, otherwise a
    // renamed/recreated default could reattach fields after deletion.
    const catalog = await buildCatalog(factoryId, '', state);
    const affected = catalog.items.filter(i => i.categoryId === id);
    for (const item of affected) state.config.overrides[item.id] = { ...(state.config.overrides[item.id] || {}), categoryId: 'uncategorized' };
    for (const entry of Object.values(state.config.overrides)) if (entry.categoryId === id) entry.categoryId = 'uncategorized';
    state.config.categories = state.config.categories.filter(c => c.id !== id);
    return { success: true, movedCount: affected.length, categories: clone(state.config.categories), revision: await commit(state, factoryId) };
}
async function saveItem(id, input, factoryId) {
    if (!object(input) || Object.keys(input).some(k => !['categoryId','label','revision'].includes(k)) || !own(input, 'categoryId') && !own(input, 'label')) throw error('数据项只允许修改显示名称和用途分类，不能修改数据绑定');
    const state = await store(factoryId); checkRevision(state, input.revision);
    if (!idPattern.test(id) || !(await buildCatalog(factoryId, '', state)).items.some(i => i.id === id)) throw error('数据项不存在或来源已移除', 404);
    if (own(input, 'categoryId') && !state.config.categories.some(c => c.id === input.categoryId)) throw error('用途分类不存在');
    const override = state.config.overrides[id] || {};
    if (own(input, 'categoryId')) override.categoryId = input.categoryId;
    if (own(input, 'label')) override.label = displayName(input.label, '数据显示名称');
    state.config.overrides[id] = override;
    return { success: true, item: { id, ...override }, revision: await commit(state, factoryId) };
}
module.exports = { buildCatalog, loadCatalogState: store, saveCategory, deleteCategory, saveItem, DEFAULT_CATEGORIES, stableId, scopedDevices, validateConfig };
