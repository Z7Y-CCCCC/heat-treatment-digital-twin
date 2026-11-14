<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import InspectionPlaybackControls from './InspectionPlaybackControls.vue'
import InspectionPresentationSettings from './InspectionPresentationSettings.vue'
import ModelInspectionPreviewOverlay from './ModelInspectionPreviewOverlay.vue'
import { inspectionCameraPose } from '../../../runtime/InspectionPreview.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { loadConfiguredGltf, disposeSceneObject } from '../../../runtime/ConfiguredFactoryScene.js'
import { restoreGltfNodeNames } from '../../../three/gltfNodeIdentity.js'
import { resolveBackendAssetUrl } from '../../../three/ModelFactory.js'
import { createManualLayoutRenderLoop, ManualDisassemblyLayoutRuntime } from '../../../runtime/manualDisassemblyLayout.js'

const props = defineProps({ device: { type: Object, default: null }, model: { type: Object, required: true }, scope: { type: String, default: 'device' },
    inspection: { type: Object, required: true }, saving: Boolean, saveRevision: { type: Number, default: 0 }, status: { type: String, default: '' } })
const emit = defineEmits(['save', 'reload', 'selection-change', 'dirty-change'])
const viewport = ref(null), loading = ref(false), error = ref(''), message = ref(''), query = ref('')
const section = ref('parts'), presentationDraft = ref(null), previewState = ref({}), previewing = ref(false)
const selectedId = ref(''), dirty = ref(false), canUndo = ref(false), canRedo = ref(false), assembled = ref(false)
const partRows = ref([]), offsets = ref([0, 0, 0]), dragging = ref(false)
const visibleParts = computed(() => partRows.value.filter(part => `${part.name} ${part.id}`.toLowerCase().includes(query.value.toLowerCase())))
const selected = computed(() => partRows.value.find(part => part.id === selectedId.value))
const parentSpace = computed(() => props.inspection.offset_space === 'parent')
const modelScope = computed(() => props.scope === 'model')
const target = computed(() => modelScope.value ? props.model : props.device)
const editable = computed(() => canAdminPage('disassembly-layout', 'edit'))
let session, abort, generation = 0, resizeObserver, mounted = false, active = true, lastRevision = props.saveRevision
let directDrag, activePointerId = null, previousOrbit = true
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), dragPlane = new THREE.Plane()
const assetUrl = computed(() => resolveBackendAssetUrl(props.model.file_path || props.model.filePath || props.model.url || props.device?.model_file || ''))

