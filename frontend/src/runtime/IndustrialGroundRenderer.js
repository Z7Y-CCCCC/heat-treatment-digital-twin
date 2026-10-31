import * as THREE from 'three'
import { buildGroundMesh, resolveGround } from '../../../shared/industrialGround.mjs'
import { normalizeWorkshopLayout } from '../utils/spatialLayout.js'

export class IndustrialGroundRenderer {
  constructor(manager) { this.manager = manager; this.root = null; this.signature = '' }
  update(workshops, force = false) {
    const enabled = force || workshops.some(ws => normalizeWorkshopLayout(ws.layout || ws.layout_json).ground || [...(ws.devices || []), ...(ws.lines || []).flatMap(line => line.devices || [])].some(d => {
      let c = d.instance_config || {}; if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = {} } }; return c.ground?.enabled === true
    }))
    const floors = enabled ? workshops.map(ws => ({ layout: normalizeWorkshopLayout(ws.layout || ws.layout_json), ground: resolveGround(ws) })) : []
    this.warning = floors.some(f => f.ground.overflow > 0) ? '自动地面超过 64 台设备，请合并为手动基坑或拆分车间。' : ''
    const signature = JSON.stringify(floors)
    if (signature === this.signature) return
    this.clear(); this.signature = signature
    // SceneManager's old first two objects are the continuous floor and grid.
    for (const object of (this.manager.environmentObjects || []).slice(0, 2)) object.visible = !enabled
    if (!enabled) return
    this.root = new THREE.Group(); this.root.name = 'Industrial ground'
    for (const { layout, ground } of floors) {
      if (layout.boundary.enabled === false) continue
      const { positions, indices } = buildGroundMesh(ground), geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere()
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8b9699, roughness: .9, metalness: .02, side: THREE.DoubleSide }))
      mesh.name = 'Industrial ground surface'; mesh.receiveShadow = true
      mesh.position.set(layout.transform.x, layout.transform.y - .01, layout.transform.z); mesh.rotation.y = -layout.transform.rotationY * Math.PI / 180
      this.root.add(mesh)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: 0x566972, transparent: true, opacity: .5 }))
      edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation); edges.position.y += .002; this.root.add(edges)
    }
    this.manager.scene.add(this.root)
  }
  clear() {
    if (!this.root) return
    this.root.traverse(node => { node.geometry?.dispose(); node.material?.dispose() }); this.manager.scene.remove(this.root); this.root = null
  }
  dispose() { this.clear(); this.signature = '' }
}
