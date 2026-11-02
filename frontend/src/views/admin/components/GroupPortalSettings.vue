<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { GROUP_MAP_DATA_FIELDS, GROUP_MAP_LEVELS, groupPortalAppearanceForLevel, normalizeGroupLogoUrl, normalizeGroupPortalAppearance } from '../../../runtime/groupPortalAppearance.js'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch, canAdminPage } from '../../../runtime/adminSession.js'
import { normalizeFactoryLocation } from '../../../runtime/groupTopology.js'
import MapGeometryPreview from './MapGeometryPreview.vue'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import { cacheFactoryDraft, clearFactoryDraft, readFactoryDraft } from '../../../runtime/factoryDraftCache.js'

const props = defineProps({ activeLevel: { type: String, default: 'world' }, designerMode: { type: Boolean, default: false }, permissionPage: { type: String, default: 'platform.map' } })
const emit = defineEmits(['saved'])
const form = ref(normalizeGroupPortalAppearance())
const draftFactoryId = getFactoryScope()
let savedFormSnapshot = ''
const formSnapshot = () => JSON.stringify(form.value)
const busy = ref(false)
const loading = ref(true)
const uploading = ref(false)
const message = ref('')
const failed = ref(false)
const selectedLevel = ref(GROUP_MAP_LEVELS.some(level => level.key === props.activeLevel) ? props.activeLevel : 'world')
const previewLocation = ref(normalizeFactoryLocation())
watch(() => props.activeLevel, value => { if (GROUP_MAP_LEVELS.some(level => level.key === value)) selectedLevel.value = value })
const levelPreview = computed(() => groupPortalAppearanceForLevel(form.value, selectedLevel.value))
const layoutStage = ref(null)
const activeDrag = ref(null)
const selectedComponent = ref('panel')
const sectionTabs = [
    { key: 'brand', label: '品牌与标题' }, { key: 'logo', label: 'Logo' }, { key: 'theme', label: '主题配色' },
    { key: 'map', label: '地图设置' }, { key: 'components', label: '画面组件' },
    { key: 'data', label: '数据来源' }, { key: 'layout', label: '画面编排' }
]
const sectionPrefix = `map-settings-${useId()}`, activeSection = ref(props.designerMode ? 'layout' : 'brand')
const settingsForm = ref(null), sectionBody = ref(null)
const levelSection = computed(() => ['map', 'components', 'data', 'layout'].includes(activeSection.value))
const componentSection = computed(() => ['components', 'data', 'layout'].includes(activeSection.value))
function selectSection(key) {
    if (!sectionTabs.some(tab => tab.key === key)) return
    activeDrag.value = null; activeSection.value = key
    if (sectionBody.value) sectionBody.value.scrollTop = 0
}
async function sectionKey(event, index) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % sectionTabs.length
    else if (event.key === 'ArrowLeft') next = (index + sectionTabs.length - 1) % sectionTabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = sectionTabs.length - 1
    else return
    event.preventDefault(); selectSection(sectionTabs[next].key)
    await nextTick(); document.getElementById(`${sectionPrefix}-tab-${sectionTabs[next].key}`)?.focus()
}
defineExpose({
    selectComponent: (key, level) => { if (GROUP_MAP_LEVELS.some(item => item.key === level)) selectedLevel.value = level; selectedComponent.value = key; selectSection('components') },
    savePending: async () => {
        if (!savedFormSnapshot || formSnapshot() === savedFormSnapshot) return true
        await save()
        if (failed.value) throw new Error(message.value || '地图组件保存失败')
        return true
    }
})
const selectedMetric = ref('panelRegionRows')
const apiSources = ref([])
const sourceFactoryId = ref('factory_default')
const discoveredFields = ref([])
const bindingMessage = ref('')
const bindingBusy = ref(false)
const availableMetrics = computed(() => GROUP_MAP_DATA_FIELDS[selectedComponent.value] || [])
const currentBinding = computed(() => levelPreview.value.dataBindings?.[selectedMetric.value] || null)
watch(selectedComponent, () => { selectedMetric.value = availableMetrics.value[0]?.key || ''; discoveredFields.value = []; bindingMessage.value = '' })
watch(selectedLevel, () => { discoveredFields.value = []; bindingMessage.value = '' })
const mapComponents = [
    { key: 'brand', label: '大屏 Logo / 标题', toggle: 'showBrand' },
    { key: 'facts', label: '区域统计', toggle: 'showFacts' },
    { key: 'panel', label: '工厂分布面板', toggle: 'showPanel' },
    { key: 'dock', label: '底部概览', toggle: 'showDock' }
]
const layoutDefaults = { brand: { x: 3, y: 5 }, facts: { x: 3, y: 26 }, panel: { x: 73, y: 17 }, dock: { x: 3, y: 76 } }
const layoutWidths = { brand: 30, facts: 19, panel: 23, dock: 65 }

