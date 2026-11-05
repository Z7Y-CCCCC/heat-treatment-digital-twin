import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { restoreGltfNodeNames } from '../src/three/gltfNodeIdentity.js'
import { ManualDisassemblyLayoutRuntime } from '../src/runtime/manualDisassemblyLayout.js'
import { disposeSceneObject } from '../src/runtime/ConfiguredFactoryScene.js'
const metadata = JSON.parse(fs.readFileSync(new URL('../../backend/assets/models/cad_tempering_furnace_091300_metadata.json', import.meta.url)))
for (const folder of ['models', 'motions']) test(`tempering ${folder}: complete mechanical assembly coverage; layout edits and restore are reversible`, async () => {
  const bytes = fs.readFileSync(new URL(`../../backend/assets/${folder}/cad_tempering_furnace_091300.glb`, import.meta.url))
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
  restoreGltfNodeNames(gltf)
  const root = gltf.scene, scene = new THREE.Scene(); scene.add(root); root.updateMatrixWorld(true)
  const meshes = []; root.traverse(node => { if (node.isMesh) meshes.push({ node, parent: node.parent, matrix: node.matrixWorld.clone(), material: node.material }) })
  if (folder === 'models') assert.equal(meshes.length, 67)
  const mechanicalRoot = root.getObjectByName('cad_tempering_furnace_v1_root')
  const below = (node, parent) => { for (let n = node; n; n = n.parent) if (n === parent) return true; return false }
  const mechanical = meshes.filter(({ node }) => below(node, mechanicalRoot))
  assert.ok(mechanical.length >= 67)
  const runtime = new ManualDisassemblyLayoutRuntime({ root, scene, inspection: metadata.inspection })
  assert.equal(runtime.parts.length, 19); assert.deepEqual(runtime.validation.errors, [])
  for (const { node } of mechanical) {
    const owners = runtime.parts.filter(part => part.targets.some(target => { for (let n = node; n; n = n.parent) if (n === target) return true; return false }))
    assert.equal(owners.length, 1, node.name)
  }
  for (let cycle = 0; cycle < 3; cycle++) {
    runtime.setAssembled(true); root.updateMatrixWorld(true)
    for (const { node, matrix } of meshes) assert.ok(node.matrixWorld.elements.every((n, i) => Math.abs(n - matrix.elements[i]) < 1e-5), node.name)
    runtime.setAssembled(false); root.updateMatrixWorld(true)
    assert.ok(meshes.some(({ node, matrix }) => node.matrixWorld.elements.some((n, i) => Math.abs(n - matrix.elements[i]) > .1)))
  }
  const id = runtime.parts[5].config.id, before = runtime.getDraft()
  runtime.setOffset(id, [2, 3, 4]); assert.ok(runtime.dirty); runtime.undo(); assert.deepEqual(runtime.getDraft(), before)
  runtime.redo(); assert.deepEqual(runtime.getDraft().parts[5].explode_offset, [2, 3, 4])
  runtime.dispose(); root.updateMatrixWorld(true)
  for (const { node, matrix, material, parent } of meshes) { assert.equal(node.parent, parent); assert.equal(node.material, material); assert.ok(node.matrixWorld.elements.every((n, i) => Math.abs(n - matrix.elements[i]) < 1e-5)) }
  disposeSceneObject(root)
})
