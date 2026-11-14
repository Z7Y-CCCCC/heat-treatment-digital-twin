<script setup>
defineProps({ name: String })
</script>

<template>
  <svg class="service-connection-icon" :class="{ 'is-spinning': name === 'spinner' }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" :data-service-icon="name">
    <template v-if="name === 'unity'"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.2l8 4.6" /></template>
    <template v-else-if="name === 'devices'"><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /><rect x="9" y="9" width="6" height="6" rx="1" /></template>
    <template v-else-if="name === 'data'"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></template>
    <template v-else-if="name === 'session'"><circle cx="9" cy="7" r="3" /><path d="M3 20v-2a6 6 0 0 1 9-5.2m5-2.8 5 2v4c0 3-5 6-5 6s-5-3-5-6v-4l5-2Z" /><path d="m15 16 1.5 1.5L19 15" /></template>
    <template v-else-if="name === 'check'"><circle cx="12" cy="12" r="8" /><path d="m8 12 3 3 5-6" /></template>
    <template v-else-if="name === 'reconnect'"><path d="M20 7v5h-5M4 17v-5h5M6.3 7a7 7 0 0 1 11.4-1L20 9M4 15l2.3 3A7 7 0 0 0 17.7 17" /></template>
    <template v-else-if="name === 'restart'"><path d="M12 2v9M7 5a8 8 0 1 0 10 0" /></template>
    <template v-else-if="name === 'center'"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4M7 9h4m-4 4h10m-2-4h2" /></template>
    <template v-else-if="name === 'unlock'"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2M12 15v2" /></template>
    <template v-else-if="name === 'close'"><path d="m6 6 12 12M18 6 6 18" /></template>
    <template v-else-if="name === 'spinner'"><path d="M20 12a8 8 0 1 1-8-8" /></template>
  </svg>
</template>

<style scoped>
.service-connection-icon{display:block;width:19px;height:19px;flex:0 0 auto}
.is-spinning{animation:connection-spin 1s linear infinite}
@keyframes connection-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.is-spinning{animation:none}}
</style>