function sync(runtime) {
    presentationDraft.value = runtime.getDraft(); previewing.value = !!runtime.previewing
    dirty.value = runtime.dirty; canUndo.value = runtime.canUndo; canRedo.value = runtime.canRedo
    assembled.value = runtime.assembled; selectedId.value = runtime.selectedId
    partRows.value = runtime.parts.map(part => ({ id: part.config.id, name: part.config.name }))
    offsets.value = [...(runtime.draft.parts.find(part => part.id === runtime.selectedId)?.explode_offset || [0, 0, 0])]
    emit('dirty-change', dirty.value)
    if (session?.runtime === runtime && !dragging.value) attachGizmo()
}
function updatePresentation(patch) {
    if (!editable.value || props.saving || dragging.value || !session) return
    if (!session.runtime.setPresentation(patch)) message.value = '设置无效，请检查数值和外壳节点。'
    else { message.value = ''; changed() }
}
function playback(command) { if (session && !dragging.value) { session.runtime.play(command); changed() } }
function editLayout() { if (session) { session.runtime.stopPlayback(); changed(); fit() } }
function captureCamera(stage) {
    if (!session || !editable.value) return
    const { camera, orbit, runtime } = session, bounds = stage === 'exploded' ? runtime.preview.explodedBounds : runtime.preview.baseBounds
    if (!bounds || bounds.isEmpty()) return
    const matrix = runtime.root.matrixWorld, inverse = matrix.clone().invert(), vector = camera.position.clone().sub(orbit.target), distance = vector.length()
    if (!distance) return
    const direction = vector.clone().transformDirection(inverse), pose = inspectionCameraPose(camera, bounds, { distance_scale: 1 }, matrix)
    const cameraConfig = { yaw: THREE.MathUtils.radToDeg(Math.atan2(direction.x,direction.z)), pitch: THREE.MathUtils.radToDeg(Math.asin(direction.y)),
        distance_scale: distance / pose.position.distanceTo(pose.target), target_offset: orbit.target.clone().applyMatrix4(inverse).sub(bounds.getCenter(new THREE.Vector3()).applyMatrix4(inverse)).toArray() }
    updatePresentation({[stage]: {...presentationDraft.value[stage], camera: cameraConfig}})
}
function attachGizmo() {
    if (!session) return
    const { runtime, proxy, transform } = session
    if (!active || !canAdminPage('disassembly-layout', 'edit') || !runtime.selectedPart || runtime.assembled || runtime.previewing || props.saving) { transform.detach(); return }
    proxy.position.copy(runtime.selectedCenter()); proxy.updateMatrixWorld(true)
    transform.attach(proxy)
}
function choose(id) {
    if (!session || dragging.value) return
    session.runtime.select(id); attachGizmo(); emit('selection-change', id)
}
function changed() { if (session) { sync(session.runtime); attachGizmo() } }
function fit(selectedOnly = false) {
    if (!session) return
    const { runtime, camera, orbit } = session
    const box = selectedOnly ? runtime.selectedPart?.bounds : runtime.bounds()
    if (!box || box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3()), radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, .001)
    const verticalFov = THREE.MathUtils.degToRad(camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
    const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.28
    const direction = camera.position.clone().sub(orbit.target).normalize()
    if (!direction.lengthSq()) direction.set(.8, .6, 1).normalize()
    orbit.target.copy(center); camera.position.copy(center).addScaledVector(direction, distance)
    camera.near = Math.max(radius / 1000, .00001); camera.far = Math.max(distance * 20, radius * 100, 100)
    orbit.minDistance = Math.max(radius / 500, .00001); orbit.maxDistance = Math.max(radius * 100, distance * 5)
    camera.updateProjectionMatrix(); orbit.update()
}
function setAxis(index, value) {
    if (!canAdminPage('disassembly-layout', 'edit')) return
    if (!session || props.saving || dragging.value || assembled.value) return
    const next = [...offsets.value]; next[index] = Number(value)
    if (!session.runtime.setOffset(selectedId.value, next)) message.value = '请输入三个有效的位移数值。'
    changed()
}
function resetSelected() { if (editable.value && session && !props.saving && !dragging.value && !assembled.value) { session.runtime.setOffset(selectedId.value, [0, 0, 0]); changed() } }
function restoreSaved() {
    if (!session || props.saving) return
    session.runtime.restoreSaved(); changed(); message.value = modelScope.value ? '已恢复模型保存位置。' : '已恢复该设备最近保存的部件位置；可撤销。'
}
function toggleAssembly() { if (session && !dragging.value) { session.runtime.setAssembled(!assembled.value); changed(); fit() } }
function undo() { if (editable.value && session && !dragging.value && !props.saving) { session.runtime.undo(); changed() } }
function redo() { if (editable.value && session && !dragging.value && !props.saving) { session.runtime.redo(); changed() } }
function save() {
    if (!editable.value || !session?.runtime?.parts.length || props.saving || dragging.value || error.value) return
    emit('save', session.runtime.getDraft())
}
function exportDraft() {
    if (!session || dragging.value) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ [modelScope.value ? 'modelId' : 'deviceId']: target.value.id, inspection: session.runtime.getDraft() }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `disassembly-${String(target.value.id).replace(/[^a-z0-9_-]/gi, '_')}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function keyboard(event) {
    if (event.key === 'Escape' && cancelDrag()) { event.preventDefault(); return }
    if (/INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '')) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
}
function beforeUnload(event) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
function setPointer(event) {
    const rect = session.renderer.domElement.getBoundingClientRect()
    ndc.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    raycaster.setFromCamera(ndc, session.camera)
}
function pickPart(event) {
    setPointer(event)
    const { runtime } = session
    for (const hit of raycaster.intersectObjects(runtime.preview.materials.map(entry => entry.mesh), false)) {
        let shown = true
        for (let node = hit.object; node; node = node.parent) if (!node.visible) { shown = false; break }
        if (!shown) continue
        return runtime.parts.find(part => part.targets.some(target => {
            for (let node = hit.object; node; node = node.parent) if (node === target) return true
            return false
        }))?.config.id || ''
    }
    return ''
}
function capturePointerDown(event) {
    if (dragging.value) { event.preventDefault(); event.stopImmediatePropagation(); return }
    if (event.isPrimary === false) return
    if (!canAdminPage('disassembly-layout', 'edit')) {
        if (session && event.button === 0) { const id = pickPart(event); if (id) choose(id) }
        return
    }
    // The canvas is not focusable by default. Move focus into the editor even
    // for gizmo drags, otherwise Escape/undo stay on a previously used control.
    if (session) viewport.value?.closest('.manual-layout')?.focus({ preventScroll: true })
    if (!session || props.saving || assembled.value || event.button !== 0) return
    setPointer(event)
    // Own the entire pointer lifecycle for gizmos too. Letting OrbitControls
    // start first leaves its pointer state stuck after cancellation/blur.
    session.transform.pointerHover({ x: ndc.x, y: ndc.y, button: event.button })
    if (session.transform.axis) {
        event.preventDefault(); event.stopImmediatePropagation()
        activePointerId = event.pointerId
        session.transform.pointerDown({ x: ndc.x, y: ndc.y, button: event.button })
        if (session.transform.dragging) session.renderer.domElement.setPointerCapture(event.pointerId)
        else activePointerId = null
        return
    }
    const id = pickPart(event)
    if (!id) return // Empty canvas remains an orbit/pan surface.
    event.preventDefault(); event.stopImmediatePropagation()
    choose(id)
    const start = session.proxy.position.clone()
    dragPlane.setFromNormalAndCoplanarPoint(session.camera.getWorldDirection(new THREE.Vector3()), start)
    setPointer(event)
    const hit = raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3())
    if (!hit || !session.runtime.beginDrag(start)) return
    directDrag = { id: event.pointerId, start, hit }
    activePointerId = event.pointerId
    previousOrbit = session.orbit.enabled; session.orbit.enabled = false; session.transform.enabled = false
    dragging.value = true; session.renderer.domElement.setPointerCapture(event.pointerId)
}
function pointerMove(event) {
    if (!session || !dragging.value || event.pointerId !== activePointerId) return
    event.preventDefault(); event.stopImmediatePropagation(); setPointer(event)
    if (!directDrag) { session.transform.pointerMove({ x: ndc.x, y: ndc.y, button: -1 }); return }
    const hit = raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3())
    if (hit) {
        const position = directDrag.start.clone().add(hit.sub(directDrag.hit))
        session.proxy.position.copy(position); session.runtime.dragTo(position)
    }
}
function finishDirect() {
    if (!session) return
    const element = session.renderer.domElement
    const pointerId = activePointerId
    // Clear ownership before releasing: lostpointercapture can be synchronous.
    directDrag = null; activePointerId = null; dragging.value = false
    if (pointerId !== null && element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId)
    if (session.orbit) session.orbit.enabled = previousOrbit
    if (session.transform) session.transform.enabled = active && editable.value && !props.saving
}
function pointerUp(event) {
    if (!session || !dragging.value || event.pointerId !== activePointerId) return
    event.preventDefault(); event.stopImmediatePropagation()
    if (event.type === 'pointercancel') { cancelDrag(); return }
    if (directDrag) session.runtime.endDrag()
    else session.transform.pointerUp({ button: 0 })
    finishDirect(); changed()
}
function cancelDrag() {
    if (!session || !dragging.value) return false
    session.runtime.endDrag(true)
    if (session.transform.dragging) { session.transform.reset(); session.transform.pointerUp({ button: 0 }) }
    session.transform.axis = null
    finishDirect(); changed()
    return true
}
function lostPointerCapture(event) {
    if (event.pointerId === activePointerId) cancelDrag()
}
function hidden() {
    if (document.visibilityState === 'hidden') cancelDrag()
}

function disposeSession() {
    abort?.abort(); generation++; resizeObserver?.disconnect()
    if (!session) return
    session.loop?.dispose()
    cancelDrag()
    finishDirect()
    const { runtime, transform, orbit, renderer, scene, listeners } = session
    for (const [name, handler, capture] of listeners) renderer.domElement.removeEventListener(name, handler, capture)
    if (transform) { transform.detach(); scene.remove(transform.getHelper()); transform.dispose() }
    orbit?.dispose()
    runtime?.dispose(); disposeSceneObject(scene); renderer.dispose(); renderer.forceContextLoss()
    renderer.domElement.remove(); session = null
}
async function load() {
    if (!mounted || !active || !viewport.value) return
    disposeSession(); const current = generation
    loading.value = true; error.value = ''; message.value = ''; dirty.value = false; emit('dirty-change', false)
    abort = new AbortController()
    let root
    try {
        if (!assetUrl.value) throw new Error('该设备没有可加载的 GLB 模型，请先在模型库关联真实模型。')
        const gltf = await loadConfiguredGltf(assetUrl.value, { signal: abort.signal, timeoutMs: 45000 })
        restoreGltfNodeNames(gltf); root = gltf.scene || gltf.scenes?.[0]
        if (!root) throw new Error('模型文件不包含可显示的场景')
        if (current !== generation) { disposeSceneObject(root); return }
        const scene = new THREE.Scene(); scene.background = new THREE.Color(0x293544)
        scene.add(root, new THREE.HemisphereLight(0xd9eafa, 0x738292, 2.4))
        const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(8, 15, 10); scene.add(light)
        const camera = new THREE.PerspectiveCamera(45, 1, .001, 1000); camera.position.set(12, 9, 16)
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
        // Own partially initialized resources immediately, so a later controls
        // or validation failure still releases its canvas/context and model.
        session = { scene, camera, renderer, orbit: null, transform: null, runtime: null, listeners: [] }
        renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2
        renderer.domElement.style.touchAction = 'none'; viewport.value.appendChild(renderer.domElement)
        const orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true; orbit.dampingFactor = .12
        session.orbit = orbit
        const transform = new TransformControls(camera, renderer.domElement); transform.setMode('translate'); transform.setSpace('world'); transform.setSize(.85)
        session.transform = transform
        const proxy = new THREE.Group(); proxy.name = '__manual_layout_handle__'; scene.add(proxy, transform.getHelper())
        session.proxy = proxy
        const runtime = new ManualDisassemblyLayoutRuntime({ root, scene, camera, inspection: props.inspection, controls: orbit, presentation: modelScope.value, onState: value => { previewState.value = value }, onChange: sync })
        session.runtime = runtime; orbit.addEventListener('start', () => { runtime.preview.cameraMotion = null }); sync(runtime); attachGizmo()
        const draggingChanged = event => {
            if (directDrag) return
            if (event.value) {
                if (activePointerId === null || !editable.value || !runtime.beginDrag(proxy.position)) {
                    transform.pointerUp({ button: 0 }); return
                }
                previousOrbit = orbit.enabled; orbit.enabled = false; dragging.value = true
            } else { runtime.endDrag(); dragging.value = false; orbit.enabled = previousOrbit; changed() }
        }
        const objectChange = () => { if (!directDrag && dragging.value) runtime.dragTo(proxy.position) }
        transform.addEventListener('dragging-changed', draggingChanged); transform.addEventListener('objectChange', objectChange)
        session.listeners = [['pointerdown', capturePointerDown, true], ['pointermove', pointerMove, true], ['pointerup', pointerUp, true], ['pointercancel', pointerUp, true], ['lostpointercapture', lostPointerCapture, true]]
        for (const [name, handler, capture] of session.listeners) renderer.domElement.addEventListener(name, handler, capture)
        let previousAspect = 0
        const resize = () => {
            if (!active || !session || current !== generation) return
            const width = Math.max(viewport.value.clientWidth, 1), height = Math.max(viewport.value.clientHeight, 1)
            renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix()
            if (previousAspect && Math.abs(previousAspect - camera.aspect) > .05 && !runtime.previewing && !dragging.value) fit()
            previousAspect = camera.aspect
        }
        session.resize = resize
        resizeObserver = new ResizeObserver(resize); resizeObserver.observe(viewport.value); resize(); fit()
        const clock = new THREE.Clock()
        session.loop = createManualLayoutRenderLoop(() => {
            if (!active || !session || current !== generation) return
            runtime.tick(clock.getDelta()); orbit.update(); renderer.render(scene, camera)
        })
        session.loop.start(); lastRevision = props.saveRevision; choose(runtime.selectedId)
    } catch (cause) {
        if (current === generation && cause.name !== 'AbortError') {
            error.value = `模型未加载：${cause.message || cause}`
            if (session) disposeSession(); else if (root) disposeSceneObject(root)
        }
    } finally { if (current === generation || error.value) loading.value = false }
}
watch([() => props.device?.id, () => props.model.id, () => assetUrl.value], () => {
    if (mounted && active) void load()
    else if (mounted) disposeSession()
})
watch([() => props.saveRevision, () => JSON.stringify(props.inspection)], () => {
    if (!session?.runtime) return
    if (props.saveRevision !== lastRevision || !dirty.value) {
        session.runtime.markSaved(props.inspection); lastRevision = props.saveRevision; changed()
    }
})
watch(() => props.saving, value => { if (value) cancelDrag(); if (session?.transform) { session.transform.enabled = active && editable.value && !value; attachGizmo() } })
watch(editable, value => { if (!value) cancelDrag(); attachGizmo() })
onDeactivated(() => {
    active = false; resizeObserver?.disconnect()
    if (session) {
        session.loop?.pause()
        cancelDrag()
        session.orbitBeforeSuspend = session.orbit.enabled
        session.orbit.enabled = false; session.transform.enabled = false
    } else {
        // An unfinished load cannot create a GPU context inside a cached,
        // hidden route. A later activation retries without a stale generation.
        abort?.abort(); generation++; loading.value = false
    }
})
onActivated(async () => {
    if (active) return // KeepAlive also calls activation after the first mount.
    active = true; await nextTick()
    if (!mounted || !active) return
    if (session) {
        session.orbit.enabled = session.orbitBeforeSuspend ?? true
        session.transform.enabled = !props.saving; attachGizmo()
        resizeObserver?.observe(viewport.value); session.resize?.(); session.loop?.start()
    } else await load()
})
onMounted(async () => { mounted = true; window.addEventListener('beforeunload', beforeUnload); window.addEventListener('blur', cancelDrag); document.addEventListener('visibilitychange', hidden); await nextTick(); await load() })
onUnmounted(() => { mounted = false; window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('blur', cancelDrag); document.removeEventListener('visibilitychange', hidden); disposeSession() })
defineExpose({ dirty, dragging, getDraft: () => session?.runtime.getDraft() || props.inspection, discardChanges: restoreSaved })
</script>

<template>
    <section class="manual-layout" :class="{'presentation-workspace':modelScope}" data-testid="manual-disassembly-layout" :data-device-id="device?.id" :data-model-id="model.id" tabindex="0" @keydown="keyboard">
        <header class="layout-heading">
            <div><span class="eyebrow">{{ modelScope ? '模型布局' : '手工空间布局' }}</span><h3>{{ target?.name || target?.id }} · {{ modelScope ? '拆解布局' : '部件摆放' }}</h3><p v-if="!modelScope">直接拖动部件，或使用三轴与平面手柄。</p></div>
            <div class="save-area"><span class="dirty-pill" :class="{ dirty }">{{ dirty ? '未保存' : '已保存' }}</span><button class="primary" type="button" data-testid="save-manual-layout" :disabled="saving || loading || !partRows.length || dragging || !!error" @click="save" v-permission="{ page: 'disassembly-layout', action: 'edit' }">{{ saving ? '保存中…' : modelScope ? '保存布局与设置' : '保存本台设备布局' }}</button></div>
        </header>
        <nav v-if="modelScope" class="layout-sections" aria-label="拆解布局分类"><button v-for="tab in [{id:'parts',label:'部件摆放'},{id:'shell',label:'外壳与时序'},{id:'camera',label:'镜头与标签'}]" :key="tab.id" type="button" :aria-current="section === tab.id ? 'page' : undefined" :class="{active:section===tab.id}" @click="section=tab.id">{{ tab.label }}</button></nav>
        <div class="layout-toolbar">
            <button type="button" :disabled="!canUndo || saving || dragging" @click="undo" v-permission="{ page: 'disassembly-layout', action: 'edit' }">↶ 撤销</button><button type="button" :disabled="!canRedo || saving || dragging" @click="redo" v-permission="{ page: 'disassembly-layout', action: 'edit' }">↷ 重做</button>
            <span class="toolbar-divider"></span><button type="button" :disabled="loading || !!error || dragging" @click="fit()">完整视图</button><button type="button" :disabled="!selected || dragging" @click="fit(true)">聚焦选中部件</button>
            <button v-if="!modelScope" type="button" :class="{ active: assembled }" :disabled="loading || !!error || dragging" @click="toggleAssembly">{{ assembled ? '返回手工拆解布局' : '查看装配原位' }}</button>
            <details class="layout-more"><summary>更多操作 ⌄</summary><div>            <button type="button" :disabled="!dirty || saving || dragging" @click="restoreSaved">恢复已保存位置</button>
            <button type="button" :disabled="saving || loading || dragging" @click="emit('reload')">重新读取布局</button>
            <button type="button" :disabled="saving || loading || dragging || !partRows.length" @click="exportDraft">导出草稿</button>
</div></details>
        </div>
        <p v-if="parentSpace" class="coordinate-note">旧版父级坐标：拖拽按选中部件首节点的父级基底换算；多节点跨父级时，各节点保持各自父坐标语义。</p>
        <div class="layout-body">
            <aside v-show="!modelScope || section === 'parts'" class="part-sidebar">
                <div class="part-list-heading"><strong>可拖拽部件</strong><span>{{ partRows.length }}</span></div>
                <input v-model="query" class="part-search" aria-label="搜索手工布局部件" placeholder="搜索部件名称…"/>
                <div class="part-list" role="listbox" aria-label="布局部件">
                    <button v-for="part in visibleParts" :key="part.id" type="button" role="option" :aria-selected="part.id === selectedId" :class="{ selected: part.id === selectedId }" :disabled="dragging || saving" @click="choose(part.id)"><i></i><span>{{ part.name || part.id }}<small>{{ part.id }}</small></span></button>
                    <p v-if="!partRows.length && !loading" class="list-empty">模型未配置可编辑部件。请先在模型拆解编排中绑定真实节点。</p>
                </div>
                <div class="offset-editor"><strong>{{ selected?.name || '请选择部件' }}</strong><small>{{ parentSpace ? '父级坐标位移' : '模型坐标位移' }} · 模型单位</small><div class="offset-fields"><label v-for="(axis,index) in ['X','Y','Z']" :key="axis" :class="axis.toLowerCase()"><span>{{ axis }}</span><input type="number" step="0.01" :aria-label="`${axis}轴拆解位移`" :value="Number(offsets[index]).toFixed(4)" :disabled="!selected || assembled || previewing || saving || dragging" @change="setAxis(index, $event.target.value)"  v-permission="{ page: 'disassembly-layout', action: 'edit' }"/></label></div><button type="button" :disabled="!selected || assembled || previewing || saving || dragging" @click="resetSelected" v-permission="{ page: 'disassembly-layout', action: 'edit' }">选中部件位移归零</button><p>保留原来的部件旋转、时序与 PLC 绑定。</p></div>
            </aside>
            <aside v-if="modelScope && section !== 'parts'" class="settings-sidebar"><InspectionPresentationSettings v-if="presentationDraft" :draft="presentationDraft" :nodes="session?.runtime.nodes || []" :section="section" :disabled="!editable || saving || dragging" @change="updatePresentation" @command="playback" @capture="captureCamera" /></aside>
            <div class="viewport-shell"><div ref="viewport" class="layout-viewport" data-testid="manual-layout-canvas"></div>
                <ModelInspectionPreviewOverlay v-if="modelScope && previewing" :state="previewState" @command="playback" />
                <InspectionPlaybackControls v-if="modelScope && !loading && !error" :preview-state="previewState" :previewing="previewing" :speed="presentationDraft?.playback_speed || 1" :editable="editable" :disabled="saving || dragging" @command="playback" @speed="updatePresentation({playback_speed:$event})" @edit="editLayout" />
                <div v-if="loading || error" class="viewport-state" :class="{ failure: error }"><strong>{{ error ? '无法打开手工布局' : '正在加载真实三维模型…' }}</strong><p v-if="error">{{ error }}</p><button v-if="error" type="button" @click="load">重新加载</button></div>
                <div v-else class="viewport-hint"><span class="hint-dot"></span>{{ assembled ? '装配原位预览 · 返回拆解布局后可拖动' : dragging ? '正在移动部件 · 松开完成，Esc 取消' : '左键拖动部件／三轴／平面 · 空白处旋转 · 右键平移 · 滚轮缩放' }}</div>
            </div>
        </div>
        <footer class="layout-footer"><span>{{ status || message || (modelScope ? '拖动部件后保存模型布局。' : '关闭或切换前请保存。') }}</span><span>Ctrl / ⌘ + Z 撤销 · Shift + Z 重做</span></footer>
    </section>
</template>

<style scoped>
.layout-sections{display:flex;gap:5px;padding:0 24px 16px}.layout-sections button{border:0;background:#f0f4f7;border-radius:8px;padding:10px 18px;color:#728597}.layout-sections button.active{background:#e3f0f5;color:#216c85;font-weight:600;box-shadow:inset 0 0 0 1px #c1dde8}.presentation-workspace .layout-body{grid-template-columns:310px minmax(0,1fr);min-height:650px}.settings-sidebar{min-width:0;background:#f6f8fb;border-right:1px solid #dbe4ee}.layout-playback{position:absolute;left:20px;right:20px;bottom:55px;padding:14px 16px;border-radius:12px;background:#172a3ae8;border:1px solid #8babb33d;backdrop-filter:blur(12px);color:#e2edf5}.playback-actions{display:flex;gap:7px;flex-wrap:wrap}.layout-playback button{background:#ffffff12;color:#d5e5ef;border-color:#ffffff26;padding:7px 10px}.layout-playback button:hover:not(:disabled){background:#ffffff24;color:white}.layout-playback .return-edit{margin-left:auto;background:#3b91a5;border-color:#3b91a5;color:white}.playback-progress{display:flex;align-items:center;gap:12px;margin-top:13px;font-size:12px;font-variant-numeric:tabular-nums}.playback-progress>input{flex:1;min-width:40px;accent-color:#5cb4c8}.playback-progress>span{min-width:32px}.playback-progress label{display:flex;align-items:center;gap:8px;white-space:nowrap}.playback-progress select{border:1px solid #ffffff33;background:#253f51;color:#e0ecf4;border-radius:6px;padding:4px}.presentation-workspace .viewport-shell{min-height:650px}.presentation-workspace .viewport-shell :deep(.preview-stage-caption){top:15px;left:18px}.presentation-workspace .layout-toolbar{background:#fafbfd}.presentation-workspace .layout-heading h3{font-size:19px}.presentation-workspace .layout-toolbar button{font-size:11px}.presentation-workspace .viewport-hint{bottom:12px}@media(max-width:900px){.presentation-workspace .layout-body{grid-template-columns:260px minmax(0,1fr)}.layout-playback{left:10px;right:10px}.layout-sections{padding-left:16px}.layout-sections button{padding:9px 12px}}@media(max-width:650px){.presentation-workspace .layout-body{grid-template-columns:1fr}.settings-sidebar{max-height:400px;overflow:auto}.presentation-workspace .viewport-shell{min-height:550px}.layout-playback{bottom:55px}.playback-actions{gap:5px}}

.manual-layout{border:1px solid #d7e0ea;border-radius:18px;background:#fff;overflow:hidden;color:#26354a;outline:none}.layout-heading{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:22px 24px;background:linear-gradient(115deg,#f6f9fc,#eef4f9)}.eyebrow{font-size:calc(10px * var(--admin-font-scale, 1));letter-spacing:.12em;color:#667f96;font-weight:700}.layout-heading h3{margin:6px 0;font-size:calc(20px * var(--admin-font-scale, 1))}.layout-heading p{margin:0;font-size:calc(12px * var(--admin-font-scale, 1));color:#65758a;line-height:1.7}.save-area{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.manual-layout button{font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));border:1px solid #d6dfe8;border-radius:8px;background:white;padding:8px 12px;color:#34465e;cursor:pointer}.manual-layout button:hover:not(:disabled){background:#eef5fb;border-color:#8caecb}.manual-layout button:disabled{opacity:.42;cursor:not-allowed}.manual-layout button.primary{background:#263a51;color:white;border-color:#263a51;padding:11px 17px;font-weight:600}.dirty-pill{border-radius:20px;padding:6px 10px;font-size:calc(11px * var(--admin-font-scale, 1));background:#e5edf4;color:#60778d;white-space:nowrap}.dirty-pill.dirty{background:#fff0d6;color:#987026}.layout-toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:12px 24px;border-top:1px solid #e2e9f0;border-bottom:1px solid #e2e9f0}.toolbar-divider{height:22px;border-left:1px solid #d7e0ea;margin:0 5px}.layout-toolbar .active{border-color:#4783b7;color:#296695;background:#eaf4fc}.coordinate-note{font-size:calc(12px * var(--admin-font-scale, 1));padding:10px 24px;margin:0;color:#916829;background:#fff8e9}.layout-body{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:540px}.part-sidebar{display:flex;flex-direction:column;border-right:1px solid #dbe4ee;background:#f8fafc;min-width:0}.part-list-heading{display:flex;justify-content:space-between;padding:18px 17px 11px;font-size:calc(13px * var(--admin-font-scale, 1))}.part-list-heading span{font-size:calc(11px * var(--admin-font-scale, 1));color:#73839b}.part-search{margin:0 14px 12px;padding:9px 10px;min-width:0;border-radius:7px;border:1px solid #d7e0eb;background:white;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1))}.part-list{height:270px;overflow-y:auto;padding:0 10px 10px}.part-list button{display:flex;gap:10px;text-align:left;width:100%;border-color:transparent;background:transparent;margin:3px 0;padding:10px 9px}.part-list button.selected{border-color:#b9d2e8;background:#e9f2fa;color:#23597f}.part-list i{height:7px;width:7px;min-width:7px;border-radius:50%;margin-top:5px;background:#8397ac}.part-list .selected i{background:#3085bd}.part-list small{display:block;color:#8a99aa;font-size:calc(10px * var(--admin-font-scale, 1));margin-top:3px}.offset-editor{padding:17px 16px;margin-top:auto;border-top:1px solid #dbe4ee}.offset-editor strong{font-size:calc(13px * var(--admin-font-scale, 1));display:block}.offset-editor>small{display:block;font-size:calc(10px * var(--admin-font-scale, 1));color:#8a98aa;margin:5px 0 13px}.offset-fields{display:grid;gap:8px}.offset-fields label{display:flex;gap:7px;align-items:center}.offset-fields label span{font-size:calc(11px * var(--admin-font-scale, 1));width:16px;font-weight:bold}.offset-fields .x span{color:#ce6867}.offset-fields .y span{color:#58a278}.offset-fields .z span{color:#5a8cbd}.offset-fields input{font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));width:100%;min-width:0;padding:6px 8px;border:1px solid #d7e0eb;border-radius:5px;background:white;color:#34465e}.offset-editor button{margin-top:12px;width:100%}.offset-editor p,.list-empty{font-size:calc(11px * var(--admin-font-scale, 1));color:#8a98aa;line-height:1.7}.viewport-shell{position:relative;min-width:0;min-height:540px;background:#293544}.layout-viewport{position:absolute;inset:0;overflow:hidden}.layout-viewport :deep(canvas){display:block;width:100%;height:100%}.viewport-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center;color:#c2d3e4;background:#293544}.viewport-state strong{font-size:calc(15px * var(--admin-font-scale, 1))}.viewport-state p{font-size:calc(12px * var(--admin-font-scale, 1));max-width:550px;line-height:1.8;color:#edc0b1}.viewport-state button{margin-top:14px}.viewport-hint{position:absolute;left:18px;right:18px;bottom:16px;padding:9px 13px;background:#172434d9;backdrop-filter:blur(8px);border:1px solid #8195ae35;border-radius:9px;color:#b5c8dd;font-size:calc(11px * var(--admin-font-scale, 1));pointer-events:none}.hint-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#6babd5;margin-right:7px}.layout-footer{display:flex;justify-content:space-between;gap:12px;padding:12px 24px;font-size:calc(11px * var(--admin-font-scale, 1));color:#7c8da0;background:#f7f9fc;border-top:1px solid #dbe4ee}@media(max-width:1000px){.layout-heading{align-items:flex-start;flex-direction:column;gap:15px}.layout-body{grid-template-columns:200px minmax(0,1fr)}.layout-footer{flex-direction:column}}@media(max-width:650px){.layout-body{grid-template-columns:1fr}.part-sidebar{border-right:0}.part-list{height:150px}.offset-fields{grid-template-columns:repeat(3,1fr)}.viewport-shell{min-height:460px}.layout-heading,.layout-toolbar{padding:16px}}
.presentation-workspace{container-type:inline-size}.layout-more{margin-left:auto;position:relative;font-size:12px;color:#708397}.layout-more summary{list-style:none;cursor:pointer;padding:7px 10px}.layout-more>div{position:absolute;right:0;top:34px;z-index:20;padding:8px;display:grid;gap:5px;min-width:160px;border:1px solid #dbe4ec;border-radius:10px;background:#fff;box-shadow:0 12px 30px #1b34471a}.layout-more button{width:100%;text-align:left}@container(max-width:760px){.presentation-workspace .layout-body{grid-template-columns:1fr}.presentation-workspace .part-sidebar{border-right:0;max-height:410px}.presentation-workspace .settings-sidebar{max-height:400px;overflow:auto;border-right:0}.presentation-workspace .viewport-shell{min-height:550px}.presentation-workspace .part-list{height:160px}.presentation-workspace .offset-fields{grid-template-columns:repeat(3,1fr)}}
</style>
