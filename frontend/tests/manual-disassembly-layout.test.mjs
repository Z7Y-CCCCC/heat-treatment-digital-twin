import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createRenderer, h, KeepAlive, nextTick, ref } from 'vue'
import * as THREE from 'three'
import { buildManualNodeIndex, createManualLayoutRenderLoop, worldDeltaToInspectionOffset, ManualDisassemblyLayoutRuntime } from '../src/runtime/manualDisassemblyLayout.js'
import { disposeSceneObject } from '../src/runtime/ConfiguredFactoryScene.js'
import { deferred, installBrowser, settle } from './helpers.mjs'

const close = (actual, expected, epsilon = 1e-7) => assert.ok(actual.distanceTo(expected) < epsilon, `${actual.toArray()} != ${expected.toArray()}`)
function fixture(t, offsetSpace = 'model', options = {}) {
    const scene = new THREE.Scene(), root = new THREE.Group(), parent = new THREE.Group(), other = new THREE.Group()
    root.name = 'CAD'; parent.name = 'First parent'; other.name = 'Second parent'
    root.position.set(7, -3, 9); root.rotation.y = .7; root.scale.set(-2, 1.5, 3)
    parent.rotation.z = .3; parent.scale.set(1.5, .8, 2)
    other.rotation.y = -.8; other.position.x = -2
    root.add(parent, other); scene.add(root)
    const material = new THREE.MeshStandardMaterial({ color: 0x7189a0 })
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 2, .6), material), b = new THREE.Mesh(new THREE.BoxGeometry(.5, .8, 1), material)
    a.name = '炉井.工装'; b.name = '部件 B'; a.position.set(1, .5, 2); b.position.set(-1, 1, 0)
    parent.add(a); other.add(b)
    const originals = { parentA: a.parent, parentB: b.parent, positionA: a.position.clone(), positionB: b.position.clone(), rotationA: a.quaternion.clone(), material }
    const config = { enabled: options.enabled ?? true, offset_space: offsetSpace, extra_metadata: { keep: true }, parts: [
        { id: 'a', name: 'A', node_name: a.name, explode_offset: [1.2, -.3, .5], explode_rotation: [15, 35, -20], point_keys: ['motor.rpm'], extra_part_field: 'keep' },
        { id: 'b', name: 'B', node_name: b.name, explode_offset: [-1, 2, .6], explode_rotation: [0, 0, 0] }
    ] }
    if (options.multi) config.parts = [{ ...config.parts[0], node_names: [b.name] }]
    const before = JSON.stringify(config)
    const runtime = new ManualDisassemblyLayoutRuntime({ root, scene, inspection: config })
    t.after(() => { runtime.dispose(); a.geometry.dispose(); b.geometry.dispose(); material.dispose() })
    return { root, scene, parent, other, a, b, config, runtime, originals, before }
}

test('opaque GLB names and index paths match the existing editor and are not sanitized away', t => {
    const { root, a } = fixture(t)
    // The runtime wraps the hierarchy, so collect before authoring in a fresh tree.
    const fresh = new THREE.Group(), group = new THREE.Group(); group.name = 'Parent/A'
    const child = new THREE.Object3D(); child.name = a.name; group.add(child); fresh.add(group)
    const { map, nodes } = buildManualNodeIndex(fresh)
    assert.equal(map.get('Parent_A#0/炉井.工装#0'), child)
    assert.equal(nodes[1].name, '炉井.工装')
    assert.equal(root.name, 'CAD')
})

test('world vector conversion retains mirrored/nonuniform scales and ignores translations', () => {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(100, -25, 60), new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .8, -.4)), new THREE.Vector3(-2, .5, 3))
    const local = new THREE.Vector3(1.2, -.8, .25)
    const world = local.clone().applyMatrix4(matrix).sub(new THREE.Vector3().applyMatrix4(matrix))
    close(worldDeltaToInspectionOffset(world, matrix), local)
    close(worldDeltaToInspectionOffset(world, matrix, 'parent'), new THREE.Vector3(-local.x, local.y, local.z))
    assert.throws(() => worldDeltaToInspectionOffset(world, new THREE.Matrix4().makeScale(0, 1, 1)), /缩放为零/)
})

