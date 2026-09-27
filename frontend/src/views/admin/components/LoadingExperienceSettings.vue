<script setup>
import { onMounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { normalizeLoadingExperience } from '../../../runtime/loadingExperienceConfig.js'

const form = ref(normalizeLoadingExperience())
const busy = ref(false)
const uploading = ref(false)
const message = ref('')
const failed = ref(false)

onMounted(async () => {
  try {
    const settings = await adminApi.getSettings()
    form.value = normalizeLoadingExperience(settings.loading_experience_config)
  } catch (error) { failed.value = true; message.value = error.message || '读取加载画面失败' }
})

async function save() {
  busy.value = true; failed.value = false; message.value = ''
  try {
    const result = await adminApi.saveSettings({ loading_experience_config: form.value })
    if (result.error) throw new Error(result.error)
    message.value = '已保存；下一次启动或刷新大屏时生效。'
  } catch (error) { failed.value = true; message.value = error.message || '保存失败' }
  finally { busy.value = false }
}

async function uploadImage(event) {
  const file = event.target.files?.[0]
  if (!file) return
  uploading.value = true; failed.value = false; message.value = ''
  try {
    const result = await adminApi.uploadAppearanceImage(file)
    if (result.error) throw new Error(result.error)
    form.value.imageUrl = result.url
    message.value = '加载图已上传，请点击保存加载画面。'
  } catch (error) { failed.value = true; message.value = error.message || '加载图上传失败' }
  finally { uploading.value = false; event.target.value = '' }
}
</script>

<template>
  <section class="loading-settings">
    <div class="loading-settings-head"><h3>加载画面</h3><p>桌面启动页和大屏加载页共用这一套标题、配色与方案。互动厂房保留旋转和设备热点；简洁方案保留厂房图片但弱化动效。</p></div>
    <form @submit.prevent="save">
      <div class="loading-settings-grid">
        <label>画面方案<select v-model="form.preset"><option value="interactive">互动厂房</option><option value="quiet">简洁厂房</option></select></label>
        <label>主标题<input v-model.trim="form.title" maxlength="48" required /></label>
        <label>英文标识<input v-model.trim="form.kicker" maxlength="72" required /></label>
        <label>背景色<input v-model="form.background" type="color" /></label>
        <label>进度强调色<input v-model="form.accent" type="color" /></label>
        <label>厂房展示图片<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploading" @change="uploadImage" /><small>建议 3:2 透明背景图，最大 5 MB；上传后保存。自定义图不会套用默认灯光热点。</small></label>
      </div>
      <div class="loading-settings-preview" :style="{background:form.background,'--loading-preview-accent':form.accent}">
        <small>{{ form.kicker }}</small><img :src="form.imageUrl || '/loading/industrial-factory.png'" alt="厂房加载画面预览" /><strong>{{ form.title }}</strong><i></i><span>{{ form.preset==='interactive'?'可旋转 · 灯光与烟囱可互动':'简洁展示 · 低干扰动效' }}</span>
      </div>
      <button v-if="form.imageUrl" class="loading-settings-secondary" type="button" @click="form.imageUrl=''">恢复内置厂房图</button>
      <button type="submit" :disabled="busy">{{ busy ? '保存中…':'保存加载画面' }}</button><span v-if="message" :class="['loading-settings-message',{failed}]" role="status">{{ message }}</span>
    </form>
  </section>
</template>

<style scoped>
.loading-settings{padding:24px;color:#1d2939;background:#fff}.loading-settings h3{margin:0 0 7px;font-size:19px}.loading-settings p{margin:0 0 18px;color:#667085;font-size:13px;line-height:1.6}.loading-settings-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:18px}.loading-settings label{display:grid;gap:6px;color:#475467;font-size:12px}.loading-settings input,.loading-settings select{box-sizing:border-box;width:100%;min-height:36px;padding:7px 9px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#1d2939;font:inherit}.loading-settings input[type=color]{width:68px;padding:2px}.loading-settings-preview{display:grid;place-items:center;gap:5px;max-width:590px;min-height:205px;margin-bottom:18px;padding:14px;border-radius:12px;color:#eee}.loading-settings-preview small{font-size:10px;letter-spacing:.12em}.loading-settings-preview img{width:260px;max-height:100px;object-fit:contain}.loading-settings-preview strong{font-size:16px}.loading-settings-preview i{display:block;width:62%;height:3px;border-radius:3px;background:var(--loading-preview-accent)}.loading-settings-preview span{font-size:10px;opacity:.7}.loading-settings button{padding:10px 16px;border:0;border-radius:7px;background:#344054;color:#fff;cursor:pointer}.loading-settings button:disabled{opacity:.55}.loading-settings-message{margin-left:12px;color:#067647;font-size:12px}.loading-settings-message.failed{color:#b42318}@media(max-width:900px){.loading-settings-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.loading-settings .loading-settings-secondary{margin-right:10px;color:#344054;background:#eef2f6}.loading-settings label small{font-size:11px;color:#98a2b3}
</style>
