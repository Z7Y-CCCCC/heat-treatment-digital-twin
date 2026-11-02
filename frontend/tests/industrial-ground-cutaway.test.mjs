import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { readFile } from 'node:fs/promises'
import { buildGroundMesh, resolveGround } from '../../shared/industrialGround.mjs'
import { buildGroundCutaway, groundPitRectangles, simplifyGroundMesh } from '../src/runtime/industrialGroundCutaway.js'
import { IndustrialGroundRenderer } from '../src/runtime/IndustrialGroundRenderer.js'

const workshop = () => ({ id: 'pit-shop', layout: { size: { width: 24, depth: 18 }, ground: { elevation: 0, areas: [
  { id: 'pit', x: 0, z: 0, width: 6, depth: 5, elevation: -4 },
  { id: 'platform', x: 8, z: -5, width: 3, depth: 3, elevation: 2 }
] } } })
function mesh(data) {
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3)); geometry.setIndex(data.indices)
  const result = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); result.updateMatrixWorld(true); return result
}
function occlusions(surface, camera, target) {
  const origin = new THREE.Vector3(camera.x, camera.y, camera.z), point = new THREE.Vector3(...target), distance = origin.distanceTo(point)
  return new THREE.Raycaster(origin, point.sub(origin).normalize(), 0, distance - .005).intersectObject(surface)
}
function downward(surface, x, z) { return new THREE.Raycaster(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0)).intersectObject(surface) }

test('near floor and retaining walls stop blocking sunken equipment from every side and diagonal', () => {
  const ground = resolveGround(workshop()), source = buildGroundMesh(ground), baseline = mesh(source)
  const targets = [[0, -3.5, 0], [2.7, -3.8, 2.2], [-2.7, -3.8, -2.2], [0, -1, 0]]
  for (const camera of [{ x: 0, y: .5, z: 20 }, { x: 0, y: .5, z: -20 }, { x: 22, y: .5, z: 0 }, { x: -22, y: .5, z: 0 }, { x: 20, y: 1, z: 18 }]) {
    assert.ok(occlusions(baseline, camera, targets[0]).length, 'uncut fixture must reproduce the obstruction')
    const cut = mesh(buildGroundCutaway(source, ground.elevation, camera))
    for (const target of targets) assert.equal(occlusions(cut, camera, target).length, 0, `${JSON.stringify(camera)} -> ${target}`)
    assert.equal(downward(cut, 0, 0)[0].point.y, -4, 'pit bottom is preserved')
    assert.equal(downward(cut, 8, -5)[0].point.y, 2, 'unrelated platform is preserved')
    cut.geometry.dispose(); cut.material.dispose()
  }
  baseline.geometry.dispose(); baseline.material.dispose()
})

test('top view retains the normal ground and reverse view restores the previously removed front', () => {
  const ground = resolveGround(workshop()), source = buildGroundMesh(ground)
  const front = mesh(buildGroundCutaway(source, 0, { x: 0, y: 1, z: 20 }))
  const rear = mesh(buildGroundCutaway(source, 0, { x: 0, y: 1, z: -20 }))
  const top = mesh(buildGroundCutaway(source, 0, { x: 0, y: 40, z: 0 }))
  assert.equal(downward(front, 0, 7).length, 0)
  assert.equal(downward(rear, 0, 7)[0].point.y, 0)
  assert.equal(downward(top, 0, 7)[0].point.y, 0)
  assert.equal(downward(top, 0, 0)[0].point.y, -4)
  for (const surface of [front, rear, top]) { surface.geometry.dispose(); surface.material.dispose() }
})

test('orthographic projection and below-floor viewpoints also expose the lower device', () => {
  const ground = resolveGround(workshop()), source = buildGroundMesh(ground)
  const direction = new THREE.Vector3(0, -1, -10).normalize()
  const camera = { x: 0, y: 1, z: 20, orthographic: true, direction }
  const surface = mesh(buildGroundCutaway(source, 0, camera))
  const target = new THREE.Vector3(0, -3.5, 0), origin = target.clone().addScaledVector(direction, -30)
  assert.equal(new THREE.Raycaster(origin, direction, 0, 29.99).intersectObject(surface).length, 0)
  const lowCamera = { x: 0, y: -2, z: 20 }, low = mesh(buildGroundCutaway(source, 0, lowCamera))
  assert.equal(occlusions(low, lowCamera, [0, -3.5, 0]).length, 0)
  for (const item of [surface, low]) { item.geometry.dispose(); item.material.dispose() }
})

