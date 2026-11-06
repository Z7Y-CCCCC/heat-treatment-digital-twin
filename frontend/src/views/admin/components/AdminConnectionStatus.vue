<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from 'vue'
import ConnectionPlugIcon from './ConnectionPlugIcon.vue'

const props = defineProps({
  unityConnected: Boolean, unityClass: [Object, String], unityLabel: String, unityDetail: String,
  summary: { type: Object, default: () => ({}) }
})
const root = ref(null), hovered = ref(false), focused = ref(false), pinned = ref(false), dismissed = ref(false)
const tooltipId = `admin-device-connections-${useId()}`
const visible = computed(() => !dismissed.value && (hovered.value || focused.value || pinned.value))
const rows = computed(() => props.summary.deviceRows || [])
const modeLabel = computed(() => props.summary.modeLabel || '设备连接')
const deviceAriaLabel = computed(() => `${props.summary.label || modeLabel.value}；${props.summary.detail || '查看设备连接状态'}`)
function enter() { hovered.value = true; dismissed.value = false }
function leave() { hovered.value = false; if (!focused.value && !pinned.value) dismissed.value = false }
function focusIn() { focused.value = true; dismissed.value = false }
function focusOut(event) { if (!root.value?.contains(event.relatedTarget)) { focused.value = false; pinned.value = false } }
function close() { pinned.value = false; dismissed.value = true }
function toggle() { if (pinned.value) close(); else { dismissed.value = false; pinned.value = true } }
function outside(event) {
  if (!root.value?.contains(event.target)) {
    hovered.value = false; focused.value = false; pinned.value = false; dismissed.value = false
  }
}
function keys(event) { if (event.key === 'Escape' && visible.value) { close(); event.preventDefault(); event.stopPropagation() } }
function resume() { window.addEventListener('pointerdown', outside); window.addEventListener('keydown', keys) }
function suspend() {
  hovered.value = false; focused.value = false; pinned.value = false; dismissed.value = false
  window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keys)
}
watch(modeLabel, close)
onMounted(resume)
onActivated(resume)
onDeactivated(suspend)
onBeforeUnmount(suspend)
</script>

<template>
  <div class="admin-connection-controls">
    <button type="button" class="admin-connection-pill unity-connection-pill" :class="unityClass" data-connection-kind="unity" :title="unityDetail" :aria-label="unityLabel || (unityConnected ? 'Unity 已连接' : 'Unity 未连接')">
      <span>Unity</span><ConnectionPlugIcon :connected="unityConnected" />
    </button>
    <div ref="root" class="device-connection-control" @mouseenter="enter" @mouseleave="leave" @focusin="focusIn" @focusout="focusOut">
      <button type="button" class="admin-connection-pill device-connection-pill" :class="summary.tone || 'is-unknown'" data-connection-kind="devices" :aria-label="deviceAriaLabel" :aria-describedby="visible ? tooltipId : undefined" :aria-expanded="visible" :aria-controls="tooltipId" @click="toggle">
        <span>{{ modeLabel }}</span><ConnectionPlugIcon :connected="summary.total > 0 && summary.online === summary.total && summary.tone === 'is-online'" />
      </button>
      <section v-if="visible" :id="tooltipId" class="admin-device-connection-tooltip" role="tooltip">
        <header><strong>{{ modeLabel }}</strong><span>{{ summary.online || 0 }} / {{ summary.total || 0 }}</span></header>
        <ul v-if="rows.length" class="device-connection-list" tabindex="0" aria-label="设备连接列表">
          <li v-for="row in rows" :key="row.id" :data-device-id="row.id" :class="row.tone || (row.connected ? 'is-online' : 'is-offline')" :aria-label="`${row.name}：${row.connected ? '已连接' : row.status === 'connecting' ? '连接中' : ['unknown', 'pending'].includes(row.state) ? '状态未知' : '未连接'}`">
            <span class="device-connection-name">{{ row.name }}</span><ConnectionPlugIcon :connected="row.connected" />
          </li>
        </ul>
        <p v-else class="device-connection-empty">{{ summary.total ? '尚未取得设备明细' : '暂无可显示的设备' }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.admin-connection-controls{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.admin-connection-pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:32px;padding:4px 10px;border:1px solid #dfe3e8;border-radius:999px;background:#f2f4f7;color:#667085;font:inherit;font-size:calc(12px * var(--admin-font-scale,1));font-weight:600;line-height:1;white-space:nowrap;cursor:default}
.device-connection-pill{cursor:pointer}
.admin-connection-pill:focus-visible,.device-connection-list:focus-visible{outline:2px solid #4285db;outline-offset:3px}
.is-online{color:#176b3a}.is-offline{color:#b42318}.is-partial{color:#936208}.is-unknown{color:#667085}
.admin-connection-pill.is-online{background:#e8f7ee;border-color:#bfe6cd}
.admin-connection-pill.is-offline{background:#fff0ee;border-color:#efc4bf}
.admin-connection-pill.is-partial{background:#fff7df;border-color:#ead29b}
.admin-connection-pill.is-unknown{background:#f2f4f7;border-color:#dfe3e8}
.admin-connection-pill.is-busy,.admin-connection-pill.is-checking{color:#17628a;background:#eaf5fb;border-color:#bedfed}
.device-connection-control{position:relative}
.admin-device-connection-tooltip{position:absolute;right:0;top:calc(100% + 10px);z-index:1500;width:min(300px,calc(100vw - 24px));padding:12px;border:1px solid #dfe5ee;border-radius:10px;background:#fff;box-shadow:0 12px 34px rgba(20,35,60,.18);color:#344054;font-size:calc(12px * var(--admin-font-scale,1));text-align:left;line-height:1.5;box-sizing:border-box}
.admin-device-connection-tooltip::before{content:'';position:absolute;top:-11px;left:0;right:0;height:11px}
.admin-device-connection-tooltip header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 4px 8px;border-bottom:1px solid #edf0f5}
.admin-device-connection-tooltip header span{color:#667085;font-variant-numeric:tabular-nums}
.device-connection-list{list-style:none;padding:5px 0 0;margin:0;max-height:min(340px,calc(100vh - 140px));overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.device-connection-list li{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:34px;padding:5px 4px;box-sizing:border-box}
.device-connection-name{color:#344054;overflow-wrap:anywhere;min-width:0}
.device-connection-empty{margin:12px 4px 3px;color:#667085}
@media(max-width:1380px){.admin-connection-controls{gap:6px}.admin-connection-pill{gap:6px;padding:4px 8px;font-size:calc(11px * var(--admin-font-scale,1))}}
</style>
