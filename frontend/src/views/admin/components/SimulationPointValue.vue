<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { formatPointValue } from '../utils/points.js'

const props = defineProps({ point: { type:Object, required:true }, currentMode: { type:String, default:'' }, canEdit: Boolean })
const emit = defineEmits(['saved'])
const editing = ref(false), draft = ref(''), busy = ref(false), error = ref(''), input = ref(null)
// A cached point may still say simulation after the factory has changed source.
// Require both the current engine mode and this reading to confirm simulation.
const isSimulation = computed(() => props.currentMode === 'simulation' && props.point.sourceMode === 'simulation')
const editable = computed(() => props.canEdit && isSimulation.value && String(props.point.access_type || 'READ').toUpperCase() !== 'WRITE')
const isBoolean = computed(() => String(props.point.data_type).toUpperCase() === 'BOOL')
let disposed = false
function cancel() { if (busy.value) return; editing.value = false; error.value = '' }
async function begin() {
  if (!editable.value || busy.value) return
  draft.value = props.point.value == null ? '' : String(props.point.value)
  editing.value = true; error.value = ''
  await nextTick(); input.value?.focus(); input.value?.select?.()
}
async function apply(reset = false) {
  if (!editable.value || busy.value) return false
  const id = props.point.id
  busy.value = true; error.value = ''
  try {
    const result = reset ? await adminApi.resetSimulationPointValue(id) : await adminApi.setSimulationPointValue(id, draft.value)
    if (result?.error || !result?.success) throw new Error(result?.error || '模拟值未修改，请重试')
    if (!disposed && props.point.id === id) { editing.value = false; emit('saved') }
    return true
  } catch (failure) { if (!disposed) error.value = failure.message || '修改模拟值失败'; return false }
  finally { if (!disposed) busy.value = false }
}
// Polling may update point.value, but must never replace a user's typed draft.
watch(() => [props.point.id, editable.value], (value, previous) => { if (!editable.value || previous && value[0] !== previous[0]) { editing.value = false; error.value = '' } })
onUnmounted(() => { disposed = true })
</script>

<template>
  <div class="simulation-point-value" :class="{ editable, fixed:isSimulation && point.simulationManual }">
    <form v-if="editing && editable" class="simulation-point-editor" @submit.prevent="apply()" @keydown.esc.stop.prevent="cancel">
      <label class="simulation-point-input-label">{{ point.label || point.name }} · {{ point.data_type }}<span v-if="point.unit"> · {{ point.unit }}</span></label>
      <select v-if="isBoolean" ref="input" v-model="draft" :disabled="busy" aria-label="模拟点位值"><option value="true">ON / true</option><option value="false">OFF / false</option></select>
      <input v-else ref="input" v-model="draft" type="text" :inputmode="['REAL','LREAL','BYTE','WORD','INT','DWORD','DINT'].includes(point.data_type) ? 'decimal' : 'text'" :disabled="busy" aria-label="模拟点位值" autocomplete="off" />
      <div class="simulation-point-buttons"><button type="submit" :disabled="busy">{{ busy?'保存中…':'保存并固定' }}</button><button type="button" :disabled="busy" @click="cancel">取消</button></div>
      <small>修改表格显示值，不重复换算；固定后不会随机刷新。本次模拟运行有效，切换数据来源或重启后清除。</small>
    </form>
    <template v-else>
      <span v-if="!editable" class="simulation-point-readonly">{{ formatPointValue(point) }}</span>
      <button v-else type="button" class="simulation-point-display" :title="'双击修改模拟值，Enter 也可编辑；不会写入 PLC'" :aria-label="`修改${point.label || point.name}的模拟值`" @dblclick="begin" @keydown.enter.prevent="begin"><strong>{{ formatPointValue(point) }}</strong><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 4 4 4M4 16l4-1L17 6l-4-4-9 9-1 6Z"/></svg></button>
      <span v-if="isSimulation" class="simulation-point-source" title="刷新页面或新增点位不会覆盖固定值；退出模拟模式或重启后清除"><span>{{ String(point.access_type).toUpperCase() === 'WRITE' ? '只写 · 无读取' : point.simulationManual?'模拟 · 已固定':'模拟 · 自动' }}</span><button v-if="editable && point.simulationManual" type="button" :disabled="busy" @click="apply(true)">恢复自动</button></span>
    </template>
    <p v-if="error" class="simulation-point-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.simulation-point-value{display:grid;gap:5px;min-width:0;font-weight:600}.simulation-point-display{display:flex;align-items:center;gap:6px;max-width:100%;margin:0;padding:4px 3px;border:1px solid transparent;border-radius:5px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:text}.simulation-point-display strong{font-weight:600;overflow-wrap:anywhere}.simulation-point-display svg{flex:none;width:13px;height:13px;fill:none;stroke:#8da1bd;stroke-width:1.3;opacity:.65}.simulation-point-display:hover{border-color:#c9dcf6;background:#f2f7ff}.simulation-point-display:focus-visible{outline:2px solid #80aef3;outline-offset:2px}.simulation-point-source{display:flex;flex-wrap:wrap;align-items:center;gap:7px;color:#8b99ab;font-size:10px;line-height:1.4;font-weight:400;white-space:nowrap}.fixed .simulation-point-source{color:#a17b2c}.simulation-point-source button{padding:0;border:0;background:none;color:#407abf;font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}.simulation-point-editor{display:grid;gap:7px;min-width:180px;padding:8px;border:1px solid #c4d9f7;border-radius:7px;background:#f8fbff;font-weight:400}.simulation-point-input-label{color:#6b7d93;font-size:10px;line-height:1.4}.simulation-point-editor input,.simulation-point-editor select{box-sizing:border-box;width:100%;min-width:0;min-height:32px;padding:5px 7px;border:1px solid #bccfe9;border-radius:5px;background:#fff;color:#24446c;font:inherit;font-size:12px}.simulation-point-buttons{display:flex;gap:6px}.simulation-point-buttons button{padding:5px 7px;border:1px solid #c2d6f3;border-radius:5px;background:#edf5ff;color:#3265a6;font:inherit;font-size:11px;cursor:pointer}.simulation-point-buttons button:last-child{background:#fff;color:#6e7c8d}.simulation-point-editor small{color:#8a98ab;font-size:10px;line-height:1.5}.simulation-point-error{margin:0;max-width:240px;color:#bb4854;font-weight:400;font-size:11px;line-height:1.5}.simulation-point-value button:disabled{opacity:.5;cursor:wait}
</style>
