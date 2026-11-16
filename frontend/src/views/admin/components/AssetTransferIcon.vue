<script setup>
defineProps({ name: { type: String, default: 'file' } })
const icons = {
  import: 'M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5', export: 'M12 15V3m-4 4 4-4 4 4M5 15v5h14v-5',
  update: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M14 3v6h6l-6-6M12 11v6m-3-3h6',
  history: 'M3 11a9 9 0 1 1 2.8 7M3 4v7h7m2-4v5l3 2', close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4 4L19 6',
  refresh: 'M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6m0 0v6h6', shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3m-4 9 3 3 5-6'
}
</script>
<template><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path :d="icons[name] || icons.file" /></svg></template>
<style scoped>svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}</style>
