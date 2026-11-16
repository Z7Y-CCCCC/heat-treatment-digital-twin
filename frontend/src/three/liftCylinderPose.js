import * as T from 'three'

/** A corrected source declares its final GLB pin coordinates; unmarked legacy assets
 * keep their original authoring anchors. This reads metadata only, never rewrites assets.
 */
export function createLiftCylinderAnchors(authoringY = y => y, authoredRestPose) {
    let base, mid, tip
    if (authoredRestPose === undefined) {
        base = new T.Vector3(.48, authoringY(.16), 0)
        mid = new T.Vector3(.20, authoringY(.59), 0)
        tip = new T.Vector3(.03, authoringY(.83), 0)
    } else {
        const validPoint = point => Array.isArray(point) && point.length === 3 && point.every(value => typeof value === 'number' && Number.isFinite(value))
        if (!authoredRestPose || typeof authoredRestPose !== 'object' || Array.isArray(authoredRestPose) ||
            authoredRestPose.schemaVersion !== 1 || authoredRestPose.coordinateSpace !== 'three-y-up-local-m' ||
            !['base', 'mid', 'tip'].every(key => validPoint(authoredRestPose[key]))) {
            throw Error('升降油缸初始姿态元数据不合法，请检查模型源文件。')
        }
        // The metadata is already in the exported model frame: do not apply transferAlignment twice.
        base = new T.Vector3(...authoredRestPose.base)
        mid = new T.Vector3(...authoredRestPose.mid)
        tip = new T.Vector3(...authoredRestPose.tip)
        if (base.distanceToSquared(mid) < 1e-12 || mid.distanceToSquared(tip) < 1e-12 || base.distanceToSquared(tip) < 1e-12) {
            throw Error('升降油缸初始姿态挂点重合，请检查模型源文件。')
        }
    }
    const lowerY = authoringY(.14)
    return {
        base, mid, tip, lowerY,
        restHeight: authoringY(.95) - lowerY,
        barrelAxis: mid.clone().sub(base).normalize(),
        rodAxis: tip.clone().sub(mid).normalize()
    }
}

/** Rigid barrel/rod transforms: the base is fixed and the upper eye follows the shaft. */
export function sampleLiftCylinderPose(anchors, height = anchors.restHeight, includeTransforms = true) {
    const { base, tip, lowerY, barrelAxis, rodAxis } = anchors
    const top = new T.Vector3(0, lowerY + height / 2, 0)
    const axis = top.clone().sub(base).normalize()
    const barrelRotation = new T.Quaternion().setFromUnitVectors(barrelAxis, axis)
    const rodRotation = new T.Quaternion().setFromUnitVectors(rodAxis, axis)
    const pose = { top, axis, barrelRotation, rodRotation }
    if (!includeTransforms) return pose
    const atPin = (from, to, rotation) => new T.Matrix4()
        .makeTranslation(to.x, to.y, to.z)
        .multiply(new T.Matrix4().makeRotationFromQuaternion(rotation))
        .multiply(new T.Matrix4().makeTranslation(-from.x, -from.y, -from.z))
    return {
        ...pose,
        barrel: atPin(base, base, barrelRotation),
        rod: atPin(tip, top, rodRotation),
        upperEye: new T.Matrix4().makeTranslation(...top.clone().sub(tip).toArray())
    }
}
