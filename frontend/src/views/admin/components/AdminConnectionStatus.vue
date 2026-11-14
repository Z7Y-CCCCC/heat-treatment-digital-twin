<script setup>
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from 'vue'
import ConnectionPlugIcon from './ConnectionPlugIcon.vue'
import ServiceConnectionIcon from './ServiceConnectionIcon.vue'

const props = defineProps({
  services: { type: Array, default: () => [] },
  actions: { type: Object, default: () => ({}) },
  // String must precede Boolean: Vue otherwise casts the controller's idle ''
  // into true and permanently disables every operation in the real AdminPanel.
  busy: { type: [String, Boolean, Object], default: false },
  feedback: { type: Object, default: () => ({}) },
  unityConnected: Boolean, unityClass: [Object, String], unityLabel: String, unityDetail: String,
  summary: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['action'])
const root = ref(null), panel = ref(null), activeKind = ref('devices')
const panelStyle = ref({})
const hovered = ref(false), focused = ref(false), pinned = ref(false), dismissed = ref(false)
const panelId = `admin-service-connections-${useId()}`
const serviceNames = { unity: 'Unity', devices: '设备采集', data: '数据服务', session: '登录状态' }
const actionIds = new Set(['check', 'reconnect', 'restart', 'center', 'unlock'])
const tones = new Set(['is-online', 'is-offline', 'is-partial', 'is-unknown', 'is-busy', 'is-checking'])
const visible = computed(() => !dismissed.value && (hovered.value || focused.value || pinned.value))
const modeLabel = computed(() => props.summary.modeLabel || '设备采集')
const deviceMode = computed(() => {
  const service = props.services.find(item => item?.key === 'devices')
  // The old engine summary can finish after the new status API. Once supplied,
  // authoritative services must not be dismissed by an unrelated legacy poll.
  return service ? service.mode || '' : modeLabel.value
})
const services = computed(() => {
  const fallback = {
    unity: { label: props.unityLabel || (props.unityConnected ? 'Unity 已连接' : 'Unity 未连接'), detail: props.unityDetail,
      connected: props.unityConnected, tone: typeof props.unityClass === 'string' ? props.unityClass : Object.keys(props.unityClass || {}).find(key => props.unityClass[key] && tones.has(key)) },
    devices: { label: props.summary.label || modeLabel.value, detail: props.summary.detail, tone: props.summary.tone,
      connected: props.summary.total > 0 && props.summary.online === props.summary.total,
      mode: modeLabel.value.includes('模拟') ? 'simulation' : props.summary.mode,
      rows: props.summary.deviceRows || [], total: props.summary.total || 0, online: props.summary.online || 0 },
    data: { label: '尚未检测', detail: '等待数据服务检测' },
    session: { label: '尚未检测', detail: '等待会话检测' }
  }
  return Object.keys(serviceNames).map(key => {
    const input = props.services.find(item => item?.key === key) || fallback[key]
    const simulated = key === 'devices' && (input.mode === 'simulation' || input.mode === 'simulating')
    const connected = input.connected === true && input.tone === 'is-online' && !input.stale && !input.restricted && !simulated
    let tone = tones.has(input.tone) ? input.tone : 'is-unknown'
    if (tone === 'is-online' && !connected) tone = input.restricted ? 'is-unknown' : 'is-partial'
    return { ...input, key, name: input.name || serviceNames[key], label: input.label || '尚未检测', tone, connected }
  })
})
const activeService = computed(() => services.value.find(item => item.key === activeKind.value))
const rows = computed(() => activeService.value?.rows || [])
const panelActions = computed(() => (props.actions[activeKind.value] || []).filter(action => actionIds.has(action?.id)))
const activeFeedback = computed(() => props.feedback[activeKind.value])
const activeBusy = computed(() => isBusy(activeKind.value))
function isBusy(kind) {
  return props.busy === true || props.busy === kind || (typeof props.busy === 'object' && !!props.busy?.[kind])
}
function ariaLabel(service) { return `${service.name}：${service.label}；${service.detail || '查看状态与操作'}` }
function rowConnected(row) { return row.connected === true && !row.stale && !row.restricted }
function rowTone(row) {
  if (row.restricted) return 'is-unknown'
  const tone = tones.has(row.tone) ? row.tone : rowConnected(row) ? 'is-online' : 'is-offline'
  return tone === 'is-online' && !rowConnected(row) ? 'is-partial' : tone
}
function rowStatus(row) {
  return rowConnected(row) ? '已连接' : row.status === 'connecting' ? '连接中' : ['unknown', 'pending'].includes(row.state) ? '状态未知' : '未连接'
}
function communicationTime(value) {
  if (!value) return '尚无成功通信'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '尚无成功通信' : date.toLocaleString('zh-CN', { hour12: false })
}
function communicationDatetime(value) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
function enter(kind = 'devices') {
  hovered.value = true
  if (!pinned.value || activeKind.value === kind) { activeKind.value = kind; dismissed.value = false }
}
function leave() { hovered.value = false }
function focusIn(kind = 'devices') {
  if (activeKind.value !== kind) pinned.value = false
  activeKind.value = kind; focused.value = true; dismissed.value = false
}
function focusOut(event) {
  if (!root.value?.contains(event.relatedTarget)) { focused.value = false; pinned.value = false; hovered.value = false }
}
function close(restoreFocus = false) {
  pinned.value = false
  if (restoreFocus) root.value?.querySelector?.(`[data-connection-kind="${activeKind.value}"]`)?.focus()
  dismissed.value = true
}
function toggle(kind = 'devices') {
  if (activeKind.value === kind && pinned.value) close()
  else { activeKind.value = kind; dismissed.value = false; pinned.value = true }
}
function outside(event) {
  if (!root.value?.contains(event.target)) {
    hovered.value = false; focused.value = false; pinned.value = false; dismissed.value = false
  }
}
function keys(event) {
  if (event.key === 'Escape' && visible.value) { close(true); event.preventDefault(); event.stopPropagation() }
}
async function triggerKeys(event, kind) {
  if (event.key !== 'ArrowDown') return
  event.preventDefault(); focusIn(kind); pinned.value = true
  await nextTick()
  panel.value?.querySelector?.('[data-connection-action]:not(:disabled)')?.focus()
}
function runAction(action) {
  const allowed = panelActions.value.find(item => item.id === action?.id)
  if (!allowed || allowed.disabled || activeBusy.value) return
  emit('action', { kind: activeKind.value, action: allowed.id })
}
function positionPanel() {
  const bounds = root.value?.getBoundingClientRect?.()
  if (!bounds || !window.innerWidth || !window.innerHeight) return
  const width = Math.min(320, window.innerWidth - 24)
  const left = Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12))
  panelStyle.value = { right: `${bounds.right - left - width}px`, maxHeight: `${Math.max(40, window.innerHeight - bounds.bottom - 22)}px` }
}
function resume() {
  window.addEventListener('pointerdown', outside); window.addEventListener('keydown', keys)
  window.addEventListener('resize', positionPanel)
}
function suspend() {
  hovered.value = false; focused.value = false; pinned.value = false; dismissed.value = false
  window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keys)
  window.removeEventListener('resize', positionPanel)
}
watch(visible, async value => { if (value) { await nextTick(); positionPanel() } })
watch(deviceMode, () => { if (activeKind.value === 'devices') close() })
// Disabling a focused action blurs it in Chromium. Move focus before the DOM
// update so a pending operation cannot unexpectedly dismiss its own feedback.
watch(activeBusy, busy => {
  if (busy && panel.value?.contains(document.activeElement)) {
    root.value?.querySelector?.(`[data-connection-kind="${activeKind.value}"]`)?.focus()
  }
})
onMounted(resume)
onActivated(resume)
onDeactivated(suspend)
onBeforeUnmount(suspend)
</script>