function layoutPoint(key) { return levelPreview.value.layout?.[key] || layoutDefaults[key] }
function layoutPosition(key) {
    const point = layoutPoint(key)
    return { left: `${point.x}%`, top: `${point.y}%` }
}

function setLayoutCoordinate(key, axis, value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return
    const current = layoutPoint(key)
    const maximum = axis === 'x' ? 100 - layoutWidths[key] : key === 'dock' ? 78 : 85
    setLevelField('layout', { ...levelPreview.value.layout, [key]: { ...current, [axis]: Math.max(0, Math.min(maximum, number)) } })
}

function startLayoutDrag(key, event) {
    if (loading.value || busy.value || uploading.value || !canAdminPage(props.permissionPage, 'edit') || event.button !== 0 || !layoutStage.value) return
    selectedComponent.value = key
    const rect = layoutStage.value.getBoundingClientRect()
    const point = layoutPoint(key)
    activeDrag.value = { key, pointerId: event.pointerId, offsetX: event.clientX - rect.left - point.x * rect.width / 100, offsetY: event.clientY - rect.top - point.y * rect.height / 100 }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
}

function moveLayoutDrag(event) {
    const drag = activeDrag.value
    if (!drag || drag.pointerId !== event.pointerId || !layoutStage.value) return
    const rect = layoutStage.value.getBoundingClientRect()
    const x = Math.round(Math.max(0, Math.min(100 - layoutWidths[drag.key], (event.clientX - rect.left - drag.offsetX) / rect.width * 100)) * 10) / 10
    const y = Math.round(Math.max(0, Math.min(drag.key === 'dock' ? 78 : 85, (event.clientY - rect.top - drag.offsetY) / rect.height * 100)) * 10) / 10
    setLevelField('layout', { ...levelPreview.value.layout, [drag.key]: { x, y } })
}

function endLayoutDrag(event) {
    if (activeDrag.value?.pointerId === event.pointerId) activeDrag.value = null
}

function resetLayout() {
    const level = { ...(form.value.levels[selectedLevel.value] || {}) }
    delete level.layout
    form.value.levels = { ...form.value.levels, [selectedLevel.value]: level }
}

function setLevelField(key, value) {
    form.value.levels = { ...form.value.levels, [selectedLevel.value]: { ...form.value.levels[selectedLevel.value], [key]: value } }
}

function resetLevel() {
    const levels = { ...form.value.levels }
    delete levels[selectedLevel.value]
    form.value.levels = levels
}

function setMapBinding(field, value) {
    const bindings = { ...(form.value.levels[selectedLevel.value]?.dataBindings || {}) }
    if (field === 'mode' && value !== 'http_api') delete bindings[selectedMetric.value]
    else bindings[selectedMetric.value] = {
        mode: 'http_api', factoryId: sourceFactoryId.value, connectionId: '', apiPath: '', jsonPath: '', refreshMs: 30000,
        ...(bindings[selectedMetric.value] || {}), [field]: value,
        ...(field === 'connectionId' ? { factoryId: sourceFactoryId.value } : {})
    }
    setLevelField('dataBindings', bindings)
    bindingMessage.value = ''
}

async function inspectMapBinding() {
    if (!currentBinding.value?.connectionId || !currentBinding.value?.apiPath) { bindingMessage.value = '请先选择连接并填写 GET 路径'; return }
    bindingBusy.value = true; bindingMessage.value = ''; discoveredFields.value = []
    try {
        const response = await adminFetch(`${API_BASE}/data-sources/inspect-http`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentBinding.value)
        })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || '读取字段失败')
        discoveredFields.value = body.result?.fields || []
        bindingMessage.value = `已发现 ${discoveredFields.value.length} 个字段`
    } catch (error) { bindingMessage.value = error.message }
    finally { bindingBusy.value = false }
}

