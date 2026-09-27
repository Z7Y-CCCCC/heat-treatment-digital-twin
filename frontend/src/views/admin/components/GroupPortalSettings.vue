<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { GROUP_MAP_LEVELS, groupPortalAppearanceForLevel, normalizeGroupLogoUrl, normalizeGroupPortalAppearance } from '../../../runtime/groupPortalAppearance.js'
import { normalizeFactoryLocation } from '../../../runtime/groupTopology.js'
import MapGeometryPreview from './MapGeometryPreview.vue'

const props = defineProps({ activeLevel: { type: String, default: 'world' }, designerMode: { type: Boolean, default: false } })
const form = ref(normalizeGroupPortalAppearance())
const busy = ref(false)
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
    if (event.button !== 0 || !layoutStage.value) return
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
        const settings = await adminApi.getSettings()
        form.value = normalizeGroupPortalAppearance(settings.group_portal_config)
        previewLocation.value = normalizeFactoryLocation(settings.factory_location)
    } catch (error) { failed.value = true; message.value = error.message || '读取集团首页外观失败' }
}

async function save() {
    busy.value = true; failed.value = false; message.value = ''
    try {
        if (form.value.logoUrl && !normalizeGroupLogoUrl(form.value.logoUrl)) throw new Error('Logo 请填写站内路径或 HTTPS 图片地址')
        const result = await adminApi.saveSettings({ group_portal_config: form.value })
        if (result.error) throw new Error(result.error)
        message.value = '已保存。地图页将在下一次配置同步时更新。'
    } catch (error) { failed.value = true; message.value = error.message || '保存失败' }
    finally { busy.value = false }
}

onMounted(load)
</script>

