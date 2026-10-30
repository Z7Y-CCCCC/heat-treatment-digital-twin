import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { InspectionPreview } from '../src/runtime/InspectionPreview.js'
import { restoreGltfNodeNames } from '../src/three/gltfNodeIdentity.js'

const require = createRequire(import.meta.url)
const { getPitFurnaceModels, nodeRecords } = require('../../backend/services/pitFurnaceModels.js')
const { stringifyModelMetadata } = require('../../backend/services/modelAssetMetadata.js')
const { mergeBuiltinModels } = require('../../backend/services/builtinModels.js')
const rootDir = path.resolve(import.meta.dirname, '../..')
const tick = (preview, duration) => { for (let time = 0; time < duration; time += .05) preview.update(.05) }

test('pit furnace registration is repeatable and preserves user metadata overrides', () => {
    const models = getPitFurnaceModels()
    assert.equal(models.length, 5)
    for (const model of models) {
        const original = JSON.parse(model.metadata)
        const normalized = JSON.parse(stringifyModelMetadata(original))
        assert.deepEqual(normalized.inspection, original.inspection)
        assert.equal(normalized.runtime.enableGenericBindings, false)
        assert.equal(normalized.assetSpec.delivery_status, 'review')
        const custom = { ...model, name: '现场自定义名称', metadata: JSON.stringify({ inspection: { enabled: false, parts: [] } }) }
        const merged = mergeBuiltinModels([custom]).find(item => item.id === model.id)
        assert.equal(merged.metadata, custom.metadata)
        assert.equal(merged.name, custom.name)
    }
})

for (const model of getPitFurnaceModels()) test(`${model.id}: real GLB supports xray/explosion/part selection/isolation/reassembly`, async t => {
    const file = fs.readFileSync(path.join(rootDir, 'backend', model.file_path.replace(/^\//, '')))
    const document = JSON.parse(file.toString('utf8', 20, 20 + file.readUInt32LE(12)))
    const gltf = await new GLTFLoader().parseAsync(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), '')
    restoreGltfNodeNames(gltf)
    const root = gltf.scene
    const scene = new THREE.Scene(); scene.add(root)
    const nodeMap = new Map()
    function walk(parent, prefix = '') {
        parent.children.forEach((child, index) => {
            const segment = `${(child.name || child.type).replaceAll('/', '_')}#${index}`
            const key = prefix ? `${prefix}/${segment}` : segment
            nodeMap.set(key, child); walk(child, key)
        })
    }
    walk(root)
    const camera = new THREE.PerspectiveCamera(45, 1.4, .01, 1000)
    camera.position.set(10, 7, 15)
    const controls = new THREE.EventDispatcher()
    Object.assign(controls, { target: new THREE.Vector3(), minDistance: 1, autoRotate: true })
    const events = new Map()
    const renderer = { localClippingEnabled: false, domElement: { style: {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
        addEventListener: (event, fn) => events.set(event, fn), removeEventListener: event => events.delete(event) } }
    const config = JSON.parse(model.metadata).inspection
    root.updateMatrixWorld(true)
    const originals = new Map([...nodeMap.values()].map(node => [node, node.matrixWorld.clone()]))
    const preview = new InspectionPreview({ root, scene, nodeMap, nodes: nodeRecords(document), camera, controls, renderer, config })
    t.after(() => preview.dispose())
    assert.deepEqual(preview.validation.errors, [])
    assert.equal(preview.parts.length, config.parts.length)
    assert.ok(preview.shellMeshes.size > 0)
    preview.setStage('xray'); tick(preview, 2)
    assert.ok([...preview.shellMeshes].every(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every(material => material.opacity < .25)))
    preview.setStage('exploded'); tick(preview, 5)
    assert.equal(preview.time, preview.timeline.duration)
    assert.ok([...preview.shellMeshes].every(mesh => !mesh.visible))
    assert.ok(preview.wrappers.some(({ target }) => !target.matrixWorld.equals(originals.get(target))))
    for (const part of preview.parts) {
        preview.command({ command: 'select', partId: part.config.id, focus: false })
        preview.command({ command: 'isolate', enabled: true })
        assert.equal(preview.selectedId, part.config.id)
        assert.equal(preview.isolated, true)
        assert.ok(!part.bounds.isEmpty())
        const owned = new Set(); part.targets.forEach(target => target.traverse(child => { if (child.isMesh) owned.add(child) }))
        for (const other of preview.parts.filter(item => item !== part)) other.targets.forEach(target => target.traverse(mesh => {
            if (mesh.isMesh && !owned.has(mesh)) assert.equal(mesh.visible, false)
        }))
        preview.command({ command: 'isolate', enabled: false })
    }
    preview.command({ command: 'labels', enabled: false }); assert.equal(preview.labelsEnabled, false)
    preview.command({ command: 'labels', enabled: true }); assert.equal(preview.labelsEnabled, true)
    preview.setStage('solid'); tick(preview, 5)
    root.updateMatrixWorld(true)
    assert.equal(preview.time, 0)
    assert.ok([...preview.shellMeshes].every(mesh => mesh.visible))
    for (const { target } of preview.wrappers) target.matrixWorld.elements.forEach((value, index) => assert.ok(Math.abs(value - originals.get(target).elements[index]) < 1e-5))
    preview.setStage('exploded'); tick(preview, .5)
    preview.command({ command: 'pause' }); const stopped = preview.time; tick(preview, .5); assert.equal(preview.time, stopped)
    preview.command({ command: 'resume' }); tick(preview, 5); assert.equal(preview.time, preview.timeline.duration)
})
