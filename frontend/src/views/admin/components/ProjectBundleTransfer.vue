<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { onUnmounted, ref, watch } from 'vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch } from '../../../runtime/adminSession.js'
import { getFactoryScope, FACTORY_DIRECTORY_CHANGE_EVENT } from '../../../runtime/factoryScope.js'

const emit = defineEmits(['imported'])
const props = defineProps({ factories: { type: Array, default: () => [] } })
const exportFactoryId = ref(getFactoryScope())
watch(() => props.factories, factories => {
  if (factories.length && !factories.some(factory => factory.id === exportFactoryId.value)) exportFactoryId.value = factories[0].id
}, { immediate: true })
const busy = ref(''), error = ref(''), message = ref('')
const selectedFile = ref(null), inspection = ref(null), inspectedSha256 = ref(''), newName = ref('')
const applySharedAppearance = ref(false)
const fileInput = ref(null)
const labels = { workshops: '车间', lines: '产线', devices: '设备', data_points: '点位', models: '模型', projects: '项目', scenes: '场景', widgets: '组件', releases: '发布版本' }
let controller
let generation = 0
onUnmounted(() => { generation++; controller?.abort() })
function chooseFile(event) {
  generation++; controller?.abort(); busy.value = ''
  selectedFile.value = event.target.files?.[0] || null
  event.target.value = ''
  inspection.value = null; inspectedSha256.value = ''; newName.value = ''; error.value = ''; message.value = ''
  applySharedAppearance.value = false
}
async function request(operation) {
  if (busy.value) return
  if (operation !== 'export' && !selectedFile.value) { error.value = '请先选择项目迁移 ZIP'; return }
  if (operation === 'import' && (!inspectedSha256.value || !newName.value.trim())) { error.value = '请先校验文件并填写新工厂名称'; return }
  busy.value = operation; error.value = ''; message.value = ''
  const current = ++generation
  controller = new AbortController()
  try {
    const form = new FormData()
    if (selectedFile.value) form.append('file', selectedFile.value)
    if (operation === 'import') { form.append('name', newName.value.trim()); form.append('inspectedSha256', inspectedSha256.value); form.append('applySharedAppearance', String(applySharedAppearance.value)) }
    const response = await adminFetch(`${API_BASE}/project-bundles/${operation}`, {
      method: operation === 'export' ? 'GET' : 'POST',
      ...(operation === 'export' ? {} : { body: form }),
      headers: { 'X-Factory-Id': operation === 'export' ? exportFactoryId.value : getFactoryScope() }, signal: controller.signal
    })
    if (current !== generation) return
    if (operation === 'export' && response.ok) {
      const blob = await response.blob()
      if (current !== generation) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = url; link.download = '工厂项目迁移.zip'
      document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      message.value = '项目包已导出（仅含已保存内容）。'
    } else {
      const result = await response.json()
      if (current !== generation) return
      if (!response.ok || result.success !== true) throw new Error(result.error || '项目迁移请求失败')
      if (operation === 'inspect') {
        inspection.value = result.inspection; inspectedSha256.value = result.sha256
        newName.value = `${result.inspection.factoryName}（副本）`
        applySharedAppearance.value = false
      } else {
        message.value = `已创建工厂“${result.name}”。当前编辑工厂未切换；请在“工厂与区域”查看，并重新配置采集连接。`
        inspection.value = null; inspectedSha256.value = ''; selectedFile.value = null
        window.dispatchEvent(new CustomEvent(FACTORY_DIRECTORY_CHANGE_EVENT))
        emit('imported', result)
      }
    }
  } catch (cause) { if (current === generation && cause.name !== 'AbortError') error.value = cause.message || '项目迁移失败' }
  finally { if (current === generation) busy.value = '' }
}
</script>