async function testMapBinding() {
    if (!currentBinding.value?.jsonPath) { bindingMessage.value = '请先选择字段路径'; return }
    bindingBusy.value = true; bindingMessage.value = ''
    try {
        const response = await adminFetch(`${API_BASE}/data-sources/preview-http`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentBinding.value)
        })
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || '数据预览失败')
        bindingMessage.value = Array.isArray(body.result?.rows) && body.result.rows.length
            ? `读取成功：${body.result.rows.length} 行` : `读取成功：${String(body.result?.value ?? '空值').slice(0, 120)}`
    } catch (error) { bindingMessage.value = error.message }
    finally { bindingBusy.value = false }
}

async function uploadLogo(event, scope = 'global') {
    const file = event.target.files?.[0]
    if (!file) return
    uploading.value = true; failed.value = false; message.value = ''
    try {
        const result = await adminApi.uploadAppearanceImage(file)
        if (result.error) throw new Error(result.error)
        if (scope === 'level') setLevelField('logoUrl', result.url)
        else form.value.logoUrl = result.url
        message.value = 'Logo 已上传，请点击下方保存，使大屏生效。'
    } catch (error) { failed.value = true; message.value = error.message || 'Logo 上传失败' }
    finally { uploading.value = false; event.target.value = '' }
}

async function load() {
    try {
        const [settings, sources, factories] = await Promise.all([
            adminApi.getSettings(),
            adminApi.getDataSources().catch(() => ({ connections: [] })),
            adminApi.listFactories().catch(() => ({ activeFactoryId:'factory_default' }))
        ])
        form.value = normalizeGroupPortalAppearance(settings.group_portal_config)
        savedFormSnapshot = formSnapshot()
        const pending = readFactoryDraft(draftFactoryId, 'group-portal')
        if (pending?.value) form.value = normalizeGroupPortalAppearance(pending.value)
        sourceFactoryId.value = getFactoryScope() || factories.activeFactoryId || 'factory_default'
        apiSources.value = (sources.connections || []).filter(source => source.sourceType === 'http_api' || source.type === 'http_api')
        previewLocation.value = normalizeFactoryLocation(settings.factory_location)
    } catch (error) { failed.value = true; message.value = error.message || '读取集团首页外观失败' }
    finally { loading.value = false }
}

async function save() {
    if (busy.value || uploading.value || loading.value) return
    if (!canAdminPage(props.permissionPage, 'edit')) { failed.value = true; message.value = '当前账户不能修改此配置'; return }
    const invalid = settingsForm.value?.querySelector('input:invalid,select:invalid,textarea:invalid')
    if (invalid) {
        selectSection(invalid.closest('[data-map-section]')?.dataset.mapSection || 'brand')
        failed.value = true; message.value = '请检查当前选项中的输入'
        await nextTick(); invalid.focus(); invalid.reportValidity(); return
    }
    busy.value = true; failed.value = false; message.value = ''
    try {
        if (form.value.logoUrl && !normalizeGroupLogoUrl(form.value.logoUrl)) throw new Error('Logo 请填写站内路径或 HTTPS 图片地址')
        const result = await adminApi.saveSettings({ group_portal_config: form.value })
        if (result.error) throw new Error(result.error)
        savedFormSnapshot = formSnapshot()
        clearFactoryDraft(draftFactoryId, 'group-portal')
        message.value = '已保存。地图页将在下一次配置同步时更新。'
        emit('saved', form.value)
    } catch (error) { failed.value = true; message.value = error.message || '保存失败' }
    finally { busy.value = false }
}

onMounted(load)
onUnmounted(() => {
    if (!savedFormSnapshot) return
    if (formSnapshot() !== savedFormSnapshot)
        cacheFactoryDraft(draftFactoryId, 'group-portal', 'setting', { key: 'group_portal_config', value: JSON.parse(formSnapshot()) })
    else clearFactoryDraft(draftFactoryId, 'group-portal')
})
</script>

