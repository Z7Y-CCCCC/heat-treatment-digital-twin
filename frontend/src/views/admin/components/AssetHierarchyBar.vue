<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { getFactoryScope, setFactoryScope, FACTORY_DIRECTORY_CHANGE_EVENT } from '../../../runtime/factoryScope.js'

const props = defineProps({
  workshops: { type: Array, default: () => [] },
  lines: { type: Array, default: () => [] },
  devices: { type: Array, default: () => [] },
  workshopId: { type: String, default: '' },
  lineId: { type: String, default: '' },
  deviceId: { type: String, default: '' },
  requestSwitch: { type: Function, required: true }
})
const factories = ref([])
const factoryId = ref(getFactoryScope())
const error = ref('')
const switching = ref(false)
const open = ref(false)
const highlightedIndex = ref(0)
const host = ref(null)
const trigger = ref(null)
const list = ref(null)
const menuId = `factory-switch-${useId()}`
const activeOptionId = computed(() => open.value && factories.value[highlightedIndex.value] ? `${menuId}-${highlightedIndex.value}` : undefined)

async function reloadFactories() {
  try {
    const result = await adminApi.listFactories()
    if (result.error) throw new Error(result.error)
    factories.value = result.factories || []
    error.value = ''
    if (!factories.value.some(factory => factory.id === factoryId.value)) {
      factoryId.value = result.activeFactoryId || factories.value[0]?.id || ''
    }
    if (open.value) highlight(Math.max(0, factories.value.findIndex(factory => factory.id === factoryId.value)))
  } catch (cause) { error.value = cause.message || '工厂列表读取失败' }
}
onMounted(() => {
  reloadFactories()
  window.addEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, reloadFactories)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('focusin', outside)
})
onUnmounted(() => {
  window.removeEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, reloadFactories)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('focusin', outside)
})

const currentFactory = computed(() => factories.value.find(factory => factory.id === factoryId.value))
const currentDevice = computed(() => props.devices.find(device => device.id === props.deviceId))
const currentLine = computed(() => props.lines.find(line => line.id === (props.lineId || currentDevice.value?.line_id)))
const currentWorkshop = computed(() => props.workshops.find(workshop => workshop.id === (props.workshopId || currentLine.value?.workshop_id)))
const hierarchy = computed(() => [
  { level: '车间', name: currentWorkshop.value?.name || currentWorkshop.value?.id || '全部', active: !!currentWorkshop.value },
  { level: '产线', name: currentLine.value?.name || currentLine.value?.id || (currentDevice.value ? '未分配' : '全部'), active: !!currentLine.value },
  { level: '设备', name: currentDevice.value?.name || currentDevice.value?.id || '全部', active: !!currentDevice.value }
])
const factoryLabel = computed(() => switching.value ? '正在切换…' : currentFactory.value?.name || (error.value ? '工厂列表读取失败' : '正在读取…'))
const scopeTitle = computed(() => [currentFactory.value?.name, ...hierarchy.value.map(item => `${item.level}：${item.name}`)].filter(Boolean).join('\n'))

