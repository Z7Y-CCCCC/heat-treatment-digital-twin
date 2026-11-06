const crypto = require('node:crypto');
const { mergeBuiltinModels } = require('./builtinModels');
const { loadModelInspection, saveModelInspectionLayout } = require('./modelInspection');
const { canonicalJson, exactJsonEquals, exactTextEquals } = require('./deviceInspection');
const { normalizeLoadingPorts, normalizeLoadingPortOverrides, resolveLoadingPort } = require('../../shared/loadingPorts.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (message, statusCode = 400, code = 'LOADING_PORT_INVALID') => Object.assign(new Error(message), { statusCode, code });
const conflict = () => error('设备或模型配置已更新，请重新读取后保存；当前草稿仍保留', 409, 'LOADING_PORT_CONFLICT');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateRequest(loaded, body, key) {
    if (!object(body) || Object.keys(body).some(field => !['revision', key].includes(field)) || !Object.hasOwn(body, key)) {
        throw error(`仅可提交 revision 和 ${key}`);
    }
    if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw error('保存需要读取时的 revision', 428, 'LOADING_PORT_REVISION_REQUIRED');
    if (body.revision !== loaded.revision) throw conflict();
    return body[key];
}
function publicModelLoadingPorts(loaded) {
    return { success: true, model: loaded.model, ports: normalizeLoadingPorts(loaded.metadata.loadingPorts), revision: loaded.revision };
}
async function loadModelLoadingPorts(db, id, factoryId) {
    const loaded = await loadModelInspection(db, id, factoryId);
    normalizeLoadingPorts(loaded.metadata.loadingPorts);
    return loaded;
}
async function saveModelLoadingPorts(tx, loaded, body, factoryId, dialect) {
    const ports = normalizeLoadingPorts(validateRequest(loaded, body, 'ports'));
    return saveModelInspectionLayout(tx, loaded, { ...loaded.metadata, loadingPorts: ports }, factoryId, dialect);
}

function normalizeInstanceLoadingPorts(input) {
    if (input === undefined || input === null || input === '') return {};
    let instance = input;
    if (typeof input === 'string') {
        try { instance = JSON.parse(input); } catch { throw error('设备实例配置 JSON 格式不正确，未修改原配置'); }
    }
    if (!object(instance)) throw error('设备实例配置必须是对象，未修改原配置');
    return Object.hasOwn(instance, 'loadingPortOverrides')
        ? { ...instance, loadingPortOverrides: normalizeLoadingPortOverrides(instance.loadingPortOverrides) } : instance;
}
async function deviceFactoryScope(db, device, factoryId) {
    if (!device) return null;
    if (device.line_id) {
        const row = await db.get('SELECT 1 FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [device.line_id, factoryId]);
        return row ? { lineId: device.line_id } : null;
    }
    const instance = normalizeInstanceLoadingPorts(device.instance_config);
    const workshopId = instance.workshop_id || instance.workshopId;
    if (!workshopId || !await db.get('SELECT 1 FROM workshops WHERE id=? AND factory_id=?', [workshopId, factoryId])) return null;
    return { workshopId };
}
async function loadDeviceLoadingPorts(db, id, factoryId) {
    const device = await db.get('SELECT * FROM devices WHERE id=?', [id]);
    const scope = await deviceFactoryScope(db, device, factoryId);
    if (!scope) throw error('设备不存在或不属于当前工厂', 404, 'LOADING_PORT_DEVICE_NOT_FOUND');
    const models = mergeBuiltinModels(await db.all('SELECT * FROM models WHERE factory_id IS NULL OR factory_id=?', [factoryId]));
    const type = String(device.model_type || '').toLowerCase();
    const resolved = models.find(model => String(model.id).toLowerCase() === type)
        || models.find(model => device.model_file && model.file_path === device.model_file);
    if (!resolved) throw error('设备模型不存在或不属于当前工厂', 404, 'LOADING_PORT_MODEL_NOT_FOUND');
    const loaded = await loadModelLoadingPorts(db, resolved.id, factoryId);
    const instance = normalizeInstanceLoadingPorts(device.instance_config);
    const overrides = normalizeLoadingPortOverrides(instance.loadingPortOverrides);
    const ports = { version: 1, inlet: resolveLoadingPort(loaded.model, { instance_config: instance }, 'inlet'),
        outlet: resolveLoadingPort(loaded.model, { instance_config: instance }, 'outlet') };
    return { ...loaded, modelRevision: loaded.revision, device, instance, overrides, ports, scope,
        revision: hash([canonicalJson(device), loaded.revision]) };
}
function publicDeviceLoadingPorts(loaded, publicDevice = device => device) {
    return { success: true, device: publicDevice(loaded.device), model: loaded.model,
        ports: loaded.ports, overrides: loaded.overrides, revision: loaded.revision };
}
async function saveDeviceLoadingPorts(tx, loaded, body, factoryId, dialect) {
    const overrides = normalizeLoadingPortOverrides(validateRequest(loaded, body, 'overrides'));
    const serialized = JSON.stringify({ ...loaded.instance, loadingPortOverrides: overrides });
    const jsonParameter = value => ['mysql', 'postgres'].includes(dialect) ? canonicalJson(value) : value ?? '';
    const textColumns = ['instance_config', 'model_type', 'model_file', 'line_id', 'coordinate_space'];
    const numericColumns = ['pos_x', 'pos_y', 'pos_z', 'rotation_y', 'scale'];
    const predicates = textColumns.map(column => column === 'instance_config' ? exactJsonEquals(column, dialect) : exactTextEquals(column, dialect));
    const params = [serialized, loaded.device.id, ...textColumns.map(column => column === 'instance_config' ? jsonParameter(loaded.device[column]) : loaded.device[column] ?? '')];
    for (const column of numericColumns) {
        if (loaded.device[column] === null || loaded.device[column] === undefined) predicates.push(`${column} IS NULL`);
        else { predicates.push(`${column}=?`); params.push(loaded.device[column]); }
    }
    if (loaded.record) {
        const record = loaded.record;
        predicates.push(`EXISTS (SELECT 1 FROM models WHERE id=? AND (factory_id IS NULL OR factory_id=?)
            AND ${exactJsonEquals('metadata', dialect)} AND ${exactTextEquals('file_path', dialect)}
            AND ${exactTextEquals('placement_level', dialect)} AND ${exactTextEquals('asset_type', dialect)}
            AND ${record.default_scale == null ? 'default_scale IS NULL' : 'default_scale=?'})`);
        params.push(record.id, factoryId, jsonParameter(record.metadata), record.file_path ?? '', record.placement_level ?? '', record.asset_type ?? '');
        if (record.default_scale != null) params.push(record.default_scale);
    } else {
        predicates.push('NOT EXISTS (SELECT 1 FROM models WHERE id=? AND (factory_id IS NULL OR factory_id=?))');
        params.push(loaded.model.id, factoryId);
    }
    if (loaded.scope.lineId) {
        predicates.push('EXISTS (SELECT 1 FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?)');
        params.push(loaded.scope.lineId, factoryId);
    } else {
        predicates.push('EXISTS (SELECT 1 FROM workshops WHERE id=? AND factory_id=?)');
        params.push(loaded.scope.workshopId, factoryId);
    }
    const result = await tx.run(`UPDATE devices SET instance_config=? WHERE id=? AND ${predicates.join(' AND ')}`, params);
    if (!result?.changes && !result?.affectedRows) throw conflict();
    return loadDeviceLoadingPorts(tx, loaded.device.id, factoryId);
}

module.exports = { loadModelLoadingPorts, publicModelLoadingPorts, saveModelLoadingPorts,
    loadDeviceLoadingPorts, publicDeviceLoadingPorts, saveDeviceLoadingPorts, normalizeInstanceLoadingPorts };
