<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ADMIN_READING_KEY, readTextSize, saveTextSize } from '../../../runtime/adminReadingPreferences.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { loadingAppearance, applyLoadingAppearance, readLoadingAppearance, patchLoadingAppearance } from '../../../runtime/loadingAppearanceState.js'
const panel = ref(null), trigger = ref(null), open = ref(false), textSize = ref(readTextSize(localStorage))
const position = ref({ top: '0px', left: '0px', maxHeight: '400px' })
const themeBusy = ref(false), themeReading = ref(false), notice = ref(''), failed = ref(false)
const canEditTheme = computed(() => canAdminPage('platform.loading', 'edit'))
let previousScale = '', previousFlag = null
let disposed = false, noticeTimer = 0, positionFrame = 0
function apply() { document.documentElement.style.setProperty('--admin-font-scale', String(textSize.value / 100)); document.documentElement.setAttribute('data-admin-typography', '') }
function change(value) { textSize.value = saveTextSize(localStorage, value); apply(); schedulePosition() }
function inside(target) { return trigger.value?.contains(target) || panel.value?.contains(target) }
function close(restoreFocus = false) { open.value = false; if (restoreFocus) trigger.value?.focus({ preventScroll: true }) }
function outside(event) { if (open.value && !inside(event.target)) close() }
function keyboard(event) {
  if (open.value && event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(true) }
}
function storage(event) { if (event.key === ADMIN_READING_KEY) { textSize.value = readTextSize(localStorage); apply() } }
function place() {
  if (!open.value || !panel.value || !trigger.value) return
  const box = trigger.value.getBoundingClientRect(), width = panel.value.offsetWidth
  const left = Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12))
  const below = window.innerHeight - box.bottom - 20, above = box.top - 20
  const height = Math.min(panel.value.scrollHeight, Math.max(100, Math.max(below, above)))
  const top = below >= Math.min(panel.value.scrollHeight, 280) || below >= above ? box.bottom + 8 : Math.max(12, box.top - height - 8)
  position.value = { left: `${left}px`, top: `${Math.max(12, top)}px`, maxHeight: `${Math.max(100, window.innerHeight - top - 12)}px` }
}
function schedulePosition() {
  if (!open.value || positionFrame) return
  positionFrame = requestAnimationFrame(() => { positionFrame = 0; place() })
}
async function toggle() {
  if (open.value) { close(); return }
  open.value = true; notice.value = ''; failed.value = false; themeReading.value = true
  await nextTick(); if (disposed || !open.value) return
  place(); panel.value?.querySelector('button:not(:disabled), input')?.focus({ preventScroll: true })
  try { await readLoadingAppearance() }
  catch (error) { if (!disposed) { notice.value = error.message; failed.value = true } }
  finally { if (!disposed) themeReading.value = false }
}
async function changeTheme(theme) {
  if (themeBusy.value || themeReading.value || !canEditTheme.value || theme === loadingAppearance.value.theme) return
  themeBusy.value = true; failed.value = false; notice.value = ''; clearTimeout(noticeTimer)
  try {
    await patchLoadingAppearance({ theme })
    if (!disposed) { notice.value = '主题已保存'; noticeTimer = setTimeout(() => { notice.value = '' }, 2400) }
  } catch (error) { if (!disposed) { notice.value = error.message; failed.value = true } }
  finally { if (!disposed) { themeBusy.value = false; schedulePosition() } }
}
function appearanceChanged(event) { if (event.detail) applyLoadingAppearance(event.detail, true) }
onMounted(() => {
  previousScale = document.documentElement.style.getPropertyValue('--admin-font-scale'); previousFlag = document.documentElement.getAttribute('data-admin-typography')
  apply(); document.addEventListener('pointerdown', outside); window.addEventListener('storage', storage)
  void readLoadingAppearance().catch(() => {})
  document.addEventListener('focusin', outside); window.addEventListener('resize', schedulePosition); document.addEventListener('scroll', schedulePosition, true)
  document.addEventListener('keydown', keyboard, true)
  window.addEventListener('loading-appearance-updated', appearanceChanged)
})
onUnmounted(() => {
  disposed = true; clearTimeout(noticeTimer); cancelAnimationFrame(positionFrame)
  if (previousScale) document.documentElement.style.setProperty('--admin-font-scale', previousScale); else document.documentElement.style.removeProperty('--admin-font-scale')
  if (previousFlag === null) document.documentElement.removeAttribute('data-admin-typography'); else document.documentElement.setAttribute('data-admin-typography', previousFlag)
  document.removeEventListener('pointerdown', outside); window.removeEventListener('storage', storage)
  document.removeEventListener('focusin', outside); window.removeEventListener('resize', schedulePosition); document.removeEventListener('scroll', schedulePosition, true)
  document.removeEventListener('keydown', keyboard, true)
  window.removeEventListener('loading-appearance-updated', appearanceChanged)
})
</script>
<template>
  <div class="admin-reading-settings">
    <button ref="trigger" type="button" class="appearance-trigger" aria-label="外观设置" title="外观设置 · 主题与字号" aria-haspopup="dialog" :aria-expanded="open" aria-controls="admin-appearance-popover" @click="toggle" @keydown.esc.stop="close(true)">
      <span aria-hidden="true">Aa</span><i aria-hidden="true" :class="`theme-${loadingAppearance.theme}`"></i>
    </button>
    <Teleport to="body">
    <div v-if="open" id="admin-appearance-popover" ref="panel" class="reading-popover" :style="position" role="dialog" aria-label="外观设置" @keydown.esc.stop.prevent="close(true)">
      <div class="appearance-heading"><strong>外观设置</strong><button type="button" aria-label="关闭外观设置" @click="close(true)">×</button></div>
      <section class="appearance-theme-section" aria-label="主题配色">
        <header><strong>主题配色</strong><small v-if="themeBusy">保存中…</small></header>
        <div class="appearance-theme-options">
          <button v-for="theme in [{id:'light',name:'蓝白'},{id:'dark',name:'深色'}]" :key="theme.id" type="button" :aria-pressed="loadingAppearance.theme===theme.id" :disabled="themeReading || !canEditTheme" :aria-disabled="themeBusy || themeReading || !canEditTheme" :title="canEditTheme ? '' : '没有加载画面编辑权限'" @click="changeTheme(theme.id)"><i :class="`theme-${theme.id}`"></i>{{ theme.name }}</button>
        </div>
        <p v-if="notice" :class="['appearance-notice',{failed}]" :role="failed?'alert':'status'">{{ notice }}</p>
      </section>
      <section class="appearance-type-section" aria-label="文字大小">
      <header><strong>文字大小</strong><output>{{ textSize }}%</output></header>
      <input type="range" min="100" max="200" step="5" :value="textSize" aria-label="后台文字大小百分比" @input="change($event.target.value)" />
      <div class="reading-size-presets"><button v-for="size in [100,115,130,150,200]" :key="size" type="button" :aria-pressed="textSize===size" @click="change(size)">{{ size }}%</button></div>
      <small>仅本机后台，自动记住。</small>
      </section>
    </div>
    </Teleport>
  </div>