<template>
    <section class="group-appearance-admin" :class="{'designer-mode':designerMode}" aria-labelledby="group-appearance-title">
        <header><h3 id="group-appearance-title">地图底图与内置模块</h3></header>
        <nav class="appearance-section-tabs" role="tablist" aria-label="地图配置分类">
            <button v-for="(tab,index) in sectionTabs" :id="`${sectionPrefix}-tab-${tab.key}`" :key="tab.key" type="button" role="tab"
                :aria-selected="activeSection===tab.key" :aria-controls="`${sectionPrefix}-panel-${tab.key}`" :tabindex="activeSection===tab.key?0:-1"
                @click="selectSection(tab.key)" @keydown="sectionKey($event,index)">{{ tab.label }}</button>
        </nav>
        <div v-show="levelSection" class="appearance-level-context">
            <span>当前地图</span><div class="appearance-level-tabs" aria-label="地图层级">
                <button v-for="level in GROUP_MAP_LEVELS" :key="level.key" type="button" :aria-pressed="selectedLevel===level.key" :class="{active:selectedLevel===level.key}" @click="selectedLevel=level.key">{{ level.label }}</button>
            </div>
            <button type="button" class="appearance-reset-level" :disabled="loading || busy || !canAdminPage(permissionPage,'edit')" @click="resetLevel">恢复本层默认</button>
        </div>
        <div v-show="componentSection" class="map-module-picker" aria-label="选择地图组件">
            <button v-for="item in mapComponents" :key="item.key" type="button" :aria-pressed="selectedComponent===item.key" :class="{active:selectedComponent===item.key}" @click="selectedComponent=item.key">{{ item.label }}</button>
        </div>
        <form ref="settingsForm" @submit.prevent="save" novalidate v-permission="{ page: permissionPage, action: 'edit' }">
            <div ref="sectionBody" class="appearance-section-body">
                <fieldset class="appearance-edit-controls" :disabled="loading || busy || uploading || !canAdminPage(permissionPage,'edit')">
<section v-show="activeSection==='brand'" :id="`${sectionPrefix}-panel-brand`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-brand`" tabindex="0" data-map-section="brand" class="appearance-tab-panel">
            <div class="appearance-fields">
                <label>大屏 Logo / 标题<input v-model.trim="form.brandTitle" maxlength="60" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
                <label>英文副标题<input v-model.trim="form.brandSubtitle" maxlength="80" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
                <label>右侧栏目标题<input v-model.trim="form.panelTitle" maxlength="60" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
                <label>区域统计标题<input v-model.trim="form.factsTitle" maxlength="60" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
                <label>底部站点标题<input v-model.trim="form.dockNetworkTitle" maxlength="60" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
                <label>底部归属标题<input v-model.trim="form.dockLocationTitle" maxlength="60" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
                <label>底部配置标题<input v-model.trim="form.dockHierarchyTitle" maxlength="60" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
            </div>
</section>
<section v-show="activeSection==='logo'" :id="`${sectionPrefix}-panel-logo`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-logo`" tabindex="0" data-map-section="logo" class="appearance-tab-panel">
            <label class="appearance-logo-url">Logo 图片地址<input v-model.trim="form.logoUrl" maxlength="400" placeholder="/uploads/brand/logo.png 或 https://..."  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
            <label class="appearance-logo-upload">上传 Logo 图片<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploading" @change="uploadLogo"  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
            <div class="appearance-preview" :style="{'--preview-background':levelPreview.background,'--preview-surface':levelPreview.panelSurface,'--preview-accent':levelPreview.accent,'--preview-text':levelPreview.text}"><span class="preview-map">◇</span><div><img v-if="form.logoUrl && normalizeGroupLogoUrl(form.logoUrl)" :src="form.logoUrl" alt="Logo 预览" class="appearance-logo-preview" /><small>{{ form.brandSubtitle }}</small><strong>{{ form.brandTitle }}</strong></div><aside><small>{{ levelPreview.panelTitle }}</small><i></i><i></i><i></i></aside></div>

