<script setup>
import { ref, onUnmounted } from 'vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch, canAdminPage } from '../../../runtime/adminSession.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
const props = defineProps({ models: { type: Array, default: () => [] }, selectedId: { type: String, default: '' } })
const emit = defineEmits(['imported'])
const fileInput = ref(null), file = ref(null), checked = ref(null), busy = ref(false), error = ref(''), message = ref(''), exportId = ref('')
let disposed = false, controller
onUnmounted(() => { disposed = true; controller?.abort() })
async function choose(event) {
  file.value = event.target.files?.[0] || null; event.target.value = ''; checked.value = null; error.value = ''; message.value = ''
  if (!file.value) return
  await request('inspect')
}
async function request(operation) {
  if (busy.value || !file.value) return
  const scope = getFactoryScope(), form = new FormData()
  form.append('file', file.value)
  if (operation === 'import') form.append('inspectedSha256', checked.value?.inspectedSha256 || '')
  busy.value = true; error.value = ''; message.value = ''; controller = new AbortController()
  try {
    const response = await adminFetch(`${API_BASE}/models/asset-${operation}`, { method: 'POST', headers: scope ? { 'X-Factory-ID': scope } : {}, body: form, signal: controller.signal })
    const data = await response.json()
    if (disposed) return
    if (!response.ok || !data.success) throw Error(data.error || '模型动作包处理失败')
    if (operation === 'inspect') checked.value = data
    else { checked.value = null; file.value = null; emit('imported', data.model); message.value = '已导入到当前工厂。模型与动作可在对应编辑器选择；不会覆盖旧模型或自动绑定设备。' }
  } catch (e) { if (!disposed) error.value = e.message } finally { busy.value = false }
}
async function exportAsset() {
  const id = props.selectedId || exportId.value
  if (!id || busy.value) return
  busy.value = true; error.value = ''; message.value = ''; controller = new AbortController()
  try {
    const response = await adminFetch(`${API_BASE}/models/${encodeURIComponent(id)}/asset-export`, { signal: controller.signal })
    if (!response.ok) throw Error((await response.json()).error || '导出失败')
    const blob = await response.blob(); if (disposed) return
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = `model-asset-${id}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    message.value = '已导出模型资产 ZIP（解压可见 model.glb、motion.glb、motion.json 和清单）。不是数据库备份。'
  } catch (e) { if (!disposed) error.value = e.message } finally { busy.value = false }
}
</script>
<template>
  <section class="asset-transfer" aria-label="项目模型与动作文件导入导出">
    <div class="asset-toolbar">
      <strong>项目导入文件</strong>
      <button type="button" class="btn btn-primary" :disabled="busy || !canAdminPage('models', 'edit')" @click="fileInput?.click()">导入模型 / 厂房 / 动作包</button>
      <input ref="fileInput" type="file" accept=".zip" aria-label="选择模型动作资产 ZIP" hidden :disabled="busy" @change="choose" />
      <select v-if="!selectedId" v-model="exportId" class="input" aria-label="选择导出模型" :disabled="busy"><option value="">选择导出模型</option><option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option></select>
      <button type="button" class="btn" :disabled="busy || !(selectedId || exportId)" @click="exportAsset">导出模型及动作文件</button>
    </div>
    <p>安装包无预置工厂或模型。按项目从根目录“导入文件”选择资产包；单个 GLB 仍可用“导入模型”。源工程 .blend 和旧分发 ZIP 不作为运行资产导入。</p>
    <div v-if="checked" class="asset-check">
      <strong>{{ checked.model.name }}</strong> · {{ checked.model.assetType === 'environment' ? '厂房环境' : '模型' }} · {{ checked.actions.length }} 个动作 · {{ file?.name }}
      <p v-if="checked.actions.length">{{ checked.actions.map(a => a.label).join('、') }}</p>
      <button class="btn btn-primary" type="button" :disabled="busy || !canAdminPage('models', 'edit')" @click="request('import')">确认导入当前工厂（创建新资产）</button>
      <button class="btn" type="button" :disabled="busy" @click="checked = null; file = null">取消</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
<style scoped>
.asset-transfer{border:1px solid #64748b50;border-radius:10px;padding:14px;margin:12px 0}.asset-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.asset-transfer p{font-size:12px;line-height:1.6;opacity:.85;margin:8px 0}.asset-toolbar select{max-width:260px}.asset-check{padding:10px;background:#64748b15;border-radius:6px}[role=alert]{color:#ef6666}
</style>
