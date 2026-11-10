const WORKSHOP_LAYOUT_VERSION = 2;
const LINE_LAYOUT_VERSION = 2;
const { normalizeGround } = require('../../shared/industrialGround.mjs');
const { resolveLineRailSpacing, lineSceneUnitsPerMeter } = require('../../shared/lineRailSpacing.mjs');

function safeObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function finiteNumber(value, fallback = 0, minimum = -100000, maximum = 100000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
}

function normalizeAngleDegrees(value, fallback = 0) {
    let angle = finiteNumber(value, fallback, -100000, 100000) % 360;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    return Number(angle.toFixed(4));
}

function normalizeSpatialTransform(value, fallback = {}) {
    const source = safeObject(value);
    return {
        x: finiteNumber(source.x, finiteNumber(fallback.x, 0)),
        y: finiteNumber(source.y, finiteNumber(fallback.y, 0), -10000, 10000),
        z: finiteNumber(source.z, finiteNumber(fallback.z, 0)),
        rotationY: normalizeAngleDegrees(
            source.rotationY ?? source.rotation_y,
            normalizeAngleDegrees(fallback.rotationY ?? fallback.rotation_y, 0)
        )
    };
}

function defaultWorkshopLayout() {
    return {
        version: WORKSHOP_LAYOUT_VERSION,
        coordinateSpace: 'factory_world',
        transform: { x: 0, y: 0, z: 0, rotationY: 0 },
        size: { width: 100, depth: 80, height: 8 },
        boundary: { enabled: true }
    };
}

function normalizeWorkshopLayout(value) {
    const defaults = defaultWorkshopLayout();
    const source = safeObject(value);
    const size = safeObject(source.size);
    const boundary = safeObject(source.boundary);
    return {
        version: WORKSHOP_LAYOUT_VERSION,
        coordinateSpace: 'factory_world',
        transform: normalizeSpatialTransform(source.transform, defaults.transform),
        size: {
            width: finiteNumber(size.width ?? source.width, defaults.size.width, 10, 5000),
            depth: finiteNumber(size.depth ?? source.depth, defaults.size.depth, 10, 5000),
            height: finiteNumber(size.height ?? source.height, defaults.size.height, 1, 200)
        },
        boundary: {
            enabled: boundary.enabled === undefined ? defaults.boundary.enabled : !!boundary.enabled
        },
        ...(source.ground === undefined ? {} : { ground: normalizeGround(source.ground) })
    };
}

function makeDefaultLineItem(type, index = 0) {
    const isRail = type === 'rail';
    return {
        id: `${isRail ? 'rail' : 'lane'}_${index + 1}`,
        name: `${isRail ? '小车导轨' : '设备线'} ${index + 1}`,
        type: isRail ? 'cart_rail' : 'device_lane',
        offsetZ: isRail ? 4 + index * 6 : index * 6,
        length: 60,
        sort_order: index
    };
}

function defaultLineLayout() {
    return {
        version: LINE_LAYOUT_VERSION,
        coordinateSpace: 'workshop_local',
        placementPending: false,
        transform: { x: 0, y: 0, z: 0, rotationY: 0 },
        flowDirection: 'right',
        lanes: [makeDefaultLineItem('lane', 0)],
        rails: []
    };
}

function normalizeLineLayoutItems(items, type) {
    const isRail = type === 'rail';
    return (Array.isArray(items) ? items : [])
        .slice(0, 120)
        .map((item, index) => ({
            id: String(item?.id || `${isRail ? 'rail' : 'lane'}_${index + 1}`),
            name: String(item?.name || `${isRail ? '小车导轨' : '设备线'} ${index + 1}`),
            type: isRail ? 'cart_rail' : 'device_lane',
            offsetZ: finiteNumber(item?.offsetZ ?? item?.offset_z ?? item?.z, isRail ? 4 : 0, -10000, 10000),
            length: finiteNumber(item?.length, 60, 1, 10000),
            sort_order: finiteNumber(item?.sort_order, index, -10000, 10000),
            ...(isRail && item?.spacing != null ? { spacing: item.spacing } : {})
        }))
        .sort((a, b) => a.sort_order - b.sort_order);
}

