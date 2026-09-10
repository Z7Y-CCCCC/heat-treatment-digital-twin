<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useFactoryConfig } from './config/factoryConfig.js'
import { SceneRuntime } from './runtime/SceneRuntime.js'
import { createDashboardDataStore } from './runtime/DataStore.js'
import { getSceneCamera } from './runtime/LayoutConfig.js'
import WidgetRenderer from './runtime/WidgetRenderer.vue'
import { normalizeRenderSettings } from './runtime/renderConfig.js'
import { createVoiceAnnouncer } from './runtime/VoiceAnnouncer.js'
import {
  DEFAULT_DEVICE_LABEL_CONFIG,
  DEFAULT_DIAGNOSTIC_CONFIG,
  DEFAULT_LINE_OVERVIEW_CONFIG,
  buildDiagnosticGroups,
  normalizeDeviceLabelConfig
} from './runtime/uiConfig.js'

const threeContainer = ref(null)
const currentLevel = ref(0)
const currentWorkshop = ref(-1)
const currentLine = ref(-1)
const currentTime = ref('')
const currentDate = ref('')
const isDrawerOpen = ref(true)
const topLevel = ref(0)

let sceneRuntime = null
let clockTimer = null

const dataStore = createDashboardDataStore()
const voiceAnnouncer = createVoiceAnnouncer()
const {
  config: factoryConfig,
  loadConfig,
  getWorkshops,
  getSetting,
  getFactoryName,
  getPlatform
} = useFactoryConfig()

const allWorkshops = computed(() => getWorkshops())
const platform = computed(() => getPlatform() || {})
const CONFIG_ONLY_WIDGET_TYPES = new Set(['device_label', 'diagnostics', 'line_overview_cards'])
const defaultDashboardWidgets = [
  { id: 'widget_navigation', widget_type: 'navigation', title: '层级导航', x: 0, y: 0, w: 5, h: 5, sort_order: 0, visible: true, config: {}, binding: {} },
  { id: 'widget_metrics', widget_type: 'metrics', title: '生产指标', x: 0, y: 5, w: 5, h: 5, sort_order: 1, visible: true, config: { compact: true }, binding: {} },
  { id: 'widget_trend', widget_type: 'trend', title: '历史趋势', x: 19, y: 0, w: 5, h: 5, sort_order: 2, visible: true, config: { metric: 'avg_temp' }, binding: {} },
  { id: 'widget_alarms', widget_type: 'alarm_list', title: '报警履历', x: 19, y: 5, w: 5, h: 5, sort_order: 3, visible: true, config: { limit: 5 }, binding: {} },
  { id: 'widget_marquee', widget_type: 'marquee', title: '实时日志', x: 3, y: 11, w: 18, h: 1, sort_order: 4, visible: true, config: { speed: 30, limit: 20, eventWindowHours: 24 }, binding: {} }
]
const dashboardWidgets = computed(() => {
  if (currentLevel.value >= 3) return []
  const widgets = platform.value.widgets?.length ? platform.value.widgets : defaultDashboardWidgets
  return widgets
    .filter(widget => widget.visible !== 0 && widget.visible !== false)
    .filter(widget => !CONFIG_ONLY_WIDGET_TYPES.has(widget.widget_type))
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
})

function getPlatformWidget(widgetType) {
  return (platform.value.widgets || []).find(item => item.widget_type === widgetType || item.id === `widget_${widgetType}`) || null
}

function getPlatformWidgetConfig(widgetType, fallback = {}) {
  return getPlatformWidget(widgetType)?.config || fallback
}

function getEventQueryConfig() {
  const marqueeConfig = getPlatformWidgetConfig('marquee', { limit: 20, eventWindowHours: 24 })
  const alarmConfig = getPlatformWidgetConfig('alarm_list', { limit: 5 })
  return {
    limit: marqueeConfig.limit || alarmConfig.limit || 20,
    eventWindowHours: marqueeConfig.eventWindowHours ?? marqueeConfig.windowHours ?? 24,
    eventType: marqueeConfig.eventType || marqueeConfig.event_type || ''
  }
}