</template>
<style scoped>
.admin-reading-settings{position:relative;flex:none}.appearance-trigger{position:relative;display:grid;place-items:center;box-sizing:border-box;width:36px;height:36px;padding:0;border:1px solid #dce3ed;border-radius:9px;background:#fff;color:#52687d;cursor:pointer;font:600 clamp(14px,calc(14px * var(--admin-font-scale,1)),20px) "Segoe UI",sans-serif}.appearance-trigger>i{position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-radius:50%;border:1px solid #d2ddeb}.appearance-trigger[aria-expanded=true]{border-color:#9dbff1;color:#2457a6;background:#edf4ff}.reading-popover{position:fixed;z-index:10020;box-sizing:border-box;width:310px;max-width:calc(100vw - 24px);overflow:auto;padding:16px;border:1px solid #dce3ed;border-radius:12px;background:#fff;box-shadow:0 12px 36px #17203324;color:#344054;font-family:"Microsoft YaHei UI","Segoe UI",sans-serif}.appearance-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;font-size:calc(15px * var(--admin-font-scale,1))}.appearance-heading button{border:0;background:transparent;color:#8191a7;font:inherit;font-size:21px;cursor:pointer;padding:0 3px}.reading-popover header{display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:calc(13px * var(--admin-font-scale,1))}.appearance-type-section{border-top:1px solid #edf0f5;margin-top:16px;padding-top:16px}.reading-popover input{box-sizing:border-box;width:100%;margin:15px 0;accent-color:#2563eb}.reading-size-presets,.appearance-theme-options{display:flex;flex-wrap:wrap;gap:5px}.reading-size-presets button,.appearance-theme-options button{padding:6px 8px;border:1px solid #d7dfeb;border-radius:6px;background:#fff;color:#52687d;font:inherit;font-size:calc(12px * var(--admin-font-scale,1));cursor:pointer}.reading-size-presets button[aria-pressed=true],.appearance-theme-options button[aria-pressed=true]{background:#edf4ff;border-color:#9dbff1;color:#2457a6}.reading-popover small{display:block;margin-top:10px;color:#8191a7;font-size:calc(11px * var(--admin-font-scale,1))}.reading-popover header small{margin:0}.appearance-theme-options{margin-top:10px;padding:4px;border:1px solid #e2e8f2;border-radius:8px;background:#f5f7fb;gap:4px}.appearance-theme-options button{display:flex;align-items:center;justify-content:center;flex:1;gap:8px;border-color:transparent;background:transparent}.appearance-theme-options button[aria-pressed=true]{background:#fff;box-shadow:0 1px 4px #315b9f18}.appearance-theme-options i{width:14px;height:14px;border:1px solid #d2ddeb;border-radius:4px}.theme-light{background:linear-gradient(135deg,#fff 50%,#2563eb 50%)}.theme-dark{background:linear-gradient(135deg,#28282b 50%,#a8c3b1 50%)}.appearance-theme-options button:disabled,.appearance-theme-options button[aria-disabled=true]{opacity:.55;cursor:default}.appearance-notice{margin:9px 0 0;padding:6px 8px;border-radius:6px;background:#eef9f3;color:#08794d;font-size:calc(12px * var(--admin-font-scale,1));line-height:1.5;overflow-wrap:anywhere}.appearance-notice.failed{background:#fff1f0;color:#b42318}.reading-popover button:focus-visible,.appearance-trigger:focus-visible{outline:2px solid #76a7f8;outline-offset:2px}
</style>
