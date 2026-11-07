<script setup>
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as T from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { loadConfiguredGltf, disposeSceneObject } from '../../../runtime/ConfiguredFactoryScene.js'
import { nativeDeviceTransform } from '../../../runtime/factorySceneConfig.js'
import { resolveBackendAssetUrl } from '../../../three/ModelFactory.js'
import { loadingAlignmentCandidates, prepareLoadingAlignment } from '../utils/loadingAlignment.js'
const props = defineProps({ mode: String, line: Object, layout: Object, devices: Array, models: Array, selectedIds: Array, busy: Boolean, error: String, canEdit: Boolean })
const emit = defineEmits(['close', 'apply', 'retry'])
const dialog = ref(null), viewport = ref(null), scope = ref(props.selectedIds?.length >= 2 ? 'selected' : 'lane')
const laneId = ref(props.layout.lanes[0]?.id || '')
const referenceId = ref(''), portKind = ref('inlet'), referencePortKind = ref('inlet')
const plan = ref(null), measuring = ref(false), sceneBusy = ref(false), localError = ref(''), sceneError = ref('')
const title = computed(() => props.mode === 'faces' ? '进料面前后对齐' : '送料高度对齐')
const candidates = computed(() => { try { return loadingAlignmentCandidates(props.devices, props.layout, props.mode, scope.value, laneId.value, props.selectedIds) } catch { return [] } })
const singleLane = computed(() => candidates.value.length > 0 && new Set(candidates.value.map(r => r.binding.item.id)).size === 1)
const refs = computed(() => props.mode === 'faces' && !singleLane.value ? [] : candidates.value)
const ready = computed(() => plan.value && !measuring.value && !sceneBusy.value && !props.busy && !props.error && props.canEdit)
const sourceSignature = computed(() => JSON.stringify([props.mode, props.line, props.layout, props.devices, props.models, props.selectedIds]))
let generation = 0, controller, sceneRuntime, disposed = false
const number = value => Number(value).toFixed(3)
function cleanupScene() { sceneRuntime?.dispose(); sceneRuntime = null }
function invalidate() { generation++; controller?.abort(); measuring.value = false; sceneBusy.value = false; plan.value = null; localError.value = ''; sceneError.value = ''; cleanupScene() }
watch([scope, laneId, portKind, referencePortKind], invalidate)
watch(referenceId, invalidate)
watch(sourceSignature, invalidate)
watch(() => candidates.value.map(r => r.id).join('|'), () => {
  if (props.mode === 'heights' && !candidates.value.some(r => r.id === referenceId.value)) referenceId.value = candidates.value[0]?.id || ''
  if (props.mode === 'faces' && (!singleLane.value || !refs.value.some(r => r.id === referenceId.value))) referenceId.value = ''
}, { immediate: true })
function close() { if (!props.busy) { invalidate(); emit('close') } }
async function generate() {
  if (props.busy || !props.canEdit) return
  invalidate(); emit('retry'); const version = generation, signature = sourceSignature.value
  controller = new AbortController(); measuring.value = true
  try {
    const result = await prepareLoadingAlignment({ line: props.line, layout: props.layout, devices: props.devices, models: props.models,
      mode: props.mode, scope: scope.value, laneId: laneId.value, selectedIds: props.selectedIds, referenceId: referenceId.value,
      portKind: portKind.value, referencePortKind: referencePortKind.value }, { signal: controller.signal })
    if (disposed || version !== generation || signature !== sourceSignature.value) return
    plan.value = result; measuring.value = false; sceneBusy.value = true
    await nextTick(); await renderScene(result, version, controller.signal)
  } catch (error) { if (version === generation && !disposed && error.name !== 'AbortError') localError.value = error.message }
  finally { if (version === generation && !disposed) { measuring.value = false; sceneBusy.value = false } }
}
function apply() { if (ready.value) emit('apply', JSON.parse(JSON.stringify(plan.value.payload))) }
async function renderScene(result, version, signal) {
  cleanupScene()
  const roots = new Set(), scene = new T.Scene(), templates = new Map()
  scene.background = new T.Color('#f0f4f8')
  let renderer, controls, observer, frame = 0, released = false
  const release = () => { if (released) return; released = true; cancelAnimationFrame(frame); observer?.disconnect(); controls?.dispose(); disposeSceneObject([scene, ...roots]); renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement?.remove() }
  sceneRuntime = { dispose: release }
  try {
    scene.add(new T.HemisphereLight(0xffffff, 0x677f95, 2.3)); const light = new T.DirectionalLight(0xffffff, 3); light.position.set(8, 12, 6); scene.add(light)
    for (const row of result.rows) {
      const device = row.device, model = props.models.find(m => m.id === device.model_type), url = resolveBackendAssetUrl(device.model_file || model?.file_path)
      if (!templates.has(url)) {
        const loaded = await loadConfiguredGltf(url, { signal })
        if (released || disposed || version !== generation || signal.aborted) { disposeSceneObject(loaded.scene); return }
        roots.add(loaded.scene); templates.set(url, loaded.scene)
      }
      if (released || disposed || version !== generation) { release(); return }
      const asset = templates.get(url), transform = nativeDeviceTransform(device, model)
      const before = new T.Group(), after = new T.Group(); before.add(clone(asset)); after.add(clone(asset))
      before.traverse(n => { if (n.isMesh) n.material = new T.MeshBasicMaterial({ color: 0x8297ae, wireframe: true, transparent: true, opacity: .22, depthWrite: false }) })
      for (const group of [before, after]) { group.position.set(transform.position.x, transform.position.y, transform.position.z); group.rotation.y = transform.yaw; group.scale.set(...transform.scale); scene.add(group) }
      after.position[result.axis] = row[result.axis]
      const offset = new T.Vector3(...row.portPosition), oldPort = offset.clone().add(before.position), newPort = offset.clone().add(after.position)
      const color = result.referenceIds.includes(row.id) ? 0xe6a033 : 0x16857a
      const marker = new T.Mesh(new T.SphereGeometry(.075, 12, 8), new T.MeshBasicMaterial({ color, depthTest: false })); marker.position.copy(newPort); marker.renderOrder = 10; scene.add(marker)
      scene.add(new T.ArrowHelper(new T.Vector3(...row.portDirection), newPort, .6, color, .15, .09))
      if (oldPort.distanceTo(newPort) > .000001) scene.add(new T.Line(new T.BufferGeometry().setFromPoints([oldPort, newPort]), new T.LineBasicMaterial({ color: 0x2876db, depthTest: false })))
    }
    const bounds = new T.Box3().setFromObject(scene), size = bounds.getSize(new T.Vector3()), center = bounds.getCenter(new T.Vector3()), span = Math.max(size.x, size.y, size.z, 3)
    const grid = new T.GridHelper(Math.ceil(span * 1.5), 30, 0xacbdce, 0xd9e2ea); grid.position.set(center.x, Math.min(0, bounds.min.y) - .015, center.z); scene.add(grid)
    renderer = new T.WebGLRenderer({ antialias: true, alpha: false }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5)); renderer.outputColorSpace = T.SRGBColorSpace
    const camera = new T.PerspectiveCamera(40, 1, .01, span * 20 + 100); camera.position.copy(center).add(new T.Vector3(span * .9, span * .7, span * 1.2))
    controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(center); controls.enableDamping = true; controls.update()
    viewport.value.append(renderer.domElement)
    const resize = () => { if (released) return; const width = Math.max(viewport.value?.clientWidth || 1, 1), height = Math.max(viewport.value?.clientHeight || 1, 1); renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix() }
    resize(); observer = new ResizeObserver(resize); observer.observe(viewport.value)
    const render = () => { if (released || disposed) return; controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(render) }; render()
  } catch (error) { release(); if (version === generation && !disposed && error.name !== 'AbortError') sceneError.value = `3D预览不可用：${error.message}。可核对下方数值预览，未修改设备。` }
}
onMounted(() => { dialog.value?.showModal() })
onUnmounted(() => { disposed = true; invalidate() })
</script>
<template>
<Teleport to="body"><dialog ref="dialog" class="loading-alignment-dialog" :aria-label="title" @cancel.prevent="close">
  <header><div><span class="eyebrow">可选布局校准 · 仅影响大屏模型</span><h2>{{ title }}</h2><p>{{ mode === 'faces' ? '只调整前后 Z 位置，保持设备高度、间距和朝向。' : '让所选进出料口的下沿基准点处于同一高度，只调整设备整体 Y，不改变间距或朝向。' }}</p></div><button type="button" class="close" aria-label="关闭对齐预览" :disabled="busy" @click="close">×</button></header>
  <div class="alignment-body">
    <aside class="alignment-settings"><strong>① 确定参与范围</strong>
      <label>参与范围<select v-model="scope" aria-label="对齐参与范围" :disabled="busy || measuring"><option value="selected" :disabled="selectedIds.length < 2">已选设备（{{ selectedIds.length }} 台）</option><option value="lane">指定设备线</option><option value="line">{{ mode === 'faces' ? '当前产线全部设备线（不含小车）' : '当前产线全部已放置设备（含小车）' }}</option></select></label>
      <label v-if="scope === 'lane'">设备线<select v-model="laneId" aria-label="对齐设备线" :disabled="busy || measuring"><option v-for="lane in layout.lanes" :key="lane.id" :value="lane.id">{{ lane.name }}</option></select></label>
      <label>参与设备使用<select v-model="portKind" aria-label="参与设备进出料口" :disabled="busy || measuring"><option value="inlet">进料口</option><option value="outlet">出料口</option></select></label>
      <strong>② 选择保持不动的基准</strong>
      <label>基准设备<select v-model="referenceId" aria-label="对齐基准设备" :disabled="busy || measuring"><option v-if="mode === 'faces'" value="">每条设备线最靠近导轨的所选料口面</option><option v-for="row in refs" :key="row.id" :value="row.id">{{ row.device.name }}</option><option v-if="mode === 'heights' && !refs.length" value="">请先选择有效参与范围</option></select></label>
      <label v-if="referenceId">基准使用<select v-model="referencePortKind" aria-label="基准设备进出料口" :disabled="busy || measuring"><option value="inlet">进料口</option><option value="outlet">出料口</option></select></label>
      <p class="help">{{ mode === 'faces' ? '跨设备线时分别对齐到各线基准，不把整条产线强行推到同一个面。' : '可用小车出料口作为基准，再对齐炉子进料口。基准设备自身位置不会改变。' }}</p>
      <p v-if="mode === 'heights'" class="help">高度对齐会抬高或降低整台模型，请在预览中同时检查底座与地面，不会缩放设备或改动模型结构。</p>
      <p class="help">只需到「模型管理 → 进出料口」点击口下沿设一个基准点，不用框选区域；单台设备也可以微调。</p>
      <p class="help">没有小车、无需交接动画对齐的设备可以不配置此项，不影响模型或产线的正常使用。</p>
      <button type="button" class="btn btn-primary" :disabled="busy || measuring || !canEdit" @click="generate">{{ measuring ? '正在测量…' : plan ? '重新生成预览' : '生成对齐预览' }}</button>
    </aside>
    <section class="alignment-preview"><div class="preview-heading"><strong>③ 核对效果，确认后才保存</strong><span>灰色：原位置　绿色：预览口　橙色：基准</span></div><div ref="viewport" class="alignment-viewport"><div v-if="!plan || sceneBusy || sceneError" class="preview-state" role="status">{{ sceneError || (sceneBusy ? '正在准备模型预览…' : measuring ? '正在读取进出料口…' : '选择范围与基准，点击「生成对齐预览」') }}</div></div>
      <div v-if="plan" class="alignment-table"><table><thead><tr><th>设备</th><th>使用口</th><th>{{ mode === 'faces' ? '原 Z → 预览 Z（m）' : '原 Y → 预览 Y（m）' }}</th><th>调整量（m）</th><th>说明</th></tr></thead><tbody><tr v-for="row in plan.rows" :key="row.id" :data-alignment-device="row.id"><td>{{ row.device.name }}</td><td>{{ row.portKind === 'outlet' ? '出料口' : '进料口' }}</td><td>{{ number(row.device['pos_' + plan.axis]) }} → {{ number(row[plan.axis]) }}</td><td>{{ number(row[plan.axis] - row.device['pos_' + plan.axis]) }}</td><td>{{ plan.referenceIds.includes(row.id) ? '基准 · 保持不动' : row.portSource === 'fallback' ? '模型已有结构' : row.portSource === 'instance' ? '实例微调' : '模型配置' }}</td></tr></tbody></table></div>
    </section>
  </div>
  <footer><p v-if="localError || error" class="error" role="alert">{{ localError || error }}</p><p v-else>预览不会写入数据库；取消不会移动任何设备。高度调整的是模型布局，不是现场机械。</p><button type="button" class="btn" :disabled="busy" @click="close">取消</button><button type="button" class="btn btn-primary" :disabled="!ready" @click="apply">{{ busy ? '正在保存…' : '确认并应用' }}</button></footer>