function isPlatformWidgetVisible(widgetType, defaultVisible = true) {
  const widget = getPlatformWidget(widgetType)
  if (!widget) return defaultVisible
  return widget.visible !== 0 && widget.visible !== false
}

const deviceLabelConfig = computed(() => {
  const config = getPlatformWidgetConfig('device_label', DEFAULT_DEVICE_LABEL_CONFIG)
  return normalizeDeviceLabelConfig({
    ...config,
    enabled: isPlatformWidgetVisible('device_label', true) && config.enabled !== false
  })
})
const diagnosticPanelConfig = computed(() => getPlatformWidgetConfig('diagnostics', DEFAULT_DIAGNOSTIC_CONFIG))
const isDiagnosticPanelVisible = computed(() => isPlatformWidgetVisible('diagnostics', true))
const lineOverviewConfig = computed(() => ({
  ...DEFAULT_LINE_OVERVIEW_CONFIG,
  ...getPlatformWidgetConfig('line_overview_cards', {})
}))
const isLineOverviewVisible = computed(() => isPlatformWidgetVisible('line_overview_cards', true))

const currentLineDevices = computed(() => {
  if (currentLine.value < 0) return []
  let c = 0
  for (const ws of allWorkshops.value) {
    for (const line of ws.lines || []) {
      if (c === currentLine.value) return line.devices || []
      c++
    }
  }
  return []
})

const lineOverviewDevices = computed(() => {
  const maxCards = Number(lineOverviewConfig.value.maxCards || 0)
  if (Number.isFinite(maxCards) && maxCards > 0) return currentLineDevices.value.slice(0, maxCards)
  return currentLineDevices.value
})

const headerKpis = computed(() => {
  const metrics = dataStore.metrics
  const alarms = Number(metrics.alarm_devices || 0)
  const oee = Number(metrics.overall_oee || 0).toFixed(1)
  return [
    { label: '在线设备', value: `${metrics.online_devices || 0}/${metrics.total_devices || 0}`, tone: 'good' },
    { label: '运行设备', value: metrics.running_devices || 0, tone: 'good' },
    { label: 'OEE', value: `${oee}%`, tone: Number(oee) >= 80 ? 'good' : 'warn' },
    { label: '今日产出', value: metrics.current_output || 0, tone: 'normal' },
    { label: '报警设备', value: alarms, tone: alarms > 0 ? 'bad' : 'good' }
  ]
})

function valueOrDash(value) {
  return value === undefined || value === null || value === '' ? '--' : value
}

function runningText(value) {
  return value ? '运行' : '停止'
}

function gasValveRows(data) {
  const gas = data.gas || {}
  const rows = []
  for (let i = 1; i <= 10; i++) {
    const on = !!gas[`valve_${i}_on`]
    const flow = valueOrDash(gas[`valve_${i}_flow`])
    rows.push({
      label: `阀${i}`,
      value: `${on ? '开' : '关'} / ${flow}`,
      unit: flow === '--' ? '' : 'Nm³/h',
      quality: data.quality?.gas?.[`valve_${i}_flow`] || data.quality?.gas?.[`valve_${i}_on`]
    })
  }
  return rows
}

const diagnosticGroups = computed(() => buildDiagnosticGroups(
  dataStore.selectedDeviceData,
  diagnosticPanelConfig.value
))

function updateTime() {
  const now = new Date()
  currentTime.value = now.toLocaleTimeString()
  currentDate.value = now.toLocaleDateString()
}

function handleWorkshopSelected(e) {
  currentWorkshop.value = e.detail
  currentLine.value = -1
  currentLevel.value = 1
}

function handleLineSelected(e) {
  currentLine.value = e.detail
  currentLevel.value = 2
}

function handleFactorySelected() {
  currentWorkshop.value = -1
  currentLine.value = -1
  currentLevel.value = 0
}

function getGlobalLineIdx(wIdx, lIdx) {
  let count = 0
  for (let i = 0; i < wIdx; i++) count += (allWorkshops.value[i].lines || []).length
  return count + lIdx
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
}

