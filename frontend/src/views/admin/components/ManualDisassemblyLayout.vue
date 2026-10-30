<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { loadConfiguredGltf, disposeSceneObject } from '../../../runtime/ConfiguredFactoryScene.js'
import { restoreGltfNodeNames } from '../../../three/gltfNodeIdentity.js'
import { resolveBackendAssetUrl } from '../../../three/ModelFactory.js'
import { createManualLayoutRenderLoop, ManualDisassemblyLayoutRuntime } from '../../../runtime/manualDisassemblyLayout.js'

const props = defineProps({ device: { type: Object, required: true }, model: { type: Object, required: true },
    inspection: { type: Object, required: true }, saving: Boolean, saveRevision: { type: Number, default: 0 }, status: { type: String, default: '' } })
const emit = defineEmits(['save', 'selection-change', 'dirty-change'])
const viewport = ref(null), loading = ref(false), error = ref(''), message = ref(''), query = ref('')
const selectedId = ref(''), dirty = ref(false), canUndo = ref(false), canRedo = ref(false), assembled = ref(false)
const partRows = ref([]), offsets = ref([0, 0, 0]), dragging = ref(false)
const visibleParts = computed(() => partRows.value.filter(part => `${part.name} ${part.id}`.toLowerCase().includes(query.value.toLowerCase())))
const selected = computed(() => partRows.value.find(part => part.id === selectedId.value))
const parentSpace = computed(() => props.inspection.offset_space === 'parent')
let session, abort, generation = 0, resizeObserver, mounted = false, active = true, lastRevision = props.saveRevision
let directDrag, previousOrbit = true
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), dragPlane = new THREE.Plane()
const assetUrl = computed(() => resolveBackendAssetUrl(props.model.file_path || props.model.filePath || props.model.url || props.device.model_file || ''))

function sync(runtime) {
    dirty.value = runtime.dirty; canUndo.value = runtime.canUndo; canRedo.value = runtime.canRedo
    assembled.value = runtime.assembled; selectedId.value = runtime.selectedId
    partRows.value = runtime.parts.map(part => ({ id: part.config.id, name: part.config.name }))
    offsets.value = [...(runtime.draft.parts.find(part => part.id === runtime.selectedId)?.explode_offset || [0, 0, 0])]
    emit('dirty-change', dirty.value)
    if (session?.runtime === runtime && !dragging.value) attachGizmo()
}
function attachGizmo() {
    if (!session) return
    const { runtime, proxy, transform } = session
    if (!active || !runtime.selectedPart || runtime.assembled || props.saving) { transform.detach(); return }
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
    if (!session || props.saving || dragging.value || assembled.value) return
    const next = [...offsets.value]; next[index] = Number(value)
    if (!session.runtime.setOffset(selectedId.value, next)) message.value = '请输入三个有效的位移数值。'
    changed()
}
function resetSelected() { if (session && !props.saving) { session.runtime.setOffset(selectedId.value, [0, 0, 0]); changed() } }
function restoreSaved() {
    if (!session || props.saving) return
    session.runtime.restoreSaved(); changed(); message.value = '已恢复该设备最近保存的部件位置；可撤销。'
}
function toggleAssembly() { if (session && !dragging.value) { session.runtime.setAssembled(!assembled.value); changed(); fit() } }
function undo() { if (session && !dragging.value && !props.saving) { session.runtime.undo(); changed() } }
function redo() { if (session && !dragging.value && !props.saving) { session.runtime.redo(); changed() } }
function save() {
    if (!session?.runtime?.parts.length || props.saving || dragging.value || error.value) return
    emit('save', session.runtime.getDraft())
}
function keyboard(event) {
    if (/INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '')) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
    if (event.key === 'Escape' && session && dragging.value) { session.runtime.endDrag(true); session.transform.reset(); session.transform.dragging = false; finishDirect(); changed() }
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
    // The canvas is not focusable by default. Move focus into the editor even
    // for gizmo drags, otherwise Escape/undo stay on a previously used control.
    if (session) viewport.value?.closest('.manual-layout')?.focus({ preventScroll: true })
    if (!session || props.saving || assembled.value || event.button !== 0 || session.transform.axis) return
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
    previousOrbit = session.orbit.enabled; session.orbit.enabled = false; session.transform.enabled = false
    dragging.value = true; session.renderer.domElement.setPointerCapture(event.pointerId)
}
function pointerMove(event) {
    if (!session || !directDrag || event.pointerId !== directDrag.id) return
    event.preventDefault(); event.stopImmediatePropagation(); setPointer(event)
    const hit = raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3())
    if (hit) {
        const position = directDrag.start.clone().add(hit.sub(directDrag.hit))
        session.proxy.position.copy(position); session.runtime.dragTo(position)
    }
}
function finishDirect() {
    if (!session) return
    const element = session.renderer.domElement
    if (directDrag && element.hasPointerCapture?.(directDrag.id)) element.releasePointerCapture(directDrag.id)
    directDrag = null; dragging.value = false
    if (session.orbit) session.orbit.enabled = previousOrbit
    if (session.transform) session.transform.enabled = !props.saving
}
function pointerUp(event) {
    if (!session || !directDrag || event.pointerId !== directDrag.id) return
    event.preventDefault(); event.stopImmediatePropagation()
    session.runtime.endDrag(event.type === 'pointercancel'); finishDirect(); changed()
}