</dialog></Teleport>
</template>
<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.loading-alignment-dialog{width:min(1280px,calc(100vw - 48px));max-height:94vh;padding:0;border:1px solid #dce5ef;border-radius:18px;background:#f7f9fc;color:#30445c;box-shadow:0 30px 100px #10254145;display:flex;flex-direction:column;overflow:hidden}.loading-alignment-dialog::backdrop{background:#13283b65;backdrop-filter:blur(3px)}header{flex:none;display:flex;justify-content:space-between;gap:16px;padding:22px 26px 18px;background:#fff;border-bottom:1px solid #e4eaf2}.eyebrow{font-size:calc(13px * var(--admin-font-scale,1));color:#526174}h2{font-size:calc(22px * var(--admin-font-scale,1));margin:6px 0 8px}header p{margin:0;color:#526174;font-size:calc(14px * var(--admin-font-scale,1))}.close{width:34px;height:34px;border:1px solid #e1e6ee;border-radius:9px;background:white;color:#475467;font-size:calc(24px * var(--admin-font-scale,1));cursor:pointer}.alignment-body{min-height:0;flex:1;display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px;padding:18px;max-height:calc(94vh - 190px);overflow:auto}.alignment-settings{display:flex;flex-direction:column;gap:15px;padding:18px;background:white;border:1px solid #e1e8f1;border-radius:12px}.alignment-settings strong{font-size:calc(15px * var(--admin-font-scale,1));color:#425c77}.alignment-settings label{display:grid;gap:7px;color:#526174;font-size:calc(14px * var(--admin-font-scale,1))}select{box-sizing:border-box;width:100%;padding:9px 10px;background:#f9fbfe;border:1px solid #d9e3ef;border-radius:8px;color:#334d68;font:inherit}.help{font-size:calc(13px * var(--admin-font-scale,1));line-height:1.7;color:#526174;margin:0}.alignment-preview{background:#fff;border:1px solid #e1e8f1;border-radius:12px;overflow:hidden;min-width:0}.preview-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:15px 17px}.preview-heading strong{font-size:calc(15px * var(--admin-font-scale,1))}.preview-heading span{font-size:calc(13px * var(--admin-font-scale,1));color:#526174}.alignment-viewport{height:360px;position:relative;background:#f0f4f8}.alignment-viewport :deep(canvas){display:block;touch-action:none}.preview-state{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;font-size:calc(15px * var(--admin-font-scale,1));color:#526174;z-index:2;pointer-events:none;background:#f0f4f8e8}.alignment-table{max-height:225px;overflow:auto}table{width:100%;min-width:650px;border-collapse:collapse;font-size:calc(13px * var(--admin-font-scale,1))}th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #eaf0f5;white-space:nowrap}th{background:#f6f9fc;color:#475467;position:sticky;top:0}td{color:#40546f}footer{flex:none;flex-wrap:wrap;display:flex;align-items:center;gap:10px;padding:14px 22px;border-top:1px solid #e1e8f1;background:white}footer p{flex:1;font-size:calc(13px * var(--admin-font-scale,1));color:#526174;margin:0;line-height:1.6}.error{color:#b84e46!important}button:focus-visible,select:focus-visible{outline:2px solid #79aaf0;outline-offset:2px}@media(max-width:900px){.loading-alignment-dialog{width:calc(100vw - 24px)}.alignment-body{grid-template-columns:240px minmax(0,1fr);gap:10px;padding:10px}.alignment-settings{padding:12px}.alignment-viewport{height:300px}.preview-heading span{font-size:calc(13px * var(--admin-font-scale,1))}}@media(max-width:680px){.alignment-body{grid-template-columns:1fr}.alignment-viewport{height:280px}footer{flex-wrap:wrap}footer p{flex-basis:100%}}
</style>
