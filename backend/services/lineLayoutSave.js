const { normalizeLineLayout, safeObject } = require('../utils/spatialLayout');
const { lineRailSpacingDeltas, shiftRailMovement, assertLineMovementUnits } = require('../../shared/lineRailSpacing.mjs');
const { assertLineTemplateTransition } = require('../../shared/linePlacementTemplate.mjs');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const validNumber = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000;

// Called by the existing line-save route inside one transaction. No point,
// animation binding, model, or acquisition setting is edited here.
async function saveLineLayout(tx, id, factoryId, body) {
    const current = await tx.get('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [id, factoryId]);
    if (!current) fail('产线不存在', 404);
    const workshopId = body.workshop_id ?? current.workshop_id;
    if (!await tx.get('SELECT id FROM workshops WHERE id=? AND factory_id=?', [workshopId, factoryId])) fail('所选车间不属于当前工厂');
    const before = normalizeLineLayout(current.layout_json), next = normalizeLineLayout(body.layout_json ?? body.layout ?? current.layout_json);
    assertLineTemplateTransition(before, next);
    if (body.expectedLayout !== undefined && !same(before, normalizeLineLayout(body.expectedLayout))) fail('产线结构已被更新，请重新读取后保存', 409);
    const requested = body.devicePositions;
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > 1000)) fail('产线设备位置批次无效');
    const positions = new Map();
    for (const row of requested || []) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'pos_x', 'pos_z', 'expected'].includes(key))
            || typeof row.id !== 'string' || !row.id || !validNumber(row.pos_x) || !validNumber(row.pos_z) || positions.has(row.id)) fail('产线设备位置必须有唯一设备 ID 和有效坐标');
        positions.set(row.id, row);
    }
    const deltas = new Map(lineRailSpacingDeltas(before, next).map(row => [String(row.railId), row.deltaZ]));
    const candidates = await tx.all("SELECT * FROM devices WHERE line_id=? OR line_id IS NULL OR line_id=''", [current.id]);
    const saved = [];
    for (const device of candidates) {
        const instance = safeObject(device.instance_config), railBound = String(instance.railLineId || device.line_id || '') === String(current.id) && !!instance.railId;
        const laneBound = String(instance.laneLineId || device.line_id || '') === String(current.id) && !!instance.laneId;
        const hasLine = !!device.line_id, workshop = instance.workshop_id || instance.workshopId;
        const owned = hasLine ? String(device.line_id) === String(current.id) : !!workshop && String(workshop) === String(current.workshop_id);
        const associatedLineId = device.line_id || instance.railLineId || instance.laneLineId;
        const movement = safeObject(instance.movement), active = movement.enabled === true || instance.animationBindings?.transferLink?.enabled === true;
        // Unit checks follow explicit line ownership, not a guessed rail. A
        // source waiting for its first rail/lane binding may not bypass them.
        if (owned && String(associatedLineId || '') === String(current.id) && active) assertLineMovementUnits(instance.movement, next, device.name || device.id);
        const row = positions.get(String(device.id));
        if (!owned || !railBound && !laneBound) {
            if (row) fail('设备不属于当前产线的明确设备线或导轨绑定');
            continue;
        }
        const items = (railBound ? next.rails : next.lanes).filter(item => String(item.id) === String(railBound ? instance.railId : instance.laneId));
        const item = items.length === 1 ? items[0] : null;
        // Validate every owned active bound source even for a name-only or
        // zero-delta save. A field declaration cannot change its physical units
        // by bypassing the carrier-position update path.
        if (active) {
            if (!item) fail('设备关联的设备线或导轨不存在或编号重复，请在现有产线结构中重新绑定');
        }
        const railDelta = railBound ? deltas.get(String(instance.railId)) || 0 : 0;
        const oldLane = laneBound && before.lanes.find(lane => lane.id === instance.laneId);
        const laneDelta = next.placementTemplate && oldLane && item ? item.offsetZ - oldLane.offsetZ : 0;
        if (!row && railDelta === 0 && laneDelta === 0) continue;
        if (!item) fail('设备关联的设备线或导轨已不存在，请先重新绑定设备');
        if (device.coordinate_space && device.coordinate_space !== 'line_local') fail('设备位置不是产线本地坐标，请先在设备编排中校准后保存产线结构');
        if (row?.expected && (!validNumber(row.expected.pos_x) || !validNumber(row.expected.pos_z)
            || Math.abs(Number(device.pos_x) - row.expected.pos_x) > .0000001 || Math.abs(Number(device.pos_z) - row.expected.pos_z) > .0000001)) fail('设备位置已被更新，请重新读取后保存', 409);
        const x = row ? row.pos_x : Number(device.pos_x), z = row ? row.pos_z : Number(device.pos_z) + railDelta + laneDelta;
        if (!validNumber(x) || !validNumber(z)) fail('计算后的设备位置超出范围');
        const delta = z - Number(device.pos_z);
        const nativeOrigin = Math.fround(Number(device.pos_z)), nativeResult = Math.fround(z), nativeDelta = Math.fround(delta);
        if (railDelta !== 0 && delta === 0 || !Number.isFinite(nativeOrigin) || !Number.isFinite(nativeResult) || !Number.isFinite(nativeDelta)
            || delta !== 0 && (nativeOrigin === nativeResult || nativeDelta === 0 || Math.sign(nativeResult - nativeOrigin) !== Math.sign(delta)))
            throw Object.assign(new Error('已配置的场景单位每米比例与设备坐标精度不足，非零导轨位移无法正确表示，导轨与移动配置均未保存'), { code: 'LINE_RAIL_SPACING_INVALID', statusCode: 400 });
        const updatedInstance = railBound ? shiftRailMovement(device.instance_config, delta, device.coordinate_space || 'line_local') : instance;
        if (railBound && delta !== 0) await tx.run('UPDATE devices SET pos_x=?,pos_z=?,coordinate_space=?,instance_config=? WHERE id=?', [x, z, 'line_local', JSON.stringify(updatedInstance), device.id]);
        else await tx.run('UPDATE devices SET pos_x=?,pos_z=?,coordinate_space=? WHERE id=?', [x, z, 'line_local', device.id]);
        positions.delete(String(device.id)); saved.push({ id: device.id, pos_x: x, pos_z: z, coordinate_space: 'line_local' });
    }
    if (positions.size) fail('批次中含有当前产线之外或已经删除的设备');
    await tx.run('UPDATE `lines` SET name=?,workshop_id=?,layout_json=?,sort_order=? WHERE id=?', [body.name ?? current.name, workshopId, JSON.stringify(next), body.sort_order ?? current.sort_order ?? 0, current.id]);
    return { success: true, devices: saved };
}

module.exports = { saveLineLayout };
