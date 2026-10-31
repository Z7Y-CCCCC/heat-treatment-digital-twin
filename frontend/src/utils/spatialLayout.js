import { normalizeGround } from '../../../shared/industrialGround.mjs'

export function parseSpatialObject(value) {
    if (!value) return {}
    if (typeof value === 'object' && !Array.isArray(value)) return value
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
        return {}
    }
}

export function spatialNumber(value, fallback = 0, minimum = -100000, maximum = 100000) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(maximum, Math.max(minimum, number))
}

export function normalizeSpatialAngle(value, fallback = 0) {
    let angle = spatialNumber(value, fallback) % 360
    if (angle > 180) angle -= 360
    if (angle < -180) angle += 360
    return Number(angle.toFixed(4))
}

export function normalizeSpatialTransform(value, fallback = {}) {
    const source = parseSpatialObject(value)
    return {
        x: spatialNumber(source.x, spatialNumber(fallback.x, 0)),
        y: spatialNumber(source.y, spatialNumber(fallback.y, 0), -10000, 10000),
        z: spatialNumber(source.z, spatialNumber(fallback.z, 0)),
        rotationY: normalizeSpatialAngle(
            source.rotationY ?? source.rotation_y,
            normalizeSpatialAngle(fallback.rotationY ?? fallback.rotation_y, 0)
        )
    }
}

export function defaultWorkshopLayout() {
    return {
        version: 2,
        coordinateSpace: 'factory_world',
        transform: { x: 0, y: 0, z: 0, rotationY: 0 },
        size: { width: 100, depth: 80, height: 8 },
        boundary: { enabled: true }
    }
}

export function normalizeWorkshopLayout(value) {
    const defaults = defaultWorkshopLayout()
    const source = parseSpatialObject(value)
    const size = parseSpatialObject(source.size)
    const boundary = parseSpatialObject(source.boundary)
    return {
        version: 2,
        coordinateSpace: 'factory_world',
        transform: normalizeSpatialTransform(source.transform, defaults.transform),
        size: {
            width: spatialNumber(size.width ?? source.width, defaults.size.width, 10, 5000),
            depth: spatialNumber(size.depth ?? source.depth, defaults.size.depth, 10, 5000),
            height: spatialNumber(size.height ?? source.height, defaults.size.height, 1, 200)
        },
        boundary: {
            enabled: boundary.enabled === undefined ? true : !!boundary.enabled
        },
        ...(source.ground === undefined ? {} : { ground: normalizeGround(source.ground) })
    }
}

export function rotateSpatialPoint(point, degrees) {
    const radians = spatialNumber(degrees, 0) * Math.PI / 180
    const cosine = Math.cos(radians)
    const sine = Math.sin(radians)
    return {
        x: spatialNumber(point?.x, 0) * cosine - spatialNumber(point?.z, 0) * sine,
        z: spatialNumber(point?.x, 0) * sine + spatialNumber(point?.z, 0) * cosine
    }
}

export function localToParentPoint(point, transform) {
    const normalized = normalizeSpatialTransform(transform)
    const rotated = rotateSpatialPoint(point, normalized.rotationY)
    return {
        x: rotated.x + normalized.x,
        y: spatialNumber(point?.y, 0) + normalized.y,
        z: rotated.z + normalized.z
    }
}

export function parentToLocalPoint(point, transform) {
    const normalized = normalizeSpatialTransform(transform)
    const rotated = rotateSpatialPoint({
        x: spatialNumber(point?.x, 0) - normalized.x,
        z: spatialNumber(point?.z, 0) - normalized.z
    }, -normalized.rotationY)
    return {
        x: rotated.x,
        y: spatialNumber(point?.y, 0) - normalized.y,
        z: rotated.z
    }
}

export function composeSpatialTransforms(parent, child) {
    const parentTransform = normalizeSpatialTransform(parent)
    const childTransform = normalizeSpatialTransform(child)
    const position = localToParentPoint(childTransform, parentTransform)
    return {
        x: position.x,
        y: position.y,
        z: position.z,
        rotationY: normalizeSpatialAngle(parentTransform.rotationY + childTransform.rotationY)
    }
}

export function deviceRotationRadians(value) {
    const rotation = spatialNumber(value, 0)
    return Math.abs(rotation) <= Math.PI * 2 + 0.01 ? rotation : rotation * Math.PI / 180
}

export function deviceLocalToWorld(device, workshop, line = null) {
    const workshopLayout = normalizeWorkshopLayout(workshop?.layout || workshop?.layout_json)
    const lineLayout = line?.layout && typeof line.layout === 'object'
        ? line.layout
        : parseSpatialObject(line?.layout_json)
    const lineTransform = normalizeSpatialTransform(lineLayout?.transform)
    const coordinateSpace = String(device?.coordinate_space || '')
    const localPoint = {
        x: spatialNumber(device?.pos_x, 0),
        y: spatialNumber(device?.pos_y, 0),
        z: spatialNumber(device?.pos_z, 0)
    }

    if (coordinateSpace === 'line_local' && line) {
        const workshopPoint = localToParentPoint(localPoint, lineTransform)
        const worldPoint = localToParentPoint(workshopPoint, workshopLayout.transform)
        return {
            ...worldPoint,
            rotationY: deviceRotationRadians(device?.rotation_y)
                + (workshopLayout.transform.rotationY + lineTransform.rotationY) * Math.PI / 180
        }
    }
    if (coordinateSpace === 'workshop_local') {
        const worldPoint = localToParentPoint(localPoint, workshopLayout.transform)
        return {
            ...worldPoint,
            rotationY: deviceRotationRadians(device?.rotation_y)
                + workshopLayout.transform.rotationY * Math.PI / 180
        }
    }
    return { ...localPoint, rotationY: deviceRotationRadians(device?.rotation_y) }
}