function selectGlobal() {
  currentWorkshop.value = -1
  currentLine.value = -1
  sceneRuntime?.flyToFactory()
}

function selectWorkshop(idx) {
  currentWorkshop.value = idx
  currentLine.value = -1
  sceneRuntime?.flyToWorkshop(idx)
}

function selectLine(idx) {
  currentLine.value = idx
  sceneRuntime?.flyToLine(idx)
}

function goBack() {
  sceneRuntime?.goUp()
  isDrawerOpen.value = true
}

function canGoBack() {
  return currentLevel.value > 0 && !(currentLevel.value === 1 && topLevel.value === 1)
}

function handleKeydown(event) {
  if (event.key !== 'Escape' || event.defaultPrevented || !canGoBack()) return

  const target = event.target
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return

  event.preventDefault()
  goBack()
}

function controlCamera(action) {
  sceneRuntime?.controlCamera(action)
}

function unlockVoicePlayback() {
  voiceAnnouncer.unlock()
}

function exposeDevRuntime() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  window.__DASHBOARD_RUNTIME__ = sceneRuntime
  window.__DASHBOARD_DATA_STORE__ = dataStore
}

function clearDevRuntime() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  delete window.__DASHBOARD_RUNTIME__
  delete window.__DASHBOARD_DATA_STORE__
}

function getWidgetGridStyle(widget) {
  const columns = platform.value.activeScene?.layout?.grid?.columns || 24
  const rows = platform.value.activeScene?.layout?.grid?.rows || 12
  const x = Number.isFinite(Number(widget.x)) ? Number(widget.x) : 0
  const y = Number.isFinite(Number(widget.y)) ? Number(widget.y) : 0
  const w = Number.isFinite(Number(widget.w)) ? Number(widget.w) : 4
  const h = Number.isFinite(Number(widget.h)) ? Number(widget.h) : 2
  return {
    left: `${Math.max(0, Math.min(columns, x)) / columns * 100}%`,
    top: `${Math.max(0, Math.min(rows, y)) / rows * 100}%`,
    width: `${Math.max(1, Math.min(columns, w)) / columns * 100}%`,
    height: `${Math.max(1, Math.min(rows, h)) / rows * 100}%`
  }
}

onMounted(async () => {
  updateTime()
  clockTimer = setInterval(updateTime, 1000)
  await loadConfig()
  voiceAnnouncer.setFactoryPoints(factoryConfig.workshops)

  const sceneCamera = getSceneCamera(platform.value)
  dataStore.setStaleMs(getSetting('realtime_stale_ms', sceneCamera.staleMs || 6000))
  dataStore.setEventQueryOptions(getEventQueryConfig())

  sceneRuntime = new SceneRuntime(threeContainer.value, {
    workshops: getWorkshops(),
    models: factoryConfig.models || [],
    cameraMode: getSetting('camera_mode', sceneCamera.mode || 'auto'),
    renderOptions: normalizeRenderSettings(factoryConfig.settings),
    deviceLabelConfig: deviceLabelConfig.value,
    onLevelChange: level => { currentLevel.value = level },
    onDeviceSelect: deviceId => dataStore.selectDevice(deviceId),
    onDeviceRegistered: deviceCfg => dataStore.registerDevice(deviceCfg)
  })

  await sceneRuntime.start()
  exposeDevRuntime()
  topLevel.value = sceneRuntime.sceneManager?.topLevel ?? 0
  if (topLevel.value === 1) {
    selectWorkshop(0)
  } else {
    selectGlobal()
  }
  dataStore.setDeviceDataHandler(data => {
    sceneRuntime.applyDeviceData(data)
    voiceAnnouncer.handleDeviceData(data)
  })
  dataStore.connect()
  dataStore.refreshEvents(true)
  dataStore.refreshMetrics(true)

  window.addEventListener('workshop-selected', handleWorkshopSelected)
  window.addEventListener('line-selected', handleLineSelected)
  window.addEventListener('factory-selected', handleFactorySelected)
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('pointerdown', unlockVoicePlayback, { passive: true })
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
  dataStore.dispose()
  sceneRuntime?.dispose()
  sceneRuntime = null
  clearDevRuntime()
  window.removeEventListener('workshop-selected', handleWorkshopSelected)
  window.removeEventListener('line-selected', handleLineSelected)
  window.removeEventListener('factory-selected', handleFactorySelected)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('pointerdown', unlockVoicePlayback)
})
</script>

