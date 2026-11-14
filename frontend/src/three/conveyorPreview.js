import * as THREE from 'three'

export const isConveyorAction = entry => ['rollers', 'hot_rollers'].includes(entry?.process?.id)
    || entry?.binding?.motion_role === 'conveyor'

// Match the top-surface travel, not an arbitrary Euler-axis +/- convention.
export function conveyorPlaybackSign(node, rest, next, worldTravel) {
    const delta = next.clone().multiply(rest.clone().invert()).normalize()
    const axis = new THREE.Vector3(delta.x, delta.y, delta.z)
    if (delta.w < 0) axis.negate()
    if (axis.lengthSq() < 1e-12 || worldTravel.lengthSq() < 1e-12) throw new Error('无法核验辊筒旋转轴或料口方向')
    axis.normalize(); node.parent.updateWorldMatrix(true, false)
    const matrix = node.parent.matrixWorld, inverse = matrix.clone().invert()
    const radial = new THREE.Vector3(0, 1, 0).applyMatrix4(inverse).sub(new THREE.Vector3().applyMatrix4(inverse)).normalize()
    const cross = new THREE.Vector3().crossVectors(axis, radial)
    const tangent = cross.applyMatrix4(matrix).sub(new THREE.Vector3().applyMatrix4(matrix))
    const dot = tangent.normalize().dot(worldTravel.clone().normalize())
    if (Math.abs(dot) < .05) throw new Error('辊筒轴与进出料方向不匹配')
    return dot > 0 ? 1 : -1
}
