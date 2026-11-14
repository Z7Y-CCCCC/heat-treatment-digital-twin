<script setup>
import { watch, onUnmounted } from 'vue'
import { saveFeedback } from '../../../runtime/saveFeedback.js'
let timer
watch(saveFeedback, notice => {
  clearTimeout(timer)
  if (notice) timer = setTimeout(() => { if (saveFeedback.value?.id === notice.id) saveFeedback.value = null }, notice.type === 'error' ? 7000 : 3500)
}, { immediate: true })
onUnmounted(() => { clearTimeout(timer); saveFeedback.value = null })
</script>
<template>
  <Teleport to="body"><div v-if="saveFeedback" class="save-feedback-toast" :class="saveFeedback.type" :role="saveFeedback.type === 'error' ? 'alert' : 'status'" data-testid="save-feedback-toast">
    <span aria-hidden="true">{{ saveFeedback.type === 'error' ? '!' : '✓' }}</span><span>{{ saveFeedback.message }}</span>
    <button type="button" aria-label="关闭保存提示" @click="saveFeedback = null">×</button>
  </div></Teleport>
</template>
<style scoped>
.save-feedback-toast{position:fixed;top:76px;right:24px;z-index:30000;display:flex;align-items:center;gap:10px;max-width:min(460px,calc(100vw - 48px));box-sizing:border-box;padding:13px 16px;border:1px solid #bce4cf;border-radius:12px;background:#f0fcf5;color:#207247;box-shadow:0 8px 28px #172b4d24;font:14px/1.5 'Noto Sans SC Variable',sans-serif;overflow-wrap:anywhere}.save-feedback-toast.error{border-color:#f2c6c2;background:#fff5f4;color:#b33c35}.save-feedback-toast>span:first-child{font-weight:700}.save-feedback-toast button{flex:none;border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;padding:0 0 0 8px}
</style>