test('model drag stores per-part offset delta, preserving pivot rotation and original mesh transforms', t => {
    const { runtime, a, config, originals, before } = fixture(t)
    const start = runtime.selectedCenter(), desired = start.clone().add(new THREE.Vector3(.4, -.6, 1.7))
    runtime.beginDrag(start); runtime.dragTo(desired); runtime.endDrag()
    close(runtime.selectedCenter(), desired)
    close(a.position, originals.positionA); assert.ok(a.quaternion.equals(originals.rotationA))
    assert.equal(JSON.stringify(config), before)
    assert.deepEqual(runtime.getDraft().parts[0].explode_rotation, [15, 35, -20])
    assert.deepEqual(runtime.getDraft().parts[0].point_keys, ['motor.rpm'])
    assert.deepEqual(runtime.getDraft().extra_metadata, { keep: true })
    assert.equal(runtime.getDraft().parts[0].extra_part_field, 'keep')
    assert.equal(runtime.dirty, true)
})

test('parent drag canonicalizes X handedness and matches the native-compatible parent preview', t => {
    const { runtime } = fixture(t, 'parent')
    const start = runtime.selectedCenter(), delta = new THREE.Vector3(.3, -.8, .9)
    const original = runtime.getDraft().parts[0].explode_offset
    const authoredDelta = worldDeltaToInspectionOffset(delta, runtime.authorMatrix(), 'parent')
    runtime.beginDrag(start); runtime.dragTo(start.clone().add(delta)); runtime.endDrag()
    close(runtime.selectedCenter(), start.clone().add(delta))
    close(new THREE.Vector3(...runtime.getDraft().parts[0].explode_offset), new THREE.Vector3(...original).add(authoredDelta))
    assert.equal(runtime.getDraft().offset_space, 'parent')
})

test('model-space multi-target assembly translates rigidly without changing the original child transforms', t => {
    const { runtime, a, b, originals } = fixture(t, 'model', { multi: true })
    const beforeA = a.getWorldPosition(new THREE.Vector3()), beforeB = b.getWorldPosition(new THREE.Vector3())
    const delta = new THREE.Vector3(.7, -.2, -.5), start = runtime.selectedCenter()
    runtime.beginDrag(start); runtime.dragTo(start.clone().add(delta)); runtime.endDrag()
    close(a.getWorldPosition(new THREE.Vector3()).sub(beforeA), delta)
    close(b.getWorldPosition(new THREE.Vector3()).sub(beforeB), delta)
    close(a.position, originals.positionA); close(b.position, originals.positionB)
})

test('parent-space multi-target keeps each parent basis instead of silently migrating to model space', t => {
    const { runtime, a, b, other } = fixture(t, 'parent', { multi: true })
    const beforeA = a.getWorldPosition(new THREE.Vector3()), beforeB = b.getWorldPosition(new THREE.Vector3())
    const start = runtime.selectedCenter(), delta = new THREE.Vector3(.7, .1, -.4)
    const authored = worldDeltaToInspectionOffset(delta, runtime.authorMatrix(), 'parent')
    const localThree = new THREE.Vector3(-authored.x, authored.y, authored.z)
    const otherExpected = localThree.applyMatrix4(other.matrixWorld).sub(new THREE.Vector3().applyMatrix4(other.matrixWorld))
    runtime.beginDrag(start); runtime.dragTo(start.clone().add(delta)); runtime.endDrag()
    close(a.getWorldPosition(new THREE.Vector3()).sub(beforeA), delta)
    close(b.getWorldPosition(new THREE.Vector3()).sub(beforeB), otherExpected)
    assert.equal(runtime.getDraft().offset_space, 'parent')
})

