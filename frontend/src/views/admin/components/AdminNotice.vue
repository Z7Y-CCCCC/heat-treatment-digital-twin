<script setup>
defineProps({ state: { type: Object, required: true } })
defineEmits(['close'])
</script>
<template>
  <Teleport to="body"><Transition name="admin-notice">
    <div v-if="state.text" :key="state.id" class="admin-notice" :class="state.tone" :role="state.tone === 'error' ? 'alert' : 'status'" aria-atomic="true">
      <span class="notice-mark" aria-hidden="true">{{ state.tone === 'error' ? '!' : '✓' }}</span><span>{{ state.text }}</span>
      <button type="button" aria-label="关闭消息" @click="$emit('close')">×</button>
    </div>
  </Transition></Teleport>
</template>
<style scoped>
.admin-notice { position:fixed; z-index:12000; top:72px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:9px; max-width:calc(100vw - 32px); box-sizing:border-box; padding:10px 12px 10px 16px; border:1px solid #dbe5df; border-radius:12px; background:#fffffff5; color:#344054; box-shadow:0 8px 28px #17203326; backdrop-filter:blur(12px); font:calc(13px * var(--admin-font-scale,1))/1.6 'Inter Variable','Noto Sans SC Variable',sans-serif; overflow-wrap:anywhere; }
.notice-mark { display:grid; place-items:center; flex:0 0 20px; width:20px; height:20px; border-radius:50%; background:#e2f5eb; color:#21895a; font-weight:800; }
.error { border-color:#f0d1cc; }.error .notice-mark { background:#ffedea; color:#cb4033; }
button { flex-shrink:0; width:26px; height:26px; padding:0; border:0; border-radius:5px; background:transparent; color:#8993a3; font-size:20px; cursor:pointer; }button:hover { background:#f1f4f8; color:#344054; }
.admin-notice-enter-active,.admin-notice-leave-active { transition:opacity .16s; }.admin-notice-enter-from,.admin-notice-leave-to { opacity:0; }
@media(prefers-reduced-motion:reduce) { .admin-notice-enter-active,.admin-notice-leave-active { transition:none; } }
</style>