<template>
  <div ref="root" class="admin-connection-controls" :class="{ 'is-open': visible }" @mouseleave="leave" @focusout="focusOut">
    <button v-for="service in services" :key="service.key" type="button" class="admin-connection-pill" :class="[service.tone, `${service.key}-connection-pill`]" :data-connection-kind="service.key" :title="ariaLabel(service)" :aria-label="ariaLabel(service)" aria-haspopup="dialog" :aria-expanded="visible && activeKind === service.key" :aria-controls="panelId" @mouseenter="enter(service.key)" @focus="focusIn(service.key)" @click="toggle(service.key)" @keydown="triggerKeys($event, service.key)">
      <ServiceConnectionIcon :name="service.key" /><ConnectionPlugIcon :connected="service.connected" />
    </button>
    <section v-if="visible" :id="panelId" ref="panel" class="admin-service-connection-panel admin-device-connection-tooltip" :style="panelStyle" role="dialog" aria-modal="false" :aria-label="`${activeService.name}连接状态与操作`" :aria-busy="activeBusy" @focusin="focused = true">
      <header>
        <strong>{{ activeService.name }}</strong>
        <button type="button" class="connection-icon-action connection-close" title="关闭连接面板" aria-label="关闭连接面板" @click="close(true)"><ServiceConnectionIcon name="close" /></button>
      </header>
      <div class="connection-status-line" :class="activeService.tone"><ConnectionPlugIcon :connected="activeService.connected" /><strong>{{ activeService.label }}</strong></div>
      <p v-if="activeService.detail" class="connection-detail">{{ activeService.detail }}</p>
      <p class="connection-last-success"><span>最近成功通信</span><time :datetime="communicationDatetime(activeService.lastSuccessAt)">{{ communicationTime(activeService.lastSuccessAt) }}</time></p>
      <div v-if="panelActions.length" class="connection-actions" :aria-label="`${activeService.name}可用操作`">
        <button v-for="action in panelActions" :key="action.id" type="button" class="connection-icon-action" :class="{ 'is-dangerous': action.dangerous || action.id === 'restart' }" :data-connection-action="action.id" :disabled="action.disabled || activeBusy" :title="action.reason ? `${action.label}：${action.reason}` : action.label" :aria-label="action.reason ? `${action.label}：${action.reason}` : action.label" @click="runAction(action)">
          <ServiceConnectionIcon :name="activeBusy ? 'spinner' : action.id" />
        </button>
      </div>
      <p v-if="activeFeedback?.message" class="connection-feedback" :class="`is-${activeFeedback.type || 'status'}`" :role="activeFeedback.type === 'error' ? 'alert' : 'status'">{{ activeFeedback.message }}</p>
      <template v-if="activeKind === 'devices'">
        <div class="connection-device-count"><span>设备明细</span><span>{{ activeService.online || 0 }} / {{ activeService.total || 0 }}</span></div>
        <ul v-if="rows.length && !activeService.restricted" class="device-connection-list" tabindex="0" aria-label="设备连接列表">
          <li v-for="row in rows" :key="row.id" :data-device-id="row.id" :class="rowTone(row)" :aria-label="`${row.name}：${rowStatus(row)}`">
            <span class="device-connection-name">{{ row.name }}</span><ConnectionPlugIcon :connected="rowConnected(row)" />
          </li>
        </ul>
        <p v-else class="device-connection-empty">{{ activeService.restricted ? '无权限查看设备明细' : activeService.total ? '尚未取得设备明细' : '暂无可显示的设备' }}</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.admin-connection-controls{display:flex;position:relative;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap}
