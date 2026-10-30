import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { InspectionPreview } from '../src/runtime/InspectionPreview.js'
import { ManualDisassemblyLayoutRuntime, worldDeltaToInspectionOffset } from '../src/runtime/manualDisassemblyLayout.js'
import inspectionConfig from '../../shared/inspectionConfig.mjs'

const { createInspectionDefaults, normalizeInspection } = inspectionConfig
const mirror = new THREE.Matrix4().makeScale(-1, 1, 1)
const vector = values => new THREE.Vector3(...values)
const closeVector = (actual, expected, name) => assert.ok(actual.distanceTo(expected) < 1e-8, `${name}: ${actual.toArray()} != ${expected.toArray()}`)
const transformVector = (value, matrix) => value.clone().applyMatrix4(matrix).sub(new THREE.Vector3().applyMatrix4(matrix))
const generated = []

function fixture(settings, config) {
    const scene = new THREE.Scene(), root = new THREE.Group(), nodeMap = new Map()
    scene.add(root)
    root.position.copy(vector(settings.position))
    root.rotation.y = THREE.MathUtils.degToRad(settings.yaw)
    root.scale.set(settings.mirrored ? -settings.scale : settings.scale, settings.scale, settings.scale)
    const material = new THREE.MeshStandardMaterial()
    function parent(name, position, yaw, scale) {
        const node = new THREE.Group(); node.name = name
        node.position.copy(vector(position)); node.rotation.y = THREE.MathUtils.degToRad(yaw); node.scale.setScalar(scale)
        root.add(node); return node
    }
    const parents = [parent('ParentA', [-1, .5, .2], 35, .7), parent('ParentB', [1, .2, -.4], -25, 1.3)]
    function cube(name, owner, position) {
        const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material); node.name = name
        node.position.copy(vector(position)); owner.add(node); nodeMap.set(name, node); return node
    }
    const a = cube('A', parents[0], [.2, .3, -.1]), b = cube('B', parents[1], [0, .2, .1]), c = cube('C', root, [0, 0, 2])
    root.updateMatrixWorld(true)
    const originalMatrices = new Map([a, b, c].map(node => [node, node.matrixWorld.clone()]))
    const nodes = [...nodeMap].map(([name]) => ({ path: name, name, isMesh: true, meshCount: 1 }))
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, .01, 1000)
    const controls = new THREE.EventDispatcher(); Object.assign(controls, { target: new THREE.Vector3(), minDistance: 1, autoRotate: false })
    const preview = new InspectionPreview({ root, scene, nodeMap, nodes, camera, controls, config })
    const modelPoint = node => root.worldToLocal(node.getWorldPosition(new THREE.Vector3()))
    return { root, parents, a, b, c, preview, originalMatrices, modelPoint,
        dispose() { preview.dispose(); root.traverse(node => node.geometry?.dispose()); material.dispose() } }
}