<template>
    <section class="group-appearance-admin" :class="{'designer-mode':designerMode}" aria-labelledby="group-appearance-title">
        <header><div><h3 id="group-appearance-title">地图层级与品牌组件</h3><p>配置全球、国家、省份、城市、区县各级地图的组件、颜色和镜头。工厂、车间、产线与设备视角在下方画布编排。</p></div><span>WORLD → FACTORY</span></header>
        <form @submit.prevent="save">
            <details class="appearance-global-settings" :open="!designerMode"><summary>通用品牌与主题 <small>Logo · 标题 · 颜色 · 全层默认组件</small></summary>
            <div class="appearance-fields">
                <label>大屏 Logo / 标题<input v-model.trim="form.brandTitle" maxlength="60" required /></label>
                <label>英文副标题<input v-model.trim="form.brandSubtitle" maxlength="80" required /></label>
                <label>右侧栏目标题<input v-model.trim="form.panelTitle" maxlength="60" required /></label>
                <label>区域统计标题<input v-model.trim="form.factsTitle" maxlength="60" required /></label>
                <label>底部站点标题<input v-model.trim="form.dockNetworkTitle" maxlength="60" required /></label>
                <label>底部归属标题<input v-model.trim="form.dockLocationTitle" maxlength="60" required /></label>
                <label>底部配置标题<input v-model.trim="form.dockHierarchyTitle" maxlength="60" required /></label>
            </div>
            <label class="appearance-logo-url">Logo 图片地址（可选，留空使用默认标识）<input v-model.trim="form.logoUrl" maxlength="400" placeholder="/uploads/brand/logo.png 或 https://..." /><small>图片与标题同属大屏品牌组件；请使用站内路径或 HTTPS 图片。</small></label>
            <label class="appearance-logo-upload">上传 Logo 图片<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploading" @change="uploadLogo" /><small>PNG、JPEG、WebP，最大 5 MB；上传后仍需保存外观。</small></label>
            <div class="appearance-colors">
                <label v-for="item in [{key:'background',name:'画布底色'},{key:'panelSurface',name:'组件底色'},{key:'accent',name:'区域高光'},{key:'text',name:'主文字色'},{key:'mapBase',name:'中国及区域底色'},{key:'mapMuted',name:'周边弱化底色'},{key:'markerPrimary',name:'位置光束主色'},{key:'markerTip',name:'光束顶端颜色'}]" :key="item.key">
                    {{ item.name }}<span><input v-model="form[item.key]" type="color" /><input v-model.trim="form[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" required /></span>
                </label>
            </div>
            <label class="appearance-zoom">地图初始镜头倍率 <span><input v-model.number="form.mapZoom" type="range" min="0.8" max="1.5" step="0.01" />{{ form.mapZoom.toFixed(2) }}×</span><small>仅影响重置视角时的距离；拖拽和滚轮仍可自由调整。</small></label>
            <div class="appearance-preview" :style="{'--preview-background':levelPreview.background,'--preview-surface':levelPreview.panelSurface,'--preview-accent':levelPreview.accent,'--preview-text':levelPreview.text}"><span class="preview-map">◇</span><div><img v-if="form.logoUrl && normalizeGroupLogoUrl(form.logoUrl)" :src="form.logoUrl" alt="Logo 预览" class="appearance-logo-preview" /><small>{{ form.brandSubtitle }}</small><strong>{{ form.brandTitle }}</strong></div><aside><small>{{ levelPreview.panelTitle }}</small><i></i><i></i><i></i></aside></div>
            <div class="appearance-toggles"><label><input v-model="form.showBrand" type="checkbox" />大屏 Logo</label><label><input v-model="form.showFacts" type="checkbox" />左侧统计</label><label><input v-model="form.showPanel" type="checkbox" />右侧分布面板</label><label><input v-model="form.showDock" type="checkbox" />底部概览</label><label><input v-model="form.showHelp" type="checkbox" />操作说明</label></div>
            </details>
            <section class="appearance-level-editor" aria-label="地图分层配置">
                <div class="appearance-level-heading"><strong>{{ GROUP_MAP_LEVELS.find(item=>item.key===selectedLevel)?.label }}地图画面</strong><span>左侧统计、右侧分布、底部概览和 Logo 可在下方画布中拖动；本层设置仅作用于当前地图。</span></div>
                <div v-if="!designerMode" class="appearance-level-tabs" role="tablist" aria-label="地图层级">
                    <button v-for="level in GROUP_MAP_LEVELS" :key="level.key" type="button" role="tab" :aria-selected="selectedLevel===level.key" :class="{active:selectedLevel===level.key}" @click="selectedLevel=level.key">{{ level.label }}</button>
                </div>
                <div class="appearance-level-fields">
                    <label>镜头倍率<input type="range" min="0.8" max="1.5" step="0.01" :value="levelPreview.mapZoom" @input="setLevelField('mapZoom',Number($event.target.value))" /><small>{{ levelPreview.mapZoom.toFixed(2) }}×</small></label>
                    <label v-for="item in [{key:'background',name:'画布底色'},{key:'panelSurface',name:'组件底色'},{key:'accent',name:'区域高光'},{key:'mapBase',name:'地图底色'},{key:'markerPrimary',name:'光束主色'},{key:'markerTip',name:'光束顶色'}]" :key="item.key">{{ item.name }}<span><input type="color" :value="levelPreview[item.key]" @input="setLevelField(item.key,$event.target.value)" /><input :value="levelPreview[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" @change="setLevelField(item.key,$event.target.value)" /></span></label>
                </div>
                <div class="map-component-panel"><strong>本层画面组件</strong><p>点选组件后可拖动或输入精确位置；关闭显示不删除配置。</p>
                    <div v-for="item in mapComponents" :key="item.key" class="map-component-row" :class="{active:selectedComponent===item.key}"><button type="button" @click="selectedComponent=item.key">{{ item.label }}</button><label><input type="checkbox" :checked="levelPreview[item.toggle]" @change="setLevelField(item.toggle,$event.target.checked)" />显示</label></div>
                    <div class="map-component-copy" v-if="selectedComponent==='brand'"><label>本层大屏标题<input :value="levelPreview.brandTitle" maxlength="60" @change="setLevelField('brandTitle',$event.target.value)" /></label><label>英文副标题<input :value="levelPreview.brandSubtitle" maxlength="80" @change="setLevelField('brandSubtitle',$event.target.value)" /></label><label>本层 Logo 地址<input :value="levelPreview.logoUrl" maxlength="400" placeholder="留空继承通用 Logo" @change="setLevelField('logoUrl',$event.target.value)" /></label><label>上传本层 Logo<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploading" @change="uploadLogo($event,'level')" /></label></div>
                    <div class="map-component-copy" v-else-if="selectedComponent==='facts'"><label>统计标题<input :value="levelPreview.factsTitle" maxlength="60" @change="setLevelField('factsTitle',$event.target.value)" /></label></div>
                    <div class="map-component-copy" v-else-if="selectedComponent==='panel'"><label>分布栏目标题<input :value="levelPreview.panelTitle" maxlength="60" @change="setLevelField('panelTitle',$event.target.value)" /></label></div>
                    <div class="map-component-copy" v-else><label>站点网络标题<input :value="levelPreview.dockNetworkTitle" maxlength="60" @change="setLevelField('dockNetworkTitle',$event.target.value)" /></label><label>行政区归属标题<input :value="levelPreview.dockLocationTitle" maxlength="60" @change="setLevelField('dockLocationTitle',$event.target.value)" /></label><label>现场配置标题<input :value="levelPreview.dockHierarchyTitle" maxlength="60" @change="setLevelField('dockHierarchyTitle',$event.target.value)" /></label></div>
                    <div class="map-coordinate-fields"><label>水平 X %<input type="number" min="0" :max="100-layoutWidths[selectedComponent]" step="0.1" :value="layoutPoint(selectedComponent).x" @change="setLayoutCoordinate(selectedComponent,'x',$event.target.value)" /></label><label>垂直 Y %<input type="number" min="0" :max="selectedComponent==='dock'?78:85" step="0.1" :value="layoutPoint(selectedComponent).y" @change="setLayoutCoordinate(selectedComponent,'y',$event.target.value)" /></label></div>
                    <label class="map-help-toggle"><input type="checkbox" :checked="levelPreview.showHelp" @change="setLevelField('showHelp',$event.target.checked)" />右侧操作说明</label>
                </div>
                <div class="layout-heading"><div><strong>画面编排</strong><small>拖动卡片调整本层位置；留在默认位置的组件不覆盖原布局。保存后大屏生效。</small></div><button type="button" @click="resetLayout">恢复本层默认位置</button></div>
                <div ref="layoutStage" class="layout-stage" :style="{'--preview-background':levelPreview.background,'--preview-surface':levelPreview.panelSurface,'--preview-accent':levelPreview.accent,'--preview-text':levelPreview.text,'--preview-map-base':levelPreview.mapBase}">
                    <MapGeometryPreview :level="selectedLevel" :location="previewLocation" />
                    <div v-if="levelPreview.showBrand" class="layout-card layout-brand" :class="{selected:selectedComponent==='brand'}" :style="layoutPosition('brand')" @pointerdown="startLayoutDrag('brand',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span><img v-if="levelPreview.logoUrl" :src="levelPreview.logoUrl" alt="" draggable="false" /><strong>{{ levelPreview.brandTitle }}</strong></div>
                    <div v-if="levelPreview.showFacts" class="layout-card layout-facts" :class="{selected:selectedComponent==='facts'}" :style="layoutPosition('facts')" @pointerdown="startLayoutDrag('facts',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span>{{ levelPreview.factsTitle }}<strong>01 <small>座</small></strong></div>
                    <div v-if="levelPreview.showPanel" class="layout-card layout-panel" :class="{selected:selectedComponent==='panel'}" :style="layoutPosition('panel')" @pointerdown="startLayoutDrag('panel',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span><strong>{{ levelPreview.panelTitle }}</strong><i></i><i></i></div>
                    <div v-if="levelPreview.showDock" class="layout-card layout-dock" :class="{selected:selectedComponent==='dock'}" :style="layoutPosition('dock')" @pointerdown="startLayoutDrag('dock',$event)" @pointermove="moveLayoutDrag" @pointerup="endLayoutDrag" @pointercancel="endLayoutDrag"><span class="layout-handle">⠿</span><span>{{ levelPreview.dockNetworkTitle }}</span><span>{{ levelPreview.dockLocationTitle }}</span><span>{{ levelPreview.dockHierarchyTitle }}</span></div>
                </div>
                <button type="button" class="appearance-reset-level" @click="resetLevel">本层恢复继承通用配置</button>
            </section>
            <button type="submit" :disabled="busy">{{ busy ? '保存中…':'保存集团首页外观' }}</button><span v-if="message" :class="['appearance-message',{failed}]" role="status">{{ message }}</span>
        </form>
    </section>
