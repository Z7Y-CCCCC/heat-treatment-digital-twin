<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { factoryDirectorySites } from '../../../runtime/groupTopology.js'
import { buildFactoryDistributionPreview } from '../../../runtime/factoryDistributionPreview.js'

const props = defineProps({ refreshKey: { type: Number, default: 0 } })
const open = ref(false)
const pinned = ref(false)
const loading = ref(false)
const error = ref('')
const preview = ref(null)
let loaded = false
let closeTimer = 0
let requestId = 0

const topRegions = computed(() => preview.value?.regions.slice(0, 5) || [])
const overseasRegions = computed(() => preview.value?.overseasRegions.slice(0, 4) || [])
const empty = computed(() => preview.value && preview.value.chinaCount + preview.value.overseasCount === 0)

function cancelClose() {
  window.clearTimeout(closeTimer)
}

function scheduleClose() {
  if (pinned.value) return
  cancelClose()
  closeTimer = window.setTimeout(() => { open.value = false }, 160)
}

async function loadPreview(force = false) {
  if (loading.value && !force || loaded && !force) return
  const currentRequest = ++requestId
  loading.value = true
  error.value = ''
  try {
    const [factoryResult, response] = await Promise.all([
      adminApi.listFactories(),
      fetch('/maps/china-provinces.geojson')
    ])
    if (!response.ok) throw new Error(`地图轮廓加载失败（${response.status}）`)
    const map = await response.json()
    const config = { factories: factoryResult.factories || [] }
    const sites = factoryDirectorySites(config)
    if (currentRequest !== requestId) return
    preview.value = buildFactoryDistributionPreview(sites, map.features)
    loaded = true
  } catch (cause) {
    if (currentRequest === requestId) error.value = cause?.message || '暂时无法加载分布预览'
  } finally {
    if (currentRequest === requestId) loading.value = false
  }
}

function show() {
  cancelClose()
  open.value = true
  void loadPreview()
}

function toggle() {
  pinned.value = !pinned.value
  if (pinned.value) show()
  else open.value = false
}

function dismiss() {
  pinned.value = false
  open.value = false
}

watch(() => props.refreshKey, () => {
  loaded = false
  if (open.value) void loadPreview(true)
})

onUnmounted(() => {
  cancelClose()
  requestId++
})
</script>