<template>
  <section class="project-transfer" aria-labelledby="project-transfer-title" :aria-busy="!!busy">
    <header class="transfer-heading">
      <h3 id="project-transfer-title">项目与资产迁移</h3>
      <p>迁移已保存的配置和引用资产，不覆盖现有工厂。</p>
    </header>
    <div class="transfer-grid">
      <section class="transfer-card" aria-labelledby="project-export-title">
        <h4 id="project-export-title">导出项目</h4>
        <label class="transfer-field">来源工厂
          <select v-model="exportFactoryId" class="input" :disabled="!!busy || !factories.length">
            <option v-if="!factories.length" value="">暂无可导出的工厂</option>
            <option v-for="factory in factories" :key="factory.id" :value="factory.id">{{ factory.name }}</option>
          </select>
        </label>
        <button type="button" class="btn btn-primary" :disabled="!!busy || !exportFactoryId || !factories.length" @click="request('export')" v-permission="{ page: 'settings.migration', action: 'edit' }">{{ busy === 'export' ? '正在导出…' : '导出项目包' }}</button>
      </section>
      <section class="transfer-card" aria-labelledby="project-import-title">
        <h4 id="project-import-title">导入项目</h4>
        <div class="transfer-file-row">
          <button type="button" class="btn" :disabled="!!busy" @click="fileInput?.click()" v-permission="{ page: 'settings.migration', action: 'edit' }">选择 ZIP 文件</button>
          <span class="transfer-file-name" :title="selectedFile?.name || ''">{{ selectedFile?.name || '未选择文件' }}</span>
          <input ref="fileInput" hidden type="file" aria-label="选择项目迁移 ZIP" accept=".zip,application/zip" :disabled="!!busy" @change="chooseFile" v-permission="{ page: 'settings.migration', action: 'edit' }" />
        </div>
        <button type="button" class="btn" :disabled="!!busy || !selectedFile" @click="request('inspect')" v-permission="{ page: 'settings.migration', action: 'edit' }">{{ busy === 'inspect' ? '正在校验…' : '校验并预览' }}</button>
        <p class="transfer-note">导入为新工厂；连接凭据需重新配置，采集默认关闭。</p>
      </section>
    </div>
    <section v-if="inspection" class="inspection" aria-label="迁移预检结果">
      <h4>预检结果 · {{ inspection.factoryName }}</h4>
      <dl><template v-for="(label, key) in labels" :key="key"><dt>{{ label }}</dt><dd>{{ inspection.counts?.[key] || 0 }}</dd></template><dt>资产文件</dt><dd>{{ inspection.assetCount }} 个（{{ (inspection.assetBytes / 1024 / 1024).toFixed(1) }} MiB）</dd></dl>
      <details v-if="inspection.warnings?.length"><summary>注意事项（{{ inspection.warnings.length }}）</summary><ul><li v-for="warning in inspection.warnings" :key="warning">{{ warning }}</li></ul></details>
      <label class="transfer-field transfer-name">新工厂名称<input v-model="newName" class="input" maxlength="120" :disabled="!!busy" /></label>
      <label v-if="inspection.sharedAppearance?.available" class="transfer-appearance"><input v-model="applySharedAppearance" type="checkbox" :disabled="!!busy" /> 同时替换集团地图外观和加载画面（影响所有工厂）</label>
      <button type="button" class="btn btn-primary" :disabled="!!busy || !newName.trim()" @click="request('import')" v-permission="{ page: 'settings.migration', action: 'edit' }">{{ busy === 'import' ? '正在导入…' : '创建新工厂并导入' }}</button>
    </section>
    <p v-if="error" role="alert" class="transfer-feedback error">{{ error }}</p>
    <p v-if="message" role="status" class="transfer-feedback">{{ message }}</p>
  </section>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.project-transfer { padding: 24px 0; color: #344054; font-size: calc(13px * var(--admin-font-scale, 1)); }
.transfer-heading h3 { margin: 0; font-size: calc(21px * var(--admin-font-scale, 1)); color: #1d2939; }
.transfer-heading p { margin: 8px 0 20px; color: #7b879a; line-height: 1.6; }
.transfer-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.transfer-card, .inspection { min-width: 0; padding: 22px; background: #fff; border: 1px solid #e0e5ed; border-radius: 12px; }
.project-transfer h4 { margin: 0 0 18px; color: #253149; font-size: calc(16px * var(--admin-font-scale, 1)); }
.transfer-field { display: grid; gap: 8px; margin-bottom: 18px; color: #515154; font-size: calc(13px * var(--admin-font-scale, 1)); font-weight: 500; }
.transfer-field .input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 38px; font-family: inherit; }
.transfer-file-row { display: flex; align-items: center; gap: 10px; min-height: 38px; margin-bottom: 18px; }
.transfer-file-row .btn { flex-shrink: 0; }
.transfer-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #7b879a; }
.project-transfer .btn { min-height: 38px; font-family: inherit; }
.transfer-note { margin: 14px 0 0; color: #7b879a; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.6; }
.inspection { margin-top: 18px; }
.inspection dl { display: grid; grid-template-columns: repeat(2, minmax(70px, 1fr) minmax(60px, 1fr)); gap: 10px; margin: 0 0 18px; font-size: calc(13px * var(--admin-font-scale, 1)); }
.inspection dt { color: #7b879a; }
.inspection dd { margin: 0; }
.inspection details { margin: 16px 0; color: #65748b; line-height: 1.7; }
.inspection summary { cursor: pointer; }
.transfer-name { max-width: 520px; }
.transfer-appearance { display: flex; align-items: center; gap: 8px; margin: 0 0 18px; font-size: calc(12px * var(--admin-font-scale, 1)); color: #65748b; }
.transfer-appearance input { flex-shrink: 0; accent-color: var(--ui-accent); }
.transfer-feedback { margin: 18px 0 0; padding: 10px 14px; border-radius: 8px; color: #067647; background: #ecfdf3; line-height: 1.6; }
.transfer-feedback.error { color: #b42318; background: #fef3f2; }
@media (max-width: 850px) { .transfer-grid { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .transfer-card, .inspection { padding: 16px; } .inspection dl { grid-template-columns: 1fr 1fr; } .project-transfer .btn { font-size: calc(13px * var(--admin-font-scale, 1)); } }
</style>
