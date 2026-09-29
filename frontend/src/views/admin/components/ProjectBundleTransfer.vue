<script setup>
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
const labels = { workshops: '车间', lines: '产线', devices: '设备', data_points: '点位', models: '模型', projects: '项目', scenes: '场景', widgets: '组件', releases: '发布版本' }
let controller
let generation = 0
onUnmounted(() => { generation++; controller?.abort() })
function chooseFile(event) {
  generation++; controller?.abort(); busy.value = ''
  selectedFile.value = event.target.files?.[0] || null
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
      message.value = '项目包已导出。包含已保存配置与引用资产；未保存编辑请先保存后重新导出。'
    } else {
      const result = await response.json()
      if (current !== generation) return
      if (!response.ok || result.success !== true) throw new Error(result.error || '项目迁移请求失败')
      if (operation === 'inspect') {
        inspection.value = result.inspection; inspectedSha256.value = result.sha256
        newName.value = `${result.inspection.factoryName}（副本）`
        applySharedAppearance.value = false
      } else {
        message.value = `已创建工厂“${result.name}”。可从上方工厂列表进入检查；当前编辑工厂未切换。切换到新工厂后，在系统设置配置数据源，再到画面设计器点击“重绑定数据”核对字段并保存发布。`
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
  <section class="project-transfer" aria-label="项目与资产迁移">
    <header><div><h3>项目与资产迁移</h3><p>将所选工厂的已保存画面、场景配置、设备拓扑和引用资产打成一个包，在这里导入复用。</p></div>
      <button type="button" :disabled="!!busy" @click="request('export')">{{ busy === 'export' ? '正在导出…' : '导出所选工厂项目包' }}</button></header>
    <p>导入会创建新工厂，保留现有工厂。连接凭据不随包迁移，设备采集默认关闭；完成连接与点位验收后再启用。</p>
    <label v-if="factories.length" class="file-label">导出来源工厂<select v-model="exportFactoryId" :disabled="!!busy"><option v-for="factory in factories" :key="factory.id" :value="factory.id">{{ factory.name }}</option></select></label>
    <label class="file-label">选择项目迁移 ZIP<input type="file" accept=".zip,application/zip" :disabled="!!busy" @change="chooseFile" /></label>
    <button type="button" :disabled="!!busy || !selectedFile" @click="request('inspect')">{{ busy === 'inspect' ? '正在校验…' : '校验并预览项目包' }}</button>
    <div v-if="inspection" class="inspection" aria-label="迁移预检结果">
      <strong>来源：{{ inspection.factoryName }}</strong>
      <dl><template v-for="(label, key) in labels" :key="key"><dt>{{ label }}</dt><dd>{{ inspection.counts?.[key] || 0 }}</dd></template><dt>资产文件</dt><dd>{{ inspection.assetCount }} 个（{{ (inspection.assetBytes / 1024 / 1024).toFixed(1) }} MiB）</dd></dl>
      <ul v-if="inspection.warnings?.length"><li v-for="warning in inspection.warnings" :key="warning">{{ warning }}</li></ul>
      <label>新工厂名称<input v-model="newName" maxlength="120" :disabled="!!busy" /></label>
      <label v-if="inspection.sharedAppearance?.available"><span><input v-model="applySharedAppearance" type="checkbox" :disabled="!!busy" /> 同时应用包中的集团地图外观和加载画面（影响所有工厂）</span><small>默认只导入新工厂。勾选后将替换当前集团的共享外观设置。</small></label>
      <button type="button" :disabled="!!busy || !newName.trim()" @click="request('import')">{{ busy === 'import' ? '正在创建并导入…' : '创建新工厂并导入' }}</button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.project-transfer{margin-top:24px;padding:20px;border:1px solid #dce3ed;border-radius:12px;background:#f8fafc;color:#34435d;font-size:13px}.project-transfer header{display:flex;align-items:center;justify-content:space-between;gap:16px}.project-transfer h3{margin:0;font-size:16px}.project-transfer p{line-height:1.65;color:#65748b}.project-transfer button{padding:9px 14px;border:1px solid #bacde9;border-radius:7px;background:#fff;color:#245d9f;cursor:pointer}.project-transfer button:disabled{opacity:.5;cursor:default}.file-label{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0}.inspection{margin-top:16px;padding:16px;background:white;border-radius:8px}.inspection dl{display:grid;grid-template-columns:repeat(2,minmax(90px,1fr) minmax(60px,1fr));gap:8px}.inspection dd{margin:0}.inspection label{display:grid;gap:7px;margin:16px 0}.inspection input{padding:9px;border:1px solid #cbd5e1;border-radius:6px}.error{color:#b42318!important}@media(max-width:700px){.project-transfer header{align-items:flex-start;flex-direction:column}.inspection dl{grid-template-columns:1fr 1fr}}
</style>