</template>

<style scoped>
.group-appearance-admin{margin-top:24px;padding:24px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;color:#1d2939}.group-appearance-admin header{display:flex;justify-content:space-between;gap:20px}.group-appearance-admin h3{margin:0 0 7px;font-size:19px}.group-appearance-admin p{margin:0 0 20px;color:#667085;font-size:13px;line-height:1.7}.group-appearance-admin header>span{color:#98a2b3;font-size:10px;letter-spacing:.14em}.appearance-fields,.appearance-colors{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:15px 0}.appearance-colors{grid-template-columns:repeat(4,minmax(0,1fr))}.group-appearance-admin label{display:grid;gap:7px;color:#475467;font-size:12px}.group-appearance-admin input:not([type=color]):not([type=checkbox]){box-sizing:border-box;min-width:0;width:100%;padding:9px 10px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#1d2939;font:inherit}.appearance-colors label span{display:flex;align-items:center;gap:6px}.appearance-colors input[type=color]{width:36px;height:34px;padding:2px;border:1px solid #d0d5dd;border-radius:6px;background:#fff}.appearance-preview{position:relative;display:flex;align-items:center;justify-content:space-between;gap:25px;min-height:125px;padding:16px 24px;border-radius:10px;overflow:hidden;background:var(--preview-background);color:var(--preview-text)}.appearance-preview:before{position:absolute;inset:0;content:"";background:radial-gradient(circle at 48% 50%,color-mix(in srgb,var(--preview-accent) 20%,transparent),transparent 43%)}.appearance-preview>div,.appearance-preview aside{position:relative;z-index:1;display:grid;gap:7px}.appearance-preview small{font-size:9px;letter-spacing:.12em;opacity:.68}.appearance-preview strong{font-size:16px}.appearance-preview .preview-map{position:absolute;left:43%;top:20%;font-size:75px;color:var(--preview-accent);opacity:.5}.appearance-preview aside{width:125px;padding:13px;background:color-mix(in srgb,var(--preview-surface) 67%,transparent);border:1px solid color-mix(in srgb,var(--preview-accent) 26%,transparent);border-radius:7px}.appearance-preview aside i{height:3px;background:var(--preview-accent);opacity:.3}.appearance-preview aside i:nth-child(3){width:70%}.appearance-preview aside i:nth-child(4){width:42%}.appearance-toggles{display:flex;flex-wrap:wrap;gap:18px;margin:17px 0}.appearance-toggles label{display:flex;align-items:center;gap:6px}.group-appearance-admin button{padding:10px 16px;border:0;border-radius:7px;background:#344054;color:#fff;cursor:pointer}.group-appearance-admin button:disabled{opacity:.5}.appearance-message{margin-left:12px;color:#067647;font-size:12px}.appearance-message.failed{color:#b42318}@media(max-width:900px){.appearance-fields,.appearance-colors{grid-template-columns:repeat(2,minmax(0,1fr))}}
.appearance-zoom{max-width:390px;margin:16px 0}.appearance-zoom span{display:flex;align-items:center;gap:12px;font-variant-numeric:tabular-nums}.group-appearance-admin .appearance-zoom input[type=range]{width:260px;max-width:100%;padding:0;border:0;accent-color:#6677c3}.appearance-zoom small{color:#98a2b3;font-size:11px}
.appearance-logo-url{max-width:720px}.appearance-logo-url small{color:#98a2b3;font-size:11px}.appearance-logo-preview{max-width:100px;max-height:38px;object-fit:contain}.appearance-level-editor{margin:24px 0;padding:18px;border:1px solid #e4e7ec;border-radius:12px;background:#f8f9fb}.appearance-level-heading{display:flex;gap:12px;align-items:baseline}.appearance-level-heading strong{font-size:15px}.appearance-level-heading span{font-size:11px;color:#667085}.appearance-level-tabs{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0}.group-appearance-admin .appearance-level-tabs button,.group-appearance-admin .appearance-reset-level{color:#344054;background:#fff;border:1px solid #d0d5dd}.group-appearance-admin .appearance-level-tabs button.active{color:#fff;background:#344054;border-color:#344054}.appearance-level-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.appearance-level-fields label span{display:flex;gap:6px;align-items:center}.appearance-level-fields input[type=color]{width:36px;height:34px;padding:2px;border:1px solid #d0d5dd;border-radius:6px;background:#fff}.group-appearance-admin .appearance-level-fields input[type=range]{padding:0;border:0;accent-color:#6677c3}.appearance-level-fields small{color:#667085}.group-appearance-admin .appearance-reset-level{margin-bottom:4px}@media(max-width:900px){.appearance-level-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}
.layout-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:22px 0 9px}.layout-heading>div{display:grid;gap:4px}.layout-heading strong{font-size:14px}.layout-heading small{color:#667085;font-size:11px}.group-appearance-admin .layout-heading button{flex:none;padding:7px 11px;color:#344054;background:#fff;border:1px solid #d0d5dd}.layout-stage{position:relative;width:100%;aspect-ratio:16/9;max-height:540px;min-height:270px;overflow:hidden;border:1px solid #667085;border-radius:10px;background:radial-gradient(ellipse at 50% 49%,color-mix(in srgb,var(--preview-accent) 12%,transparent),transparent 36%),var(--preview-background);color:var(--preview-text);user-select:none;touch-action:none}.layout-map-mark{position:absolute;left:43%;top:27%;font-size:clamp(70px,16vw,190px);line-height:1;color:var(--preview-accent);opacity:.26;pointer-events:none}.layout-card{position:absolute;box-sizing:border-box;z-index:1;display:flex;align-items:center;gap:7px;padding:9px 12px;border:1px solid color-mix(in srgb,var(--preview-accent) 40%,transparent);border-radius:5px;background:color-mix(in srgb,var(--preview-surface) 78%,transparent);box-shadow:0 8px 24px #0003;color:var(--preview-text);font-size:11px;line-height:1.25;cursor:grab;touch-action:none}.layout-card:active{cursor:grabbing}.layout-handle{color:var(--preview-accent);font-size:17px;line-height:1}.layout-brand{width:30%;min-height:11%;overflow:hidden;white-space:nowrap}.layout-brand strong{overflow:hidden;text-overflow:ellipsis;font-size:clamp(10px,1.5vw,17px)}.layout-facts{width:19%;min-height:28%;display:grid;align-content:center;gap:8px}.layout-facts strong{font-size:clamp(17px,2.5vw,30px);font-weight:400}.layout-facts small{font-size:9px}.layout-panel{width:23%;min-height:48%;display:grid;align-content:start;gap:12px}.layout-panel strong{font-size:11px;overflow:hidden;text-overflow:ellipsis}.layout-panel i{display:block;width:80%;height:3px;background:var(--preview-accent);opacity:.35}.layout-panel i:last-child{width:56%}.layout-dock{width:65%;min-height:13%;justify-content:space-around;gap:5px;font-size:10px}.layout-dock>span:not(.layout-handle){flex:1;text-align:center}@media(max-width:700px){.layout-stage{min-height:230px}.layout-card{padding:5px;font-size:8px}.layout-handle{font-size:12px}.layout-dock{font-size:7px}.layout-heading{align-items:flex-start;flex-direction:column}}
.appearance-global-settings{padding:15px 18px;border:1px solid #e4e7ec;border-radius:10px;background:#fff}.appearance-global-settings>summary{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:650;cursor:pointer}.appearance-global-settings>summary small{color:#667085;font-size:11px;font-weight:400}.appearance-global-settings>summary::-webkit-details-marker{display:none}.appearance-global-settings[open]>summary{margin-bottom:17px}.designer-mode{margin:0;padding:14px;border-top:0;border-radius:0 0 12px 12px;background:#f4f5f7}.designer-mode>header{display:none}.designer-mode form{display:flex;flex-direction:column;gap:13px}.designer-mode .appearance-level-editor{order:1;display:grid;grid-template-columns:minmax(0,2.65fr) minmax(230px,1fr);grid-template-areas:'heading heading' 'canvas-heading fields' 'canvas fields' 'canvas toggles' 'canvas reset';gap:11px 16px;align-items:start;margin:0;padding:14px;background:#fff}.designer-mode .appearance-level-heading{grid-area:heading;display:grid;gap:4px}.designer-mode .appearance-level-heading strong{font-size:17px}.designer-mode .appearance-level-heading span{font-size:12px}.designer-mode .layout-heading{grid-area:canvas-heading;margin:0}.designer-mode .layout-stage{grid-area:canvas;max-height:none;min-height:240px;align-self:start}.designer-mode .appearance-level-fields{grid-area:fields;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;max-height:440px;overflow:auto;padding:12px;border:1px solid #e4e7ec;border-radius:9px;background:#f9fafb}.designer-mode .appearance-level-fields>label:nth-child(-n+2){grid-column:1/-1}.designer-mode .appearance-level-fields input:not([type=color]){padding:6px;font-size:11px}.designer-mode .appearance-toggles{grid-area:toggles;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:0;padding:12px;border:1px solid #e4e7ec;border-radius:9px;background:#f9fafb}.designer-mode .appearance-reset-level{grid-area:reset;justify-self:start;margin:0}.designer-mode .appearance-global-settings{order:2}.designer-mode form>button[type=submit]{order:3;align-self:start}.designer-mode form>.appearance-message{order:4;margin:0}.designer-mode .appearance-preview{margin-top:18px}@media(max-width:980px){.designer-mode .appearance-level-editor{display:flex;flex-direction:column}.designer-mode .layout-stage{width:100%}.designer-mode .appearance-level-fields{width:100%;max-height:none;box-sizing:border-box}.designer-mode .appearance-toggles{width:100%;box-sizing:border-box}}
.map-component-panel{display:grid;gap:7px;padding:12px;border:1px solid #e4e7ec;border-radius:9px;background:#f9fafb}.map-component-panel>strong{font-size:13px}.map-component-panel>p{margin:0 0 4px;color:#667085;font-size:11px;line-height:1.5}.map-component-row{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:35px;padding:4px;border:1px solid #e4e7ec;border-radius:7px;background:#fff}.map-component-row.active{border-color:#98afd9;background:#edf3ff}.group-appearance-admin .map-component-row>button{flex:1;padding:5px 7px;color:#344054;background:transparent;text-align:left;font-size:11px}.map-component-row label{display:flex;align-items:center;gap:4px;flex:none;font-size:10px}.map-coordinate-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:5px}.map-component-panel .map-help-toggle{display:flex;align-items:center;gap:5px;margin-top:6px}.layout-card.selected{outline:2px solid var(--preview-accent);outline-offset:2px}.designer-mode .map-component-panel{grid-area:toggles}.designer-mode .appearance-level-editor{grid-template-areas:'heading heading' 'canvas-heading fields' 'canvas fields' 'canvas toggles' 'canvas reset'}@media(max-width:980px){.designer-mode .map-component-panel{width:100%;box-sizing:border-box}}
.map-component-copy{display:grid;gap:8px;margin:5px 0;padding:10px;border:1px solid #dde3ed;border-radius:7px;background:#fff}.map-component-copy label{font-size:10px}.map-component-copy input{min-height:30px}.layout-brand img{width:20px;height:20px;object-fit:contain;flex:none}.designer-mode .appearance-level-fields{max-height:250px}.designer-mode .map-component-panel{max-height:390px;overflow:auto}
</style>
