<script setup>
import { ref, computed, nextTick, onUnmounted } from 'vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch, canAdminPage } from '../../../runtime/adminSession.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import ModelActionPicker from './ModelActionPicker.vue'
import { MAX_PACKAGE_SELECTION, runPackageQueue } from '../utils/modelPackageSelection.js'
const props = defineProps({ models: { type: Array, default: () => [] }, selectedId: { type: String, default: '' } })
const emit = defineEmits(['imported'])
const fileInput = ref(null), rows = ref([]), busy = ref(false), error = ref(''), message = ref(''), exportIds = ref([])
const dialog = ref(null), operation = ref('import')
const readyImports = computed(() => rows.value.filter(row => row.checked && row.status !== 'imported'))
let disposed = false, controller, batchScope = ''
onUnmounted(() => { disposed = true; controller?.abort() })
async function openDialog(mode) {
  operation.value = mode; rows.value = []; error.value = ''; message.value = ''; batchScope = getFactoryScope()
  if (mode === 'export') exportIds.value = props.models.some(m => m.id === props.selectedId) ? [props.selectedId] : []
  await nextTick(); if (!disposed) dialog.value?.showModal()
}
function closeDialog() {
  if (busy.value) return
  dialog.value?.close(); rows.value = []
}
function assertScope() { if (getFactoryScope() !== batchScope) throw Error('工厂已切换，请关闭并重新选择文件') }
async function request(operation, row) {
  assertScope(); controller = new AbortController()
  const form = new FormData(); form.append('file', row.file)
  if (operation === 'import') form.append('inspectedSha256', row.checked.inspectedSha256)
  const response = await adminFetch(`${API_BASE}/models/asset-${operation}`, { method: 'POST', headers: { ...(batchScope ? { 'X-Factory-ID': batchScope } : {}), ...(operation === 'import' ? { 'X-Asset-Request-ID': row.requestId } : {}) }, body: form, signal: controller.signal })
  const data = await response.json()
  if (!response.ok || !data.success) throw Error(data.error || '动作包处理失败')
  return data
}
async function choose(event) {
  const files = [...(event.target.files || [])]; event.target.value = ''
  if (!files.length) return
  await openDialog('import')
  if (files.length > MAX_PACKAGE_SELECTION) { error.value = `一次最多导入 ${MAX_PACKAGE_SELECTION} 个文件`; return }
  rows.value = files.map((file, index) => ({ id: index, requestId: crypto.randomUUID(), file, name: file.name, status: 'waiting', error: '', checked: null }))
  busy.value = true
  try {
    await runPackageQueue(rows.value, async row => {
      row.status = 'checking'
      try { const data = await request('inspect', row); if (!disposed) { row.checked = data; row.status = 'ready' } }
      catch (cause) { if (!disposed) { row.status = 'error'; row.error = cause.message }; throw cause }
    }, { stopped: () => disposed })
  } finally { if (!disposed) busy.value = false }
}
async function importAssets() {
  if (busy.value || !canAdminPage('models', 'edit') || !readyImports.value.length) return
  busy.value = true; message.value = ''; const imported = []
  try {
    await runPackageQueue(rows.value, async row => {
      row.status = 'importing'; row.error = ''
      try { const result = await request('import', row); if (!disposed) { row.status = 'imported'; imported.push(...(result.models || [result.model])) } }
      catch (cause) { if (!disposed) { row.status = 'error'; row.error = cause.message }; throw cause }
    }, { eligible: row => row.checked && row.status !== 'imported', stopped: () => disposed })
    if (!disposed) {
      if (imported.length) emit('imported', imported.at(-1))
      const doneRows = rows.value.filter(r => r.status === 'imported'), done = doneRows.reduce((n, row) => n + (row.checked.models?.length || 1), 0), failed = rows.value.filter(r => r.status === 'error').length
      message.value = rows.value.length === 1 && done === 1 ? '动作包已导入' : `已导入 ${done} 个${failed ? `，失败 ${failed} 个` : ''}`
    }
  } finally { if (!disposed) busy.value = false }
}
async function exportAssets() {
  if (busy.value || !exportIds.value.length) return
  rows.value = [...new Set(exportIds.value)].map(id => ({ id, name: props.models.find(m => m.id === id)?.name || id, status: 'waiting', error: '' }))
  busy.value = true; error.value = ''; message.value = ''
  try {
    assertScope(); controller = new AbortController()
    if (rows.value.some(row => !props.models.some(m => m.id === row.id))) throw Error('模型已不存在，请重新选择')
    rows.value.forEach(row => { row.status = 'exporting' })
    const multiple = rows.value.length > 1
    const response = await adminFetch(multiple ? `${API_BASE}/models/asset-export` : `${API_BASE}/models/${encodeURIComponent(rows.value[0].id)}/asset-export`, {
      method: multiple ? 'POST' : 'GET', signal: controller.signal,
      headers: { ...(multiple ? { 'Content-Type': 'application/json' } : {}), ...(batchScope ? { 'X-Factory-ID': batchScope } : {}) },
      ...(multiple ? { body: JSON.stringify({ modelIds: rows.value.map(row => row.id) }) } : {})
    })
    if (!response.ok) throw Error((await response.json()).error || '导出失败')
    const blob = await response.blob(); if (disposed) return
    assertScope()
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = multiple ? '动作包合集.zip' : `model-asset-${rows.value[0].id}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    rows.value.forEach(row => { row.status = 'exported' })
    message.value = multiple ? `已导出 ${rows.value.length} 个模型（1 个动作包）` : '动作包已导出'
  } catch (cause) {
    if (!disposed) { rows.value.forEach(row => { row.status = 'error' }); error.value = cause.message }
  } finally { if (!disposed) busy.value = false }
}
const statuses = { waiting: '等待', checking: '读取中…', ready: '可导入', importing: '导入中…', imported: '已导入', exporting: '导出中…', exported: '已导出', error: '失败' }
</script>
<template>
  <div class="motion-package-actions" role="group" aria-label="动作包导入导出">
    <button type="button" class="btn btn-sm" :disabled="busy || !canAdminPage('models', 'edit')" @click="fileInput?.click()">导入动作包</button>
    <input ref="fileInput" type="file" accept=".zip" multiple aria-label="选择模型动作资产 ZIP" hidden :disabled="busy" @change="choose" />
    <button type="button" class="btn btn-sm" :disabled="busy || !models.length" @click="openDialog('export')">导出动作包</button>
  </div>
  <Teleport to="body">
    <dialog ref="dialog" class="motion-package-dialog" :aria-label="operation === 'import' ? '导入动作包' : '导出动作包'" @cancel.prevent="closeDialog">
      <header><h3>{{ operation === 'import' ? '导入动作包' : '导出动作包' }}</h3><button type="button" class="dialog-close" aria-label="关闭动作包弹窗" :disabled="busy" @click="closeDialog">×</button></header>
      <div class="package-dialog-body">
        <div v-if="operation === 'export' && !message" class="package-model-field"><span>模型</span><ModelActionPicker v-model="exportIds" :models="models" :disabled="busy" /></div>
        <ul v-if="rows.length" class="package-file-list" aria-label="动作包处理结果"><li v-for="row in rows" :key="row.id" :data-status="row.status"><div><strong>{{ row.checked?.model?.name || row.name }}</strong><small v-if="row.checked">{{ row.checked.isCollection ? `${row.checked.models.length} 个模型` : `${row.checked.actions.length} 个动作` }}</small><span>{{ statuses[row.status] }}</span></div><p v-if="row.checked?.actions?.length" class="package-action-names">{{ row.checked.actions.map(a=>a.label).join('、') }}</p>
          <details v-if="row.checked?.isCollection" class="collection-models" :open="rows.length === 1"><summary>包内模型</summary><ul><li v-for="item in row.checked.models" :key="item.model.id"><div><strong>{{ item.model.name }}</strong><small>{{ item.actions.length }} 个动作</small></div><p v-if="item.actions.length" class="package-action-names">{{ item.actions.map(a=>a.label).join('、') }}</p></li></ul></details>
          <p v-if="row.error" role="alert">{{ row.error }}</p></li></ul>
        <p v-if="operation === 'import' && readyImports.length" class="import-effect">导入为新模型，保留现有模型与设备绑定。</p>
        <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
      </div>
      <footer>
        <button type="button" class="btn" :disabled="busy" @click="closeDialog">{{ message ? '完成' : '取消' }}</button>
        <button v-if="operation === 'import' && readyImports.length" class="btn btn-primary" type="button" :disabled="busy || !canAdminPage('models', 'edit')" @click="importAssets">{{ message ? '重试未完成项' : '确认导入' }}</button>
        <button v-if="operation === 'export' && !message" class="btn btn-primary" type="button" :disabled="busy || !exportIds.length" @click="exportAssets">确认导出{{ exportIds.length ? `（${exportIds.length}）` : '' }}</button>
      </footer>
    </dialog>
  </Teleport>
</template>
<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.motion-package-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-left: auto; }
.motion-package-actions button { white-space: nowrap; min-height: 34px; }
.motion-package-dialog { position: fixed; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); margin: auto; padding: 0; overflow: auto; border: 1px solid #dce3ec; border-radius: 14px; background: #fff; box-shadow: 0 20px 70px #17203335; color: #344054; font: calc(13px * var(--admin-font-scale, 1)) 'Inter Variable', 'Noto Sans SC Variable', sans-serif; }
.motion-package-dialog::backdrop { background: #17203355; }
.motion-package-dialog header { position: relative; padding: 20px 44px 16px 22px; border-bottom: 1px solid #edf0f5; }
.motion-package-dialog h3 { margin: 0; font-size: calc(16px * var(--admin-font-scale, 1)); }
.dialog-close { position: absolute; top: 5px; right: 5px; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #73829a; font-family: inherit; font-size: calc(20px * var(--admin-font-scale, 1)); cursor: pointer; }
.dialog-close:hover:not(:disabled) { color: #2457a6; }
.dialog-close:disabled { opacity: .5; cursor: wait; }
.package-dialog-body { padding: 20px 22px; line-height: 1.6; }
.package-dialog-body label { display: grid; gap: 8px; }
.package-dialog-body select { width: 100%; min-width: 0; }
.package-dialog-body p { margin: 8px 0 0; overflow-wrap: anywhere; }
.package-summary > span { margin-left: 10px; color: #7b8ca3; }
.package-summary .import-effect { color: #7b8ca3; font-size: calc(12px * var(--admin-font-scale, 1)); }
.motion-package-dialog footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 22px; border-top: 1px solid #edf0f5; }
[role=alert] { color: #b42318; }
.package-model-field{display:grid;gap:8px}.package-file-list{list-style:none;margin:0;padding:0;max-height:300px;overflow:auto}.package-file-list li{padding:10px 0;border-bottom:1px solid #edf0f5}.package-file-list li>div{display:flex;align-items:center;gap:8px}.package-file-list strong{flex:1;min-width:0;overflow-wrap:anywhere}.package-file-list small,.package-action-names,.import-effect{color:#7b8ca3;font-size:calc(12px * var(--admin-font-scale, 1))}.package-file-list li[data-status=imported] span,.package-file-list li[data-status=exported] span{color:#16815b}.package-file-list li[data-status=error] span{color:#b42318}
.collection-models{margin-top:8px}.collection-models summary{cursor:pointer;color:#506580}.collection-models ul{list-style:none;padding:0 0 0 12px;margin:4px 0;border-left:2px solid #e4ebf4}.collection-models li:last-child{border-bottom:0}
</style>