</section>
<section v-show="activeSection==='theme'" :id="`${sectionPrefix}-panel-theme`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-theme`" tabindex="0" data-map-section="theme" class="appearance-tab-panel">
            <div class="appearance-colors">
                <label v-for="item in [{key:'background',name:'画布底色'},{key:'panelSurface',name:'组件底色'},{key:'accent',name:'区域高光'},{key:'text',name:'主文字色'},{key:'mapBase',name:'中国及区域底色'},{key:'mapMuted',name:'周边弱化底色'},{key:'markerPrimary',name:'位置光束主色'},{key:'markerTip',name:'光束顶端颜色'}]" :key="item.key">
                    {{ item.name }}<span><input v-model="form[item.key]" type="color"  v-permission="{ page: permissionPage, action: 'edit' }"/><input v-model.trim="form[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" required  v-permission="{ page: permissionPage, action: 'edit' }"/></span>
                </label>
            </div>
            <label class="appearance-zoom">地图初始镜头倍率 <span><input v-model.number="form.mapZoom" type="range" min="0.8" max="1.5" step="0.01"  v-permission="{ page: permissionPage, action: 'edit' }"/>{{ form.mapZoom.toFixed(2) }}×</span><small>仅影响重置视角时的距离；拖拽和滚轮仍可自由调整。</small></label>
            <div class="appearance-toggles"><label><input v-model="form.showBrand" type="checkbox"  v-permission="{ page: permissionPage, action: 'edit' }"/>大屏 Logo</label><label><input v-model="form.showFacts" type="checkbox"  v-permission="{ page: permissionPage, action: 'edit' }"/>左侧统计</label><label><input v-model="form.showPanel" type="checkbox"  v-permission="{ page: permissionPage, action: 'edit' }"/>右侧分布面板</label><label><input v-model="form.showDock" type="checkbox"  v-permission="{ page: permissionPage, action: 'edit' }"/>底部概览</label><label><input v-model="form.showHelp" type="checkbox"  v-permission="{ page: permissionPage, action: 'edit' }"/>操作说明</label></div>

</section>
<section v-show="activeSection==='map'" :id="`${sectionPrefix}-panel-map`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-map`" tabindex="0" data-map-section="map" class="appearance-tab-panel appearance-map-panel">
                <div class="appearance-level-fields">
                    <label>镜头倍率<input type="range" min="0.8" max="1.5" step="0.01" :value="levelPreview.mapZoom" @input="setLevelField('mapZoom',Number($event.target.value))" /><small>{{ levelPreview.mapZoom.toFixed(2) }}×</small></label>
                    <label v-for="item in [{key:'background',name:'画布底色'},{key:'panelSurface',name:'组件底色'},{key:'accent',name:'区域高光'},{key:'mapBase',name:'地图底色'},{key:'markerPrimary',name:'光束主色'},{key:'markerTip',name:'光束顶色'}]" :key="item.key">{{ item.name }}<span><input type="color" :value="levelPreview[item.key]" @input="setLevelField(item.key,$event.target.value)" /><input :value="levelPreview[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" @change="setLevelField(item.key,$event.target.value)" /></span></label>
                </div>

</section>
<section v-show="activeSection==='components'" :id="`${sectionPrefix}-panel-components`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-components`" tabindex="0" data-map-section="components" class="appearance-tab-panel">
<div class="appearance-toggles"><label v-for="item in mapComponents" :key="item.key"><input type="checkbox" :checked="levelPreview[item.toggle]" @change="setLevelField(item.toggle,$event.target.checked)" />{{ item.label }}</label></div>
                    <div class="map-component-copy" v-if="selectedComponent==='brand'"><label>本层大屏标题<input :value="levelPreview.brandTitle" maxlength="60" @change="setLevelField('brandTitle',$event.target.value)" /></label><label>英文副标题<input :value="levelPreview.brandSubtitle" maxlength="80" @change="setLevelField('brandSubtitle',$event.target.value)" /></label><label>本层 Logo 地址<input :value="levelPreview.logoUrl" maxlength="400" placeholder="留空继承通用 Logo" @change="setLevelField('logoUrl',$event.target.value)" /></label><label>上传本层 Logo<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploading" @change="uploadLogo($event,'level')"  v-permission="{ page: permissionPage, action: 'edit' }"/></label></div>
                    <div class="map-component-copy" v-else-if="selectedComponent==='facts'"><label>统计标题<input :value="levelPreview.factsTitle" maxlength="60" @change="setLevelField('factsTitle',$event.target.value)" /></label></div>
                    <div class="map-component-copy" v-else-if="selectedComponent==='panel'"><label>分布栏目标题<input :value="levelPreview.panelTitle" maxlength="60" @change="setLevelField('panelTitle',$event.target.value)" /></label></div>
                    <div class="map-component-copy" v-else><label>站点网络标题<input :value="levelPreview.dockNetworkTitle" maxlength="60" @change="setLevelField('dockNetworkTitle',$event.target.value)" /></label><label>行政区归属标题<input :value="levelPreview.dockLocationTitle" maxlength="60" @change="setLevelField('dockLocationTitle',$event.target.value)" /></label><label>现场配置标题<input :value="levelPreview.dockHierarchyTitle" maxlength="60" @change="setLevelField('dockHierarchyTitle',$event.target.value)" /></label></div>
                    <div class="map-coordinate-fields"><label>水平 X %<input type="number" min="0" :max="100-layoutWidths[selectedComponent]" step="0.1" :value="layoutPoint(selectedComponent).x" @change="setLayoutCoordinate(selectedComponent,'x',$event.target.value)" /></label><label>垂直 Y %<input type="number" min="0" :max="selectedComponent==='dock'?78:85" step="0.1" :value="layoutPoint(selectedComponent).y" @change="setLayoutCoordinate(selectedComponent,'y',$event.target.value)" /></label></div>
                    <label class="map-help-toggle"><input type="checkbox" :checked="levelPreview.showHelp" @change="setLevelField('showHelp',$event.target.checked)" />操作说明</label>