test('undo/redo, drag cancellation, and confirmed save baseline are independent', t => {
    const { runtime } = fixture(t)
    const original = runtime.getDraft().parts[0].explode_offset
    runtime.setOffset('a', [8, 2, 1]); assert.ok(runtime.canUndo); assert.ok(runtime.dirty)
    runtime.undo(); assert.deepEqual(runtime.getDraft().parts[0].explode_offset, original); assert.equal(runtime.dirty, false)
    runtime.redo(); assert.deepEqual(runtime.getDraft().parts[0].explode_offset, [8, 2, 1])
    const start = runtime.selectedCenter(); runtime.beginDrag(start); runtime.dragTo(start.clone().add(new THREE.Vector3(5, 0, 0))); runtime.endDrag(true)
    assert.deepEqual(runtime.getDraft().parts[0].explode_offset, [8, 2, 1])
    runtime.markSaved(runtime.getDraft()); assert.equal(runtime.dirty, false); assert.equal(runtime.canUndo, false)
    runtime.setOffset('a', [0, 0, 0]); runtime.restoreSaved()
    assert.deepEqual(runtime.getDraft().parts[0].explode_offset, [8, 2, 1]); assert.equal(runtime.dirty, false)
    runtime.undo(); assert.deepEqual(runtime.getDraft().parts[0].explode_offset, [0, 0, 0])
})

test('disabled device inspection is editable without mutating its persisted enabled field', t => {
    const { runtime, config } = fixture(t, 'model', { enabled: false })
    assert.equal(runtime.parts.length, 2)
    assert.equal(runtime.getDraft().enabled, false); assert.equal(config.enabled, false)
    assert.equal(runtime.beginDrag(), true); runtime.endDrag()
})

test('assembled preview changes no saved offsets and prevents dragging until returning', t => {
    const { runtime, a, originals } = fixture(t)
    const draft = runtime.getDraft()
    runtime.setAssembled(true)
    assert.equal(runtime.beginDrag(), false)
    close(a.getWorldPosition(new THREE.Vector3()), originals.parentA.localToWorld(originals.positionA.clone()))
    assert.deepEqual(runtime.getDraft(), draft)
    runtime.setAssembled(false); assert.equal(runtime.beginDrag(), true); runtime.endDrag()
})

test('a second pointer cannot replace an active drag or change its selected part', t => {
    const { runtime } = fixture(t)
    const before = runtime.getDraft(), start = runtime.selectedCenter()
    assert.equal(runtime.beginDrag(start), true)
    runtime.dragTo(start.clone().add(new THREE.Vector3(1, 0, 0)))
    assert.equal(runtime.beginDrag(runtime.selectedCenter()), false)
    assert.equal(runtime.select('b'), false)
    runtime.endDrag(true)
    assert.deepEqual(runtime.getDraft(), before)
    assert.equal(runtime.canUndo, false, 'cancelled interaction adds no history entry')
})

test('invalid drag bases and positions fail without corrupting the draft', t => {
    const { runtime, root } = fixture(t)
    const before = runtime.getDraft()
    assert.equal(runtime.beginDrag(new THREE.Vector3(NaN, 0, 0)), false)
    const start = runtime.selectedCenter()
    assert.equal(runtime.beginDrag(start), true)
    assert.equal(runtime.dragTo(new THREE.Vector3(Infinity, 0, 0)), false)
    assert.deepEqual(runtime.getDraft(), before)
    runtime.endDrag(true)
    root.scale.x = 0
    assert.equal(runtime.beginDrag(start), false)
    assert.deepEqual(runtime.getDraft(), before)
})

test('dispose restores original parent/order/material and is idempotent', t => {
    const { runtime, a, b, originals } = fixture(t)
    assert.notEqual(a.parent, originals.parentA); assert.notEqual(a.material, originals.material)
    runtime.dispose(); runtime.dispose()
    assert.equal(a.parent, originals.parentA); assert.equal(b.parent, originals.parentB)
    assert.equal(a.material, originals.material); assert.equal(b.material, originals.material)
    close(a.position, originals.positionA); close(b.position, originals.positionB)
})