<template>
  <div class="dashboard-container">
    <div ref="threeContainer" class="three-layer"></div>

    <div class="ui-layer" :class="'level-' + currentLevel">
      <header class="header">
        <div class="header-left">
          <div class="brand-block">
            <span>Heat Treatment Digital Twin</span>
            <h1>{{ getFactoryName() }}</h1>
            <p>{{ platform.activeProject?.name || '热处理车间大屏项目' }} / {{ platform.activeScene?.name || '工厂总览' }}</p>
          </div>
          <div class="connection-pill" :class="{ online: dataStore.wsConnected.value }">
            <span></span>{{ dataStore.plcStatusText.value }}
          </div>
        </div>
        <div class="header-center header-kpis">
          <div class="kpi-chip" v-for="item in headerKpis" :key="item.label" :class="'tone-' + item.tone">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
        <div class="header-right">
          <div class="time"><span>{{ currentDate }}</span>{{ currentTime }}</div>
          <button class="icon-btn" @click="toggleFullscreen" title="全屏切换">⛶</button>
        </div>
      </header>

      <div class="config-widget-layer" v-if="dashboardWidgets.length">
        <div
          v-for="widget in dashboardWidgets"
          :key="widget.id"
          class="config-widget-slot"
          :class="'widget-type-' + widget.widget_type"
          :style="getWidgetGridStyle(widget)"
        >
          <div v-if="widget.widget_type === 'navigation'" class="navigation-widget widget-shell industrial-panel">
            <div class="widget-title"><i></i>{{ widget.title }}</div>
            <div class="navigation-panel">
              <div v-if="topLevel === 0" class="menu-item" :class="{ active: currentLevel === 0 }" @click="selectGlobal">
                <span class="menu-icon">▦</span> 全局总览
              </div>
              <template v-for="(ws, wIdx) in allWorkshops" :key="ws.id">
                <div class="menu-item workshop-item" :class="{ active: currentLevel === 1 && currentWorkshop === wIdx }" @click="selectWorkshop(wIdx)">
                  <span class="menu-icon">厂</span>{{ ws.name }}
                </div>
                <div
                  v-for="(line, lIdx) in ws.lines"
                  :key="line.id"
                  class="menu-item line-item"
                  :class="{ active: currentLevel === 2 && currentLine === getGlobalLineIdx(wIdx, lIdx) }"
                  @click="selectLine(getGlobalLineIdx(wIdx, lIdx))"
                >
                  <span class="menu-icon">→</span>{{ line.name }}
                </div>
              </template>
            </div>
          </div>
          <WidgetRenderer
            v-else
            :widget="widget"
            :metrics="dataStore.metrics"
            :events="dataStore.events.value"
            :trend-points="dataStore.trendPoints.value"
            :device-status-map="dataStore.deviceStatusMap"
            :device-data-map="dataStore.deviceDataMap"
          />
        </div>
      </div>

      <transition name="slide-up">
        <div class="bottom-drawer-panel industrial-panel" v-if="currentLevel === 3 && isDiagnosticPanelVisible" :class="{ 'drawer-closed': !isDrawerOpen }">
          <div class="drawer-handle" @click="isDrawerOpen = !isDrawerOpen">
            {{ isDrawerOpen ? '收起诊断面板' : '展开诊断面板' }}
          </div>
          <div class="drawer-content">
            <h2>{{ dataStore.selectedDeviceData.furnace_name || '设备' }} 详细诊断</h2>
            <div class="diagnostic-grid">
              <div class="diag-card" v-for="group in diagnosticGroups" :key="group.title">
                <h3>{{ group.title }}</h3>
                <div class="diag-row" v-for="row in group.rows" :key="row.label">
                  <span>{{ row.label }}</span>
                  <strong :class="'quality-' + (row.quality || 'good')">{{ row.value }} <em>{{ row.unit }}</em></strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <div class="camera-controls" v-if="currentLevel === 3">
        <button class="tool-btn" @click="controlCamera('rotateLeft')" title="向左旋转">↺</button>
        <button class="tool-btn" @click="controlCamera('rotateRight')" title="向右旋转">↻</button>
        <button class="tool-btn" @click="controlCamera('zoomIn')" title="拉近放大">＋</button>
        <button class="tool-btn" @click="controlCamera('zoomOut')" title="拉远缩小">－</button>
      </div>

      <button class="back-btn" v-if="canGoBack()" @click="goBack">
        返回上一级
      </button>

      <transition name="fade-up">
        <div class="device-overview-bar" v-if="currentLevel === 2 && isLineOverviewVisible && lineOverviewDevices.length > 0">
          <div
            v-for="deviceCfg in lineOverviewDevices"
            :key="deviceCfg.id"
            class="device-mini-card industrial-panel"
            :class="[
              'quality-' + (dataStore.deviceStatusMap[deviceCfg.id]?.quality || 'bad'),
              { 'alarm-flash': dataStore.deviceStatusMap[deviceCfg.id]?.alarm }
            ]"
          >
            <div class="card-header">
              <span class="dot" :class="dataStore.deviceStatusMap[deviceCfg.id]?.quality || 'bad'"></span>
              {{ dataStore.deviceStatusMap[deviceCfg.id]?.name || deviceCfg.name }}
            </div>
            <div class="card-body">
              <span v-if="lineOverviewConfig.showTemperature !== false">{{ dataStore.deviceStatusMap[deviceCfg.id]?.temp || '--' }} {{ lineOverviewConfig.temperatureUnit }}</span>
              <span v-if="lineOverviewConfig.showCarbon !== false">{{ dataStore.deviceStatusMap[deviceCfg.id]?.carbon || '--' }} {{ lineOverviewConfig.carbonUnit }}</span>
            </div>
          </div>
        </div>
      </transition>

    </div>
  </div>
