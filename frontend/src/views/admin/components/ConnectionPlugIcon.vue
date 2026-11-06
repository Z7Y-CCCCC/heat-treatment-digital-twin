<script setup>
defineProps({ connected: Boolean })
</script>

<template>
  <svg class="connection-plug-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false" :data-plug-state="connected ? 'connected' : 'disconnected'">
    <g transform="rotate(-45 24 24)" fill="currentColor">
      <g :transform="connected ? 'translate(3 0)' : 'translate(-3 0)'">
        <path fill-rule="evenodd" d="M18 12v24h-2a12 12 0 0 1 0-24h2ZM14 17h-1a7 7 0 0 0 0 14h1V17Z" />
        <rect x="18" y="16" width="7" height="4" rx="1" />
        <rect x="18" y="28" width="7" height="4" rx="1" />
        <rect x="0" y="21" width="7" height="6" rx="1" />
      </g>
      <g :transform="connected ? 'translate(-3 0)' : 'translate(3 0)'">
        <path fill-rule="evenodd" d="M30 12h2a12 12 0 0 1 0 24h-2V12ZM34 17v14h1a7 7 0 0 0 0-14h-1Z" />
        <rect x="41" y="21" width="7" height="6" rx="1" />
      </g>
    </g>
  </svg>
</template>

<style scoped>
.connection-plug-icon{display:block;width:22px;height:22px;flex:0 0 auto;overflow:visible}
</style>