</section>
<section v-show="activeSection==='data'" :id="`${sectionPrefix}-panel-data`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-data`" tabindex="0" data-map-section="data" class="appearance-tab-panel">
                    <div v-if="availableMetrics.length" class="map-data-binding">
                        <strong>本层组件数据来源</strong>

                        <label>配置项<select v-model="selectedMetric"><option v-for="field in availableMetrics" :key="field.key" :value="field.key">{{ field.label }}</option></select></label>
                        <label>来源<select :value="currentBinding?'http_api':'built_in'" @change="setMapBinding('mode',$event.target.value)"><option value="built_in">系统工厂资料</option><option value="http_api">外部 HTTP API</option></select></label>
                        <template v-if="currentBinding">
                            <label>只读接口连接（当前工厂配置范围）<select :value="currentBinding.connectionId" @change="setMapBinding('connectionId',$event.target.value)"><option value="">选择已登记连接</option><option v-for="source in apiSources" :key="source.id" :value="source.id">{{ source.name }}</option></select></label>
                            <label>GET 相对路径<input :value="currentBinding.apiPath" placeholder="/api/v1/production/summary" @change="setMapBinding('apiPath',$event.target.value.trim())" /></label>
                            <label>字段路径<input :value="currentBinding.jsonPath" :placeholder="selectedMetric==='panelRegionRows'?'regions':'data.factoryCount'" @change="setMapBinding('jsonPath',$event.target.value.trim())" /></label>
                            <label>刷新间隔（秒）<input type="number" min="5" max="3600" :value="currentBinding.refreshMs/1000" @change="setMapBinding('refreshMs',Math.round(Number($event.target.value)*1000))" /></label>
                            <div class="map-binding-actions"><button type="button" :disabled="bindingBusy" @click="inspectMapBinding">读取字段</button><button type="button" :disabled="bindingBusy" @click="testMapBinding">测试数值</button></div>
                            <select v-if="discoveredFields.length" aria-label="选取接口字段" :value="currentBinding.jsonPath" @change="setMapBinding('jsonPath',$event.target.value)"><option value="">选择发现的字段</option><option v-for="field in discoveredFields" :key="field.path" :value="field.path">{{ field.path }} · {{ field.kind }}</option></select>
                            <small v-if="selectedMetric==='panelRegionRows'">区域列表需为对象数组，至少包含与地图对应的 code；可覆盖 count、localCount、registeredCount、districtAssignedCount。</small>
                            <small v-if="bindingMessage" role="status">{{ bindingMessage }}</small>
                        </template>
                    </div>