test('manual editor compiles real Vue template with required public props/events and drag controls', async () => {
    const source = await readFile(new URL('../src/views/admin/components/ManualDisassemblyLayout.vue', import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source)
    assert.deepEqual(errors, [])
    const compiled = compileScript(descriptor, { id: 'manual-layout', inlineTemplate: true })
    for (const name of ['device', 'model', 'inspection', 'saving', 'saveRevision', 'status']) assert.ok(compiled.content.includes(name))
    for (const name of ['save', 'selection-change', 'dirty-change']) assert.ok(compiled.content.includes(name))
    assert.ok(source.includes("transform.setMode('translate')"))
    assert.ok(source.includes("runtime.beginDrag")); assert.ok(source.includes("runtime.dragTo"))
    assert.ok(source.includes("loadConfiguredGltf")); assert.ok(source.includes("restoreGltfNodeNames"))
    assert.ok(source.includes('onDeactivated(')); assert.ok(source.includes('onActivated('))
    assert.ok(source.includes('session.loop?.pause()')); assert.ok(source.includes('session.loop?.start()'))
})

test('render loop pauses for KeepAlive, resumes exactly once, and rejects old callbacks after disposal', () => {
    const scheduled = new Map(), cancelled = [], callbacks = []
    let id = 0, renders = 0
    const loop = createManualLayoutRenderLoop(() => renders++, {
        requestFrame(callback) { scheduled.set(++id, callback); callbacks.push(callback); return id },
        cancelFrame(key) { cancelled.push(key); scheduled.delete(key) }
    })
    loop.start(); loop.start(); assert.equal(renders, 1); assert.equal(scheduled.size, 1)
    const stale = callbacks[0]
    loop.pause(); assert.equal(loop.running, false); assert.equal(scheduled.size, 0)
    loop.start(); assert.equal(renders, 2); assert.equal(scheduled.size, 1)
    stale(); assert.equal(renders, 2); assert.equal(scheduled.size, 1)
    const nextId = [...scheduled.keys()][0], next = scheduled.get(nextId); scheduled.delete(nextId); next()
    assert.equal(renders, 3); assert.equal(scheduled.size, 1)
    loop.dispose(); assert.equal(scheduled.size, 0); assert.equal(loop.running, false)
    callbacks.at(-1)(); loop.start(); assert.equal(renders, 3)
    assert.equal(cancelled.length, 2)
})

test('real component KeepAlive cancels unfinished loads and reclaims late scenes without reviving a hidden canvas', async t => {
    const environment = installBrowser(t), loads = [], disposals = []
    environment.replace('__manualLayoutTestLoad', (_url, options) => {
        const pending = deferred(); loads.push({ ...pending, signal: options.signal }); return pending.promise
    })
    environment.replace('__manualLayoutTestDispose', root => { disposals.push(root); disposeSceneObject(root) })
    const url = new URL('../src/views/admin/components/ManualDisassemblyLayout.vue', import.meta.url)
    const { descriptor } = parse(await readFile(url, 'utf8'))
    let compiled = compileScript(descriptor, { id: 'manual-life', inlineTemplate: true,
        templateOptions: { compilerOptions: { hoistStatic: false } } }).content
    const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
        const specifier = match[2]
        let resolved = specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)
        // Presentation children are absent in this device-scope lifecycle
        // fixture. Their real model-scope behavior is tested separately.
        if (specifier.endsWith('.vue')) resolved = moduleUrl('export default {render(){return null}}')
        if (specifier.endsWith('/ConfiguredFactoryScene.js')) resolved = moduleUrl('export const loadConfiguredGltf=(...args)=>globalThis.__manualLayoutTestLoad(...args); export const disposeSceneObject=(...args)=>globalThis.__manualLayoutTestDispose(...args)')
        if (specifier.endsWith('/ModelFactory.js')) resolved = moduleUrl('export const resolveBackendAssetUrl=value=>value')
        compiled = compiled.replace(match[0], `from ${JSON.stringify(resolved)}`)
    }
    const { default: Component } = await import(moduleUrl(compiled))
    const element = (type, text = '') => ({ type, tagName: type.toUpperCase(), text, props: {}, children: [], parent: null, style: {},
        addEventListener() {}, removeEventListener() {}, getRootNode: () => globalThis.document })
    const renderer = createRenderer({
        createElement: type => element(type), createText: text => element('#text', text), createComment: text => element('#comment', text),
        setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
        parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
        patchProp: (node, key, _previous, value) => { node.props[key] = value; if (key === 'value') node.value = value },
        insert(node, parent, anchor = null) {
            if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node)
            node.parent = parent; const index = parent.children.indexOf(anchor)
            if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
        },
        remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = null }
    })
    const shown = ref(true), instance = ref(null), container = element('root')
    const device = ref({ id: 'd' }), model = ref({ id: 'm', file_path: '/model.glb' })
    const app = renderer.createApp({ setup: () => () => h(KeepAlive, null, { default: () => shown.value
        ? h(Component, { key: 'manual', ref: instance, device: device.value, model: model.value, inspection: { enabled: true, parts: [] } })
        : h('div', { key: 'other' }) }) })
    let unmounted = false
    environment.beforeRestore(() => { if (!unmounted) app.unmount() })
    const flush = async () => { await nextTick(); await nextTick(); await settle() }
    app.mount(container); await flush()
    assert.equal(loads.length, 1, 'initial KeepAlive activation does not duplicate the load')
    device.value = { id: 'd', name: 'device cache refreshed' }
    model.value = { id: 'm', file_path: '/model.glb', metadata: { refreshed: true } }
    await flush()
    assert.equal(loads.length, 1, 'equivalent device/model identity must not abort and reload a live editor')
    assert.equal(loads[0].signal.aborted, false)
    shown.value = false; await flush()
    assert.equal(loads[0].signal.aborted, true, 'deactivation cancels its pending model request')
    shown.value = true; await flush()
    assert.equal(loads.length, 2, 'activation starts exactly one fresh generation')
    const makeRoot = () => { const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())); return root }
    const stale = makeRoot(); loads[0].resolve({ scene: stale }); await flush()
    assert.equal(disposals.filter(root => root === stale).length, 1)
    assert.equal(loads[1].signal.aborted, false, 'stale completion cannot dispose the current request')
    app.unmount(); unmounted = true; await flush()
    assert.equal(loads[1].signal.aborted, true)
    const late = makeRoot(); loads[1].resolve({ scene: late }); await flush()
    assert.equal(disposals.filter(root => root === late).length, 1)
    assert.equal(environment.browser.listeners.get('beforeunload')?.size, 0)
})


