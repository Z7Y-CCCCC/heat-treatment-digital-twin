<script setup>
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch } from '../../../runtime/adminSession.js'

const props = defineProps({ factoryId:String, factoryName:String, kind:String, count:Number })
const labels = { workshops:'车间', lines:'产线', devices:'设备' }
const label = computed(() => labels[props.kind] || '')
const tooltipId = useId(), anchor = ref(null), popup = ref(null), open = ref(false), loading = ref(false), error = ref(''), items = ref([])
const position = ref({ left:'12px', top:'12px' })
let closeTimer, request, requestTimer, sequence = 0, loadedAt = 0, loadedCount = -1, disposed = false

function place() {
  if (!anchor.value || !popup.value) return
  const target = anchor.value.getBoundingClientRect(), box = popup.value.getBoundingClientRect()
  const left = Math.max(12, Math.min(target.left + target.width/2 - box.width/2, innerWidth - box.width - 12))
  const preferredTop = target.bottom + box.height + 8 <= innerHeight - 12 ? target.bottom + 8 : target.top - box.height - 8
  const top = Math.max(12, Math.min(preferredTop, innerHeight - box.height - 12))
  position.value = { left:`${left}px`, top:`${top}px` }
}
function cancelClose() { clearTimeout(closeTimer) }
function close() { cancelClose(); open.value = false }
function scheduleClose() { cancelClose(); closeTimer = setTimeout(close,150) }
async function load() {
  if (loading.value || !labels[props.kind] || !props.factoryId) return
  if (loadedCount === props.count && Date.now() - loadedAt < 30000) return
  if (props.count === 0) { items.value = []; error.value = ''; loadedCount = 0; loadedAt = Date.now(); return }
  const current = ++sequence
  request = new AbortController(); loading.value = true; error.value = ''
  requestTimer = setTimeout(() => request?.abort(),10000)
  try {
    const response = await adminFetch(`${API_BASE}/${props.kind}`, { signal:request.signal, cache:'no-store', headers:{'X-Factory-ID':props.factoryId} })
    const data = await response.json()
    if (!response.ok || !Array.isArray(data)) throw Error(data.error || '名称读取失败')
    if (disposed || current !== sequence) return
    items.value = data.map(item => ({ id:String(item.id), name:String(item.name || item.id) }))
    loadedAt = Date.now(); loadedCount = props.count
  } catch (cause) { if (!disposed && current === sequence) error.value = cause.name === 'AbortError' ? '读取超时，请重试' : cause.message }
  finally {
    if (current === sequence) { clearTimeout(requestTimer); request = null; loading.value = false; await nextTick(); place() }
  }
}
function show() { cancelClose(); open.value = true; void nextTick(place); void load() }
watch(open, value => {
  const action = value ? 'addEventListener' : 'removeEventListener'
  window[action]('resize',place); window[action]('scroll',place,true)
})
watch(() => [props.factoryId,props.kind], () => {
  sequence++; request?.abort(); clearTimeout(requestTimer); loading.value = false; loadedAt = 0; items.value = []; close()
})
onUnmounted(() => { disposed = true; sequence++; cancelClose(); request?.abort(); clearTimeout(requestTimer); window.removeEventListener('resize',place); window.removeEventListener('scroll',place,true) })
</script>

<template>
  <button ref="anchor" type="button" class="factory-summary-trigger" :aria-label="`${factoryName}的${label}：${count}`" :aria-describedby="open ? tooltipId : undefined"
    @mouseenter="show" @mouseleave="scheduleClose" @focus="show" @blur="scheduleClose" @click="show" @keydown.esc.stop="close">{{ count }}</button>
  <Teleport to="body">
    <div v-if="open" :id="tooltipId" ref="popup" role="tooltip" class="factory-structure-tooltip" :style="position" :data-factory-id="factoryId" :data-kind="kind"
      @mouseenter="cancelClose" @mouseleave="scheduleClose" @keydown.esc="close">
      <header><strong>{{ factoryName }}</strong><span>{{ label }}</span></header>
      <div v-if="loading" class="structure-state">读取中…</div>
      <div v-else-if="error" class="structure-state error">{{ error }}</div>
      <ul v-else-if="items.length"><li v-for="item in items" :key="item.id">{{ item.name }}</li></ul>
      <div v-else class="structure-state">暂无{{ label }}</div>
    </div>
  </Teleport>
</template>

<style scoped>
.factory-summary-trigger{min-width:24px;padding:3px 2px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:help;text-decoration:underline dotted #b5c3d3;text-underline-offset:4px}
.factory-summary-trigger:hover,.factory-summary-trigger:focus-visible{color:#2865b9;background:#edf4ff;outline:none}
.factory-summary-trigger:focus-visible{box-shadow:0 0 0 2px #94b7ed}
.factory-structure-tooltip{position:fixed;z-index:3200;box-sizing:border-box;width:max-content;min-width:min(170px,calc(100vw - 24px));max-width:min(310px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:10px 12px;border:1px solid #d6e1ec;border-radius:9px;background:#fff;box-shadow:0 10px 32px #1c35542b;color:#4d5d73;font-size:12px;line-height:1.6}
.factory-structure-tooltip header{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding-bottom:6px;border-bottom:1px solid #edf1f6}.factory-structure-tooltip strong{font-size:12px;color:#293d58;overflow-wrap:anywhere}.factory-structure-tooltip header span{font-size:11px;color:#8a98ab;white-space:nowrap}
.factory-structure-tooltip ul{max-height:min(230px,calc(100vh - 110px));overflow:auto;overscroll-behavior:contain;list-style:none;margin:5px 0 0;padding:0 4px 0 0}.factory-structure-tooltip li{padding:3px 0;overflow-wrap:anywhere}.structure-state{padding:9px 0 3px;color:#8996a8}.structure-state.error{color:#ae5461}
</style>