test('resolved filled pits and flat floors create no phantom cutaway', () => {
  const ws = workshop(); ws.layout.ground.areas.push({ id: 'fill', x: 0, z: 0, width: 6, depth: 5, elevation: 0 })
  const ground = resolveGround(ws), source = buildGroundMesh(ground)
  assert.deepEqual(groundPitRectangles(source, 0), [])
  assert.equal(buildGroundCutaway(source, 0, { x: 0, y: 1, z: 20 }), source)
})

test('64 separated pits are merged before clipping without changing floor heights or opening walls', () => {
  const ground = { elevation: 0, width: 200, depth: 180, areas: Array.from({ length: 64 }, (_, i) => ({ x: (i % 8) * 20 - 70, z: Math.floor(i / 8) * 20 - 70, width: 6 + i * .001, depth: 6 + i * .002, elevation: -4 })) }
  const original = buildGroundMesh(ground), simplified = simplifyGroundMesh(original)
  assert.ok(simplified.positions.length / 12 < 600)
  assert.ok(original.positions.length > simplified.positions.length * 20)
  const before = mesh(original), after = mesh(simplified)
  for (const r of ground.areas) {
    for (const [x, z] of [[r.x, r.z], [r.x + 4, r.z], [r.x, r.z + 4]]) assert.ok(Math.abs(downward(after, x, z)[0].point.y - downward(before, x, z)[0].point.y) < 1e-5)
    const camera = { x: r.x, y: .5, z: r.z + 9 }, target = [r.x, -3, r.z]
    assert.equal(occlusions(after, camera, target).length > 0, occlusions(before, camera, target).length > 0)
  }
  for (const item of [before, after]) { item.geometry.dispose(); item.material.dispose() }
})

test('preview follows the camera in rotated/elevated workshops, does not mutate saved data, and releases resources', () => {
  const ws = workshop(), controls = new THREE.EventDispatcher(), camera = new THREE.PerspectiveCamera(40, 1, .1, 200)
  ws.layout.transform = { x: 30, y: 5, z: -20, rotationY: 67 }
  const snapshot = JSON.stringify(ws), manager = { scene: new THREE.Scene(), environmentObjects: [], controls, camera }
  const renderer = new IndustrialGroundRenderer(manager, { cutaway: true }); renderer.update([ws], true)
  const surface = renderer.floors[0].mesh
  const move = point => { camera.position.copy(surface.localToWorld(new THREE.Vector3(...point))); camera.lookAt(surface.localToWorld(new THREE.Vector3(0, -3, 0))); controls.dispatchEvent({ type: 'change' }) }
  move([0, 1, 20])
  const first = surface.geometry
  renderer.updateView(); assert.equal(surface.geometry, first, 'stationary cameras do not rebuild terrain')
  let disposed = false; first.addEventListener('dispose', () => { disposed = true })
  move([0, 1, -20]); assert.ok(disposed)
  const target = surface.localToWorld(new THREE.Vector3(0, -3.5, 0)), origin = camera.position.clone()
  assert.equal(new THREE.Raycaster(origin, target.clone().sub(origin).normalize(), 0, origin.distanceTo(target) - .005).intersectObject(surface).length, 0)
  assert.equal(JSON.stringify(ws), snapshot)
  const second = surface.geometry; let finalDisposed = false; second.addEventListener('dispose', () => { finalDisposed = true })
  renderer.dispose(); assert.ok(finalDisposed); assert.equal(controls.hasEventListener('change', renderer.onCameraChange), false)
  assert.equal(manager.scene.children.length, 0)
})

test('cutaway is enabled only in the composer, not persisted or forced into other previews/native scenes', async () => {
  const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /industrialGround: true,\s*groundCutaway: true/)
  const manager = { scene: new THREE.Scene(), environmentObjects: [] }, ws = workshop()
  const renderer = new IndustrialGroundRenderer(manager); renderer.update([ws], true)
  assert.equal(renderer.floors[0].mesh.geometry, renderer.floors[0].baseGeometry)
  renderer.dispose()
})
