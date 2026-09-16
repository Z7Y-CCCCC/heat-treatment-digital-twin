import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import inspectionConfig from '../../shared/inspectionConfig.mjs'
import { InspectionPreview, generateInspectionParts, inspectionTimeline, inspectionCameraPose, spreadInspectionParts } from '../src/runtime/InspectionPreview.js'

const { createInspectionDefaults, normalizeInspection, validateInspection } = inspectionConfig
const close = (actual, expected, epsilon = 0.00001) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`)
function tick(preview, duration) { for (let time = 0; time < duration - 0.00001; time += 0.05) preview.update(Math.min(0.05, duration - time)) }
function fixture(t, patch = {}) {
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    root.name = 'Root'
    scene.add(root)
    const material = new THREE.MeshStandardMaterial({ color: 0x8899aa })
    const shell = new THREE.Group()
    shell.name = 'Case'
    const shellMesh = new THREE.Mesh(new THREE.BoxGeometry(10, 8, 7), material)
    shellMesh.name = 'CaseMesh'
    shell.add(shellMesh)
    const motor = new THREE.Group()
    motor.name = 'Motor'
    motor.position.set(1, 0, 0)
    const motorMesh = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.04), material)
    motorMesh.name = 'MotorMesh'
    motor.add(motorMesh)
    shell.add(motor)
    const drive = new THREE.Group()
    drive.name = 'Drive'
    drive.position.set(-2, 0, 0)
    drive.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material))
    root.add(shell, drive)
    const nodeMap = new Map([['Case#0', shell], ['Case#0/CaseMesh#0', shellMesh], ['Case#0/Motor#1', motor], ['Case#0/Motor#1/MotorMesh#0', motorMesh], ['Drive#1', drive]])
    const nodes = [...nodeMap].map(([path, node]) => ({ path, name: node.name, parentPath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', isMesh: !!node.isMesh, type: node.type, meshCount: 1 }))
    const camera = new THREE.PerspectiveCamera(45, 1.4, 0.01, 1000)
    camera.position.set(14, 10, 20)
    const controls = new THREE.EventDispatcher()
    controls.target = new THREE.Vector3()
    controls.minDistance = 1
    controls.autoRotate = true
    const listeners = new Map()
    const renderer = { localClippingEnabled: false, domElement: {
        style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 700, height: 500 }),
        addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name)
    } }
    let state
    const defaults = createInspectionDefaults()
    const config = { ...defaults, animation_duration: 1, shell_duration: 1, stagger: 0.2,
        shell: { ...defaults.shell, transition: 'clip', node_path: 'Case#0/CaseMesh#0' },
        parts: [
            { id: 'motor', name: '循环风机', node_path: 'Case#0/Motor#1', explode_offset: [2, 1, 0], point_ids: ['p1'], point_keys: ['motors.rpm'] },
            { id: 'drive', name: '驱动总成', node_path: 'Drive#1', explode_offset: [-2, 0, 0], delay: 0.3, duration: 0.5 }
        ], ...patch }
    const preview = new InspectionPreview({ root, scene, nodeMap, nodes, camera, controls, renderer, config, onState: next => { state = next } })
    t.after(() => { preview.dispose(); root.traverse(node => node.geometry?.dispose()); material.dispose() })
    return { preview, scene, root, shell, shellMesh, motor, motorMesh, drive, material, camera, controls, renderer, listeners, nodeMap, nodes, get state() { return state } }
}

test('timeline uses enabled part order, shell lead-in, per-part delay and duration', () => {
    const defaults = createInspectionDefaults()
    const timeline = inspectionTimeline({ ...defaults, shell_duration: 1, animation_duration: 2, stagger: 0.2, parts: [
        { id: 'one', delay: 0.1 }, { id: 'off', enabled: false, delay: 10 }, { id: 'two', delay: 0.3, duration: 0.5 }
    ] })
    assert.deepEqual(timeline.parts.map(({id, start, duration}) => [id,start,duration]), [['one',1.1,2],['two',1.5,0.5]])
    close(timeline.duration, 3.1)
})

test('shell clip clears first while retained internal assemblies stay opaque', t => {
    const { preview, motor, motorMesh, shellMesh, material, renderer } = fixture(t)
    const assembled = motor.getWorldPosition(new THREE.Vector3())
    preview.setProgress(0.5 / preview.timeline.duration)
    assert.equal(renderer.localClippingEnabled, true)
    assert.equal(shellMesh.material.clippingPlanes.length, 1)
    assert.equal(motorMesh.material.clippingPlanes, null)
    assert.equal(motorMesh.material.opacity, 1)
    assert.deepEqual(motor.getWorldPosition(new THREE.Vector3()).toArray(), assembled.toArray())
    preview.setProgress(1)
    assert.equal(shellMesh.visible, false)
    assert.equal(motorMesh.visible, true)
    assert.equal(material.opacity, 1)
    assert.equal(material.clippingPlanes, null)
})

test('explosion and reverse assembly use one continuous timeline without transform reset', t => {
    const { preview, motor } = fixture(t)
    preview.setStage('exploded')
    tick(preview, 1.6)
    const beforeReverse = motor.getWorldPosition(new THREE.Vector3()).clone()
    assert.ok(beforeReverse.x > 1)
    preview.setStage('solid')
    assert.deepEqual(motor.getWorldPosition(new THREE.Vector3()).toArray(), beforeReverse.toArray())
    tick(preview, 1.6)
    close(motor.getWorldPosition(new THREE.Vector3()).x, 1)
    close(preview.time, 0)
    assert.equal(preview.playing, false)
})

test('pause freezes timeline and resume continues in the same direction', t => {
    const { preview } = fixture(t)
    preview.setStage('exploded')
    tick(preview, 1.2)
    preview.command({ command: 'pause' })
    const pausedTime = preview.time
    tick(preview, 1)
    close(preview.time, pausedTime)
    preview.command({ command: 'resume' })
    tick(preview, 0.2)
    close(preview.time, pausedTime + 0.2)
})

test('playback speed changes wall-clock playback without changing authored timeline positions', t => {
    const slow = fixture(t, { playback_speed: 0.5 })
    const fast = fixture(t, { playback_speed: 2 })
    slow.preview.setStage('exploded')
    fast.preview.setStage('exploded')
    slow.preview.update(0.2)
    fast.preview.update(0.2)
    close(slow.preview.time, 0.1)
    close(fast.preview.time, 0.4)
    close(slow.preview.timeline.duration, fast.preview.timeline.duration)
})

test('multi-node transforms use dedicated wrappers and preserve live PLC transforms', t => {
    const { preview, motor, drive, root } = fixture(t, { parts: [{ id: 'both', name: '总成', node_paths: ['Case#0/Motor#1', 'Drive#1'], explode_offset: [3, 0, 0], explode_rotation: [0, 0, 0] }] })
    const originalMotorPosition = motor.position.clone()
    motor.rotation.x = 0.42
    root.rotation.y = Math.PI / 2
    root.scale.setScalar(2)
    root.updateMatrixWorld(true)
    preview.setProgress(1)
    close(motor.rotation.x, 0.42)
    assert.deepEqual(motor.position.toArray(), originalMotorPosition.toArray())
    assert.equal(preview.wrappers.length, 2)
    close(motor.getWorldPosition(new THREE.Vector3()).z, -8)
    close(drive.getWorldPosition(new THREE.Vector3()).z, -2)
})

test('multi-node assembly rotates rigidly around a shared pivot instead of spinning each node separately', t => {
    const { preview, motor, drive } = fixture(t, { parts: [{ id: 'both', node_paths: ['Case#0/Motor#1', 'Drive#1'], explode_offset: [3, 0, 0], explode_rotation: [0, 90, 0] }] })
    const before = motor.getWorldPosition(new THREE.Vector3()).sub(drive.getWorldPosition(new THREE.Vector3()))
    preview.setProgress(1)
    const after = motor.getWorldPosition(new THREE.Vector3()).sub(drive.getWorldPosition(new THREE.Vector3()))
    close(after.length(), before.length())
    close(after.x, 0)
    close(after.z, -3)
    close(motor.rotation.y, 0)
})

test('automatic small-part camera uses part size and no whole-model target offset', t => {
    const { preview, camera, controls, motor } = fixture(t)
    preview.setProgress(1)
    preview.select('motor')
    tick(preview, 0.7)
    assert.ok(camera.position.distanceTo(controls.target) < 0.5)
    close(controls.target.distanceTo(motor.getWorldPosition(new THREE.Vector3())), 0)
    assert.ok(camera.near < 0.001)
    assert.ok(controls.minDistance < 0.01)
})

test('authored part camera overrides auto orientation and projects spatial labels', t => {
    const result = fixture(t)
    const { preview, controls, camera } = result
    preview.parts[0].config.camera = { yaw: 0, pitch: 0, distance_scale: 2, target_offset: [0, 0.1, 0] }
    preview.select('motor')
    tick(preview, 0.7)
    close(camera.position.x, controls.target.x)
    close(camera.position.y, controls.target.y)
    assert.ok(camera.position.z > controls.target.z)
    assert.ok(result.state.parts.every(part => Number.isFinite(part.anchor.x) && Number.isFinite(part.label.y)))
    assert.equal(result.state.selectedId, 'motor')
})

test('dispose restores exact node parent/order, materials, clipping and event listeners', t => {
    const { preview, root, shell, motor, motorMesh, shellMesh, drive, material, renderer, controls, listeners } = fixture(t)
    const temporaryMaterials = preview.materials.flatMap(entry => entry.clones)
    let disposed = 0
    temporaryMaterials.forEach(value => value.addEventListener('dispose', () => disposed++))
    preview.setProgress(1)
    preview.dispose()
    assert.deepEqual(root.children, [shell, drive])
    assert.deepEqual(shell.children, [shellMesh, motor])
    assert.equal(motorMesh.material, material)
    assert.equal(shellMesh.material, material)
    assert.equal(shellMesh.visible, true)
    assert.equal(listeners.size, 0)
    assert.equal(renderer.localClippingEnabled, false)
    assert.equal(controls.minDistance, 1)
    assert.equal(controls.autoRotate, true)
    assert.equal(disposed, temporaryMaterials.length)
    preview.dispose()
    assert.equal(disposed, temporaryMaterials.length)
})

test('ambiguous part ownership is validated and never translated twice in preview', t => {
    const result = fixture(t, { parts: [{id:'first',node_name:'Motor',explode_offset:[1,0,0]},{id:'second',node_path:'Case#0/Motor#1',explode_offset:[9,0,0]}] })
    assert.equal(result.preview.validation.valid, false)
    assert.equal(result.preview.parts.length, 1)
    result.preview.setProgress(1)
    close(result.motor.getWorldPosition(new THREE.Vector3()).x, 2)
})

test('broad shell roots are kept visible instead of hiding unconfigured descendants', t => {
    const result = fixture(t, { shell: { node_path: 'Case#0' } })
    assert.equal(result.preview.validation.valid, false)
    assert.ok(result.preview.validation.errors.some(error => error.code === 'shell_part_overlap'))
    result.preview.setProgress(1)
    assert.equal(result.shellMesh.visible, true)
    assert.equal(result.motorMesh.visible, true)
})

const authorNodes = [
    {path:'Machine#0',parentPath:'',name:'Machine',displayName:'设备',type:'Group',isMesh:false,meshCount:3,bounds:{center:[0,0,0],size:[10,6,8]}},
    {path:'Machine#0/A#0',parentPath:'Machine#0',name:'A',displayName:'前机构',type:'Group',isMesh:false,meshCount:1,bounds:{center:[3,0,1],size:[1,1,1]}},
    {path:'Machine#0/B#1',parentPath:'Machine#0',name:'B',displayName:'后机构',type:'Group',isMesh:false,meshCount:1,bounds:{center:[-3,0,-1],size:[2,1,1]}},
    {path:'Machine#0/A#0/material#0',parentPath:'Machine#0/A#0',name:'material',type:'Mesh',isMesh:true,meshCount:1,bounds:{center:[3,0,1],size:[1,1,1]}}
]

test('hierarchy generation produces real groups, retains PLC keys and only appends nonoverlapping parts', () => {
    const existing = [{id:'keep',node_path:'Machine#0/A#0',point_ids:['temperature'] }]
    const generated = generateInspectionParts(authorNodes, {existingParts:existing,partBindings:[{node_path:'Machine#0/B#1',source_group:'motors',source_key:'rpm',point_id:'rpm-id'}]})
    assert.equal(generated.length, 1)
    assert.equal(generated[0].node_path, 'Machine#0/B#1')
    assert.equal(generated[0].name, '后机构')
    assert.deepEqual(generated[0].point_keys, ['motors.rpm'])
    assert.deepEqual(generated[0].point_ids, ['rpm-id'])
    assert.equal(generateInspectionParts(authorNodes.filter(node => node.isMesh)).length, 0)
})

test('generic bounds-based layouts retain metadata and do not mutate the input configuration', () => {
    const parts = generateInspectionParts(authorNodes)
    parts[0].point_ids = ['keep-id']
    parts[0].explode_rotation = [0,15,0]
    const snapshot = JSON.stringify(parts)
    for (const mode of ['radial','grid','x','y','z']) {
        const spread = spreadInspectionParts(parts, authorNodes, {mode,spacing:1.3})
        assert.equal(spread.length, 2)
        assert.equal(spread[0].id, parts[0].id)
        assert.deepEqual(spread[0].point_ids, ['keep-id'])
        assert.deepEqual(spread[0].explode_rotation, [0,15,0])
        assert.notDeepEqual(spread[0].explode_offset, spread[1].explode_offset)
        assert.ok(spread.every(part => part.explode_offset.every(Number.isFinite)))
    }
    assert.equal(JSON.stringify(parts), snapshot)
})

test('shared normalization survives full JSON save/reopen without dropping rich authoring fields', () => {
    const authored = normalizeInspection({ ...createInspectionDefaults(), shell_duration:1.2,stagger:0.2,easing:'cubic',labels:{enabled:false,leader_lines:true},
        shell:{node_names:['Case'],transition:'clip',axis:'z',direction:-1,opacity:0.15,wireframe:true},
        parts:[{id:'stable',name:'精密驱动',group:'驱动组',enabled:true,node_names:['A','B'],explode_offset:[1,2,3],explode_rotation:[10,20,30],delay:0.4,duration:2.3,label_offset:[0.1,0.2,0.3],point_ids:['plc-01'],point_keys:['motors.rpm'],detail_view_id:'device_part',description:'保留说明',camera:{yaw:71,pitch:15,distance_scale:0.85,target_offset:[0,0.2,0]}}]
    })
    assert.deepEqual(normalizeInspection(JSON.parse(JSON.stringify(authored))), authored)
    assert.equal(authored.parts[0].point_ids[0], 'plc-01')
    assert.equal(authored.parts[0].duration, 2.3)
    assert.deepEqual(authored.parts[0].explode_rotation, [10,20,30])
    assert.equal(validateInspection(authored, [{name:'A',path:'A#0'},{name:'B',path:'B#1'},{name:'Case',path:'Case#2'}]).valid, true)
})

test('camera fitting considers narrow viewports and keeps authored model-local target offsets', () => {
    const camera = new THREE.PerspectiveCamera(45, 0.4)
    const box = new THREE.Box3(new THREE.Vector3(-1,-1,-1),new THREE.Vector3(1,1,1))
    const narrow = inspectionCameraPose(camera,box,{yaw:90,pitch:0,distance_scale:1,target_offset:[1,0,0]},new THREE.Matrix4().makeScale(2,2,2))
    close(narrow.target.x,2)
    assert.ok(narrow.position.distanceTo(narrow.target) > 8)
})

test('draft rebuild preserves a paused reverse timeline and the manually orbited camera', t => {
    const original = fixture(t)
    original.preview.setProgress(.65)
    original.preview.setStage('solid')
    original.preview.command({command:'pause'})
    original.camera.position.set(8, 9, 10)
    original.controls.target.set(1, 2, 3)
    const state = original.preview.capturePlaybackState()
    const replacement = fixture(t)
    replacement.preview.restorePlaybackState(state)
    assert.equal(replacement.preview.stage, 'solid')
    assert.equal(replacement.preview.direction, -1)
    assert.equal(replacement.preview.paused, true)
    assert.deepEqual(replacement.camera.position.toArray(), [8, 9, 10])
    assert.deepEqual(replacement.controls.target.toArray(), [1, 2, 3])
    const before = replacement.preview.time
    replacement.preview.command({command:'resume'})
    replacement.preview.update(.1)
    assert.ok(replacement.preview.time < before)
})

test('disabled inspection cannot animate or hide the equipment shell', t => {
    const { preview, shellMesh } = fixture(t, { enabled: false })
    preview.setStage('exploded')
    preview.setProgress(1)
    tick(preview, 4)
    assert.equal(preview.time, 0)
    assert.equal(preview.stage, 'solid')
    assert.equal(preview.wrappers.length, 0)
    assert.equal(shellMesh.visible, true)
})

test('spatial labels wait for the part reveal and respect live visibility', t => {
    const f = fixture(t)
    assert.equal(f.state.parts.some(part => part.anchor.visible), false)
    f.preview.setProgress(1)
    f.motor.visible = false
    f.preview.update(.1)
    assert.equal(f.state.parts.find(part => part.id === 'motor').anchor.visible, false)
})