<template>
  <div class="distribution-preview-anchor" @mouseenter="show" @mouseleave="scheduleClose" @focusin="show" @focusout="scheduleClose" @keydown.esc="dismiss">
    <button class="distribution-preview-trigger" type="button" :aria-expanded="open" aria-haspopup="dialog" @click="toggle">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5 8 3l4 1.5L17 3v12.5L12 17l-4-1.5-5 1.5zM8 3v12.5m4-11V17" /></svg>
      工厂分布预览
      <span>悬停查看</span>
    </button>

    <Transition name="distribution-preview">
      <section v-if="open" class="distribution-preview-popover" role="dialog" aria-label="工厂分布轻量预览" @mouseenter="cancelClose" @mouseleave="scheduleClose">
        <header><div><strong>工厂分布</strong><small>按行政区粗略定位</small></div><span v-if="preview">{{ preview.chinaCount + preview.overseasCount }} 座</span></header>
        <div v-if="loading" class="distribution-preview-state"><i></i>正在载入地图轮廓…</div>
        <p v-else-if="error" class="distribution-preview-error" role="status">{{ error }}</p>
        <div v-else-if="preview" class="distribution-preview-content">
          <svg class="distribution-preview-map" viewBox="0 0 320 220" role="img" aria-label="中国各省工厂分布示意图">
            <path v-for="province in preview.provinces" :key="province.code" :d="province.path" :class="{ populated: province.count > 0 }" />
            <g v-for="marker in preview.markers" :key="marker.code" class="distribution-marker" :transform="`translate(${marker.x} ${marker.y})`">
              <circle r="7" /><text y=".7">{{ marker.count > 9 ? '9+' : marker.count }}</text>
              <title>{{ marker.name }}：{{ marker.count }} 座</title>
            </g>
          </svg>
          <p v-if="empty" class="distribution-empty">还没有可展示的工厂登记</p>
          <div v-else class="distribution-preview-stats">
            <span><i class="stat-dot china"></i>中国 {{ preview.chinaCount }} 座</span>
            <span v-if="preview.overseasCount"><i class="stat-dot overseas"></i>境外 {{ preview.overseasCount }} 座</span>
            <span v-if="preview.unassignedChinaCount"><i class="stat-dot pending"></i>未定位 {{ preview.unassignedChinaCount }} 座</span>
          </div>
          <div v-if="topRegions.length" class="distribution-preview-regions">
            <span v-for="region in topRegions" :key="region.code"><b>{{ region.name }}</b><em>{{ region.count }}</em></span>
          </div>
          <div v-if="overseasRegions.length" class="distribution-preview-regions overseas-regions" aria-label="境外国家分布">
            <span v-for="region in overseasRegions" :key="region.code"><b>境外 {{ region.code }}</b><em>{{ region.count }}</em></span>
          </div>
          <small class="distribution-preview-footnote">仅加载行政区轮廓与工厂摘要；点击分布地图不会启动实时大屏。</small>
        </div>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.distribution-preview-anchor{position:relative;display:inline-flex;align-items:center}.distribution-preview-trigger{display:inline-flex;align-items:center;gap:7px;border:1px solid #d4dbea;border-radius:7px;padding:9px 12px;background:#fff;color:#4262a1;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.distribution-preview-trigger:hover,.distribution-preview-trigger[aria-expanded=true]{border-color:#9bb7ee;background:#f7faff}.distribution-preview-trigger svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.distribution-preview-trigger span{color:#8792a6;font-size:10px}.distribution-preview-popover{position:absolute;z-index:90;top:calc(100% + 9px);left:0;width:min(380px,calc(100vw - 32px));padding:14px;border:1px solid #d9e0eb;border-radius:12px;background:#fff;box-shadow:0 18px 48px rgba(22,34,55,.2);color:#263349}.distribution-preview-popover:before{position:absolute;top:-6px;left:22px;width:10px;height:10px;border-top:1px solid #d9e0eb;border-left:1px solid #d9e0eb;background:#fff;content:"";transform:rotate(45deg)}.distribution-preview-popover header{display:flex;justify-content:space-between;align-items:center;padding:0 2px 10px;border-bottom:1px solid #edf0f5}.distribution-preview-popover header div{display:grid;gap:3px}.distribution-preview-popover header strong{font-size:13px}.distribution-preview-popover header small,.distribution-preview-footnote{color:#8893a6;font-size:10px}.distribution-preview-popover header>span{color:#52637e;font-size:11px}.distribution-preview-map{display:block;width:100%;height:210px;margin:7px auto 2px}.distribution-preview-map path{fill:#e8edf4;stroke:#c4cfdd;stroke-width:.65;vector-effect:non-scaling-stroke}.distribution-preview-map path.populated{fill:#cedaf0;stroke:#9eafd0}.distribution-marker circle{fill:#3973de;stroke:#fff;stroke-width:1.4}.distribution-marker text{fill:#fff;font:600 7px Inter,"Microsoft YaHei",sans-serif;text-anchor:middle;dominant-baseline:middle}.distribution-preview-stats{display:flex;gap:12px;flex-wrap:wrap;padding:2px 3px 7px;color:#5d6b80;font-size:10px}.distribution-preview-stats span{display:inline-flex;align-items:center;gap:5px}.stat-dot{width:6px;height:6px;border-radius:50%;background:#3973de}.stat-dot.overseas{background:#8d76d6}.stat-dot.pending{background:#d7a34b}.distribution-preview-regions{display:flex;gap:5px;flex-wrap:wrap;padding:4px 2px 8px}.distribution-preview-regions span{display:inline-flex;gap:6px;align-items:center;padding:4px 7px;border-radius:5px;background:#f3f6fa;color:#59677b;font-size:10px}.distribution-preview-regions em{font-style:normal;color:#315fae}.distribution-preview-footnote{display:block;padding:7px 2px 0;border-top:1px solid #edf0f5;line-height:1.5}.distribution-preview-state{display:flex;align-items:center;justify-content:center;gap:8px;min-height:190px;color:#7e8ba0;font-size:12px}.distribution-preview-state i{width:14px;height:14px;border:2px solid #dce5f3;border-top-color:#4679d8;border-radius:50%;animation:spin .8s linear infinite}.distribution-preview-error{padding:28px 8px;color:#ae4650;font-size:12px}.distribution-empty{text-align:center;color:#7e8ba0;font-size:11px}.distribution-preview-enter-active,.distribution-preview-leave-active{transition:opacity .15s ease,transform .15s ease}.distribution-preview-enter-from,.distribution-preview-leave-to{opacity:0;transform:translateY(-4px)}@keyframes spin{to{transform:rotate(360deg)}}
</style>