</template>

<style>
html, body { margin: 0; padding: 0; }
html, body, #app { width: 100%; height: 100%; overscroll-behavior: none; }

.dashboard-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
  color: #f3f5f4;
  background: #a9b0ad;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  user-select: none;
  touch-action: none;
}

.dashboard-container::before,
.dashboard-container::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  z-index: 4;
  pointer-events: none;
}

.dashboard-container::before {
  top: 0;
  height: 150px;
  background: linear-gradient(180deg, rgba(14, 18, 20, .72), rgba(14, 18, 20, .22), transparent);
}

.dashboard-container::after {
  bottom: 0;
  height: 170px;
  background: linear-gradient(0deg, rgba(12, 15, 17, .62), rgba(12, 15, 17, .2), transparent);
}

.three-layer { position: absolute; inset: 0; z-index: 1; touch-action: none; }
.ui-layer { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
.ui-layer > * { pointer-events: auto; }

.header {
  position: absolute;
  top: 14px;
  left: 22px;
  right: 22px;
  height: 72px;
  display: grid;
  grid-template-columns: minmax(360px, 430px) 1fr minmax(250px, 320px);
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  background: rgba(17, 21, 23, .82);
  border: 1px solid rgba(218, 224, 222, .24);
  box-shadow: 0 12px 34px rgba(0, 0, 0, .24);
}

.header-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand-block { min-width: 0; }
.brand-block span { display: block; color: #8ec7a4; font-size: 10px; line-height: 1; text-transform: uppercase; letter-spacing: 1.8px; }
.brand-block h1 { margin: 5px 0 3px; color: #ffffff; font-size: 22px; line-height: 1.1; letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brand-block p { margin: 0; color: #b7c0bd; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.header-center { text-align: center; }
.header-kpis { display: grid; grid-template-columns: repeat(5, minmax(92px, 1fr)); gap: 10px; min-width: 0; }
.kpi-chip {
  min-width: 0;
  height: 48px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, .055);
  border: 1px solid rgba(255, 255, 255, .1);
  border-left: 3px solid #7f8a8b;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.kpi-chip span { color: #aeb7b4; font-size: 11px; line-height: 1; }
.kpi-chip strong { margin-top: 5px; color: #f5f7f6; font-family: Consolas, 'Microsoft YaHei', sans-serif; font-size: 18px; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kpi-chip.tone-good { border-left-color: #48b982; }
.kpi-chip.tone-warn { border-left-color: #d4a24a; }
.kpi-chip.tone-bad { border-left-color: #d65f59; }
.header-right { justify-self: end; display: flex; align-items: center; gap: 16px; }
.time { font-family: Consolas, monospace; color: #f2b85b; font-size: 20px; white-space: nowrap; }
.time span { margin-right: 12px; color: #b7c0bd; font-size: 13px; }
.icon-btn { width: 44px; height: 44px; border: 1px solid rgba(218,224,222,.25); background: rgba(255,255,255,.055); color: #e8ecef; cursor: pointer; font-size: 21px; touch-action: manipulation; }
.icon-btn:hover { background: rgba(242,184,91,.16); border-color: rgba(242,184,91,.52); }

.connection-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 7px 10px;
  border: 1px solid rgba(218,224,222,.18);
  background: rgba(0, 0, 0, .2);
  color: #c5cfcb;
  font-size: 12px;
}
.connection-pill span { width: 8px; height: 8px; border-radius: 50%; background: #d96060; }
.connection-pill.online span { background: #4fc08d; box-shadow: 0 0 10px rgba(79, 192, 141, .8); }

.industrial-panel {
  background: rgba(18, 22, 24, .72);
  border: 1px solid rgba(229, 234, 232, .18);
  box-shadow: 0 14px 34px rgba(0, 0, 0, .24);
}

.side-panel { position: absolute; top: 106px; bottom: 72px; width: 354px; display: flex; flex-direction: column; gap: 12px; }
.left-panel { left: 24px; }
.right-panel { right: 24px; width: 374px; }

.navigation-panel { padding: 10px; max-height: 38vh; overflow-y: auto; }
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 42px;
  padding: 10px 12px;
  margin-bottom: 7px;
  color: #d7dedb;
  cursor: pointer;
  border-left: 3px solid transparent;
  background: rgba(255, 255, 255, .045);
  touch-action: manipulation;
  transition: background .18s ease, border-color .18s ease, color .18s ease;
}
.menu-item:hover { background: rgba(255, 255, 255, .08); }
.line-item { margin-left: 16px; color: #b4bdb9; }
.menu-item.active { border-left-color: #f2b85b; background: rgba(242, 184, 91, .16); color: #fff; }
.menu-icon { width: 22px; color: #f2b85b; text-align: center; }

.widget-shell { padding: 14px; min-height: 150px; }
.widget-title { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; font-weight: 600; color: #f4f7f6; font-size: 14px; }
.widget-title i { width: 3px; height: 16px; background: #f2b85b; display: inline-block; }
.metrics-layout { display: grid; grid-template-columns: 128px 1fr; gap: 12px; align-items: center; }
.widget-chart { width: 100%; height: 142px; }
.trend-chart { height: 220px; }
.metric-list { display: grid; gap: 8px; }
.metric-row { display: flex; justify-content: space-between; padding: 8px 10px; background: rgba(255,255,255,.05); color: #b9c3bf; font-size: 13px; }
.metric-row strong { color: #f4f7f6; }
.text-widget-body { height: calc(100% - 30px); display: flex; flex-direction: column; justify-content: center; gap: 6px; color: #d2d8dc; font-size: 16px; line-height: 1.45; }
.text-widget-body p { margin: 0; }
.text-widget-body.tone-warning { color: #ffd180; }
.text-widget-body.tone-critical { color: #ff8a80; }
.text-widget-body.tone-success { color: #9be7be; }
.alarm-list { padding: 0; margin: 0; list-style: none; }
.alarm-list li { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
.rank { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; background: #4d5656; color: #fff; font-size: 12px; }
.rank.critical, .tag.critical { background: #9f3333; }
.rank.warning, .tag.warning { background: #a6762d; }
.rank.info, .tag.info { background: #3f6f8a; }
.alarm-txt { flex: 1; color: #d7dedb; font-size: 13px; }
.tag { padding: 3px 6px; color: #fff; font-size: 11px; }

.config-widget-layer {
  position: absolute;
  inset: 106px 24px 72px;
  pointer-events: none;
}
.config-widget-slot {
  position: absolute;
  min-width: 180px;
  min-height: 74px;
  padding: 0 8px 8px 0;
  pointer-events: auto;
  box-sizing: border-box;
}
.config-widget-slot .widget-shell { width: 100%; height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; }
.navigation-widget { display: flex; flex-direction: column; }
.navigation-widget .navigation-panel { flex: 1; min-height: 0; max-height: none; overflow-y: auto; padding: 0; }
.config-widget-slot.widget-type-alarm_list .alarm-list { max-height: calc(100% - 30px); overflow-y: auto; }
.config-widget-slot.widget-type-marquee .widget-shell { min-height: 0; padding: 0 14px; }
.config-widget-slot.widget-type-marquee .widget-title { display: none; }
.config-widget-slot.widget-type-marquee .marquee-content-wrap { height: 100%; }

.bottom-drawer-panel { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); width: min(1220px, 92vw); transition: transform .35s; }
.bottom-drawer-panel.drawer-closed { transform: translateX(-50%) translateY(calc(100% - 44px)); }
.drawer-handle { height: 42px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.1); color: #f2b85b; font-size: 14px; letter-spacing: .5px; touch-action: manipulation; }
.drawer-content { padding: 16px 24px 22px; max-height: 43vh; overflow: auto; overscroll-behavior: contain; }
.drawer-content h2 { text-align: center; margin: 0 0 16px; font-size: 18px; color: #f5f7f6; }
.diagnostic-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.diag-card { padding: 12px 14px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.08); }
.diag-card h3 { margin: 0 0 10px; font-size: 13px; color: #f2b85b; }
.diag-row { display: flex; justify-content: space-between; align-items: center; min-height: 26px; margin: 6px 0; font-size: 13px; color: #b9c3bf; gap: 10px; }
.diag-row strong { color: #f5f7f6; }
.diag-row em { color: #b9c3bf; font-style: normal; font-size: 12px; }

.camera-controls { position: absolute; right: 28px; top: 50%; transform: translateY(-50%); display: grid; gap: 10px; }
.tool-btn { width: 52px; height: 52px; border: 1px solid rgba(218,224,222,.25); background: rgba(18,22,24,.86); color: #f2b85b; cursor: pointer; font-size: 23px; touch-action: manipulation; }
.tool-btn:hover, .back-btn:hover { background: rgba(242,184,91,.16); border-color: rgba(242,184,91,.52); }
.back-btn { position: absolute; top: 106px; left: 24px; min-height: 44px; padding: 9px 20px; border: 1px solid rgba(218,224,222,.25); background: rgba(18,22,24,.86); color: #f4f7f6; cursor: pointer; font-size: 14px; touch-action: manipulation; }

.device-overview-bar { position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; width: min(1120px, 88vw); }
.device-mini-card { width: 148px; min-height: 70px; padding: 11px 13px; touch-action: manipulation; }
.card-header { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #d96060; }
.dot.good { background: #4fc08d; }
.dot.stale { background: #f0b35a; }
.dot.bad { background: #d96060; }
.card-body { display: flex; justify-content: space-between; color: #f0b35a; font-size: 13px; }
.quality-stale { border-color: rgba(240, 179, 90, .55); }
.quality-bad { border-color: rgba(217, 96, 96, .72); opacity: .72; }
.diag-row strong.quality-stale { color: #f0b35a; }
.diag-row strong.quality-bad { color: #d96060; }

.bottom-marquee-bar { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); width: min(1120px, 78vw); height: 40px; overflow: hidden; pointer-events: auto; }
.bottom-marquee-bar .widget-shell { min-height: 0; height: 40px; padding: 0; background: rgba(18,22,24,.76); }
.bottom-marquee-bar .widget-title { display: none; }
.marquee-content-wrap { height: 100%; overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 5%, #000 95%, transparent); }
.marquee-content { display: flex; height: 100%; align-items: center; white-space: nowrap; animation: marqueeRoll 30s linear infinite; }
.marquee-item { margin-right: 42px; color: #d2d8dc; font-size: 13px; }
.marquee-item.critical { color: #ff8a80; }
.marquee-item.warning { color: #ffd180; }
.marquee-item.info { color: #9ad4f5; }

@keyframes marqueeRoll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@keyframes flashAlarm { 0%, 100% { box-shadow: 0 0 0 rgba(217,96,96,.0); } 50% { box-shadow: 0 0 18px rgba(217,96,96,.75); } }
.alarm-flash { animation: flashAlarm 1.2s infinite; }
.fade-slide-left-enter-active, .fade-slide-left-leave-active,
.fade-slide-right-enter-active, .fade-slide-right-leave-active,
.fade-up-enter-active, .fade-up-leave-active { transition: all .45s ease; }
.fade-slide-left-enter-from, .fade-slide-left-leave-to { opacity: 0; transform: translateX(-60px); }
.fade-slide-right-enter-from, .fade-slide-right-leave-to { opacity: 0; transform: translateX(60px); }
.fade-up-enter-from, .fade-up-leave-to { opacity: 0; transform: translate(-50%, 40px); }

.furnace-label,
.furnace-part-label {
  color: #f4f7f6;
  background: rgba(18, 22, 24, .84);
  border: 1px solid rgba(242, 184, 91, .35);
  box-shadow: 0 8px 18px rgba(0,0,0,.32);
  pointer-events: none;
}

.furnace-label {
  min-width: 132px;
  padding: 8px 10px;
  font-size: 12px;
}

.furnace-label .header {
  position: static;
  display: block;
  height: auto;
  padding: 0 0 5px;
  background: transparent;
  color: var(--device-label-title-color, #f2b85b);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0;
}

.furnace-label .data-row { display: flex; justify-content: space-between; gap: 8px; line-height: 1.5; color: var(--device-label-text-color, #d7dedb); }
.furnace-label span { color: var(--device-label-value-color, #ffffff); font-weight: 700; }
.furnace-part-label { padding: 5px 8px; color: #ffd180; font-size: 11px; white-space: nowrap; }
.device-connection-badge {
  min-width: 48px;
  padding: 6px 10px;
  border-radius: 4px;
  position: relative;
  z-index: 5;
  background: rgba(28, 31, 33, .9);
  border: 1px solid rgba(255,255,255,.18);
  color: #f4f7f6;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .08em;
  pointer-events: none;
  text-align: center;
  white-space: nowrap;
  box-shadow: 0 8px 24px rgba(0,0,0,.26);
}
.device-connection-badge.bad {
  background: rgba(74, 78, 80, .92);
  border-color: rgba(210, 216, 216, .38);
}
.device-connection-badge.stale {
  color: #1d1d1f;
  background: rgba(240, 179, 90, .94);
  border-color: rgba(255, 230, 180, .72);
}

.factory-guide-label {
  min-width: 108px;
  padding: 7px 10px 8px;
  color: #f4f7f6;
  background: rgba(20, 24, 25, .8);
  border: 1px solid rgba(226, 173, 79, .46);
  border-left: 3px solid #e0ad4f;
  box-shadow: 0 8px 18px rgba(0, 0, 0, .24);
  pointer-events: none;
}

.factory-guide-label span {
  display: block;
  color: #aeb8b4;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}

.factory-guide-label strong {
  display: block;
  margin-top: 5px;
  color: #ffd180;
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .header { grid-template-columns: minmax(260px, 1fr) minmax(330px, 1.4fr) minmax(190px, .7fr); left: 14px; right: 14px; }
  .header-kpis { grid-template-columns: repeat(3, minmax(84px, 1fr)); }
  .side-panel { width: 320px; }
  .right-panel { width: 330px; }
  .diagnostic-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
