'use strict';
const { assertLineMovementUnits, movementSceneUnitsPerMeter } = require('../../shared/lineRailSpacing.mjs');

function instanceObject(value) {
    if (!value) return {};
    const result = typeof value === 'string' ? JSON.parse(value) : value;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('设备配置格式无效');
    return result;
}
function deviceLineId(device, instance) {
    return device.line_id || instance.railLineId || instance.laneLineId || '';
}
async function loadDeviceLineContext(db, device, instance, factoryId) {
    const id = deviceLineId(device, instance);
    if (!id) return null;
    const line = await db.get('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [id, factoryId]);
    if (!line) return null;
    return { id: String(line.id), name: line.name || String(line.id), layout: instanceObject(line.layout_json) };
}
// Apply the same unit contract at every existing authoring entry point. This
// validates configuration only; it never rewrites an inherited calibration,
// a source value, its timestamp, model scale, or any acquisition setting.
async function assertDeviceLineUnits(db, device, value, factoryId) {
    const instance = instanceObject(value);
    if (instance.movement?.enabled !== true && instance.animationBindings?.transferLink?.enabled !== true) return;
    const context = await loadDeviceLineContext(db, device, instance, factoryId);
    if (!context && deviceLineId(device, instance)) throw Object.assign(new Error('活动移动或联动的所属产线不存在或不属于当前工厂，请重新配置所属产线'), { statusCode: 400 });
    if (context) return assertLineMovementUnits(instance.movement, context.layout, device.name || device.id);
    return movementSceneUnitsPerMeter(instance.movement);
}
module.exports = { assertDeviceLineUnits, loadDeviceLineContext, deviceLineId };
