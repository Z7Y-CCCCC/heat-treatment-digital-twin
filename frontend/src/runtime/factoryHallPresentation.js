import { Color, FrontSide } from 'three'

// Same architecture-only presentation as the native Unity runtime.
export function applyHallPresentation(hall) {
  const materials = new Map()
  hall.traverse(node => {
    if (!node.isMesh) return
    node.userData.factoryHall = true
    node.castShadow = false
    node.raycast = () => {} // The building is context, never a device pick target.
    const source = Array.isArray(node.material) ? node.material : [node.material]
    const floor = /floor|ground|apron/i.test(node.name) || source.some(m => /floor/i.test(m?.name || ''))
    node.receiveShadow = floor
    if (floor) return
    const convert = original => {
      if (!original) return original
      if (materials.has(original)) return materials.get(original)
      const material = original.clone()
      material.name = original.name + ' / hall ghost'
      material.transparent = true
      material.opacity = Math.min(original.opacity ?? 1, 1) * .10
      material.depthWrite = false
      material.side = FrontSide
      material.color?.lerp(new Color(.48, .55, .61), .35)
      materials.set(original, material)
      return material
    }
    node.material = Array.isArray(node.material) ? source.map(convert) : convert(node.material)
  })
  return hall
}