function disposeSession() {
    abort?.abort(); generation++; resizeObserver?.disconnect()
    if (!session) return
    session.loop?.dispose()
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
        const runtime = new ManualDisassemblyLayoutRuntime({ root, scene, camera, inspection: props.inspection, onChange: sync })
        session.runtime = runtime; sync(runtime); attachGizmo()
        const draggingChanged = event => {
            if (directDrag) return
            dragging.value = event.value
            if (event.value) { previousOrbit = orbit.enabled; orbit.enabled = false; runtime.beginDrag(proxy.position) }
            else { runtime.endDrag(); orbit.enabled = previousOrbit; changed() }
        }
        const objectChange = () => { if (!directDrag && dragging.value) runtime.dragTo(proxy.position) }
        transform.addEventListener('dragging-changed', draggingChanged); transform.addEventListener('objectChange', objectChange)
        session.listeners = [['pointerdown', capturePointerDown, true], ['pointermove', pointerMove, true], ['pointerup', pointerUp, true], ['pointercancel', pointerUp, true]]
        for (const [name, handler, capture] of session.listeners) renderer.domElement.addEventListener(name, handler, capture)
        const resize = () => {
            if (!active || !session || current !== generation) return
            const width = Math.max(viewport.value.clientWidth, 1), height = Math.max(viewport.value.clientHeight, 1)
            renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix()
        }
        session.resize = resize
        resizeObserver = new ResizeObserver(resize); resizeObserver.observe(viewport.value); resize(); fit()
        session.loop = createManualLayoutRenderLoop(() => {
            if (!active || !session || current !== generation) return
            orbit.update(); renderer.render(scene, camera)
        })
        session.loop.start(); lastRevision = props.saveRevision; choose(runtime.selectedId)
    } catch (cause) {
        if (current === generation && cause.name !== 'AbortError') {
            error.value = `模型未加载：${cause.message || cause}`
            if (session) disposeSession(); else if (root) disposeSceneObject(root)
        }
    } finally { if (current === generation || error.value) loading.value = false }
}
watch(() => [props.device.id, props.model.id, assetUrl.value], () => {
    if (mounted && active) void load()
    else if (mounted) disposeSession()
})
watch(() => [props.saveRevision, JSON.stringify(props.inspection)], () => {
    if (!session?.runtime) return
    if (props.saveRevision !== lastRevision || !dirty.value) {
        session.runtime.markSaved(props.inspection); lastRevision = props.saveRevision; changed()
    }
})
watch(() => props.saving, value => { if (session?.transform) { session.transform.enabled = active && !value; attachGizmo() } })
onDeactivated(() => {
    active = false; resizeObserver?.disconnect()
    if (session) {
        session.loop?.pause()
        if (dragging.value) { session.runtime.endDrag(true); session.transform.reset(); session.transform.dragging = false; finishDirect(); changed() }
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
onMounted(async () => { mounted = true; window.addEventListener('beforeunload', beforeUnload); await nextTick(); await load() })
onUnmounted(() => { mounted = false; window.removeEventListener('beforeunload', beforeUnload); disposeSession() })
defineExpose({ dirty, getDraft: () => session?.runtime.getDraft() || props.inspection, discardChanges: restoreSaved })
</script>

<template>
    <section class="manual-layout" data-testid="manual-disassembly-layout" tabindex="0" @keydown="keyboard">
        <header class="layout-heading">
            <div><span class="eyebrow">PER-DEVICE / 手工空间布局</span><h3>{{ device.name || device.id }} · 部件摆放</h3><p>直接拖动部件，或使用三轴与平面手柄。只保存本台设备的位置，不改变同型号其他设备。</p></div>
            <div class="save-area"><span class="dirty-pill" :class="{ dirty }">{{ dirty ? '有未保存的位置' : '已载入保存位置' }}</span><button class="primary" type="button" data-testid="save-manual-layout" :disabled="saving || loading || !partRows.length || dragging || !!error" @click="save">{{ saving ? '保存中…' : '保存本台设备布局' }}</button></div>
        </header>
        <div class="layout-toolbar">
            <button type="button" :disabled="!canUndo || saving || dragging" @click="undo">↶ 撤销</button><button type="button" :disabled="!canRedo || saving || dragging" @click="redo">↷ 重做</button>
            <span class="toolbar-divider"></span><button type="button" :disabled="loading || !!error || dragging" @click="fit()">完整视图</button><button type="button" :disabled="!selected || dragging" @click="fit(true)">聚焦选中部件</button>
            <button type="button" :class="{ active: assembled }" :disabled="loading || !!error || dragging" @click="toggleAssembly">{{ assembled ? '返回手工拆解布局' : '查看装配原位' }}</button>
            <button type="button" :disabled="!dirty || saving || dragging" @click="restoreSaved">恢复已保存位置</button>
        </div>
        <p v-if="parentSpace" class="coordinate-note">旧版父级坐标：拖拽按选中部件首节点的父级基底换算；多节点跨父级时，各节点保持各自父坐标语义。</p>
        <div class="layout-body">
            <aside class="part-sidebar">
                <div class="part-list-heading"><strong>可拖拽部件</strong><span>{{ partRows.length }}</span></div>
                <input v-model="query" class="part-search" aria-label="搜索手工布局部件" placeholder="搜索部件名称…" />
                <div class="part-list" role="listbox" aria-label="布局部件">
                    <button v-for="part in visibleParts" :key="part.id" type="button" role="option" :aria-selected="part.id === selectedId" :class="{ selected: part.id === selectedId }" :disabled="dragging || saving" @click="choose(part.id)"><i></i><span>{{ part.name || part.id }}<small>{{ part.id }}</small></span></button>
                    <p v-if="!partRows.length && !loading" class="list-empty">模型未配置可编辑部件。请先在模型拆解编排中绑定真实节点。</p>
                </div>
                <div class="offset-editor"><strong>{{ selected?.name || '请选择部件' }}</strong><small>{{ parentSpace ? '父级坐标位移' : '模型坐标位移' }} · 模型单位</small><div class="offset-fields"><label v-for="(axis,index) in ['X','Y','Z']" :key="axis" :class="axis.toLowerCase()"><span>{{ axis }}</span><input type="number" step="0.01" :aria-label="`${axis}轴拆解位移`" :value="Number(offsets[index]).toFixed(4)" :disabled="!selected || assembled || saving || dragging" @change="setAxis(index, $event.target.value)" /></label></div><button type="button" :disabled="!selected || assembled || saving || dragging" @click="resetSelected">选中部件位移归零</button><p>保留原来的部件旋转、时序与 PLC 绑定。</p></div>
            </aside>
            <div class="viewport-shell"><div ref="viewport" class="layout-viewport" data-testid="manual-layout-canvas"></div>
                <div v-if="loading || error" class="viewport-state" :class="{ failure: error }"><strong>{{ error ? '无法打开手工布局' : '正在加载真实三维模型…' }}</strong><p v-if="error">{{ error }}</p><button v-if="error" type="button" @click="load">重新加载</button></div>
                <div v-else class="viewport-hint"><span class="hint-dot"></span>{{ assembled ? '装配原位预览 · 返回拆解布局后可拖动' : dragging ? '正在移动部件 · 松开完成，Esc 取消' : '左键拖动部件／三轴／平面 · 空白处旋转 · 右键平移 · 滚轮缩放' }}</div>
            </div>
        </div>
        <footer class="layout-footer"><span>{{ status || message || '位置只在点击保存后写入该设备；关闭或切换前请保存。' }}</span><span>Ctrl / ⌘ + Z 撤销 · Shift + Z 重做</span></footer>
    </section>
</template>

<style scoped>
.manual-layout{border:1px solid #d7e0ea;border-radius:18px;background:#fff;overflow:hidden;color:#26354a;outline:none}.layout-heading{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:22px 24px;background:linear-gradient(115deg,#f6f9fc,#eef4f9)}.eyebrow{font-size:10px;letter-spacing:.12em;color:#667f96;font-weight:700}.layout-heading h3{margin:6px 0;font-size:20px}.layout-heading p{margin:0;font-size:12px;color:#65758a;line-height:1.7}.save-area{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.manual-layout button{font:inherit;font-size:12px;border:1px solid #d6dfe8;border-radius:8px;background:white;padding:8px 12px;color:#34465e;cursor:pointer}.manual-layout button:hover:not(:disabled){background:#eef5fb;border-color:#8caecb}.manual-layout button:disabled{opacity:.42;cursor:not-allowed}.manual-layout button.primary{background:#263a51;color:white;border-color:#263a51;padding:11px 17px;font-weight:600}.dirty-pill{border-radius:20px;padding:6px 10px;font-size:11px;background:#e5edf4;color:#60778d;white-space:nowrap}.dirty-pill.dirty{background:#fff0d6;color:#987026}.layout-toolbar{display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding:12px 24px;border-top:1px solid #e2e9f0;border-bottom:1px solid #e2e9f0}.toolbar-divider{height:22px;border-left:1px solid #d7e0ea;margin:0 5px}.layout-toolbar .active{border-color:#4783b7;color:#296695;background:#eaf4fc}.coordinate-note{font-size:12px;padding:10px 24px;margin:0;color:#916829;background:#fff8e9}.layout-body{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:540px}.part-sidebar{display:flex;flex-direction:column;border-right:1px solid #dbe4ee;background:#f8fafc;min-width:0}.part-list-heading{display:flex;justify-content:space-between;padding:18px 17px 11px;font-size:13px}.part-list-heading span{font-size:11px;color:#73839b}.part-search{margin:0 14px 12px;padding:9px 10px;min-width:0;border-radius:7px;border:1px solid #d7e0eb;background:white;font:inherit;font-size:12px}.part-list{height:270px;overflow-y:auto;padding:0 10px 10px}.part-list button{display:flex;gap:10px;text-align:left;width:100%;border-color:transparent;background:transparent;margin:3px 0;padding:10px 9px}.part-list button.selected{border-color:#b9d2e8;background:#e9f2fa;color:#23597f}.part-list i{height:7px;width:7px;min-width:7px;border-radius:50%;margin-top:5px;background:#8397ac}.part-list .selected i{background:#3085bd}.part-list small{display:block;color:#8a99aa;font-size:10px;margin-top:3px}.offset-editor{padding:17px 16px;margin-top:auto;border-top:1px solid #dbe4ee}.offset-editor strong{font-size:13px;display:block}.offset-editor>small{display:block;font-size:10px;color:#8a98aa;margin:5px 0 13px}.offset-fields{display:grid;gap:8px}.offset-fields label{display:flex;gap:7px;align-items:center}.offset-fields label span{font-size:11px;width:16px;font-weight:bold}.offset-fields .x span{color:#ce6867}.offset-fields .y span{color:#58a278}.offset-fields .z span{color:#5a8cbd}.offset-fields input{font:inherit;font-size:12px;width:100%;min-width:0;padding:6px 8px;border:1px solid #d7e0eb;border-radius:5px;background:white;color:#34465e}.offset-editor button{margin-top:12px;width:100%}.offset-editor p,.list-empty{font-size:11px;color:#8a98aa;line-height:1.7}.viewport-shell{position:relative;min-width:0;min-height:540px;background:#293544}.layout-viewport{position:absolute;inset:0;overflow:hidden}.layout-viewport :deep(canvas){display:block;width:100%;height:100%}.viewport-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px;text-align:center;color:#c2d3e4;background:#293544}.viewport-state strong{font-size:15px}.viewport-state p{font-size:12px;max-width:550px;line-height:1.8;color:#edc0b1}.viewport-state button{margin-top:14px}.viewport-hint{position:absolute;left:18px;right:18px;bottom:16px;padding:9px 13px;background:#172434d9;backdrop-filter:blur(8px);border:1px solid #8195ae35;border-radius:9px;color:#b5c8dd;font-size:11px;pointer-events:none}.hint-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#6babd5;margin-right:7px}.layout-footer{display:flex;justify-content:space-between;gap:12px;padding:12px 24px;font-size:11px;color:#7c8da0;background:#f7f9fc;border-top:1px solid #dbe4ee}@media(max-width:1000px){.layout-heading{align-items:flex-start;flex-direction:column;gap:15px}.layout-body{grid-template-columns:200px minmax(0,1fr)}.layout-footer{flex-direction:column}}@media(max-width:650px){.layout-body{grid-template-columns:1fr}.part-sidebar{border-right:0}.part-list{height:150px}.offset-fields{grid-template-columns:repeat(3,1fr)}.viewport-shell{min-height:460px}.layout-heading,.layout-toolbar{padding:16px}}
</style>
