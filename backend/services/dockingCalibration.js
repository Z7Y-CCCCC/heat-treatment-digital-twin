const { loadDeviceLoadingPorts } = require('./loadingPorts');
const { canonicalJson, exactJsonEquals, exactTextEquals } = require('./deviceInspection');
const { normalizeLineLayout } = require('../utils/spatialLayout');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'DOCKING_CALIBRATION_INVALID' });
const conflict = () => fail('校准来源已更新，请重新预览；没有移动设备', 409);
const numeric = ['pos_x', 'pos_y', 'pos_z', 'rotation_y', 'scale'];
const text = ['model_type', 'model_file', 'line_id', 'coordinate_space'];
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function fields(v, names) { if (!object(v) || Object.keys(v).some(k => !names.includes(k)) || names.some(k => !Object.hasOwn(v, k))) throw fail('校准请求字段无效'); }
function validateDockingCalibration(body) {
    fields(body, ['deviceId', 'cartId', 'deviceRevision', 'cartRevision', 'expectedLine', 'position']);
    for (const key of ['deviceId', 'cartId']) if (typeof body[key] !== 'string' || !body[key] || body[key].length > 120) throw fail('请选择工位和小车');
    if (body.deviceId === body.cartId) throw fail('工位与小车不能是同一设备');
    for (const key of ['deviceRevision', 'cartRevision']) if (!/^[a-f0-9]{64}$/.test(body[key])) throw fail('需要预览时的设备与小车快照', 428);
    fields(body.expectedLine, ['id', 'workshop_id', 'layout_json']);
    if (['id', 'workshop_id'].some(k => typeof body.expectedLine[k] !== 'string' || !body.expectedLine[k] || body.expectedLine[k].length > 120)) throw fail('产线来源无效');
    canonicalJson(body.expectedLine.layout_json);
    fields(body.position, ['x', 'y']);
    if (Object.values(body.position).some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 100000)) throw fail('校准位置必须是有限数字');
}
async function saveDockingCalibration(tx, body, factoryId, dialect) {
    validateDockingCalibration(body);
    const line = await tx.get('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [body.expectedLine.id, factoryId]);
    if (!line) throw fail('产线不存在或不属于当前工厂', 404);
    if (line.workshop_id !== body.expectedLine.workshop_id || canonicalJson(normalizeLineLayout(line.layout_json)) !== canonicalJson(normalizeLineLayout(body.expectedLine.layout_json))) throw conflict();
    const target = await loadDeviceLoadingPorts(tx, body.deviceId, factoryId), cart = await loadDeviceLoadingPorts(tx, body.cartId, factoryId);
    if (target.revision !== body.deviceRevision || cart.revision !== body.cartRevision) throw conflict();
    const layout = normalizeLineLayout(line.layout_json);
    for (const loaded of [target, cart]) {
        if (loaded.device.coordinate_space !== 'line_local' || loaded.device.line_id && loaded.device.line_id !== line.id || ![loaded.device.line_id, loaded.instance.laneLineId, loaded.instance.railLineId].includes(line.id)) throw fail('只能校准同产线本地坐标的工位和小车');
    }
    for (const axis of ['x','y']) if (body.position[axis] !== target.device['pos_' + axis] && Math.fround(body.position[axis]) === Math.fround(target.device['pos_' + axis])) throw fail('场景坐标精度不足，Unity 无法区分该非零位移');
    const lane = layout.lanes.find(r => r.id === target.instance.laneId);
    const nearest = lane && layout.rails.slice().sort((a, b) => Math.abs(a.offsetZ - lane.offsetZ) - Math.abs(b.offsetZ - lane.offsetZ))[0];
    const mobile = ['transfer_cart', 'auxiliary'].includes(cart.instance.role) || object(cart.instance.movement) || cart.device.model_type === 'transfer_cart';
    if (!lane || !nearest || nearest.id !== cart.instance.railId || target.instance.railId || !mobile) throw fail('请选择已放置工位及其最近导轨上的移动小车');
    const json = v => ['mysql', 'postgres'].includes(dialect) ? canonicalJson(v) : v ?? '';
    const params = [body.position.x, body.position.y, target.device.id], predicates = [];
    function devicePredicates(device, prefix) {
        const clauses = [];
        for (const k of text) { clauses.push(exactTextEquals(prefix + k, dialect)); params.push(device[k] ?? ''); }
        clauses.push(exactJsonEquals(prefix + 'instance_config', dialect)); params.push(json(device.instance_config));
        for (const k of numeric) {
            if (device[k] == null) clauses.push(`${prefix}${k} IS NULL`);
            else { clauses.push(`${prefix}${k}=?`); params.push(device[k]); }
        }
        return clauses;
    }
    predicates.push(...devicePredicates(target.device, ''));
    // The cart is a read-only reference. Its pose/configuration must still be
    // unchanged at the committed write, but no cart field is written.
    params.push(cart.device.id);
    // MySQL forbids updating a table selected directly by a subquery (1093).
    // LIMIT makes this one-row derived reference non-mergeable/materialized.
    predicates.push(`EXISTS (SELECT 1 FROM (SELECT * FROM devices WHERE id=? LIMIT 1) c WHERE ${devicePredicates(cart.device, 'c.').join(' AND ')})`);
    for (const loaded of [target, cart]) {
        if (loaded.record) {
            const record = loaded.record;
            params.push(record.id, factoryId, record.file_path ?? '', json(record.metadata), record.placement_level ?? '', record.asset_type ?? '');
            predicates.push(`EXISTS (SELECT 1 FROM models m WHERE m.id=? AND (m.factory_id IS NULL OR m.factory_id=?) AND ${exactTextEquals('m.file_path', dialect)} AND ${exactJsonEquals('m.metadata', dialect)} AND ${exactTextEquals('m.placement_level', dialect)} AND ${exactTextEquals('m.asset_type', dialect)} AND ${record.default_scale == null ? 'm.default_scale IS NULL' : 'm.default_scale=?'})`);
            if (record.default_scale != null) params.push(record.default_scale);
        } else {
            params.push(loaded.model.id, factoryId);
            predicates.push('NOT EXISTS (SELECT 1 FROM models m WHERE m.id=? AND (m.factory_id IS NULL OR m.factory_id=?))');
        }
    }
    params.push(line.id, factoryId, line.workshop_id, json(line.layout_json));
    predicates.push(`EXISTS (SELECT 1 FROM \`lines\` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=? AND ${exactTextEquals('l.workshop_id', dialect)} AND ${exactJsonEquals('l.layout_json', dialect)})`);
    const result = await tx.run(`UPDATE devices SET pos_x=?,pos_y=? WHERE id=? AND ${predicates.join(' AND ')}`, params);
    if (!result?.changes && !result?.affectedRows) throw conflict();
    return [await tx.get('SELECT * FROM devices WHERE id=?', [body.deviceId])];
}
module.exports = { validateDockingCalibration, saveDockingCalibration };
