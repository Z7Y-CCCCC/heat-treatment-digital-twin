<script setup>
import { computed, nextTick, ref } from 'vue'
import { GROUP_MAP_LEVELS } from '../../../runtime/groupPortalAppearance.js'
import GroupPortalSettings from './GroupPortalSettings.vue'
import DashboardDesigner from './DashboardDesigner.vue'
import LoadingExperienceSettings from './LoadingExperienceSettings.vue'
import FactorySiteSceneSettings from './FactorySiteSceneSettings.vue'

const emit = defineEmits(['reload', 'preview-view', 'open-data-sources'])
const activeSurface = ref('world')
const siteViewId = ref('site_street')
const dashboardDesigner = ref(null)
const mapBaseSettings = ref(null)
const groupPortalSettings = ref(null)
const siteSceneSettings = ref(null)
const loadingSettings = ref(null)
defineExpose({
    savePending: async () => {
        for (const editor of [dashboardDesigner.value, groupPortalSettings.value, siteSceneSettings.value, loadingSettings.value])
            await editor?.savePending?.()
        return true
    },
    discardPending: () => dashboardDesigner.value?.discardPending?.()
})
const showingMap = computed(() => GROUP_MAP_LEVELS.some(level=>level.key===activeSurface.value))
const showingSite = computed(() => activeSurface.value==='site')
const designerViewId = computed(() => activeSurface.value === 'site' ? siteViewId.value : activeSurface.value === 'factory' ? 'factory_overview' : `map_${activeSurface.value}`)

function selectSurface(surface) {
    activeSurface.value = surface
}
function syncSurface(viewId) {
    if (String(viewId).startsWith('map_')) activeSurface.value = String(viewId).slice(4)
    else if (String(viewId).startsWith('site_')) { siteViewId.value = viewId; activeSurface.value = 'site' }
    else activeSurface.value = 'factory'
}
async function editMapModule(key) {
    if (!showingMap.value) return
    mapBaseSettings.value.open = true
    await nextTick()
    groupPortalSettings.value?.selectComponent(key)
    mapBaseSettings.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function mapSettingsSaved(value) { dashboardDesigner.value?.setMapAppearance(value) }
</script>

<template>
    <section class="unified-dashboard-designer" aria-label="大屏画面设计器">
        <header class="unified-designer-header">
            <div><strong>大屏画面设计器</strong><small>01–07 共用组件库与自由画布。地图标题、统计、分布面板和底部摘要已列入图层；点击图层可直接打开该模块设置。</small></div>
            <div class="unified-designer-actions"><span>MAP → SITE → WORKSHOP → LINE → DEVICE</span><button type="button" @click="emit('open-data-sources')">配置外部数据连接 ↗</button></div>
        </header>
        <nav class="unified-designer-views" role="tablist" aria-label="选择大屏视角">
            <button v-for="(level,index) in GROUP_MAP_LEVELS" :key="level.key" type="button" role="tab" :aria-selected="activeSurface===level.key" :class="{active:activeSurface===level.key}" @click="selectSurface(level.key)"><i>{{ String(index+1).padStart(2,'0') }}</i>{{ level.label }}地图</button>
            <button type="button" role="tab" :aria-selected="activeSurface==='site'" :class="{active:activeSurface==='site'}" @click="selectSurface('site')"><i>06</i>街道 · 工厂建筑</button>
            <button type="button" role="tab" :aria-selected="activeSurface==='factory'" :class="{active:activeSurface==='factory'}" @click="selectSurface('factory')"><i>07</i>车间 · 产线 · 设备</button>
        </nav>
        <div class="unified-factory-workspace" role="tabpanel" aria-label="统一画面组件编辑">
            <DashboardDesigner ref="dashboardDesigner" :initial-view-id="designerViewId" @reload="emit('reload')" @preview-view="value=>emit('preview-view',value)" @view-change="syncSurface" @edit-map-module="editMapModule" />
        </div>
        <details v-if="showingMap" ref="mapBaseSettings" class="unified-base-settings"><summary>地图底图与内置模块 <span>标题、统计、分布面板和底部摘要可调整位置、显隐和数据</span></summary><GroupPortalSettings ref="groupPortalSettings" :active-level="activeSurface" designer-mode @saved="mapSettingsSaved" /></details>
        <details v-if="showingSite" class="unified-base-settings"><summary>街道与工厂建筑底层配置 <span>背景、建筑展示顺序、光标与悬停效果</span></summary><FactorySiteSceneSettings ref="siteSceneSettings" /></details>
        <details class="unified-loading-settings"><summary>加载画面 <span>启动页和大屏载入共用方案，可单独切换图片、颜色与文案</span></summary><LoadingExperienceSettings ref="loadingSettings" /></details>
    </section>
</template>

<style scoped>
.unified-dashboard-designer{min-width:0}.unified-designer-header{display:flex;justify-content:space-between;align-items:start;gap:18px;padding:15px 18px;border:1px solid #dfe2e7;border-bottom:0;border-radius:12px 12px 0 0;background:#fff;color:#242629}.unified-designer-header>div{display:grid;gap:5px}.unified-designer-header strong{font-size:17px}.unified-designer-header small{font-size:12px;color:#717781}.unified-designer-actions{justify-items:end}.unified-designer-actions span{color:#8d949e;font-size:10px;letter-spacing:.12em;white-space:nowrap}.unified-designer-actions button{padding:7px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc;color:#315ab9;font-size:11px;cursor:pointer}.unified-designer-actions button:hover{background:#edf3ff}.unified-designer-views{display:flex;gap:3px;overflow-x:auto;padding:6px 9px;border:1px solid #dfe2e7;background:#f6f7f9;scrollbar-width:thin}.unified-designer-views button{display:flex;align-items:center;gap:7px;flex:none;min-height:38px;padding:7px 12px;border:1px solid transparent;border-radius:7px;background:transparent;color:#606873;font-size:12px;cursor:pointer}.unified-designer-views button i{font-size:10px;font-style:normal;color:#98a2b3}.unified-designer-views button:hover{background:#ebedf1}.unified-designer-views button.active{border-color:#cdd4df;background:#fff;color:#1d2939;box-shadow:0 1px 4px #0f172a12}.unified-designer-views button.active i{color:#315ab9}.unified-map-workspace,.unified-factory-workspace{min-width:0}.unified-loading-settings{margin-top:15px;border:1px solid #dfe2e7;border-radius:12px;background:#fff;overflow:hidden}.unified-loading-settings summary{display:flex;gap:14px;align-items:center;padding:15px 18px;font-size:14px;font-weight:650;color:#1d2939;cursor:pointer}.unified-loading-settings summary span{font-size:11px;font-weight:400;color:#667085}.unified-loading-settings :deep(.loading-experience-admin){margin:0;border:0;border-top:1px solid #e4e7ec;border-radius:0}@media(max-width:800px){.unified-designer-actions span{display:none}.unified-loading-settings summary{display:grid;gap:3px}}
.unified-base-settings{margin-top:15px;border:1px solid #dfe2e7;border-radius:12px;background:#fff;overflow:hidden}.unified-base-settings summary{display:flex;gap:14px;align-items:center;padding:15px 18px;font-size:14px;font-weight:650;color:#1d2939;cursor:pointer}.unified-base-settings summary span{font-size:11px;font-weight:400;color:#667085}.unified-base-settings :deep(.group-appearance-admin){border:0;border-top:1px solid #e4e7ec;border-radius:0}
.unified-loading-settings :deep(.loading-settings){margin:0;border:0;border-top:1px solid #e4e7ec;border-radius:0}
</style>
