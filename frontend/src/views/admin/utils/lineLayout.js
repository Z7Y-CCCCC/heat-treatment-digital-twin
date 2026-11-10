// 产线布局纯函数:创建与规范化车道(lane)/导轨(rail)布局结构。
// 依赖 common 的基础数值/JSON 解析工具。

import { numberOrDefault, parseInstanceConfig } from './common.js'
import { normalizeSpatialTransform } from '../../../utils/spatialLayout.js'
import { resolveLineRailSpacing, lineSceneUnitsPerMeter } from '../../../../../shared/lineRailSpacing.mjs'

export function makeLineLayoutItem(type, index = 0) {
    const isRail = type === 'rail'
    const prefix = isRail ? 'rail' : 'lane'
    const name = isRail ? '小车导轨' : '设备线'
    return {
        id: `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
        name: `${name} ${index + 1}`,
        type: isRail ? 'cart_rail' : 'device_lane',
        offsetZ: isRail ? 4 + index * 6 : index * 6,
        length: 60,
        sort_order: index
    }
}

export function defaultLineLayout() {
    return {
        version: 2,
        coordinateSpace: 'workshop_local',
        placementPending: false,
        transform: { x: 0, y: 0, z: 0, rotationY: 0 },
        flowDirection: 'right',
        lanes: [{ ...makeLineLayoutItem('lane', 0), id: 'lane_1' }],
        rails: []
    }
}

export function normalizeLineLayoutItems(items, type) {
    const isRail = type === 'rail'
    return (Array.isArray(items) ? items : [])
        .map((item, index) => ({
            id: String(item?.id || `${isRail ? 'rail' : 'lane'}_${index + 1}`),
            name: String(item?.name || `${isRail ? '小车导轨' : '设备线'} ${index + 1}`),
            type: isRail ? 'cart_rail' : 'device_lane',
            offsetZ: numberOrDefault(item?.offsetZ ?? item?.offset_z ?? item?.z, isRail ? 4 : 0),
            length: Math.max(1, numberOrDefault(item?.length, 60)),
            sort_order: numberOrDefault(item?.sort_order, index),
            ...(isRail && item?.spacing != null ? { spacing: item.spacing } : {})
        }))
        .sort((a, b) => a.sort_order - b.sort_order)
}

export function normalizeLineLayout(value) {
    const source = parseInstanceConfig(value) || {}
    const lanes = normalizeLineLayoutItems(source.lanes, 'lane')
    const rails = normalizeLineLayoutItems(source.rails, 'rail')
    const flowDirection = ['right', 'left', 'none'].includes(source.flowDirection) ? source.flowDirection : 'right'
    if (!lanes.length) lanes.push(defaultLineLayout().lanes[0])
    return resolveLineRailSpacing({
        version: 2,
        coordinateSpace: 'workshop_local',
        placementPending: source.placementPending === true,
        transform: normalizeSpatialTransform(source.transform),
        flowDirection,
        ...(Object.prototype.hasOwnProperty.call(source, 'sceneUnitsPerMeter') ? { sceneUnitsPerMeter: lineSceneUnitsPerMeter(source) } : {}),
        lanes,
        rails
    })
}

export function serializeLineLayout(layout) {
    return JSON.stringify(normalizeLineLayout(layout), null, 2)
}

export function normalizeLineRecord(line) {
    const layout = normalizeLineLayout(line?.layout || line?.layout_json)
    return {
        ...line,
        layout,
        layout_json: JSON.stringify(layout)
    }
}
