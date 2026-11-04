<script setup>
import { computed, ref } from 'vue'
import DashboardDesigner from './DashboardDesigner.vue'
import FactorySiteSceneSettings from './FactorySiteSceneSettings.vue'

const emit = defineEmits(['reload', 'preview-view'])
const selectedViewId = ref('map_world')
const dashboardDesigner = ref(null)
const siteSceneSettings = ref(null)
defineExpose({
    savePending: async () => {
        for (const editor of [dashboardDesigner.value, siteSceneSettings.value])
            await editor?.savePending?.()
        return true
    },
    discardPending: () => dashboardDesigner.value?.discardPending?.(),
    setMapAppearance: value => dashboardDesigner.value?.setMapAppearance(value)
})
const showingSite = computed(() => selectedViewId.value.startsWith('site_'))

function syncSurface(viewId) {
    selectedViewId.value = String(viewId)
}
</script>

<template>
    <section class="unified-dashboard-designer" aria-label="大屏画面设计器">
        <header class="unified-designer-header">
            <div><strong>大屏画面设计器</strong><small>所有视角共用组件、布局与数据绑定。</small></div>
            <div class="unified-designer-actions"><span>MAP → SITE → WORKSHOP → LINE → DEVICE</span></div>
        </header>
        <div class="unified-factory-workspace" role="region" aria-label="统一画面组件编辑">
            <DashboardDesigner ref="dashboardDesigner" initial-view-id="map_world" @reload="emit('reload')" @preview-view="value=>emit('preview-view',value)" @view-change="syncSurface" />
        </div>
        <details v-if="showingSite" class="unified-base-settings"><summary>街道与工厂建筑底层配置 <span>背景、建筑展示顺序、光标与悬停效果</span></summary><FactorySiteSceneSettings ref="siteSceneSettings" /></details>
    </section>
</template>

<style scoped>
.unified-dashboard-designer{min-width:0}.unified-designer-header{display:flex;justify-content:space-between;align-items:start;gap:18px;padding:15px 18px;border:1px solid #dfe2e7;border-bottom:0;border-radius:12px 12px 0 0;background:#fff;color:#242629}.unified-designer-header>div{display:grid;gap:5px}.unified-designer-header strong{font-size:calc(17px * var(--admin-font-scale, 1))}.unified-designer-header small{font-size:calc(12px * var(--admin-font-scale, 1));color:#717781}.unified-designer-actions{justify-items:end}.unified-designer-actions span{color:#8d949e;font-size:calc(10px * var(--admin-font-scale, 1));letter-spacing:.12em;white-space:nowrap}.unified-designer-actions button{padding:7px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#f8fafc;color:#315ab9;font-size:calc(11px * var(--admin-font-scale, 1));cursor:pointer}.unified-designer-actions button:hover{background:#edf3ff}.unified-map-workspace,.unified-factory-workspace{min-width:0}.unified-loading-settings{margin-top:15px;border:1px solid #dfe2e7;border-radius:12px;background:#fff;overflow:hidden}.unified-loading-settings summary{display:flex;gap:14px;align-items:center;padding:15px 18px;font-size:calc(14px * var(--admin-font-scale, 1));font-weight:650;color:#1d2939;cursor:pointer}.unified-loading-settings summary span{font-size:calc(11px * var(--admin-font-scale, 1));font-weight:400;color:#667085}.unified-loading-settings :deep(.loading-experience-admin){margin:0;border:0;border-top:1px solid #e4e7ec;border-radius:0}@media(max-width:800px){.unified-designer-actions span{display:none}.unified-loading-settings summary{display:grid;gap:3px}}
.unified-base-settings{margin-top:15px;border:1px solid #dfe2e7;border-radius:12px;background:#fff;overflow:hidden}.unified-base-settings summary{display:flex;gap:14px;align-items:center;padding:15px 18px;font-size:calc(14px * var(--admin-font-scale, 1));font-weight:650;color:#1d2939;cursor:pointer}.unified-base-settings summary span{font-size:calc(11px * var(--admin-font-scale, 1));font-weight:400;color:#667085}.unified-base-settings :deep(.group-appearance-admin){border:0;border-top:1px solid #e4e7ec;border-radius:0}
.unified-loading-settings :deep(.loading-settings){margin:0;border:0;border-top:1px solid #e4e7ec;border-radius:0}
</style>
