'use strict';

// Validate authored values; do not repair missing coordinates or infer PLC
// identities. A disabled historical configuration may remain a partial object.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400, code: 'MOVEMENT_CONFIG_INVALID' }); };
const finite = (value, minimum, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
const id = value => typeof value === 'string' && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
const position = value => object(value) && ['x', 'y', 'z'].every(axis => finite(value[axis], -100000, 100000));
const readId = (value, legacy) => value ?? legacy ?? '';

function validateMovementConfig(movement) {
    if (!object(movement) || typeof movement.enabled !== 'boolean') fail('设备运动配置需要明确的启用状态');
    for (const field of ['currentPositionPointId', 'startActionPointId', 'arrivalPositionPointId', 'current_position_point_id', 'start_action_point_id']) {
        if (movement[field] !== undefined && !(id(movement[field]) || Number.isSafeInteger(movement[field]) && movement[field] > 0)) fail('运动点位标识无效');
    }
    for (const field of ['simulationEnabled', 'simulation_enabled', 'diagnosticLogging']) {
        if (movement[field] !== undefined && typeof movement[field] !== 'boolean') fail('运动开关设置无效：' + field);
    }
    if (movement.valueMode !== undefined && !['normalized', 'range', 'station'].includes(movement.valueMode)) fail('运动位置模式无效');
    if (movement.stationInputMeaning !== undefined && !['current', 'target', 'last-confirmed'].includes(movement.stationInputMeaning)) fail('工位输入含义必须为当前到位反馈、最后到位工位或目标命令');
    if (movement.stationInputMeaning === 'last-confirmed' && movement.valueMode !== 'station') fail('最后到位工位只适用于工位编号模式');
    if (movement.arrivalPositionPointId) {
        if (movement.valueMode !== 'station' || movement.stationInputMeaning !== 'target') fail('独立到位工位反馈仅适用于目标工位估算模式');
        if (String(movement.arrivalPositionPointId) === String(readId(movement.currentPositionPointId, movement.current_position_point_id))) fail('目标命令不能同时用作实际到位反馈');
        if (!String(readId(movement.startActionPointId, movement.start_action_point_id)).trim()) fail('独立到位反馈需要绑定实际移动状态 BOOL，不能仅凭保持的工位编号确认停靠');
    }
    for (const field of ['speedMode', 'speed_mode']) if (movement[field] !== undefined && !['auto', 'fixed'].includes(movement[field])) fail('移动速度模式无效');
    if (movement.staleMs !== undefined && (!Number.isInteger(movement.staleMs) || !finite(movement.staleMs, 1000, 60000))) fail('运动数据过期时间必须是 1000–60000 毫秒的整数');
    if (movement.diagnosticIntervalSeconds !== undefined && !finite(movement.diagnosticIntervalSeconds, 1, 60)) fail('运动诊断间隔必须是 1–60 秒');
    for (const field of ['smoothingMs', 'smoothing_ms']) if (movement[field] !== undefined && !finite(movement[field], 0, 1000)) fail('位置过渡时间必须是 0–1000 毫秒');
    // A held workstation code is only the last observed endpoint. Neither an
    // estimated trip nor a visual transition can add an unobserved position.
    if (movement.stationInputMeaning === 'last-confirmed') {
        if (movement.simulationEnabled === true || movement.simulation_enabled === true) fail('最后到位工位不支持移动估算，请关闭运动细节模拟');
        if (movement.smoothingMs > 0 || movement.smoothing_ms > 0) fail('最后到位工位不支持视觉过渡，请将平滑时间设置为 0');
    }
    for (const field of ['maxSpeed', 'max_speed', 'acceleration', 'sceneUnitsPerMeter', 'scene_units_per_meter']) {
        if (movement[field] !== undefined && (!finite(movement[field], 0, 100000) || movement[field] === 0)) fail('移动速度、加速度或场景单位比例必须是有限正数');
    }
    for (const field of ['valueMin', 'valueMax', 'value_min', 'value_max']) if (movement[field] !== undefined && !finite(movement[field], -1e12, 1e12)) fail('位置输入范围无效');
    if (movement.valueMode === 'range' && (movement.valueMin ?? movement.value_min ?? 0) >= (movement.valueMax ?? movement.value_max ?? 100)) fail('位置输入上限必须大于下限');
    for (const field of ['start', 'end']) if ((movement.enabled || movement[field] !== undefined) && !position(movement[field])) fail('请完整填写轨道基准和参考终点的有限 X / Y / Z 坐标');
    if (movement.start !== undefined && movement.end !== undefined && Math.hypot(movement.end.x - movement.start.x, movement.end.z - movement.start.z) < .0001) fail('轨道基准与参考终点的水平坐标不能重合，未推测导轨方向');
    if (movement.stations !== undefined && (!Array.isArray(movement.stations) || movement.stations.length > 500)) fail('工位配置必须是最多 500 项的数组');
    const values = new Set();
    for (const station of movement.stations || []) {
        if (!object(station) || !finite(station.value, -1e12, 1e12) || values.has(station.value) || !position(station.position)) fail('工位编号必须是唯一有限数值，且必须完整填写工位坐标');
        values.add(station.value);
        if (station.anchorDeviceId !== undefined && !id(station.anchorDeviceId)) fail('工位目标设备标识无效');
        if (station.distanceMeters !== undefined && !finite(station.distanceMeters, 0, 100000)) fail('工位实际间距必须是非负有限米数');
    }
    if (movement.enabled && !String(readId(movement.currentPositionPointId, movement.current_position_point_id)).trim()) fail('请选择本设备的实时位置采集点位');
    if (movement.enabled && movement.valueMode === 'station' && !values.size) fail('请配置真实工位编号和坐标，未创建默认工位');
    if (movement.enabled && movement.valueMode === 'station' && movement.stationInputMeaning === 'target'
        && movement.simulationEnabled !== true && movement.simulation_enabled !== true) fail('目标工位是运动命令而非到位反馈，请显式启用移动估算或改选真实当前到位反馈');
    return movement;
}

async function validateMovementSources(db, device, movement, factoryId, belongsToFactory) {
    const fields = [['currentPositionPointId', 'current_position_point_id'], ['startActionPointId', 'start_action_point_id'], ['arrivalPositionPointId']];
    for (const [field, legacy] of fields) {
        const pointId = readId(movement[field], movement[legacy]);
        if (!String(pointId).trim()) continue;
        const point = await db.get('SELECT * FROM data_points WHERE id=? AND device_id=?', [pointId, device.id]);
        if (!point || String(point.access_type || 'READ').toUpperCase() !== 'READ') fail('运动点位必须是本设备的只读采集点位');
        if (field !== 'startActionPointId' && ['BOOL', 'STRING', 'CHAR', 'DT', 'DTZ', 'DTL', 'DTLZ', 'DATE', 'TIME', 'TOD'].includes(String(point.data_type || '').toUpperCase())) fail('实时位置点位必须是数值，不能把开关量、文字或日期当作位置');
        if (field === 'startActionPointId' && (movement.stationInputMeaning === 'last-confirmed' || movement.arrivalPositionPointId) && String(point.data_type || '').toUpperCase() !== 'BOOL') fail('实际移动状态反馈必须是本设备只读 BOOL，不能使用开始命令或数值');
    }
    for (const targetId of new Set((movement.stations || []).map(station => station.anchorDeviceId).filter(Boolean))) {
        const target = await db.get('SELECT * FROM devices WHERE id=?', [targetId]);
        if (String(targetId) === String(device.id) || !await belongsToFactory(db, target, factoryId)) fail('工位关联设备不存在或不属于当前工厂');
    }
    if (movement.enabled === true) {
        // A fixed target must not become mobile behind another editor's back.
        // The runtime independently rejects such a target after hot refresh,
        // including legacy/imported configurations that bypass this endpoint.
        const sources = await db.all('SELECT id,line_id,instance_config FROM devices WHERE id<>?', [device.id]);
        for (const source of sources) {
            let instance;
            try { instance = typeof source.instance_config === 'string' ? JSON.parse(source.instance_config || '{}') : source.instance_config || {}; } catch { continue; }
            const transfer = instance.animationBindings?.transferLink;
            if (transfer?.enabled !== true) continue;
            const referencesTarget = transfer.targetMode === 'fixed' ? String(transfer.targetDeviceId) === String(device.id)
                : transfer.targetMode === 'station' && Array.isArray(instance.movement?.stations)
                    && instance.movement.stations.some(station => String(station?.anchorDeviceId || '') === String(device.id));
            if (referencesTarget && await belongsToFactory(db, source, factoryId)) fail('该设备是来源设备 '+source.id+' 已启用进出料联动的固定目标，请先停用或重新配置来源设备联动，再启用目标设备移动');
        }
    }
}

module.exports = { validateMovementConfig, validateMovementSources };
