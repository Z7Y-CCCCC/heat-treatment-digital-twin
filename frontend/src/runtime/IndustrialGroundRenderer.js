import * as THREE from 'three'
import { buildGroundMesh, resolveGround } from '../../../shared/industrialGround.mjs'
import { normalizeWorkshopLayout } from '../utils/spatialLayout.js'
import { buildGroundCutaway, groundPitRectangles, simplifyGroundMesh } from './industrialGroundCutaway.js'

function makeGeometry({ positions, indices }) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere()
  return geometry
}

export class IndustrialGroundRenderer {
  constructor(manager, { cutaway = false } = {}) {
    this.manager = manager; this.root = null; this.signature = ''; this.cutaway = cutaway; this.floors = []; this.cameraStamp = ''
    this.lastViewAt = -Infinity; this.viewTimer = null
    this.onCameraChange = () => {
      // Large layouts have a bounded update rate while orbiting, and one final
      // update after movement stops. Idle cameras do no geometry work.
      const delay = this.floors.some(floor => floor.source.positions.length > 3000) ? 80 - (performance.now() - this.lastViewAt) : 0
      if (delay > 0) { if (!this.viewTimer) this.viewTimer = setTimeout(() => { this.viewTimer = null; this.updateView() }, delay); return }
      this.updateView()
    }
    if (cutaway) manager.controls?.addEventListener('change', this.onCameraChange)
  }
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
      const original = buildGroundMesh(ground), source = this.cutaway ? simplifyGroundMesh(original) : original, geometry = makeGeometry(source)
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8b9699, roughness: .9, metalness: .02, side: THREE.DoubleSide }))
      mesh.name = 'Industrial ground surface'; mesh.receiveShadow = true
      mesh.position.set(layout.transform.x, layout.transform.y - .01, layout.transform.z); mesh.rotation.y = -layout.transform.rotationY * Math.PI / 180
      this.root.add(mesh)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: 0x566972, transparent: true, opacity: .5 }))
      edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation); edges.position.y += .002; this.root.add(edges)
      this.floors.push({ mesh, edges, source, baseGeometry: geometry, elevation: ground.elevation, pits: groundPitRectangles(source, ground.elevation) })
    }
    this.manager.scene.add(this.root)
    this.cameraStamp = ''; this.updateView()
  }
  updateView(camera = this.manager.camera) {
    if (!this.cutaway || !this.root || !camera) return
    camera.updateMatrixWorld(true)
    const position = camera.getWorldPosition(new THREE.Vector3()), direction = camera.getWorldDirection(new THREE.Vector3())
    const stamp = [...position.toArray(), ...direction.toArray(), camera.isOrthographicCamera ? 1 : 0].map(value => Math.round(value * 1e5)).join(':')
    if (stamp === this.cameraStamp) return
    this.cameraStamp = stamp; this.lastViewAt = performance.now(); this.root.updateMatrixWorld(true)
    for (const floor of this.floors) {
      if (!floor.pits.length) continue
      const local = floor.mesh.worldToLocal(position.clone()), inverse = floor.mesh.matrixWorld.clone().invert()
      const view = { x: local.x, y: local.y, z: local.z, orthographic: camera.isOrthographicCamera === true, direction: direction.clone().transformDirection(inverse) }
      const geometry = makeGeometry(buildGroundCutaway(floor.source, floor.elevation, view, floor.pits))
      const previous = floor.mesh.geometry
      floor.mesh.geometry = geometry
      if (previous !== floor.baseGeometry) previous.dispose()
      floor.edges.geometry.dispose(); floor.edges.geometry = new THREE.EdgesGeometry(geometry, 25)
    }
  }
  clear() {
    clearTimeout(this.viewTimer); this.viewTimer = null; this.lastViewAt = -Infinity
    if (!this.root) return
    for (const floor of this.floors) if (floor.mesh.geometry !== floor.baseGeometry) floor.baseGeometry.dispose()
    this.floors = []; this.cameraStamp = ''
    this.root.traverse(node => { node.geometry?.dispose(); node.material?.dispose() }); this.manager.scene.remove(this.root); this.root = null
  }
  dispose() { this.manager.controls?.removeEventListener('change', this.onCameraChange); this.clear(); this.signature = '' }
}
