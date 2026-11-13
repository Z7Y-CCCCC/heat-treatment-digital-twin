import * as THREE from 'three'

// Optional presentation only. No model-library seed, PLC binding or scene edit.
export function createSimpleRotatingCart(bounds, port) {
  if (!bounds || bounds.isEmpty() || !port?.position || !port?.direction) return null
  const point = new THREE.Vector3(...port.position), direction = new THREE.Vector3(...port.direction).setY(0).normalize()
  const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3()).setY(point.y)
  const span = Math.max(size.x, size.z), length = Math.max(center.distanceTo(point) * 2, span * .65)
  const width = Math.max(Math.min(size.x, size.z) * .8, span * .3), depth = Math.max(point.y - bounds.min.y, span * .18)
  if (![span, length, width, depth].every(value => Number.isFinite(value) && value > 0) || !direction.lengthSq()) return null
  const root = new THREE.Group(); root.name = '__SimpleRotatingCart'
  const materials = { base: new THREE.MeshStandardMaterial({ color: 0x1f334d, roughness: .6 }), upper: new THREE.MeshStandardMaterial({ color: 0x148cad, roughness: .5 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa6b8c7, metalness: .6, roughness: .35 }), accent: new THREE.MeshStandardMaterial({ color: 0xffa61f, roughness: .5 }) }
  function part(type, name, parent, position, scale, material, rotation = null) {
    const geometry = type === 'cylinder' ? new THREE.CylinderGeometry(.5, .5, 2, 24) : new THREE.BoxGeometry(1, 1, 1)
    const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.position.copy(position); mesh.scale.copy(scale)
    if (rotation) mesh.rotation.set(...rotation)
    parent.add(mesh); return mesh
  }
  part('box', 'Rail chassis', root, center.clone().addScaledVector(new THREE.Vector3(0, -1, 0), depth * .65), new THREE.Vector3(size.x * .85, depth * .25, size.z * .85), materials.base)
  const wheel = Math.min(width, length) * .12
  for (const x of [-1, 1]) for (const z of [-1, 1]) part('cylinder', 'Rail wheel', root, center.clone().add(new THREE.Vector3(x * size.x * .36, -depth + wheel, z * size.z * .36)), new THREE.Vector3(wheel * 2, wheel * .35, wheel * 2), materials.steel, [Math.PI / 2, 0, 0])
  part('cylinder', 'Fixed turntable bearing', root, center.clone().add(new THREE.Vector3(0, -depth * .25, 0)), new THREE.Vector3(width * .85, depth * .12, width * .85), materials.base)
  const upper = new THREE.Group(); upper.name = '__SimpleCartUpper'; upper.position.copy(center); upper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction); root.add(upper)
  const radius = Math.min(width, length) * .035
  part('box', 'Upper rotating deck', upper, new THREE.Vector3(0, -radius * 3, 0), new THREE.Vector3(width, radius * 2, length), materials.upper)
  for (let i = 0; i < 7; i++) part('cylinder', `Upper roller ${i}`, upper, new THREE.Vector3(0, -radius, (i / 6 - .5) * length * .85), new THREE.Vector3(radius * 2, width * .45, radius * 2), materials.steel, [0, 0, Math.PI / 2])
  const mouth = point.clone().sub(center).applyQuaternion(upper.quaternion.clone().invert())
  part('box', 'Physical shared loading mouth', upper, mouth.add(new THREE.Vector3(0, -radius, 0)), new THREE.Vector3(width, radius * 2, radius * 2), materials.accent)
  part('box', 'Upper direction marker', upper, new THREE.Vector3(0, radius * .1, length * .22), new THREE.Vector3(width * .12, radius * .3, length * .25), materials.accent)
  return { root, upper }
}
