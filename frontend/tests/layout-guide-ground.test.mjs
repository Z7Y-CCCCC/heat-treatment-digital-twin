import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { SceneManager } from '../src/three/SceneManager.js'
import { IndustrialGroundRenderer } from '../src/runtime/IndustrialGroundRenderer.js'

function fixture(t, { transform = {}, lineTransform = {}, length = 72.5, offsetZ = .5 } = {}) {
  const workshop = { id: 'workshop', layout: { size: { width: 200, depth: 100 }, transform }, lines: [
    { id: 'line', layout: { version: 2, transform: lineTransform,
      lanes: [{ id: 'lane', offsetZ: -4.3, length: 81 }],
      rails: [{ id: 'rail', name: '小车导轨 1', offsetZ, length }] }, devices: [] }
  ] }
  const before = JSON.stringify(workshop)
  const manager = Object.assign(Object.create(SceneManager.prototype), {
    scene: new THREE.Scene(), furnaces: [], environmentObjects: [], currentLevel: 2, activeLineIndex: 0,
    addLineBadge() {} // DOM labels do not participate in floor occlusion.
  })
  manager.setTopologyConfig([workshop], '4level')
  const ground = new IndustrialGroundRenderer(manager)
  ground.update([workshop], true)
  manager.scene.updateMatrixWorld(true)
  t.after(() => { ground.dispose(); manager.clearFactoryGuides() })
  const group = manager.factoryGuideLayer.children[0]
  const rails = group.children.filter(node => node.geometry?.parameters?.height === .16)
  assert.equal(rails.length, 2)
  assert.equal(JSON.stringify(workshop), before, 'Rendering must never rewrite saved layout data')
  return { workshop, manager, ground, group, rails }
}

test('configured double rails render above the new opaque industrial floor, not below it', t => {
  const { manager, rails } = fixture(t)
  for (const rail of rails) {
    const point = rail.getWorldPosition(new THREE.Vector3())
    const hits = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0, 20, 0)), new THREE.Vector3(0, -1, 0)).intersectObject(manager.scene)
    assert.ok(hits[0]?.object === rail, 'The rail must be the first visible surface, not the opaque floor')
    assert.equal(rail.material.depthTest, true, 'Do not draw a fake rail through equipment')
    assert.equal(rail.material.depthWrite, false)
    assert.equal(rail.geometry.parameters.width, 72.5)
  }
})

test('rail position and direction follow rotated/elevated workshops and line drafts without changing their dimensions', t => {
  const { manager, group, rails } = fixture(t, { transform: { x: 25, y: 3, z: -40, rotationY: 90 }, lineTransform: { x: 5, z: 8, rotationY: 35 }, offsetZ: 4.75, length: 37.25 })
  for (const rail of rails) {
    const point = rail.getWorldPosition(new THREE.Vector3())
    const hits = new THREE.Raycaster(point.clone().add(new THREE.Vector3(0, 20, 0)), new THREE.Vector3(0, -1, 0)).intersectObject(manager.scene)
    assert.ok(hits[0]?.object === rail)
    assert.equal(rail.geometry.parameters.width, 37.25)
  }
  assert.ok(Math.abs((rails[0].position.z + rails[1].position.z) / 2 - 4.75) < 1e-8)
  assert.ok(Math.abs(group.rotation.y + 125 * Math.PI / 180) < 1e-8)
  manager.currentLevel = 1; manager.activeWorkshopIdx = 0; manager.updateFactoryGuideVisibility()
  assert.equal(group.visible, true)
  manager.currentLevel = 2; manager.activeLineIndex = 1; manager.updateFactoryGuideVisibility()
  assert.equal(group.visible, false)
  manager.activeLineIndex = 0; manager.updateFactoryGuideVisibility()
  assert.equal(group.visible, true)
})

test('rebuilding layout marks uses the new draft length/offset and releases the old rail resources', t => {
  const { workshop, manager, rails } = fixture(t)
  let disposed = 0
  for (const rail of rails) rail.geometry.addEventListener('dispose', () => disposed++)
  workshop.lines[0].layout.rails[0].length = 3
  workshop.lines[0].layout.rails[0].offsetZ = 7
  manager.setTopologyConfig([workshop], '4level')
  assert.equal(disposed, 2)
  const next = manager.factoryGuideLayer.children[0].children.filter(node => node.geometry?.parameters?.height === .16)
  assert.ok(next.every(rail => rail.geometry.parameters.width === 3), 'Do not silently enlarge short saved rails')
  assert.ok(Math.abs((next[0].position.z + next[1].position.z) / 2 - 7) < 1e-8)
})
