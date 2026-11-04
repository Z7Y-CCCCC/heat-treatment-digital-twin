<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import { cacheFactoryDraft, readFactoryDraft, clearFactoryDraft } from '../../../runtime/factoryDraftCache.js'
import MotionLinkPreview from './MotionLinkPreview.vue'
const props = defineProps({ models: Array, confirm: Function })
const emit = defineEmits(['saved'])
const modelId = ref(''), loaded = ref(null), actions = ref([]), selectedId = ref(''), trackIndex = ref(0), saved = ref('[]')
const busy = ref(false), error = ref(''), message = ref(''), nodeQuery = ref(''), preview = ref(null), progress = ref(0), playing = ref(false)
const factory = getFactoryScope(), clone = value => JSON.parse(JSON.stringify(value))
let generation = 0, disposed = false, timer
const model = computed(() => loaded.value?.model)
const action = computed(() => actions.value.find(a => a.id === selectedId.value))
const track = computed(() => action.value?.tracks[trackIndex.value])
const dirty = computed(() => JSON.stringify(actions.value) !== saved.value)
const visibleNodes = computed(() => (loaded.value?.nodes || []).filter(n => n.id === track.value?.nodeId || `${n.label} ${n.name}`.toLowerCase().includes(nodeQuery.value.toLowerCase())).slice(0, 1500))
const previewBindings = computed(() => preview.value?.bundle.actions.some(a => a.id === action.value?.id) ? [{ actionId: 'clip:' + action.value.id, kind: 'clip', clipId: action.value.id, enabled: true, mode: 'position', inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 0, sourceGroup: 'analog', sourceKey: '_author' }] : [])
const operations = { translate: '位移', rotate: '旋转', scale: '缩放', visibility: '显隐', color: '变色' }
function pickNode(name) { const node = loaded.value?.nodes.find(n => n.name === name); if (track.value && node) { track.value.nodeId = node.id; nodeQuery.value = '' } }
function persist() { if (dirty.value && loaded.value) cacheFactoryDraft(factory, `motion-authoring:${modelId.value}`, 'motion-authoring', { modelId: modelId.value, revision: loaded.value.revision, actions: actions.value }) }
async function canLeave() { return !busy.value && (!dirty.value || await props.confirm('工艺动作尚未保存，保留草稿并离开？')) }
async function chooseModel(event) {
  const id = event.target.value
  if (!await canLeave()) { event.target.value = modelId.value; return }
  persist(); modelId.value = id; await load()
}
async function reload() { if (!dirty.value || await props.confirm('保留当前草稿，重新读取服务器动作？')) { persist(); await load() } }
async function load() {
  const version = ++generation; busy.value = true; error.value = ''; message.value = ''; preview.value = null; playing.value = false
  try {
    const data = await adminApi.getMotionActions(modelId.value)
    if (disposed || version !== generation) return
    if (data.error) throw Error(data.error)
    loaded.value = data; saved.value = JSON.stringify(data.actions); const cached = readFactoryDraft(factory, `motion-authoring:${modelId.value}`)
    actions.value = clone(cached?.revision === data.revision ? cached.actions : data.actions)
    if (cached && cached.revision !== data.revision) message.value = '模型已更新，旧草稿仍保留；请重新核对动作。'
    selectedId.value = actions.value[0]?.id || ''; trackIndex.value = 0
  } catch (e) { error.value = e.message; loaded.value = null } finally { if (version === generation) busy.value = false }
}
function addAction() {
  if (!loaded.value || actions.value.length >= 32) return
  const next = { id: 'user_' + crypto.randomUUID(), label: '新工艺动作', mode: 'position', duration: 4, cycle: 'forward', tracks: [] }
  actions.value.push(next); selectedId.value = next.id; trackIndex.value = 0; addTrack()
}
function addTrack() {
  if (!action.value || action.value.tracks.length >= 32) return
  action.value.tracks.push({ nodeId: loaded.value.nodes[0]?.id || '', operation: 'translate', axis: 'y', from: 0, to: .5, start: 0, end: 1, easing: 'linear', pivot: [0,0,0], fromColor: '#667788', toColor: '#00c8a0' })
  trackIndex.value = action.value.tracks.length - 1; nodeQuery.value = ''
}
async function removeAction() {
  if (!action.value || !await props.confirm(`删除“${action.value.label}”？保存后生效。`)) return
  actions.value = actions.value.filter(a => a.id !== selectedId.value); selectedId.value = actions.value[0]?.id || ''; trackIndex.value = 0; preview.value = null
}
function changedOperation() {
  if (track.value.operation === 'scale') { track.value.from = 1; track.value.to = 1.5 }
  else if (track.value.operation === 'rotate') { track.value.from = 0; track.value.to = 90 }
  else { track.value.from = 0; track.value.to = track.value.operation === 'visibility' ? 1 : .5 }
}
async function submit(previewOnly = false) {
  if (!loaded.value || busy.value) return false
  busy.value = true; error.value = ''; message.value = ''; playing.value = false
  const id = modelId.value, version = generation, body = { revision: loaded.value.revision, actions: clone(actions.value) }
  try {
    const result = await adminApi.saveMotionActions(id, body, previewOnly)
    if (disposed || version !== generation) return false
    if (result.error || !result.success) throw Error(result.error || '动作未保存')
    preview.value = { bundle: result.bundle, signature: JSON.stringify(body.actions) }; progress.value = 0
    if (!previewOnly) {
      loaded.value = { ...loaded.value, revision: result.revision, model: result.model }; saved.value = JSON.stringify(body.actions)
      clearFactoryDraft(factory, `motion-authoring:${id}`); emit('saved', result.model); message.value = '已保存，实时联动中可直接选择。'
    }
    return true
  } catch (e) { error.value = e.message; return false } finally { if (version === generation) busy.value = false }
}
watch(actions, persist, { deep: true })
watch(selectedId, () => { trackIndex.value = 0; playing.value = false; progress.value = 0 })
watch(() => props.models, models => { if (!modelId.value && models?.length) { modelId.value = models[0].id; load() } }, { immediate: true })
timer = setInterval(() => { if (!playing.value || !action.value) return; progress.value = Math.min(1, progress.value + .04 / action.value.duration); if (progress.value >= 1) { if (action.value.mode === 'running') progress.value = 0; else playing.value = false } }, 40)
onUnmounted(() => { persist(); disposed = true; generation++; clearInterval(timer) })
defineExpose({ canLeave, savePending: () => dirty.value ? submit(false) : Promise.resolve(true) })
</script>
<template>
<section class="motion-author" aria-label="工艺动作编辑器">
  <header class="author-heading"><label>模型<select :value="modelId" :disabled="busy" aria-label="工艺动作模型" @change="chooseModel"><option v-for="m in models" :key="m.id" :value="m.id">{{ m.name || m.id }}</option></select></label><span class="feedback" role="status">{{ message }}</span><span v-if="dirty" class="dirty">未保存</span><button type="button" :disabled="busy" @click="reload">重新读取</button><button type="button" :disabled="busy || !loaded || !action" @click="submit(true)" v-permission="{ page: 'model-animations', action: 'edit' }">预览</button><button type="button" class="primary" :disabled="busy || !loaded || !dirty" @click="submit(false)" v-permission="{ page: 'model-animations', action: 'edit' }">保存并同步</button></header>
  <p v-if="error" class="author-error" role="alert">{{ error }}<button v-if="!loaded" type="button" @click="load">重新读取</button></p>
  <div class="author-body">
    <aside class="author-list"><div class="list-heading"><strong>自定义动作</strong><button type="button" :disabled="busy || !loaded" aria-label="新增工艺动作" @click="addAction" v-permission="{ page: 'model-animations', action: 'edit' }">＋</button></div><div class="action-scroll"><button v-for="a in actions" :key="a.id" type="button" :class="{ selected: selectedId === a.id }" :disabled="busy" @click="selectedId = a.id"><span>{{ a.label }}</span><small>{{ a.tracks.length }} 个部件 · {{ a.mode === 'position' ? '行程' : '运行' }}</small></button><p v-if="!actions.length" class="empty">点击 ＋ 创建动作</p></div><small class="existing">原有内置动作保留在“实时联动”。</small></aside>
    <fieldset class="author-fields" :disabled="busy || !loaded" v-permission="{ page: 'model-animations', action: 'edit' }">
      <template v-if="action"><div class="pair"><label>动作名称<input v-model="action.label" maxlength="80" aria-label="工艺动作名称"></label><label>驱动方式<select v-model="action.mode" aria-label="动作驱动方式"><option value="position">行程跟随</option><option value="running">运行循环</option></select></label></div><div class="pair"><label>周期（秒）<input v-model.number="action.duration" type="number" min=".1" max="30" step=".1" aria-label="动作周期"></label><label v-if="action.mode === 'running'">循环方式<select v-model="action.cycle" aria-label="动作循环方式"><option value="forward">正向循环</option><option value="pingpong">往返循环</option></select></label><button v-else class="danger" type="button" @click="removeAction">删除动作</button></div>
      <div class="track-heading"><strong>联动部件</strong><button type="button" @click="addTrack">＋ 添加部件</button></div><div class="track-tabs"><button v-for="(t,i) in action.tracks" :key="i" type="button" :class="{ selected: trackIndex === i }" @click="trackIndex = i">{{ i + 1 }} · {{ operations[t.operation] }}</button></div>
      <div v-if="track" class="track-fields"><label>查找部件<input v-model="nodeQuery" placeholder="名称或节点" aria-label="查找动作部件"></label><label>模型部件<select v-model="track.nodeId" aria-label="动作部件"><option v-for="node in visibleNodes" :key="node.id" :value="node.id">{{ node.label }} · {{ node.id }}</option></select></label><div class="pair"><label>动作<select v-model="track.operation" aria-label="部件动作类型" @change="changedOperation"><option v-for="(label,key) in operations" :key="key" :value="key">{{ label }}</option></select></label><label v-if="!['visibility','color'].includes(track.operation)">轴向<select v-model="track.axis" aria-label="部件动作轴向"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label></div>
      <div v-if="track.operation === 'color'" class="pair"><label>初始颜色<input v-model="track.fromColor" type="color" aria-label="初始颜色"></label><label>目标颜色<input v-model="track.toColor" type="color" aria-label="目标颜色"></label></div><div v-else class="pair"><label>起始{{ track.operation === 'rotate' ? '（°）' : track.operation === 'translate' ? '（模型单位）' : '' }}<input v-model.number="track.from" type="number" step="any" aria-label="部件动作起始值"></label><label>目标<input v-model.number="track.to" type="number" step="any" aria-label="部件动作目标值"></label></div>
      <details><summary>时序与转轴</summary><div class="pair"><label>开始进度<input v-model.number="track.start" type="number" min="0" max="1" step=".05" aria-label="部件开始进度"></label><label>结束进度<input v-model.number="track.end" type="number" min="0" max="1" step=".05" aria-label="部件结束进度"></label></div><label>过渡<select v-model="track.easing"><option value="linear">线性</option><option value="smooth">平滑</option></select></label><div v-if="track.operation === 'rotate'" class="pivot"><label v-for="(axis,i) in ['X','Y','Z']" :key="axis">转轴 {{ axis }}<input v-model.number="track.pivot[i]" type="number" step="any" :aria-label="'转轴 ' + axis"></label></div></details><button type="button" class="danger remove-track" @click="action.tracks.splice(trackIndex,1); trackIndex = 0">移除此部件</button></div><button v-if="action.mode === 'running'" type="button" class="danger" @click="removeAction">删除动作</button></template>
      <p v-else class="empty">位移、转动或多个部件组合，保存后统一供大屏使用。</p>
    </fieldset>
    <div class="author-preview"><MotionLinkPreview v-if="loaded" :key="(preview?.bundle?.clipSha256 || model?.motion_package?.clipSha256 || modelId) + selectedId" :model="model" :bundle="preview?.bundle || model?.motion_package" :bindings="previewBindings" :points="[]" :stale-ms="5000" :test="true" :test-value="progress" :selectable-node-names="loaded.nodes.map(n => n.name)" @node-picked="pickNode"/><div v-else class="preview-empty"><span>动作预览</span><small>配置部件后点击“预览”</small></div><footer v-if="preview && action"><button type="button" @click="if(progress >= 1) progress = 0; playing = !playing">{{ playing ? '暂停' : '播放' }}</button><input v-model.number="progress" type="range" min="0" max="1" step=".001" aria-label="工艺动作预览进度" @input="playing = false"><span>{{ Math.round(progress * 100) }}%</span></footer><small v-if="preview && preview.signature !== JSON.stringify(actions)" class="preview-stale">配置已变更，点击预览更新。</small></div>
  </div>