<p v-if="!availableMetrics.length" class="appearance-empty">此组件无需绑定数据。</p>
</section>
<section v-show="activeSection==='layout'" :id="`${sectionPrefix}-panel-layout`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-layout`" tabindex="0" data-map-section="layout" class="appearance-tab-panel appearance-layout-panel">
                <div class="layout-heading"><div><strong>画面编排</strong></div><button type="button" @click="resetLayout">恢复本层默认位置</button></div>
                <div ref="layoutStage" class="layout-stage" :style="{'--preview-background':levelPreview.background,'--preview-surface':levelPreview.panelSurface,'--preview-accent':levelPreview.accent,'--preview-text':levelPreview.text,'--preview-map-base':levelPreview.mapBase}">
                    <MapGeometryPreview :level="selectedLevel" :location="previewLocation" />
                    <div v-if="levelPreview.showBrand" class="layout-card layout-brand" :class="{selected:selectedComponent==='brand'}" :style="layoutPosition('brand')" @pointerdown="startLayoutDrag('brand',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span><img v-if="levelPreview.logoUrl" :src="levelPreview.logoUrl" alt="" draggable="false" /><strong>{{ levelPreview.brandTitle }}</strong></div>
                    <div v-if="levelPreview.showFacts" class="layout-card layout-facts" :class="{selected:selectedComponent==='facts'}" :style="layoutPosition('facts')" @pointerdown="startLayoutDrag('facts',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span>{{ levelPreview.factsTitle }}<strong>01 <small>座</small></strong></div>
                    <div v-if="levelPreview.showPanel" class="layout-card layout-panel" :class="{selected:selectedComponent==='panel'}" :style="layoutPosition('panel')" @pointerdown="startLayoutDrag('panel',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span><strong>{{ levelPreview.panelTitle }}</strong><i></i><i></i></div>
                    <div v-if="levelPreview.showDock" class="layout-card layout-dock" :class="{selected:selectedComponent==='dock'}" :style="layoutPosition('dock')" @pointerdown="startLayoutDrag('dock',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span><span>{{ levelPreview.dockNetworkTitle }}</span><span>{{ levelPreview.dockLocationTitle }}</span><span>{{ levelPreview.dockHierarchyTitle }}</span></div>
                </div>

</section>
                </fieldset>
            </div>
            <footer class="appearance-save-row"><button type="submit" :disabled="loading || busy || uploading" v-permission="{ page: permissionPage, action: 'edit' }">{{ busy?'保存中…':'保存配置' }}</button><span v-if="message" :class="['appearance-message',{failed}]" role="status">{{ message }}</span></footer>
        </form>
    </section>
