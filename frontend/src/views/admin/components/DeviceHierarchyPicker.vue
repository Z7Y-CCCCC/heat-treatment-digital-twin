<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
const props = defineProps({ factories: { type: Array, default: () => [] }, workshops: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] }, devices: { type: Array, default: () => [] }, factoryId: String, deviceId: String, disabled: Boolean, requestFactorySwitch: Function, requestDevice: Function })
const open = ref(false), switching = ref(false), error = ref(''), workshopId = ref(''), lineId = ref(''), host = ref(null), menuElement = ref(null), menuStyle = ref({})
const menuId = `device-hierarchy-${useId()}`
let disposed = false
const textId = value => String(value || '')
const currentFactory = computed(() => props.factories.find(factory => textId(factory.id) === props.factoryId))
const currentDevice = computed(() => props.devices.find(device => textId(device.id) === props.deviceId))
const parseInstance = device => { try { return typeof device?.instance_config === 'string' ? JSON.parse(device.instance_config || '{}') : device?.instance_config || {} } catch { return {} } }
const deviceLine = device => { const id = textId(device.line_id || device.lineId); return props.lines.some(line => textId(line.id) === id) ? id : '' }
const deviceWorkshop = device => { const line = props.lines.find(line => textId(line.id) === deviceLine(device)); const id = textId(device.workshop_id || device.workshopId || parseInstance(device).workshop_id || parseInstance(device).workshopId || line?.workshop_id || line?.workshopId); return props.workshops.some(workshop => textId(workshop.id) === id) ? id : '' }
const workshopOptions = computed(() => [...props.workshops.map(workshop => ({ ...workshop, id: textId(workshop.id) })), ...(props.devices.some(device => !deviceWorkshop(device)) ? [{ id: '__unassigned', name: '未分配车间' }] : [])])
const lineOptions = computed(() => {
  const lines = props.lines.filter(line => textId(line.workshop_id || line.workshopId) === workshopId.value).map(line => ({ ...line, id: textId(line.id) }))
  if (props.devices.some(device => (deviceWorkshop(device) || '__unassigned') === workshopId.value && !deviceLine(device))) lines.push({ id: '__unassigned', name: '未分配产线' })
  return lines
})
const deviceOptions = computed(() => props.devices.filter(device => (deviceWorkshop(device) || '__unassigned') === workshopId.value && (deviceLine(device) || '__unassigned') === lineId.value))
function revealCurrent() { workshopId.value = currentDevice.value ? deviceWorkshop(currentDevice.value) || '__unassigned' : workshopOptions.value[0]?.id || ''; lineId.value = currentDevice.value ? deviceLine(currentDevice.value) || '__unassigned' : lineOptions.value[0]?.id || '' }
function positionMenu() {
  if (!open.value || !host.value?.getBoundingClientRect) return
  const rect = host.value.getBoundingClientRect(), viewportWidth = window.innerWidth || 1024, viewportHeight = window.innerHeight || 768
  const width = Math.max(240, Math.min(750, viewportWidth - 32)), height = Math.min(menuElement.value?.offsetHeight || 400, viewportHeight - 32)
  const below = viewportHeight - rect.bottom - 16, above = rect.top - 16
  const preferredTop = below < Math.min(height, 220) && above > below ? rect.top - height - 10 : rect.bottom + 10
  const top = Math.max(16, Math.min(viewportHeight - 136, preferredTop)), left = Math.max(16, Math.min(rect.left, viewportWidth - width - 16))
  menuStyle.value = { width: `${width}px`, left: `${left}px`, top: `${top}px`, maxHeight: `${Math.max(120, viewportHeight - top - 16)}px` }
}
function toggle() { if (props.disabled || switching.value) return; open.value = !open.value; if (open.value) { error.value = ''; revealCurrent(); positionMenu(); void nextTick(positionMenu) } }
function chooseWorkshop(id) { workshopId.value = id; lineId.value = lineOptions.value[0]?.id || '' }
async function chooseFactory(id) {
  if (props.disabled || switching.value || !props.factories.some(factory => textId(factory.id) === id)) return false
  if (id === props.factoryId) { revealCurrent(); return true }
  if (typeof props.requestFactorySwitch !== 'function') { error.value = '当前页面未提供安全的工厂切换入口'; return false }
  switching.value = true; error.value = ''
  try {
    // The parent owns authorization, all dirty editors and the actual scope
    // change/reload. This selector never writes factory scope itself.
    const result = await props.requestFactorySwitch({ factoryId: id, factoryName: props.factories.find(factory => textId(factory.id) === id)?.name || id })
    if (!disposed && result === true) open.value = false
    return result === true
  } catch (failure) { if (!disposed) error.value = failure.message || '切换工厂失败'; return false }
  finally { if (!disposed) switching.value = false }
}
async function chooseDevice(id) {
  if (props.disabled || switching.value || !deviceOptions.value.some(device => textId(device.id) === id)) return false
  if (typeof props.requestDevice !== 'function') { error.value = '当前页面未提供设备选择入口'; return false }
  try { const selected = await props.requestDevice(id); if (!disposed && selected !== false) open.value = false; return selected !== false }
  catch (failure) { if (!disposed) error.value = failure.message || '设备选择失败'; return false }
}
function outside(event) { if (open.value && !host.value?.contains(event.target)) open.value = false }
function keydown(event) { if (event.key === 'Escape') { open.value = false; host.value?.querySelector('button')?.focus() } }
watch(() => [props.deviceId, props.factoryId], revealCurrent)
onMounted(() => { document.addEventListener('pointerdown', outside); window.addEventListener('resize', positionMenu); window.addEventListener('scroll', positionMenu, true) })
onBeforeUnmount(() => { disposed = true; document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', positionMenu); window.removeEventListener('scroll', positionMenu, true) })
</script>
<template>
  <div ref="host" class="device-hierarchy-picker" @keydown="keydown">
    <button type="button" class="hierarchy-trigger" aria-label="选择现场设备范围" :aria-expanded="open" :aria-controls="menuId" :disabled="disabled || switching" @click="toggle"><span><strong>现场设备</strong><small>{{ currentFactory?.name || '当前工厂' }} · {{ devices.length }} 台</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
    <div v-if="open" ref="menuElement" :id="menuId" :style="menuStyle" class="hierarchy-menu" role="dialog" aria-label="按工厂车间产线选择设备">
      <header><div><strong>选择现场设备</strong><small>按现场层级找到设备，再配置它的动作</small></div><button type="button" aria-label="关闭设备选择" @click="open = false">×</button></header>
      <div class="hierarchy-columns">
        <section><h4>01 <span>工厂</span></h4><button v-for="factory in factories" :key="factory.id" type="button" :class="{ active: String(factory.id) === factoryId }" :disabled="switching" @click="chooseFactory(String(factory.id))">{{ factory.name || factory.id }}<span>›</span></button><p v-if="!factories.length">暂无可访问工厂</p></section>
        <section><h4>02 <span>车间</span></h4><button v-for="workshop in workshopOptions" :key="workshop.id" type="button" :class="{ active: workshop.id === workshopId }" :disabled="switching" @click="chooseWorkshop(workshop.id)">{{ workshop.name || workshop.id }}<span>›</span></button><p v-if="!workshopOptions.length">当前工厂暂无车间</p></section>
        <section><h4>03 <span>产线</span></h4><button v-for="line in lineOptions" :key="line.id" type="button" :class="{ active: line.id === lineId }" :disabled="switching" @click="lineId = line.id">{{ line.name || line.id }}<span>›</span></button><p v-if="!lineOptions.length">此车间暂无产线或设备</p></section>
        <section><h4>04 <span>设备</span></h4><button v-for="device in deviceOptions" :key="device.id" type="button" :class="{ active: String(device.id) === deviceId }" :disabled="switching || disabled" @click="chooseDevice(String(device.id))">{{ device.name || device.id }}<span v-if="String(device.id) === deviceId">✓</span></button><p v-if="!deviceOptions.length">此产线暂无设备</p></section>
      </div>
      <footer><span>{{ switching ? '正在处理草稿并切换工厂…' : '切换设备前会确认未保存修改；切换工厂由统一入口处理。' }}</span><p v-if="error" role="alert">{{ error }}</p></footer>
    </div>
  </div>
</template>
<style scoped>
.device-hierarchy-picker{position:relative;min-width:0}.hierarchy-trigger{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;padding:0;border:0;background:none;color:#32445d;cursor:pointer;text-align:left}.hierarchy-trigger>span{display:grid;gap:6px}.hierarchy-trigger strong{font-size:13px;font-weight:600}.hierarchy-trigger small{font-size:11px;color:#8492a6}.hierarchy-trigger svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7}.hierarchy-trigger[aria-expanded=true]{color:#2c69c2}.hierarchy-trigger:disabled{opacity:.5;cursor:default}.hierarchy-menu{position:fixed;box-sizing:border-box;overflow:auto;left:16px;top:70px;z-index:180;width:min(750px,calc(100vw - 65px));padding:15px;border:1px solid #dce5f1;border-radius:12px;background:#fff;box-shadow:0 15px 40px #263a5926}.hierarchy-menu>header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:13px}.hierarchy-menu>header>div{display:grid;gap:5px}.hierarchy-menu>header strong{font-size:13px}.hierarchy-menu>header small{font-size:11px;color:#8995a6}.hierarchy-menu>header button{border:0;background:none;color:#8492a8;font-size:20px;cursor:pointer}.hierarchy-columns{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid #e8edf5;border-radius:8px;overflow:hidden}.hierarchy-columns>section{min-width:0;min-height:220px;max-height:360px;overflow:auto;border-right:1px solid #e8edf5;padding:8px}.hierarchy-columns>section:last-child{border-right:0}.hierarchy-columns h4{display:flex;gap:7px;align-items:center;margin:3px 5px 11px;font-size:10px;font-weight:500;color:#a0acc0}.hierarchy-columns h4 span{font-size:12px;font-weight:600;color:#597191}.hierarchy-columns button{display:flex;align-items:center;justify-content:space-between;gap:6px;box-sizing:border-box;width:100%;padding:9px 7px;border:0;border-radius:6px;background:none;text-align:left;font:inherit;font-size:12px;color:#65758d;cursor:pointer;overflow-wrap:anywhere}.hierarchy-columns button.active{background:#edf4ff;color:#3672c6}.hierarchy-columns button:hover{background:#f4f7fc}.hierarchy-columns button span{color:#9caec6;flex:none}.hierarchy-columns p{font-size:11px;line-height:1.7;color:#98a4b7;padding:0 6px}.hierarchy-menu footer{display:grid;gap:6px;padding-top:12px;font-size:11px;color:#94a0b3;line-height:1.6}.hierarchy-menu footer p{margin:0;color:#b95860}button:focus-visible{outline:2px solid #8bb9ef;outline-offset:2px}@media(max-width:850px){.hierarchy-menu{width:min(600px,calc(100vw - 70px))}.hierarchy-columns{grid-template-columns:repeat(2,minmax(0,1fr))}.hierarchy-columns>section{min-height:120px;max-height:200px}.hierarchy-columns>section:nth-child(2){border-right:0}.hierarchy-columns>section:nth-child(-n+2){border-bottom:1px solid #e8edf5}}
</style>
