import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { LoadingPortPreview, collectLoadingPortNodes, nodeBoundsInLoadingRoot } from '../src/three/LoadingPortPreview.js'

test('node bounds and center/bottom coordinates include authored hierarchy but exclude owner root transforms', () => {
  const root = new THREE.Group(); root.position.set(100, 40, -70); root.scale.set(2, 3, 4); root.rotation.y = .5
  const group = new THREE.Group(); group.position.set(5, 1, 6); root.add(group)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 6)); mesh.position.set(2, 3, 0); group.add(mesh)
  const original = { position: root.position.toArray(), scale: root.scale.toArray(), rotation: root.rotation.toArray(), node: mesh.position.toArray() }
  const originalBounds = mesh.geometry.boundingBox
  const box = nodeBoundsInLoadingRoot(group, root)
  const center = box.getCenter(new THREE.Vector3()).toArray()
  center.forEach((value, axis) => assert.ok(Math.abs(value - [7, 4, 6][axis]) < 1e-8)); assert.ok(Math.abs(box.min.y - 3) < 1e-8)
  assert.deepEqual({ position: root.position.toArray(), scale: root.scale.toArray(), rotation: root.rotation.toArray(), node: mesh.position.toArray() }, original)
  assert.equal(mesh.geometry.boundingBox, originalBounds, 'measurement must not populate or mutate asset geometry bounds')
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { root, nodes: collectLoadingPortNodes(root) })
  const point = preview.nodePoint(group.uuid, true); assert.ok(Math.abs(point.position[1] - 3) < 1e-8)
  mesh.geometry.dispose()
})

test('editor markers never pollute node bounds and node picker keeps duplicate names distinct', () => {
  const root = new THREE.Group(), one = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)), two = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
  one.name = two.name = 'same'; two.position.x = 3; root.add(one, two)
  const entries = collectLoadingPortNodes(root); assert.equal(entries.filter(entry => entry.name === 'same').length, 2); assert.notEqual(entries[1].id, entries[2].id)
  const marker = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000)); marker.userData.loadingPortEditor = true; root.add(marker)
  const bounds = nodeBoundsInLoadingRoot(root, root); assert.equal(bounds.min.x, -1); assert.equal(bounds.max.x, 4)
  for (const mesh of [one, two, marker]) mesh.geometry.dispose()
})

test('preview disposal is idempotent and releases animation, resize, controls, renderer and pointer hooks', () => {
  const counts = {}, count = name => counts[name] = (counts[name] || 0) + 1
  const dom = { removeEventListener: name => count(name), remove: () => count('dom') }
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { disposed: false, renderer: { domElement: dom, setAnimationLoop: value => { assert.equal(value, null); count('loop') }, dispose: () => count('renderer'), forceContextLoss: () => count('context') }, controls: { dispose: () => count('controls') }, observer: { disconnect: () => count('resize') }, clearAsset: () => count('assets') })
  preview.dispose(); preview.dispose()
  assert.deepEqual(counts, { loop: 1, resize: 1, pointerdown: 1, pointerup: 1, controls: 1, assets: 1, renderer: 1, context: 1, dom: 1 })
})
