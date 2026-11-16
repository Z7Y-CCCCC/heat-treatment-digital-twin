<script setup>
import { ref, computed, nextTick, onUnmounted, watch } from 'vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch, canAdminPage } from '../../../runtime/adminSession.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import ModelActionPicker from './ModelActionPicker.vue'
import AssetTransferIcon from './AssetTransferIcon.vue'
import { MAX_PACKAGE_SELECTION, runPackageQueue } from '../utils/modelPackageSelection.js'
import { ASSET_MODULES, assetActionChoices, checkedActionChoices, uniqueActions, updateOptionsFor, importReady, toggleAssetAction, assetUpdateSummary } from '../utils/modelAssetTransfer.js'
const props = defineProps({ models: { type: Array, default: () => [] }, selectedId: { type: String, default: '' }, dirty: Boolean, disabled: Boolean })
const emit = defineEmits(['imported', 'raw-file', 'busy-change'])
const fileInput = ref(null), updateFileInput = ref(null), dialog = ref(null), operation = ref('import')
const rows = ref([]), busy = ref(false), error = ref(''), message = ref(''), exportIds = ref([])
const updateModules = ref(['actions']), updateActionIds = ref(null), replaceActionIds = ref([]), updateTargetId = ref(''), batchGuard = ref('')
const exportMode = ref('full'), exportActionIds = ref([]), versions = ref([]), selectedVersion = ref(''), historyRevision = ref('')
const selected = computed(() => props.models.find(model => model.id === props.selectedId))
const canEdit = computed(() => canAdminPage('models', 'edit'))
const blocked = computed(() => busy.value || props.disabled || props.dirty)
const titles = { import: '导入模型资产', export: '导出模型资产', update: '补充更新模型资产', history: '模型资产版本' }
const currentOptions = computed(() => updateOptionsFor(updateTargetId.value, updateModules.value, updateActionIds.value, replaceActionIds.value))
const readyImports = computed(() => batchGuard.value ? [] : rows.value.filter(row => importReady(row, operation.value === 'update', currentOptions.value)))
const updateActions = computed(() => rows.value[0]?.actionChoices || checkedActionChoices(rows.value[0]?.checked))
const exportActions = computed(() => exportIds.value.length === 1 ? assetActionChoices(props.models.find(model => model.id === exportIds.value[0])) : [])
const targetVersion = computed(() => versions.value.find(version => (version.versionId || version.id) === selectedVersion.value))
const updateTarget = computed(() => props.models.find(model => model.id === updateTargetId.value))
let disposed = false, controller, batchScope = '', focusBeforeDialog
watch([exportIds, exportMode], () => { exportActionIds.value = [] }, { deep: true })
onUnmounted(() => { disposed = true; controller?.abort(); emit('busy-change', false) })
function buttonTitle(title) { return props.dirty ? '请先保存当前修改' : title }
function assertScope() { if (getFactoryScope() !== batchScope) throw Error('工厂已切换，请重新打开') }
function headers(json = false) { return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(batchScope ? { 'X-Factory-ID': batchScope } : {}) } }
async function openDialog(mode) {
  if (blocked.value || (['import','update'].includes(mode) && !canEdit.value)) return false
  if (['update','history'].includes(mode) && !selected.value) return false
  operation.value = mode; rows.value = []; error.value = ''; message.value = ''; batchGuard.value = ''; batchScope = getFactoryScope()
  updateModules.value = ['actions']; updateActionIds.value = null; replaceActionIds.value = []; updateTargetId.value = props.selectedId
  exportMode.value = 'full'; exportActionIds.value = []; versions.value = []; selectedVersion.value = ''; historyRevision.value = ''
  if (mode === 'export') exportIds.value = selected.value ? [props.selectedId] : []
  focusBeforeDialog = typeof document !== 'undefined' ? document.activeElement : null
  emit('busy-change', true)
  await nextTick(); if (!disposed) dialog.value?.showModal()
  if (mode === 'history') await loadHistory()
  return true
}
function closeDialog() {
  if (busy.value) return
  dialog.value?.close(); rows.value = []; emit('busy-change', false); focusBeforeDialog?.focus?.()
}
function chooseUpdateFile() { if (!blocked.value && canEdit.value && selected.value) updateFileInput.value?.click() }
async function request(kind, row, detectOnly = false) {
  assertScope(); controller = new AbortController()
  const form = new FormData(); form.append('file', row.file)
  if (operation.value === 'update' && !detectOnly) form.append('updateOptions', JSON.stringify(currentOptions.value))
  if (kind === 'import') {
    form.append('inspectedSha256', row.checked.inspectedSha256)
    if (operation.value === 'update') form.append('updatePlan', JSON.stringify(row.checked.updatePlan))
    else form.append('importPlan', JSON.stringify(row.checked.isCollection ? row.checked.models.map(item => item.importDecision) : row.checked.importDecision))
  }
  const response = await adminFetch(`${API_BASE}/models/asset-${kind}`, { method:'POST', headers:{ ...headers(), ...(kind === 'import' ? { 'X-Asset-Request-ID':row.requestId } : {}) }, body:form, signal:controller.signal })
  const data = await response.json(); assertScope()
  if (!response.ok || !data.success) {
    if (['IMPORT_PLAN_STALE','IMPORT_CONFIRMATION_REQUIRED','IMPORT_TARGET_AMBIGUOUS'].includes(data.code)) row.checked = null
    throw Error(data.error || '资产处理失败')
  }
  return data
}
async function choose(event, updating = false) {
  const files = [...(event.target.files || [])]; event.target.value = ''
  if (!files.length || blocked.value || !canEdit.value) return
  const rawFiles = files.filter(file => /\.(glb|gltf)$/i.test(file.name))
  if (!updating && files.length === 1 && rawFiles.length) { emit('raw-file',files[0]); return }
  if (!await openDialog(updating ? 'update' : 'import')) return
  if (rawFiles.length) { error.value = updating ? '更新模型请使用资产包' : '模型文件请单独导入'; return }
  if (files.length > (updating ? 1 : MAX_PACKAGE_SELECTION)) { error.value = updating ? '每次补充一个模型' : `一次最多 ${MAX_PACKAGE_SELECTION} 个文件`; return }
  rows.value = files.map((file,index) => ({ id:index, requestId:crypto.randomUUID(), file, name:file.name, status:'waiting', error:'', checked:null, inspectedOptions:'' }))
  busy.value = true
  try { await runPackageQueue(rows.value,async row => {
    row.status = 'checking'
    try {
      const preview = await request('inspect',row,true)
      row.preview = preview
      const legacyUpdate = preview.importDecision?.kind === 'update_actions'
      if (preview.isCollection && (operation.value === 'update' || preview.models?.some(item => item.importDecision?.kind === 'update_actions')) || rows.value.length > 1 && (legacyUpdate || preview.supplement)) {
        batchGuard.value = '已有模型请单独补充更新'; throw Error(batchGuard.value)
      }
      if (operation.value === 'import' && (legacyUpdate || preview.supplement)) {
        operation.value = 'update'
        updateTargetId.value = legacyUpdate ? preview.importDecision.targetId : props.selectedId
        updateModules.value = preview.supplement?.modules?.includes('actions') === false ? preview.supplement.modules.filter(id => id === 'inspection') : ['actions']
      }
      if (operation.value === 'update' && preview.supplement?.modules?.includes('actions') === false) updateModules.value = preview.supplement.modules.filter(id => id === 'inspection')
      const options = JSON.stringify(currentOptions.value)
      const data = operation.value === 'update' && updateTargetId.value && updateModules.value.length ? await request('inspect',row) : preview
      if (!disposed) { row.checked = data; row.actionChoices = checkedActionChoices(data); row.inspectedOptions = options; row.status = 'ready' }
    }
    catch (cause) { if (!disposed) { row.status = 'error'; row.error = cause.message }; throw cause }
  },{stopped:() => disposed}) } finally { if (!disposed) busy.value = false }
}
async function importAssets() {
  if (blocked.value || !canEdit.value || !readyImports.value.length) return
  busy.value = true; message.value = ''; const imported = []
  try {
    await runPackageQueue(rows.value,async row => {
      row.status = 'importing'; row.error = ''
      try { const result = await request('import',row); if (!disposed) { row.status = 'imported'; row.outcomes = result.outcomes || [{outcome:result.outcome || (result.reused ? 'reuse' : 'create')}]; imported.push(...(result.models || [result.model]).filter(Boolean)) } }
      catch (cause) { if (!disposed) { row.status = 'error'; row.error = cause.message }; throw cause }
    },{eligible:row => importReady(row,operation.value === 'update',currentOptions.value),stopped:() => disposed})
    if (!disposed) {
      if (imported.length) emit('imported',imported.at(-1))
      const effects = rows.value.filter(row => row.status === 'imported').flatMap(row => row.outcomes || []), failed = rows.value.filter(row => row.status === 'error').length
      message.value = operation.value === 'update' ? (imported.length ? '更新已保存' : '') : `新建 ${effects.filter(item => item.outcome === 'create').length} · 复用 ${effects.filter(item => item.outcome === 'reuse').length} · 更新 ${effects.filter(item => ['update_actions','update'].includes(item.outcome)).length}`
      if (failed) message.value = `${message.value}${message.value ? ' · ' : ''}${failed} 项失败`
    }
  } finally { if (!disposed) busy.value = false }
}
async function recheck(row) {
  if (busy.value || props.disabled || props.dirty) return
  busy.value = true; row.status = 'checking'; row.error = ''; row.inspectedOptions = ''; message.value = ''
  try { const options = JSON.stringify(currentOptions.value), data = await request('inspect',row); if (!disposed) { row.checked = data; row.actionChoices = uniqueActions([...(row.actionChoices || []), ...checkedActionChoices(data)]); row.inspectedOptions = options; row.requestId = crypto.randomUUID(); row.status = 'ready' } }
  catch (cause) { if (!disposed) { row.checked = null; row.status = 'error'; row.error = cause.message } }
  finally { if (!disposed) busy.value = false }
}
async function recheckUpdate() { if (rows.value[0]) await recheck(rows.value[0]) }
async function toggleUpdateAction(action,checked) { updateActionIds.value = toggleAssetAction(updateActionIds.value,action.id,checked,updateActions.value.map(item => item.id)); await recheckUpdate() }
async function toggleReplacement(id,checked) { replaceActionIds.value = toggleAssetAction(replaceActionIds.value,id,checked,[]); await recheckUpdate() }
function isActionSelected(id) { return updateActionIds.value === null || updateActionIds.value.includes(id) }
function needsReplacement(row,id) { return row.checked?.updatePlan?.conflicts?.some(conflict => (typeof conflict === 'string' ? conflict : conflict.id) === id) || replaceActionIds.value.includes(id) }
async function exportAssets() {
  if (blocked.value || !exportIds.value.length) return
  if (exportMode.value !== 'full' && exportIds.value.length !== 1) { error.value = '补充包请选择一个模型'; return }
  rows.value = [...new Set(exportIds.value)].map(id => ({id,name:props.models.find(model => model.id === id)?.name || id,status:'waiting',error:''}))
  busy.value = true; error.value = ''; message.value = ''
  try {
    assertScope(); controller = new AbortController()
    if (rows.value.some(row => !props.models.some(model => model.id === row.id))) throw Error('模型已不存在，请重新选择')
    rows.value.forEach(row => { row.status = 'exporting' })
    const multiple = rows.value.length > 1, partial = exportMode.value !== 'full', post = multiple || partial
    const response = await adminFetch(post ? `${API_BASE}/models/asset-export` : `${API_BASE}/models/${encodeURIComponent(rows.value[0].id)}/asset-export`,{
      method:post ? 'POST' : 'GET',signal:controller.signal,headers:headers(post),
      ...(post ? {body:JSON.stringify({modelIds:rows.value.map(row => row.id),...(partial ? {modules:exportMode.value === 'actions' ? ['actions'] : ['inspection'],...(exportMode.value === 'actions' && exportActionIds.value.length ? {actionIds:exportActionIds.value} : {})} : {})})} : {})
    })
    if (!response.ok) throw Error((await response.json()).error || '导出失败')
    const blob = await response.blob(); if (disposed) return
    assertScope()
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = multiple ? '模型资产合集.zip' : `${partial ? 'model-supplement' : 'model-asset'}-${rows.value[0].id}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000)
    rows.value.forEach(row => { row.status = 'exported' }); message.value = `已导出 ${rows.value.length} 个模型`
  } catch (cause) { if (!disposed) { rows.value.forEach(row => { row.status = 'error' }); error.value = cause.message } }
  finally { if (!disposed) busy.value = false }
}
async function loadHistory() {
  busy.value = true; error.value = ''; versions.value = []; selectedVersion.value = ''
  try {
    assertScope(); controller = new AbortController()
    const response = await adminFetch(`${API_BASE}/models/${encodeURIComponent(props.selectedId)}/asset-history`,{headers:headers(),signal:controller.signal})
    const data = await response.json(); assertScope()
    if (!response.ok || !data.success) throw Error(data.error || '版本读取失败')
    if (!disposed) { versions.value = data.versions || []; historyRevision.value = data.revision }
  } catch (cause) { if (!disposed) error.value = cause.message }
  finally { if (!disposed) busy.value = false }
}
async function restoreVersion() {
  if (blocked.value || !canEdit.value || !targetVersion.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    assertScope(); controller = new AbortController()
    const response = await adminFetch(`${API_BASE}/models/${encodeURIComponent(props.selectedId)}/asset-history/${encodeURIComponent(selectedVersion.value)}/restore`,{method:'POST',headers:headers(true),body:JSON.stringify({revision:historyRevision.value}),signal:controller.signal})
    const data = await response.json(); assertScope()
    if (!response.ok || !data.success) throw Error(data.error || '版本回退失败')
    if (!disposed) { emit('imported',data.model); message.value = '版本已恢复'; selectedVersion.value = '' }
  } catch (cause) { if (!disposed) { error.value = cause.message; selectedVersion.value = '' } }
  finally { if (!disposed) busy.value = false }
}
function historyDate(value) { return value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '' }
function effectLabel(item) {
  const plan = item?.importDecision
  if (!plan) return ''
  if (plan.kind === 'reuse') return `复用「${plan.targetName}」`
  if (plan.kind === 'update_actions') return `更新「${plan.targetName}」 · ${plan.bindingCount} 项${plan.shared ? ' · 共享模型' : ''}`
  return '新建模型'
}
</script>
<template>
  <div class="motion-package-actions" role="group" aria-label="模型资产工具" data-testid="model-asset-transfer">
    <button type="button" class="asset-icon-button asset-import-button" aria-label="导入模型资产" :title="buttonTitle('导入模型资产')" :disabled="blocked || !canEdit" @click="fileInput?.click()"><AssetTransferIcon name="import" /></button>
    <button type="button" class="asset-icon-button" aria-label="导出模型资产" :title="buttonTitle('导出模型资产')" :disabled="blocked || !models.length" @click="openDialog('export')"><AssetTransferIcon name="export" /></button>
    <span class="asset-tool-divider" aria-hidden="true"></span>
    <button type="button" class="asset-icon-button" aria-label="补充更新模型资产" :title="buttonTitle('补充更新模型资产')" :disabled="blocked || !canEdit || !selected" @click="chooseUpdateFile"><AssetTransferIcon name="update" /></button>
    <button type="button" class="asset-icon-button" aria-label="模型资产版本" :title="buttonTitle('模型资产版本')" :disabled="blocked || !selected" @click="openDialog('history')"><AssetTransferIcon name="history" /></button>
    <input ref="fileInput" type="file" accept=".zip,.glb,.gltf" multiple aria-label="选择模型资产文件" hidden :disabled="blocked || !canEdit" @change="choose($event)" />
    <input ref="updateFileInput" type="file" accept=".zip" aria-label="选择补充资产包" hidden :disabled="blocked || !canEdit || !selected" @change="choose($event,true)" />
  </div>
  <Teleport to="body">
    <dialog ref="dialog" class="motion-package-dialog" :aria-label="titles[operation]" data-testid="model-asset-transfer-dialog" @cancel.prevent="closeDialog">
      <header><span class="asset-dialog-mark"><AssetTransferIcon :name="operation" /></span><div><h3>{{ titles[operation] }}</h3><small v-if="operation==='update'||operation==='history'">{{ operation==='update'?updateTarget?.name:selected?.name }}</small></div><button type="button" class="asset-icon-button dialog-close" aria-label="关闭模型资产弹窗" title="关闭" :disabled="busy" @click="closeDialog"><AssetTransferIcon name="close" /></button></header>
      <div class="package-dialog-body">
        <template v-if="operation==='export'&&!message">
          <div class="package-model-field"><ModelActionPicker v-model="exportIds" :models="models" :disabled="busy" /></div>
          <fieldset class="asset-module-options"><legend>导出范围</legend><label v-for="mode in [{id:'full',label:'完整资产'},{id:'actions',label:'仅动作'},{id:'inspection',label:'仅拆解布局'}]" :key="mode.id" :class="{active:exportMode===mode.id}"><input v-model="exportMode" type="radio" name="asset-export-mode" :value="mode.id" :disabled="busy||(mode.id!=='full'&&exportIds.length!==1)" />{{ mode.label }}</label></fieldset>
          <fieldset v-if="exportMode==='actions'&&exportActions.length" class="asset-action-choices"><legend>动作 <small>不选则导出全部</small></legend><label v-for="action in exportActions" :key="action.id"><input v-model="exportActionIds" type="checkbox" :value="action.id" :disabled="busy" :aria-label="`导出动作 ${action.label}`" :data-export-action-id="action.id" /><span>{{ action.label }}</span></label></fieldset>
        </template>
        <template v-if="operation==='update'&&!message">
          <label class="asset-target-field"><span>目标模型</span><select v-model="updateTargetId" class="input input-sm" aria-label="补充目标模型" :disabled="busy" @change="recheckUpdate"><option value="" disabled>选择模型</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option></select></label>
          <fieldset class="asset-module-options"><legend>更新范围</legend><label v-for="module in ASSET_MODULES" :key="module.id" :class="{active:updateModules.includes(module.id)}"><input v-model="updateModules" type="checkbox" :value="module.id" :disabled="busy||(module.id==='inspection'&&!canAdminPage('disassembly-layout','edit'))" @change="recheckUpdate" />{{ module.label }}</label></fieldset>
        </template>
        <ul v-if="rows.length" class="package-file-list" aria-label="模型资产处理结果"><li v-for="row in rows" :key="row.id" :data-status="row.status">
          <div class="package-file-heading"><AssetTransferIcon name="file" class="asset-file-mark" /><strong>{{ row.checked?.model?.name||row.name }}</strong><span class="asset-status">{{ {waiting:'等待',checking:'检查中',ready:'已检查',importing:'导入中',imported:'完成',exporting:'导出中',exported:'完成',error:'失败'}[row.status] }}</span></div>
          <template v-if="operation==='update'&&row.checked?.updatePlan">
            <div class="asset-update-summary"><span>{{ assetUpdateSummary(row.checked.updatePlan) }}</span><small :title="row.checked.updatePlan.shared?'共享模型影响所有引用它的工厂，设备专属配置保留':'所有引用该模型的设备使用更新后的默认资产'">{{ row.checked.updatePlan.shared?'共享 · ':'' }}{{ row.checked.updatePlan.affectedDeviceCount||0 }} 台设备</small></div>
            <fieldset v-if="updateModules.includes('actions')&&updateActions.length" class="asset-action-choices"><legend>动作</legend><div v-for="action in updateActions" :key="action.id" class="asset-action-row"><label><input type="checkbox" :checked="isActionSelected(action.id)" :disabled="busy" :aria-label="`导入动作 ${action.label}`" :data-action-id="action.id" @change="toggleUpdateAction(action,$event.target.checked)" /><span>{{ action.label }}</span><small>{{ action.kind==='add'?'新增':action.kind==='same'?'一致':'更新' }}</small></label><label v-if="needsReplacement(row,action.id)" class="asset-replace-choice"><input type="checkbox" :checked="replaceActionIds.includes(action.id)" :disabled="busy||!isActionSelected(action.id)" :aria-label="`替换动作 ${action.label}`" :data-replace-action-id="action.id" @change="toggleReplacement(action.id,$event.target.checked)" />替换</label></div></fieldset>
            <p v-if="row.checked.updatePlan.conflicts?.length" class="asset-conflict" role="status">同名动作需勾选替换</p>
          </template>
          <template v-else-if="operation==='import'&&row.checked">
            <p v-if="!row.checked.isCollection" class="package-import-decision">{{ effectLabel(row.checked) }}</p>
            <div v-if="row.checked.actions?.length" class="asset-action-tags"><span v-for="action in row.checked.actions" :key="action.id">{{ action.label }}</span></div>
            <details v-if="row.checked.isCollection" class="collection-models" :open="rows.length===1"><summary>{{ row.checked.models.length }} 个模型</summary><ul><li v-for="item in row.checked.models" :key="item.model.id"><strong>{{ item.model.name }}</strong><small>{{ effectLabel(item) }}</small></li></ul></details>
          </template>
          <p v-if="row.error" role="alert">{{ row.error }}</p><button v-if="['import','update'].includes(operation)&&row.status==='error'&&!row.checked" type="button" class="asset-icon-button asset-recheck" aria-label="重新检查模型资产" title="重新检查" :disabled="busy" @click="recheck(row)"><AssetTransferIcon name="refresh" /></button>
        </li></ul>
        <template v-if="operation==='history'&&!message">
          <div v-if="busy" class="asset-empty-state" role="status">读取中…</div>
          <div v-else-if="!versions.length&&!error" class="asset-empty-state"><AssetTransferIcon name="history" /><span>暂无历史版本</span></div>
          <ul v-else class="asset-version-list" aria-label="模型资产历史版本"><li v-for="version in versions" :key="version.versionId||version.id" :data-version-id="version.versionId||version.id"><label :class="{selected:selectedVersion===(version.versionId||version.id)}"><input v-model="selectedVersion" type="radio" name="asset-history-version" :value="version.versionId||version.id" :disabled="busy||!canEdit" :aria-label="`选择版本 ${version.label||version.summary||historyDate(version.createdAt)}`" /><span><strong>{{ version.label||version.summary||'资产更新' }}</strong><small>{{ historyDate(version.createdAt) }}</small></span><i>{{ (version.modules||[]).map(id=>ASSET_MODULES.find(module=>module.id===id)?.label||id).join(' · ') }}</i></label><button class="asset-icon-button asset-version-restore" type="button" :aria-label="`恢复版本 ${version.versionId||version.id}`" title="恢复此版本" :disabled="busy||!canEdit" @click="selectedVersion=version.versionId||version.id"><AssetTransferIcon name="history" /></button></li></ul>
          <div v-if="targetVersion" class="asset-restore-confirm" role="status">恢复所选资产版本，现场绑定保持不变。</div>
        </template>
        <div v-if="operation==='update'&&!message&&rows[0]?.checked" class="asset-preserve-note"><AssetTransferIcon name="shield" />未选择内容与现场绑定保持不变</div>
        <p v-if="error" role="alert">{{ error }}</p><p v-if="message" class="asset-result" role="status"><AssetTransferIcon name="check" />{{ message }}</p>
      </div>
      <footer>
        <button v-if="operation==='history'&&error" type="button" class="asset-icon-button" aria-label="重新读取资产版本" title="重新读取" :disabled="busy" @click="loadHistory"><AssetTransferIcon name="refresh" /></button>
        <button type="button" class="asset-icon-button" :aria-label="message?'完成模型资产操作':'取消模型资产操作'" :title="message?'完成':'取消'" :disabled="busy" @click="closeDialog"><AssetTransferIcon :name="message?'check':'close'" /></button>
        <button v-if="['import','update'].includes(operation)&&rows.some(row=>row.status!=='imported')" class="asset-icon-button primary" type="button" :aria-label="operation==='update'?'确认补充更新':'确认导入模型资产'" :title="operation==='update'?'确认更新':'确认导入'" :disabled="blocked||!canEdit||!readyImports.length" @click="importAssets"><AssetTransferIcon name="check" /></button>
        <button v-if="operation==='export'&&!message" class="asset-icon-button primary" type="button" aria-label="确认导出模型资产" title="确认导出" :disabled="blocked||!exportIds.length" @click="exportAssets"><AssetTransferIcon name="export" /></button>
        <button v-if="operation==='history'&&!message" class="asset-icon-button primary" type="button" aria-label="确认回退版本" title="恢复所选版本" :disabled="blocked||!canEdit||!targetVersion" @click="restoreVersion"><AssetTransferIcon name="history" /></button>
      </footer>
    </dialog>
  </Teleport>
</template>
<style scoped src="../styles/form-controls.css"></style>
<style scoped src="../styles/model-asset-transfer.css"></style>
