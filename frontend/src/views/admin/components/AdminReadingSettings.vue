<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ADMIN_READING_KEY, readTextSize, saveTextSize } from '../../../runtime/adminReadingPreferences.js'
const panel = ref(null), textSize = ref(readTextSize(localStorage))
let previousScale = '', previousFlag = null
function apply() { document.documentElement.style.setProperty('--admin-font-scale', String(textSize.value / 100)); document.documentElement.setAttribute('data-admin-typography', '') }
function change(value) { textSize.value = saveTextSize(localStorage, value); apply() }
function outside(event) { if (!panel.value?.contains(event.target)) panel.value?.removeAttribute('open') }
function storage(event) { if (event.key === ADMIN_READING_KEY) { textSize.value = readTextSize(localStorage); apply() } }
onMounted(() => {
  previousScale = document.documentElement.style.getPropertyValue('--admin-font-scale'); previousFlag = document.documentElement.getAttribute('data-admin-typography')
  apply(); document.addEventListener('pointerdown', outside); window.addEventListener('storage', storage)
})
onUnmounted(() => {
  if (previousScale) document.documentElement.style.setProperty('--admin-font-scale', previousScale); else document.documentElement.style.removeProperty('--admin-font-scale')
  if (previousFlag === null) document.documentElement.removeAttribute('data-admin-typography'); else document.documentElement.setAttribute('data-admin-typography', previousFlag)
  document.removeEventListener('pointerdown', outside); window.removeEventListener('storage', storage)
})
</script>
<template>
  <details ref="panel" class="admin-reading-settings" @keydown.esc="panel?.removeAttribute('open')">
    <summary aria-label="后台文字大小" title="后台文字大小"><span aria-hidden="true">Aa</span></summary>
    <div class="reading-popover" role="group" aria-label="后台文字大小设置">
      <header><strong>文字大小</strong><output>{{ textSize }}%</output></header>
      <input type="range" min="100" max="200" step="5" :value="textSize" aria-label="后台文字大小百分比" @input="change($event.target.value)" />
      <div class="reading-size-presets"><button v-for="size in [100,115,130,150,200]" :key="size" type="button" :aria-pressed="textSize===size" @click="change(size)">{{ size }}%</button></div>
      <small>仅本机后台，自动记住。</small>
    </div>
  </details>
</template>
<style scoped>
.admin-reading-settings{position:relative;flex:none}.admin-reading-settings summary{display:grid;place-items:center;list-style:none;width:36px;height:36px;border:1px solid #dce3ed;border-radius:9px;background:#fff;color:#52687d;cursor:pointer;font-size:calc(14px * var(--admin-font-scale, 1));font-weight:600}.admin-reading-settings summary::-webkit-details-marker{display:none}.admin-reading-settings[open] summary{border-color:#9dbff1;color:#2457a6;background:#edf4ff}.reading-popover{position:absolute;top:44px;right:0;z-index:10020;width:270px;max-width:calc(100vw - 30px);padding:17px;border:1px solid #dce3ed;border-radius:12px;background:#fff;box-shadow:0 12px 36px #17203324;color:#344054}.reading-popover header{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:calc(14px * var(--admin-font-scale, 1))}.reading-popover input{width:100%;margin:15px 0;accent-color:#2563eb}.reading-size-presets{display:flex;flex-wrap:wrap;gap:5px}.reading-size-presets button{padding:6px 8px;border:1px solid #d7dfeb;border-radius:6px;background:#fff;color:#52687d;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));cursor:pointer}.reading-size-presets button[aria-pressed=true]{background:#edf4ff;border-color:#9dbff1;color:#2457a6}.reading-popover small{display:block;margin-top:12px;color:#8191a7;font-size:calc(12px * var(--admin-font-scale, 1))}
</style>