test('model placement keeps presentation overlays out of the canvas and restores editable pose on tab return', async () => {
    const source = await readFile(new URL('../src/views/admin/components/ManualDisassemblyLayout.vue', import.meta.url), 'utf8')
    const { descriptor } = parse(source)
    assert.match(descriptor.template.content, /ModelInspectionPreviewOverlay v-if="modelScope && section !== 'parts' && previewing"/)
    assert.match(descriptor.template.content, /InspectionPlaybackControls v-if="modelScope && section !== 'parts'/)
    assert.match(source, /function editLayout\(\)\s*\{\s*section.value = 'parts'/)
    assert.match(source, /if \(id === 'parts'\) editLayout\(\)/)
    assert.ok(compileScript(descriptor, { id: 'placement-layout', inlineTemplate: true }).content.includes('chooseSection'))
})

test('fixed-height presentation sidebar uses a shrinkable grid and one keyboard-scrollable owner', async () => {
    const source = await readFile(new URL('../src/views/admin/components/ManualDisassemblyLayout.vue', import.meta.url), 'utf8')
    const settings = await readFile(new URL('../src/views/admin/components/InspectionPresentationSettings.vue', import.meta.url), 'utf8')
    assert.match(source, /grid-template-rows:minmax\(0,1fr\)/)
    assert.match(source, /settings-sidebar\{display:flex;min-height:0;overflow:hidden\}/)
    assert.match(settings, /class="presentation-settings" tabindex="0"/)
    assert.match(settings, /min-height:0;max-height:none;overflow-y:scroll;overflow-x:hidden/)
    assert.match(settings, /scrollbar-gutter:stable/)
})