.admin-connection-controls.is-open::after{content:'';position:absolute;left:0;right:0;top:100%;height:11px;z-index:1499}
.admin-connection-pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:32px;padding:4px 10px;border:1px solid #dfe3e8;border-radius:999px;background:#f2f4f7;color:#667085;font:inherit;font-size:calc(12px * var(--admin-font-scale,1));font-weight:600;line-height:1;white-space:nowrap;cursor:pointer;box-sizing:border-box}
.admin-connection-pill:focus-visible,.connection-icon-action:focus-visible,.device-connection-list:focus-visible{outline:2px solid #4285db;outline-offset:3px}
.is-online{color:#176b3a}.is-offline{color:#b42318}.is-partial{color:#936208}.is-unknown{color:#667085}
.admin-connection-pill.is-online{background:#e8f7ee;border-color:#bfe6cd}
.admin-connection-pill.is-offline{background:#fff0ee;border-color:#efc4bf}
.admin-connection-pill.is-partial{background:#fff7df;border-color:#ead29b}
.admin-connection-pill.is-unknown{background:#f2f4f7;border-color:#dfe3e8}
.admin-connection-pill.is-busy,.admin-connection-pill.is-checking{color:#17628a;background:#eaf5fb;border-color:#bedfed}
.admin-service-connection-panel{position:absolute;right:0;top:calc(100% + 10px);z-index:1500;width:min(320px,calc(100vw - 24px));max-height:calc(100dvh - 110px);overflow:auto;overscroll-behavior:contain;padding:12px;border:1px solid #dfe5ee;border-radius:10px;background:#fff;box-shadow:0 12px 34px rgba(20,35,60,.18);color:#344054;font-size:calc(12px * var(--admin-font-scale,1));text-align:left;line-height:1.5;box-sizing:border-box}
.admin-service-connection-panel::before{content:'';position:absolute;top:-11px;left:0;right:0;height:11px}
.admin-service-connection-panel header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 4px 8px;border-bottom:1px solid #edf0f5}
.connection-status-line{display:flex;align-items:center;gap:8px;margin:12px 4px 0}
.connection-detail{margin:8px 4px;color:#667085;overflow-wrap:anywhere}
.connection-last-success{display:flex;flex-direction:column;gap:2px;margin:10px 4px;color:#667085;font-variant-numeric:tabular-nums}
.connection-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 4px}
.connection-icon-action{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:5px;border:1px solid #dfe3e8;border-radius:999px;background:#f2f4f7;color:#667085;cursor:pointer;flex:0 0 auto}
.connection-icon-action:hover:not(:disabled){border-color:#bedfed;color:#17628a;background:#eaf5fb}
.connection-icon-action.is-dangerous{color:#b42318;background:#fff0ee;border-color:#efc4bf}
.connection-icon-action:disabled{opacity:.5;cursor:not-allowed}
.connection-close{width:26px;height:26px;border:0;background:transparent}
.connection-feedback{margin:8px 4px;overflow-wrap:anywhere}.connection-feedback.is-error{color:#b42318}.connection-feedback.is-success{color:#176b3a}
.connection-device-count{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 4px 0;padding-top:8px;border-top:1px solid #edf0f5;color:#667085;font-variant-numeric:tabular-nums}
.device-connection-list{list-style:none;padding:5px 0 0;margin:0;max-height:min(340px,calc(100dvh - 280px));overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.device-connection-list li{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:34px;padding:5px 4px;box-sizing:border-box}
.device-connection-name{color:#344054;overflow-wrap:anywhere;min-width:0}
.device-connection-empty{margin:12px 4px 3px;color:#667085}
@media(max-width:1380px){.admin-connection-controls{gap:6px}.admin-connection-pill{gap:6px;padding:4px 8px}}
@media(max-width:480px){.admin-connection-controls{gap:4px}.admin-connection-pill{gap:5px;padding:4px 7px}.admin-service-connection-panel{max-height:calc(100dvh - 150px)}}
</style>
