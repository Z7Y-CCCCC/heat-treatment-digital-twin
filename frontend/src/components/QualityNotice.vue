<script setup>
defineProps({ state: { type: Object, required: true } })
</script>
<template>
  <Teleport to="body"><Transition name="quality-notice">
    <div v-if="state.notice" class="quality-notice" data-account-hit="true" :class="{ error: state.error }" role="status" aria-live="polite">{{ state.notice }}</div>
  </Transition></Teleport>
</template>
<style scoped>
.quality-notice{position:fixed;z-index:12000;top:72px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 20px;border:1px solid #ffffff29;border-radius:999px;background:#20252ef2;color:#f2f5fa;box-shadow:0 8px 24px #0003;font:12px/1.5 "Microsoft YaHei UI",sans-serif;pointer-events:none}.quality-notice.error{color:#ffc4be}.quality-notice-enter-active,.quality-notice-leave-active{transition:opacity .16s}.quality-notice-enter-from,.quality-notice-leave-to{opacity:0}@media(prefers-reduced-motion:reduce){.quality-notice-enter-active,.quality-notice-leave-active{transition:none}}
</style>