function highlight(index) {
  highlightedIndex.value = index
  void nextTick(() => list.value?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: 'nearest' }))
}
function closeMenu(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}
function toggleMenu() {
  if (!factories.value.length || switching.value) return
  open.value = !open.value
  if (open.value) highlight(Math.max(0, factories.value.findIndex(factory => factory.id === factoryId.value)))
}
function outside(event) { if (open.value && !host.value?.contains(event.target)) closeMenu() }
function keydown(event) {
  if (event.key === 'Tab') { closeMenu(); return }
  if (event.key === 'Escape') { if (open.value) { event.preventDefault(); event.stopPropagation(); closeMenu(true) }; return }
  if (switching.value || !factories.value.length) return
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    if (!open.value) { toggleMenu(); return }
    const count = factories.value.length
    highlight(event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (highlightedIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (open.value) void changeFactory(factories.value[highlightedIndex.value]?.id)
    else toggleMenu()
  }
}
function factorySummary(factory) {
  const counts = [['workshopCount', '个车间'], ['lineCount', '条产线'], ['deviceCount', '台设备']]
    .filter(([key]) => Number.isFinite(factory[key]))
    .map(([key, unit]) => `${factory[key]} ${unit}`)
  return counts.length ? counts.join(' · ') : '独立工厂配置'
}
async function changeFactory(next) {
  if (switching.value) return
  const factory = factories.value.find(factory => factory.id === next)
  if (!factory) return
  closeMenu(true)
  if (next === factoryId.value) return
  const name = factory.name || next
  error.value = ''
  switching.value = true
  let accepted = false
  try {
    accepted = await props.requestSwitch({ factoryId: next, factoryName: name })
  } catch (cause) {
    error.value = cause.message || '切换工厂失败'
  } finally {
    switching.value = false
  }
  if (!accepted) {
    await nextTick()
    trigger.value?.focus()
    return
  }
  setFactoryScope(next)
  factoryId.value = next
  window.location.reload()
}
</script>

<template>
  <section ref="host" class="asset-hierarchy-bar" aria-label="当前编辑范围">
    <button ref="trigger" type="button" role="combobox" class="asset-factory-select" :class="{ 'is-pending': switching, 'is-unavailable': !factories.length }" aria-label="当前编辑工厂" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="menuId" :aria-activedescendant="activeOptionId" :aria-busy="switching" :data-factory-id="factoryId" :disabled="!factories.length || switching" :title="scopeTitle" @click="toggleMenu" @keydown="keydown">
      <span class="asset-factory-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M3 20V4h5v8l6-4v4l7-4v12H3Z"/><path class="factory-windows" d="M7 16h1m4 0h1m4 0h1"/></svg>
      </span>
      <span class="asset-factory-copy">
        <span class="asset-factory-caption">当前工厂 / 区域</span>
        <span class="asset-factory-current" aria-live="polite"><i class="asset-factory-dot" :class="{ 'is-muted': !currentFactory || currentFactory.enabled === false }" aria-hidden="true"></i><strong>{{ factoryLabel }}</strong></span>
      </span>
      <svg class="asset-factory-caret" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4Z"/></svg>
      <svg class="asset-factory-switch" viewBox="0 0 16 20" aria-hidden="true"><path d="m5 6 3-3 3 3M5 14l3 3 3-3"/></svg>
    </button>
    <Transition name="factory-menu">
      <div v-if="open" class="asset-factory-menu">
        <div class="asset-factory-menu-heading"><strong>切换工厂</strong><span>{{ factories.length }} 个工厂</span></div>
        <div ref="list" :id="menuId" class="asset-factory-options" role="listbox" aria-label="工厂列表">
          <button v-for="(factory, index) in factories" :id="`${menuId}-${index}`" :key="factory.id" type="button" role="option" tabindex="-1" class="asset-factory-option" :class="{ 'is-selected': factory.id === factoryId, 'is-highlighted': index === highlightedIndex }" :aria-selected="factory.id === factoryId" :data-factory-id="factory.id" :data-highlighted="index === highlightedIndex" :title="factory.name" @pointermove="highlightedIndex = index" @pointerdown.prevent @click="changeFactory(factory.id)">
            <span class="asset-factory-option-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 20V5h5v7l5-4v4l6-4v12H4Z"/><path d="M8 16h1m3 0h1m3 0h1"/></svg></span>
            <span class="asset-factory-option-copy"><strong>{{ factory.name }}</strong><small>{{ factorySummary(factory) }}</small></span>
            <span v-if="factory.id === factoryId" class="asset-factory-selected-mark"><span>当前</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg></span>
          </button>
        </div>
        <div class="asset-factory-menu-footer"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 切换</span><span><kbd>Esc</kbd> 关闭</span></div>
      </div>
    </Transition>
    <p v-if="error" class="asset-hierarchy-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.asset-hierarchy-bar{position:relative;box-sizing:border-box;width:340px;max-width:100%;min-width:0;margin:0;color:#202b3d}
.asset-factory-select{position:relative;display:flex;align-items:center;gap:11px;box-sizing:border-box;width:100%;min-width:0;min-height:52px;padding:8px 12px;border:1px solid #e1e5ed;border-radius:10px;background:#fff;color:inherit;font:inherit;text-align:left;box-shadow:0 4px 12px #1b2d4b08;cursor:pointer;transition:border-color .18s ease,box-shadow .18s ease}
.asset-factory-select:hover{border-color:#bdcde5;box-shadow:0 4px 14px #1b2d4b10}
.asset-factory-select:focus-visible{outline:2px solid #83adf5;outline-offset:2px}
.asset-factory-select[aria-expanded=true]{border-color:#abc7ee;box-shadow:0 0 0 3px #3b82f60b,0 4px 14px #1b2d4b0c}.asset-factory-select[aria-expanded=true] .asset-factory-caret{transform:rotate(180deg);fill:#537fbb}
.asset-factory-icon{display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;border-radius:8px;background:#e5efff;color:#315a91}
.asset-factory-icon svg{width:23px;height:23px;fill:currentColor;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round}.asset-factory-icon .factory-windows{fill:none;stroke:#e5efff;stroke-width:2;stroke-linecap:round}
.asset-factory-copy{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
.asset-factory-caption{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9299a5;font-size:clamp(10px,calc(11px * var(--admin-font-scale,1)),14px);line-height:1.2}
.asset-factory-current{display:flex;align-items:center;gap:7px;min-width:0;line-height:1.3}.asset-factory-current strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:clamp(12px,calc(13px * var(--admin-font-scale,1)),18px);font-weight:600}
.asset-factory-dot{flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:#48b888;box-shadow:0 0 0 2px #48b88812}.asset-factory-dot.is-muted{background:#b1bac6;box-shadow:none}
.asset-factory-caret{flex:0 0 14px;width:14px;height:14px;fill:#969fab;transition:transform .18s ease}.asset-factory-switch{flex:0 0 14px;width:14px;height:20px;fill:none;stroke:#7e8897;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.asset-factory-select:disabled{cursor:wait}.asset-factory-select.is-unavailable{opacity:.65}.asset-factory-select.is-pending .asset-factory-dot{background:#d4a148}
.asset-factory-menu{position:absolute;top:calc(100% + 9px);left:0;z-index:2;box-sizing:border-box;width:max(100%,340px);max-width:calc(100vw - 32px);padding:7px;border:1px solid #e1e7f0;border-radius:14px;background:#fff;box-shadow:0 18px 46px #1b2d4b1a,0 4px 12px #1b2d4b08;transform-origin:top center}
.asset-factory-menu-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px 12px}.asset-factory-menu-heading strong{color:#41516a;font-size:12px;font-weight:600}.asset-factory-menu-heading>span{color:#9aa6b6;font-size:11px}
.asset-factory-options{display:grid;gap:4px;max-height:min(340px,calc(100dvh - 200px));overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#d6deea transparent}
.asset-factory-option{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:100%;min-width:0;min-height:64px;margin:0;padding:10px;border:1px solid transparent;border-radius:9px;background:transparent;color:#34445b;text-align:left;font:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease}
.asset-factory-option.is-highlighted{background:#f5f8fc}.asset-factory-option.is-selected{border-color:#d8e6fa;background:#eef5ff;color:#255f9e}.asset-factory-option.is-selected.is-highlighted{background:#e9f2ff}
.asset-factory-option-icon{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;border:1px solid #e6ebf2;border-radius:8px;background:#f7f9fc;color:#8a9db5}.asset-factory-option-icon svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}.is-selected .asset-factory-option-icon{border-color:#d8e6fb;background:#deebff;color:#4373b2}
.asset-factory-option-copy{display:grid;flex:1;gap:5px;min-width:0}.asset-factory-option-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:1.3}.asset-factory-option-copy small{color:#98a4b5;font-size:10px;line-height:1.3}.is-selected .asset-factory-option-copy small{color:#7b98bc}
.asset-factory-selected-mark{display:flex;flex:none;align-items:center;gap:4px;color:#4d7db8;font-size:10px}.asset-factory-selected-mark svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.asset-factory-menu-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 3px 0;padding:10px 7px 4px;border-top:1px solid #edf1f6;color:#a1aaba;font-size:10px}.asset-factory-menu-footer>span{display:flex;align-items:center;gap:3px}.asset-factory-menu-footer kbd{padding:1px 3px;border:1px solid #e7ebf2;border-radius:3px;background:#fbfcfe;color:#8b98aa;font:inherit;font-size:9px;line-height:1.2}
.factory-menu-enter-active,.factory-menu-leave-active{transition:opacity .14s ease,transform .14s ease}.factory-menu-enter-from,.factory-menu-leave-to{opacity:0;transform:translateY(-4px) scale(.985)}
.asset-hierarchy-error{position:absolute;top:calc(100% + 8px);left:0;z-index:1;box-sizing:border-box;width:max-content;max-width:min(380px,calc(100vw - 32px));margin:0;padding:9px 12px;border:1px solid #f0ccd0;border-radius:8px;background:#fff7f7;box-shadow:0 6px 18px #1b2d4b12;color:#b43e4d;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
@media(max-width:760px){.asset-factory-select{gap:8px;padding:8px 10px}.asset-factory-switch{display:none}.asset-factory-icon{flex-basis:30px;width:30px;height:30px}}
@media(prefers-reduced-motion:reduce){.asset-factory-select,.asset-factory-caret,.asset-factory-option,.factory-menu-enter-active,.factory-menu-leave-active{transition:none}}
</style>
