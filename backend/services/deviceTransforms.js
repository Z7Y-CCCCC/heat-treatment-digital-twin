const { TRANSFORM_FIELDS, LAYOUT_CONFIG_FIELDS } = require('../../shared/deviceAuthoring.mjs');
const { normalizeDeviceGround } = require('../../shared/industrialGround.mjs');
const { assertDeviceLineUnits } = require('./deviceLineUnits');
function parseJson(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return {};
    }
}

async function deviceBelongsToFactory(db, device, factoryId) {
    if (!device) return false;
    if (device.line_id) {
        return Boolean(await db.get(`SELECT 1 FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
            WHERE l.id = ? AND w.factory_id = ?`, [device.line_id, factoryId]));
    }
    const config = parseJson(device.instance_config);
    const workshopId = config.workshop_id || config.workshopId;
    return Boolean(workshopId && await db.get('SELECT 1 FROM workshops WHERE id = ? AND factory_id = ?', [workshopId, factoryId]));
}

async function lineBelongsToFactory(db, lineId, factoryId) {
    return !lineId || Boolean(await db.get(`SELECT 1 FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
        WHERE l.id = ? AND w.factory_id = ?`, [lineId, factoryId]));
}

function isAuxiliaryDevice(modelType, instanceConfig) {
    const config = parseJson(instanceConfig);
    return modelType === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true;
}

function validateTransform(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => ![...TRANSFORM_FIELDS, 'layoutConfig', 'ground'].includes(key))) throw new Error('布局包含不可修改字段');
    if (body.ground !== undefined) {
        const g = body.ground;
        if (!g || Array.isArray(g) || typeof g.enabled !== 'boolean' || Object.keys(g).some(key => !['enabled', 'width', 'depth', 'clearance'].includes(key))
            || ['width', 'depth', 'clearance'].some(key => typeof g[key] !== 'number' || !Number.isFinite(g[key]) || g[key] < (key === 'clearance' ? 0 : .2) || g[key] > (key === 'clearance' ? 20 : 500))) throw new Error('设备地面尺寸无效');
    }
    const layout = body.layoutConfig || {};
    if (typeof layout !== 'object' || Array.isArray(layout) || Object.keys(layout).some(key => !LAYOUT_CONFIG_FIELDS.includes(key)
        || layout[key] !== null && !['string', 'number', 'boolean'].includes(typeof layout[key])
        || typeof layout[key] === 'string' && layout[key].length > 160
        || typeof layout[key] === 'number' && !Number.isFinite(layout[key]))) throw new Error('布局配置格式无效');
    for (const key of TRANSFORM_FIELDS.filter(k => !['line_id', 'coordinate_space'].includes(k))) {
        if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || Math.abs(body[key]) > 100000
            || key === 'scale' && (body[key] <= 0 || body[key] > 1000))) throw new Error('布局数值无效');
    }
    if (body.line_id !== undefined && body.line_id !== null && (typeof body.line_id !== 'string' || body.line_id.length > 120)) throw new Error('产线 ID 无效');
    if (body.coordinate_space !== undefined && !['line_local', 'workshop_local'].includes(body.coordinate_space)) throw new Error('坐标空间无效');
}
async function applyTransform(tx, id, body, factoryId) {
    const device = await tx.get('SELECT * FROM devices WHERE id = ?', [id]);
    if (!await deviceBelongsToFactory(tx, device, factoryId)) throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
    const lineId = body.line_id === undefined ? device.line_id : body.line_id;
    if (!await lineBelongsToFactory(tx, lineId, factoryId) || !lineId && !isAuxiliaryDevice(device.model_type, device.instance_config)) throw new Error('产线不属于当前工厂');
    const config = parseJson(device.instance_config);
    if (body.ground !== undefined) config.ground = normalizeDeviceGround(body.ground);
    for (const [key, value] of Object.entries(body.layoutConfig || {})) { if (value === null) delete config[key]; else config[key] = value; }
    for (const key of ['workshop_id', 'workshopId']) if (config[key] && !await tx.get('SELECT id FROM workshops WHERE id = ? AND factory_id = ?', [config[key], factoryId])) throw new Error('车间不属于当前工厂');
    for (const key of ['laneLineId', 'railLineId']) if (config[key] && !await lineBelongsToFactory(tx, config[key], factoryId)) throw new Error('绑定产线不属于当前工厂');
    await assertDeviceLineUnits(tx, { ...device, line_id: lineId }, config, factoryId);
    const fields = TRANSFORM_FIELDS.filter(key => body[key] !== undefined);
    await tx.run(`UPDATE devices SET ${fields.map(key => `${key}=?`).concat('instance_config=?').join(',')} WHERE id=?`,
        [...fields.map(key => body[key]), JSON.stringify(config), id]);
    return { id, ...Object.fromEntries(TRANSFORM_FIELDS.map(key => [key, body[key] === undefined ? device[key] : body[key]])), instance_config: JSON.stringify(config) };
}

module.exports = { validateTransform, applyTransform, deviceBelongsToFactory };
