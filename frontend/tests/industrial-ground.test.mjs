import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as THREE from 'three'
import { buildGroundMesh, resolveGround, normalizeGround, validateGround } from '../../shared/industrialGround.mjs'
import { normalizeWorkshopLayout } from '../src/utils/spatialLayout.js'
import { deviceTransformPayload } from '../../shared/deviceAuthoring.mjs'
import { IndustrialGroundRenderer } from '../src/runtime/IndustrialGroundRenderer.js'
const fixtures = JSON.parse(await readFile(new URL('../../shared/industrial-ground-fixtures.json', import.meta.url), 'utf8'))
for (const fixture of fixtures) test(`industrial ground contract: ${fixture.name}`, () => {
  const ground = resolveGround(fixture.workshop), mesh = buildGroundMesh(ground)
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3)); geometry.setIndex(mesh.indices)
  const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); surface.updateMatrixWorld(true)
  for (const [x, z, height] of fixture.samples) {
    const hits = new THREE.Raycaster(new THREE.Vector3(x, 150, z), new THREE.Vector3(0, -1, 0)).intersectObject(surface)
    assert.ok(hits.length, `${x},${z} must have a floor`)
    assert.ok(Math.abs(hits[0].point.y - height) < 1e-5, `${x},${z}: expected ${height}, got ${hits[0].point.y}`)
  }
  assert.ok(mesh.positions.every(Number.isFinite)); assert.ok(mesh.indices.every(i => i >= 0 && i < mesh.positions.length / 3))
  assert.ok(mesh.indices.length / 3 < 10000)
  geometry.dispose(); surface.material.dispose()
})
test('floor normalizers preserve data; invalid fields and excessive regions are rejected', () => {
  const ground = normalizeGround({ elevation: 1, areas: [{ id: 'a', x: 2, z: 3, width: 4, depth: 5, elevation: -2 }] })
  assert.deepEqual(normalizeWorkshopLayout({ ground }).ground, ground)
  assert.deepEqual(validateGround(ground), ground)
  for (const value of [{ ...ground, elevation: NaN }, { ...ground, areas: Array(33).fill(ground.areas[0]) }, { ...ground, areas: [{ ...ground.areas[0], width: -1 }] }]) assert.throws(() => validateGround(value))
})
test('narrow placement payload carries only explicit ground settings, never clears legacy data implicitly', () => {
  assert.equal('ground' in deviceTransformPayload({ pos_y: -3, instance_config: {} }), false)
  const ground = { enabled: true, width: 4, depth: 5, clearance: .5 }
  assert.deepEqual(deviceTransformPayload({ instance_config: { ground, inspection: { enabled: false }, plc_password: 'not-a-layout-field' } }).ground, ground)
  assert.equal('inspection' in deviceTransformPayload({ instance_config: { ground } }), false)
})
test('automatic ground stays bounded and reports overflow rather than crashing the scene', () => {
  const workshop = { layout: { size: { width: 100, depth: 80 } }, devices: Array.from({ length: 65 }, (_, i) => ({ id: `d${i}`, coordinate_space: 'workshop_local', pos_y: -2, scale: 1, instance_config: { ground: { enabled: true, width: 4, depth: 4, clearance: 0 } } })) }
  const ground = resolveGround(workshop)
  assert.equal(ground.areas.length, 64); assert.equal(ground.overflow, 1)
  assert.ok(buildGroundMesh(ground).indices.length < 1000)
})
test('preview ground replaces the old continuous plane and disposes replaced resources', () => {
  const old = new THREE.Object3D(), grid = new THREE.Object3D(), manager = { scene: new THREE.Scene(), environmentObjects: [old, grid] }
  const renderer = new IndustrialGroundRenderer(manager); renderer.update([fixtures[1].workshop])
  assert.equal(old.visible, false); assert.equal(grid.visible, false); assert.equal(renderer.root.children.length, 2)
  const previous = renderer.root; renderer.update([fixtures[1].workshop]); assert.equal(renderer.root, previous)
  let disposed = false; previous.children[0].geometry.addEventListener('dispose', () => { disposed = true })
  renderer.update([fixtures[0].workshop]); assert.ok(disposed); assert.equal(old.visible, true); assert.equal(renderer.root, null)
  renderer.dispose()
})