</section>
</template>
<style scoped>
.motion-author{border:1px solid #e0e6ef;border-radius:12px;background:#fff;color:#30445c;overflow:hidden}.author-heading{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #e6eaf1}.author-heading>label{display:flex;align-items:center;gap:10px}.author-heading select{width:240px}.feedback{flex:1;color:#38876f;font-size:calc(12px * var(--admin-font-scale, 1))}.dirty{color:#af7a1e;font-size:calc(11px * var(--admin-font-scale, 1))}.author-body{display:grid;grid-template-columns:180px minmax(280px,360px) minmax(300px,1fr);min-height:610px}.author-list{padding:13px;border-right:1px solid #e6eaf1;display:flex;flex-direction:column;min-width:0}.list-heading,.track-heading{display:flex;justify-content:space-between;align-items:center;font-size:calc(13px * var(--admin-font-scale, 1));gap:8px}.list-heading button{font-size:calc(19px * var(--admin-font-scale, 1));padding:1px 8px}.action-scroll{display:grid;gap:6px;align-content:start;max-height:480px;overflow:auto;margin-top:12px}.action-scroll>button{display:grid;gap:6px;text-align:left;padding:10px}.action-scroll span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.action-scroll small,.existing{font-size:calc(10px * var(--admin-font-scale, 1));color:#8190a4}.existing{line-height:1.6;margin-top:auto;padding-top:16px}.author-fields{border:0;border-right:1px solid #e6eaf1;margin:0;padding:16px;min-width:0;max-height:650px;overflow:auto}.author-fields label{display:grid;gap:6px;font-size:calc(11px * var(--admin-font-scale, 1));margin-bottom:12px;min-width:0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pair>button{align-self:end;margin-bottom:12px}.track-heading{margin:12px 0}.track-tabs{display:flex;gap:6px;overflow:auto;margin-bottom:14px;padding-bottom:4px}.track-tabs button{white-space:nowrap;font-size:calc(11px * var(--admin-font-scale, 1));padding:6px 9px}.selected{border-color:#adc8f6!important;background:#eef4ff!important;color:#2265c8!important}.track-fields{border-top:1px solid #e8edf4;padding-top:12px}input,select{box-sizing:border-box;width:100%;padding:9px;border:1px solid #d3dce9;border-radius:7px;background:#fafbfe;color:#30445c;min-width:0;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1))}input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid #9ac2ff;outline-offset:1px}input[type=color]{height:36px;padding:3px}button{padding:8px 11px;border:1px solid #d1ddeb;border-radius:8px;background:white;color:#35619d;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));cursor:pointer}.primary{background:#2868eb;color:white;border-color:#2868eb}button:disabled,fieldset:disabled{opacity:.55;cursor:default}.danger{color:#b45e5e}.remove-track{margin-top:12px}summary{font-size:calc(11px * var(--admin-font-scale, 1));color:#788ba4;cursor:pointer;margin-bottom:12px}.pivot{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.author-preview{display:flex;flex-direction:column;min-width:0;background:#f3f6fa}.preview-empty{display:grid;align-content:center;justify-content:center;gap:12px;flex:1;color:#8192a8;text-align:center}.preview-empty small{font-size:calc(11px * var(--admin-font-scale, 1));color:#a1afbf}.author-preview footer{display:flex;align-items:center;gap:12px;padding:12px;background:white;font-size:calc(11px * var(--admin-font-scale, 1))}.author-preview footer input{flex:1;accent-color:#397ede}.author-preview footer span{width:35px;text-align:right}.preview-stale{padding:9px 12px;color:#b68537;background:#fffaf0;font-size:calc(11px * var(--admin-font-scale, 1))}.empty{font-size:calc(12px * var(--admin-font-scale, 1));color:#8a99ad;line-height:1.8}.author-error{background:#fff3f0;color:#b34840;font-size:calc(12px * var(--admin-font-scale, 1));margin:0;padding:12px 16px}.author-error button{margin-left:12px}@media(max-width:1150px){.author-body{grid-template-columns:145px minmax(250px,300px) minmax(250px,1fr)}}@media(max-width:900px){.author-body{grid-template-columns:145px 1fr}.author-preview{grid-column:1/-1;min-height:420px}.author-heading{flex-wrap:wrap}.author-heading select{width:200px}}
</style>