function normalizeLineLayout(value, transformFallback = null) {
    const defaults = defaultLineLayout();
    const source = safeObject(value);
    const lanes = normalizeLineLayoutItems(source.lanes, 'lane');
    const rails = normalizeLineLayoutItems(source.rails, 'rail');
    if (!lanes.length) lanes.push(defaults.lanes[0]);
    return resolveLineRailSpacing({
        version: LINE_LAYOUT_VERSION,
        coordinateSpace: 'workshop_local',
        placementPending: source.placementPending === true,
        transform: normalizeSpatialTransform(source.transform, transformFallback || defaults.transform),
        flowDirection: ['right', 'left', 'none'].includes(source.flowDirection)
            ? source.flowDirection
            : defaults.flowDirection,
        ...(Object.prototype.hasOwnProperty.call(source, 'sceneUnitsPerMeter') ? { sceneUnitsPerMeter: lineSceneUnitsPerMeter(source) } : {}),
        lanes,
        rails
    });
}

function degreesToRadians(value) {
    return finiteNumber(value, 0) * Math.PI / 180;
}

function rotatePoint2d(point, degrees) {
    const radians = degreesToRadians(degrees);
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return {
        x: point.x * cosine - point.z * sine,
        z: point.x * sine + point.z * cosine
    };
}

function localToParentPoint(point, transform) {
    const normalized = normalizeSpatialTransform(transform);
    const rotated = rotatePoint2d({
        x: finiteNumber(point?.x, 0),
        z: finiteNumber(point?.z, 0)
    }, normalized.rotationY);
    return {
        x: rotated.x + normalized.x,
        y: finiteNumber(point?.y, 0) + normalized.y,
        z: rotated.z + normalized.z
    };
}

function parentToLocalPoint(point, transform) {
    const normalized = normalizeSpatialTransform(transform);
    const translated = {
        x: finiteNumber(point?.x, 0) - normalized.x,
        z: finiteNumber(point?.z, 0) - normalized.z
    };
    const rotated = rotatePoint2d(translated, -normalized.rotationY);
    return {
        x: rotated.x,
        y: finiteNumber(point?.y, 0) - normalized.y,
        z: rotated.z
    };
}

function composeSpatialTransforms(parent, child) {
    const parentTransform = normalizeSpatialTransform(parent);
    const childTransform = normalizeSpatialTransform(child);
    const position = localToParentPoint(childTransform, parentTransform);
    return {
        x: position.x,
        y: position.y,
        z: position.z,
        rotationY: normalizeAngleDegrees(parentTransform.rotationY + childTransform.rotationY)
    };
}

function deviceYawToDegrees(value) {
    const number = finiteNumber(value, 0, -100000, 100000);
    return Math.abs(number) <= Math.PI * 2 + 0.01 ? number * 180 / Math.PI : number;
}

function deviceYawFromDegrees(value, originalValue) {
    const original = finiteNumber(originalValue, 0, -100000, 100000);
    return Math.abs(original) <= Math.PI * 2 + 0.01
        ? normalizeAngleDegrees(value) * Math.PI / 180
        : normalizeAngleDegrees(value);
}

function effectiveDeviceLineId(device) {
    const config = safeObject(device?.instance_config);
    return String(
        device?.line_id
        || config.railLineId
        || config.laneLineId
        || ''
    ).trim();
}

function configuredDeviceWorkshopId(device) {
    const config = safeObject(device?.instance_config);
    return String(config.workshop_id || config.workshopId || '').trim();
}

module.exports = {
    WORKSHOP_LAYOUT_VERSION,
    LINE_LAYOUT_VERSION,
    safeObject,
    finiteNumber,
    normalizeAngleDegrees,
    normalizeSpatialTransform,
    defaultWorkshopLayout,
    normalizeWorkshopLayout,
    defaultLineLayout,
    normalizeLineLayoutItems,
    normalizeLineLayout,
    localToParentPoint,
    parentToLocalPoint,
    composeSpatialTransforms,
    deviceYawToDegrees,
    deviceYawFromDegrees,
    effectiveDeviceLineId,
    configuredDeviceWorkshopId
};
