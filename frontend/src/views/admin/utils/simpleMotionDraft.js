import { localToParentPoint, parentToLocalPoint } from '../../../utils/spatialLayout.js'

const object = value => value && typeof value === 'object' && !Array.isArray(value)
const parse = value => { try { const result = typeof value === 'string' ? JSON.parse(value) : value; return object(result) ? result : {} } catch { return {} } }
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000
const position = value => object(value) && ['x', 'y', 'z'].every(axis => finite(value[axis]))
const authored = value => Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, finite(value?.[axis]) ? value[axis] : '']))
const id = value => value == null ? '' : String(value)

// Rail length/direction already belong to the canvas, not another engineering
// form. Preserve the cart's authored rail-plane calibration. No metre inputs
// or guessed +10-unit rail are created when the canvas has no usable rail.
export function canvasMotionBasis(device = {}) {
    const config = parse(device.instance_config), layout = parse(device.lineLayout)
    const railId = config.railId ?? config.rail_id
    const rails = (Array.isArray(layout.rails) ? layout.rails : []).filter(row => row && String(row.id) === String(railId))
    if (!railId || rails.length !== 1 || !finite(rails[0].length) || rails[0].length <= 0) throw new Error('请先在产线画布中给小车绑定有效导轨，再重新导入工位')
    const saved = { x: device.pos_x, y: device.pos_y, z: device.pos_z }
    if (!position(saved)) throw new Error('画布中的小车位置无效，请先在产线画布中修正')
    const space = device.coordinate_space || 'line_local'
    if (!['line_local', 'workshop_local'].includes(space)) throw new Error('小车坐标系不支持，请先在产线画布中修正')
    const transform = parse(layout.transform)
    for (const field of ['x', 'y', 'z', 'rotationY', 'rotation_y']) if (transform[field] !== undefined && !finite(transform[field])) throw new Error('产线画布变换无效，请先在画布中修正')
    const local = space === 'workshop_local' ? parentToLocalPoint(saved, transform) : saved
    const convert = point => space === 'workshop_local' ? localToParentPoint(point, transform) : point
    return { start: convert({ x: -rails[0].length / 2, y: local.y, z: local.z }), end: convert({ x: rails[0].length / 2, y: local.y, z: local.z }) }
}

// This is an editor draft only. The exact original movement remains the CAS
// baseline; reading a legacy record never updates the running configuration.
export function simpleMotionDraft(device = {}, override) {
    const source = override ?? parse(parse(device.instance_config).movement)
    let basis
    try { basis = canvasMotionBasis(device) } catch { basis = { start: authored(null), end: authored(null) } }
    const targetMeaning = source.displayMode === 'simple' || source.valueMode === 'station' && source.stationInputMeaning === 'target'
    const animation = parse(parse(device.instance_config).animationBindings)
    const timeout = source.staleMs ?? animation.staleMs
    return {
        enabled: source.enabled === true, displayMode: 'simple', valueMode: 'station', stationInputMeaning: 'target',
        currentPositionPointId: targetMeaning ? id(source.currentPositionPointId ?? source.current_position_point_id) : '',
        // An old moving bit has the opposite meaning; never silently reuse it.
        arrivalSignalPointId: id(source.arrivalSignalPointId), arrivalSmoothing: source.arrivalSmoothing !== false,
        staleMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 60000 ? timeout : 5000,
        start: source.start !== undefined ? authored(source.start) : basis.start,
        end: source.end !== undefined ? authored(source.end) : basis.end,
        stations: (Array.isArray(source.stations) ? source.stations : []).map(row => ({
            value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : '',
            label: String(row.label || ''), anchorDeviceId: id(row.anchorDeviceId ?? row.anchor_device_id),
            deviceLineKey: id(row.deviceLineKey ?? row.device_line_key), deviceLineName: String(row.deviceLineName ?? row.device_line_name ?? ''),
            position: authored(row.position || row)
        }))
    }
}

// Used by both the page and the factory-switch draft saver. A cached draft
// cannot resurrect retired fields or resample an old movement/start binding.
export function simpleMovementPayload(movement) {
    return {
        enabled: movement.enabled === true, displayMode: 'simple', valueMode: 'station', stationInputMeaning: 'target',
        currentPositionPointId: id(movement.currentPositionPointId), arrivalSignalPointId: id(movement.arrivalSignalPointId),
        arrivalSmoothing: movement.arrivalSmoothing !== false, staleMs: movement.staleMs,
        stations: (movement.stations || []).map(row => ({ value: row.value, label: String(row.label || ''),
            anchorDeviceId: id(row.anchorDeviceId), deviceLineKey: id(row.deviceLineKey), deviceLineName: String(row.deviceLineName || ''),
            position: { ...row.position } })),
        ...(position(movement.start) ? { start: { ...movement.start } } : {}),
        ...(position(movement.end) ? { end: { ...movement.end } } : {})
    }
}
