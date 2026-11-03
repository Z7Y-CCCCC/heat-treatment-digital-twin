<script setup>
defineProps({ enabled: Boolean, disabled: Boolean, pending: Boolean, label: String, title: String })
const emit = defineEmits(['toggle'])
</script>
<template>
  <button type="button" class="enable-capsule" :class="{'is-enabled':enabled}" role="switch" :aria-label="label" :aria-checked="enabled" :aria-busy="pending" :title="title" :disabled="disabled || pending" @click="emit('toggle')"><span>{{ enabled ? '启用' : '停用' }}</span><i aria-hidden="true"></i></button>
</template>
<style scoped>
.enable-capsule{position:relative;display:inline-flex;align-items:center;box-sizing:border-box;width:68px;height:28px;padding:0 7px 0 28px;border:1px solid #d6dde7;border-radius:999px;background:#edf1f6;color:#758198;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;transition:background .18s,color .18s}.enable-capsule i{position:absolute;left:3px;top:3px;width:20px;height:20px;border-radius:50%;background:white;box-shadow:0 1px 4px #26334926;transition:transform .18s}.enable-capsule.is-enabled{padding:0 28px 0 8px;border-color:#b8e5ce;background:#def5e9;color:#21764e}.enable-capsule.is-enabled i{transform:translateX(40px)}.enable-capsule:focus-visible{outline:2px solid #386dca;outline-offset:2px}.enable-capsule:disabled{opacity:.6;cursor:default}.enable-capsule[aria-busy=true]{cursor:wait}@media(prefers-reduced-motion:reduce){.enable-capsule,.enable-capsule i{transition:none}}
</style>