for (const offsetSpace of ['model', 'parent']) for (const device of [0, 1]) test(`${offsetSpace}: device ${device} drag/save/reload preserves native coordinate contract`, () => {
    const settings = { position: device ? [-4, 1, 8] : [7, 2, -3], yaw: device ? -41 : 63, scale: device ? 1.5 : 2, mirrored: !device }
    const defaults = createInspectionDefaults()
    const base = normalizeInspection({ ...defaults, offset_space: offsetSpace, shell_duration: .25, stagger: .06, easing: 'linear',
        parts: [
            { id: 'group', name: 'Manual assembly', node_names: ['A', 'B'], explode_offset: [.7, -.8, .9], explode_rotation: [23, -37, 51], point_ids: ['retained-plc-id'] },
            { id: 'other', name: 'Unedited part', node_name: 'C', explode_offset: [.5, .25, -.75], delay: .1 }
        ] })
    const baseJson = JSON.stringify(base)
    const baseline = fixture(settings, base)
    baseline.preview.setProgress(1)
    const before = [baseline.a, baseline.b, baseline.c].map(node => node.getWorldPosition(new THREE.Vector3()))
    const dragWorld = vector(device ? [-1.25, .4, 2.2] : [2.5, -.7, 1.3])
    const basis = offsetSpace === 'model' ? baseline.root.matrixWorld : baseline.parents[0].matrixWorld
    const expectedOffsetDelta = transformVector(dragWorld, basis.clone().invert())
    if (offsetSpace === 'parent') expectedOffsetDelta.x = -expectedOffsetDelta.x
    const offsetDelta = worldDeltaToInspectionOffset(dragWorld, basis, offsetSpace)
    closeVector(offsetDelta, expectedOffsetDelta, 'UI math helper preserves full inverse scale/rotation/mirror transform')
    baseline.preview.dispose()
    const manual = new ManualDisassemblyLayoutRuntime({ root: baseline.root, scene: baseline.root.parent, inspection: base })
    const start = manual.selectedCenter()
    assert.equal(manual.beginDrag(start), true)
    manual.dragTo(start.clone().add(dragWorld)); manual.endDrag()
    const saved = manual.getDraft()
    closeVector(vector(saved.parts[0].explode_offset), vector(base.parts[0].explode_offset).add(offsetDelta), 'actual drag runtime saves canonical offsets')
    const instanceConfig = { unrelatedSetting: 'must survive', mirrorX: settings.mirrored, inspection: saved }
    const reloaded = normalizeInspection(JSON.parse(JSON.stringify(instanceConfig)).inspection)
    assert.deepEqual(reloaded.parts[1], base.parts[1], 'unedited assembly and PLC associations survive')
    assert.deepEqual(reloaded.parts[0].explode_rotation, base.parts[0].explode_rotation, 'dragging does not overwrite authored rotation')
    assert.equal(JSON.stringify(base), baseJson, 'shared model defaults are not changed')
    const edited = fixture(settings, reloaded)
    const samples = {}
    try {
        edited.preview.setProgress(1)
        const after = [edited.a, edited.b, edited.c].map(node => node.getWorldPosition(new THREE.Vector3()))
        closeVector(after[0].clone().sub(before[0]), dragWorld, 'representative target follows exact world drag')
        closeVector(after[2], before[2], 'other configured part stays in its saved location')
        const expectedSecondDelta = offsetSpace === 'model' ? dragWorld : transformVector(offsetDelta.clone().applyMatrix4(mirror), baseline.parents[1].matrixWorld)
        closeVector(after[1].clone().sub(before[1]), expectedSecondDelta, 'second target follows the same authored vector in its configured coordinate basis')
        for (const progress of [0, .35, 1]) {
            edited.preview.setProgress(progress)
            samples[String(progress)] = Object.fromEntries([edited.a, edited.b, edited.c].map(node => [node.name, edited.modelPoint(node).toArray()]))
        }
        edited.preview.setProgress(0)
        for (const [node, original] of edited.originalMatrices) node.matrixWorld.elements.forEach((value, index) => assert.ok(Math.abs(value - original.elements[index]) < 1e-9, 'reassembly has no transform drift'))
        edited.preview.setProgress(1)
        for (const node of [edited.a, edited.b, edited.c]) closeVector(edited.modelPoint(node), vector(samples['1'][node.name]), 'reload/replay has identical endpoint')
        if (offsetSpace === 'parent') {
            const nativeRotation = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-37))
                .multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(23)))
                .multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(51)))
            const equivalent = mirror.clone().multiply(nativeRotation).multiply(mirror)
            const actual = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(23), THREE.MathUtils.degToRad(37), THREE.MathUtils.degToRad(-51), 'YXZ'))
            actual.elements.forEach((value, index) => assert.ok(Math.abs(value - equivalent.elements[index]) < 1e-12, 'parent Euler order and F conjugation exactly reproduce Unity ZXY'))
        }
        generated.push({ id: `${offsetSpace}-${device}`, settings, sourceInspection: base, instanceConfig, samples })
    } finally { manual.dispose(); baseline.dispose(); edited.dispose() }
})

after(() => {
    const output = path.resolve(import.meta.dirname, '../../output/device-inspection-offset-preview-contract.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, JSON.stringify({ status: generated.length === 4 ? 'passed' : 'incomplete', cases: generated }, null, 2))
})