</template>
<style scoped>
.group-appearance-admin{margin-top:20px;padding:20px;border:1px solid #e1e6ee;border-radius:12px;background:#fff;color:#273347}.group-appearance-admin h3{margin:0 0 16px;font-size:18px}.appearance-section-tabs{display:flex;gap:6px;overflow-x:auto;margin:0 0 16px;padding:7px;border:1px solid #e1e6ee;border-radius:10px;background:#f6f8fb}.appearance-section-tabs button{flex:none;padding:9px 15px;border:0;border-radius:7px;background:transparent;color:#64748b;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.appearance-section-tabs button[aria-selected=true]{background:#fff;color:#245dc5;box-shadow:0 2px 8px #243c6420;font-weight:600}.appearance-section-tabs button:focus-visible,.appearance-level-tabs button:focus-visible,.map-module-picker button:focus-visible{outline:2px solid #84caff;outline-offset:1px}
.appearance-edit-controls{display:contents;border:0;margin:0;padding:0;min-width:0}.appearance-section-body{max-height:min(560px,max(240px,calc(100vh - 600px)));overflow-y:auto;scrollbar-gutter:stable;padding:0 5px 2px 0}.appearance-tab-panel{outline:none}.appearance-fields,.appearance-colors,.appearance-level-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:2px 0 16px}.appearance-colors{grid-template-columns:repeat(4,minmax(0,1fr))}.group-appearance-admin label{display:grid;gap:7px;color:#53627a;font-size:12px}.group-appearance-admin input:not([type=color]):not([type=checkbox]):not([type=range]),.group-appearance-admin select{box-sizing:border-box;min-width:0;width:100%;padding:9px 10px;border:1px solid #d0d9e7;border-radius:7px;background:#fff;color:#273347;font:inherit}.group-appearance-admin input[type=color]{width:36px;height:34px;padding:2px;border:1px solid #d0d9e7;border-radius:6px;background:#fff}.appearance-colors label span,.appearance-level-fields label span{display:flex;align-items:center;gap:6px}.appearance-level-fields input:not([type=color]){min-width:0}.appearance-logo-url,.appearance-logo-upload{margin:12px 0}.appearance-logo-upload input[type=file]{font-size:12px}.appearance-zoom{max-width:390px;margin:16px 0}.appearance-zoom>span{display:flex;align-items:center;gap:10px}.appearance-zoom small,.layout-heading small{display:none}.appearance-toggles{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 18px}.appearance-toggles label,.map-help-toggle{display:flex!important;align-items:center;gap:6px}
.appearance-level-context{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 12px;color:#7a879b;font-size:11px}.appearance-level-tabs,.map-module-picker{display:flex;gap:5px;flex-wrap:wrap}.appearance-level-tabs button,.map-module-picker button,.appearance-reset-level,.layout-heading button,.map-binding-actions button{padding:7px 11px;border:1px solid #d5deeb;border-radius:6px;background:#fff;color:#536983;font:inherit;font-size:11px;cursor:pointer}.appearance-level-tabs button.active,.map-module-picker button.active{color:#245dc5;background:#eef4ff;border-color:#a9c4f5}.appearance-reset-level{margin-left:auto}.map-module-picker{margin:0 0 15px;padding-bottom:12px;border-bottom:1px solid #edf0f5}.map-component-copy{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:0 0 15px}.map-coordinate-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;max-width:420px;margin:15px 0}.map-data-binding{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.map-data-binding>strong,.map-data-binding>small,.map-binding-actions,.map-data-binding>select{grid-column:1/-1}.map-data-binding>strong{color:#344054;font-size:13px}.map-data-binding small,.appearance-empty{font-size:11px;line-height:1.5;color:#7a879b}.map-binding-actions{display:flex;gap:8px}
.layout-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;font-size:13px}.layout-stage{position:relative;aspect-ratio:16/9;max-height:440px;min-height:230px;overflow:hidden;border:1px solid #667783;border-radius:9px;background:var(--preview-background);color:var(--preview-text);touch-action:none}.layout-card{position:absolute;display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--preview-accent) 32%,transparent);border-radius:6px;background:color-mix(in srgb,var(--preview-surface) 75%,transparent);box-sizing:border-box;font-size:12px;cursor:grab;user-select:none;touch-action:none}.layout-card:active{cursor:grabbing}.layout-card.selected{outline:2px solid var(--preview-accent);outline-offset:2px}.layout-handle{color:var(--preview-accent);font-size:16px}.layout-brand{width:30%;min-height:11%}.layout-brand img{width:20px;height:20px;object-fit:contain}.layout-brand strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.layout-facts{width:19%;min-height:18%;flex-wrap:wrap}.layout-facts strong{width:100%;font-size:25px}.layout-facts small{font-size:10px}.layout-panel{width:23%;min-height:39%;flex-wrap:wrap;align-content:flex-start}.layout-panel strong{width:100%;overflow:hidden;text-overflow:ellipsis}.layout-panel i{display:block;width:80%;height:3px;background:var(--preview-accent);opacity:.35}.layout-panel i:last-child{width:56%}.layout-dock{width:65%;min-height:13%;justify-content:space-around;gap:5px;font-size:10px}.layout-dock>span:not(.layout-handle){flex:1;text-align:center}
.appearance-preview{position:relative;display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:100px;margin-top:16px;padding:16px 22px;border-radius:9px;overflow:hidden;background:var(--preview-background);color:var(--preview-text)}.appearance-preview>div,.appearance-preview aside{position:relative;display:grid;gap:7px}.appearance-preview small{font-size:9px;letter-spacing:.1em;opacity:.7}.appearance-preview strong{font-size:16px}.appearance-logo-preview{width:30px;height:30px;object-fit:contain}.preview-map{position:absolute;left:43%;font-size:70px;color:var(--preview-accent);opacity:.4}.appearance-preview aside{width:130px;padding:12px;background:var(--preview-surface);border-radius:7px}.appearance-preview aside i{height:3px;background:var(--preview-accent);opacity:.3}.appearance-save-row{display:flex;align-items:center;gap:12px;min-height:36px;margin-top:16px;padding-top:14px;border-top:1px solid #e7ecf3}.appearance-save-row>button{flex:none;padding:9px 16px;border:1px solid #3269db;border-radius:7px;background:#3269db;color:#fff;font:inherit;font-size:12px;cursor:pointer}.group-appearance-admin button:disabled{opacity:.5;cursor:default}.appearance-message{color:#21764e;font-size:12px;overflow-wrap:anywhere}.appearance-message.failed{color:#b64250}.designer-mode{margin:0;border:0}.designer-mode>header{display:none}@media(max-width:900px){.appearance-fields,.appearance-colors,.appearance-level-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){.group-appearance-admin{padding:14px}.map-component-copy,.map-data-binding{grid-template-columns:1fr}.appearance-level-context>.appearance-reset-level{margin-left:0}.layout-card{padding:5px;font-size:8px}.layout-handle{font-size:12px}.layout-dock{font-size:7px}}
</style>
