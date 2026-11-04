<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { GROUP_MAP_LEVELS, groupPortalAppearanceForLevel, normalizeGroupLogoUrl, normalizeGroupPortalAppearance } from '../../../runtime/groupPortalAppearance.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
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
watch(() => props.activeLevel, value => { if (GROUP_MAP_LEVELS.some(level => level.key === value)) selectedLevel.value = value })
const levelPreview = computed(() => groupPortalAppearanceForLevel(form.value, selectedLevel.value))
const sectionTabs = [
    { key: 'brand', label: '品牌与标题' }, { key: 'logo', label: 'Logo' },
    { key: 'theme', label: '主题配色' }, { key: 'map', label: '地图设置' }
]
const sectionPrefix = `map-settings-${useId()}`, activeSection = ref('brand')
const settingsForm = ref(null), sectionBody = ref(null)
const levelSection = computed(() => activeSection.value === 'map')
function selectSection(key) {
    if (!sectionTabs.some(tab => tab.key === key)) return
    activeSection.value = key
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
    savePending: async () => {
        if (!savedFormSnapshot || formSnapshot() === savedFormSnapshot) return true
        await save()
        if (failed.value) throw new Error(message.value || '地图组件保存失败')
        return true
    }
})
function setLevelField(key, value) {
    form.value.levels = { ...form.value.levels, [selectedLevel.value]: { ...form.value.levels[selectedLevel.value], [key]: value } }
}
function resetLevel() {
    const level = {...form.value.levels[selectedLevel.value]}
    for (const key of ['mapZoom','background','panelSurface','accent','text','mapBase','mapMuted','markerPrimary','markerTip']) delete level[key]
    form.value.levels = {...form.value.levels,[selectedLevel.value]:level}
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
        savedFormSnapshot = formSnapshot()
        const pending = readFactoryDraft(draftFactoryId, 'group-portal')
        if (pending?.value) form.value = normalizeGroupPortalAppearance(pending.value)
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
        <header><h3 id="group-appearance-title">地图底图与主题</h3></header>
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
        <form ref="settingsForm" @submit.prevent="save" novalidate v-permission="{ page: permissionPage, action: 'edit' }">
            <div ref="sectionBody" class="appearance-section-body">
                <fieldset class="appearance-edit-controls" :disabled="loading || busy || uploading || !canAdminPage(permissionPage,'edit')">
<section v-show="activeSection==='brand'" :id="`${sectionPrefix}-panel-brand`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-brand`" tabindex="0" data-map-section="brand" class="appearance-tab-panel">
            <div class="appearance-fields">
                <label>默认品牌标题<input v-model.trim="form.brandTitle" maxlength="60" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
                <label>默认英文副标题<input v-model.trim="form.brandSubtitle" maxlength="80" required  v-permission="{ page: permissionPage, action: 'edit' }"/></label>





            </div>
</section>
<section v-show="activeSection==='logo'" :id="`${sectionPrefix}-panel-logo`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-logo`" tabindex="0" data-map-section="logo" class="appearance-tab-panel">
            <label class="appearance-logo-url">默认Logo图片地址<input v-model.trim="form.logoUrl" maxlength="400" placeholder="/uploads/brand/logo.png 或 https://..."  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
            <label class="appearance-logo-upload">上传 Logo 图片<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploading" @change="uploadLogo"  v-permission="{ page: permissionPage, action: 'edit' }"/></label>
            <div class="appearance-preview" :style="{'--preview-background':levelPreview.background,'--preview-surface':levelPreview.panelSurface,'--preview-accent':levelPreview.accent,'--preview-text':levelPreview.text}"><span class="preview-map">◇</span><div><img v-if="form.logoUrl && normalizeGroupLogoUrl(form.logoUrl)" :src="form.logoUrl" alt="Logo 预览" class="appearance-logo-preview" /><small>{{ form.brandSubtitle }}</small><strong>{{ form.brandTitle }}</strong></div><aside><small>{{ levelPreview.panelTitle }}</small><i></i><i></i><i></i></aside></div>

</section>
<section v-show="activeSection==='theme'" :id="`${sectionPrefix}-panel-theme`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-theme`" tabindex="0" data-map-section="theme" class="appearance-tab-panel">
            <div class="appearance-colors">
                <label v-for="item in [{key:'background',name:'画布底色'},{key:'accent',name:'区域高光'},{key:'mapBase',name:'中国及区域底色'},{key:'mapMuted',name:'周边弱化底色'},{key:'markerPrimary',name:'位置光束主色'},{key:'markerTip',name:'光束顶端颜色'}]" :key="item.key">
                    {{ item.name }}<span><input v-model="form[item.key]" type="color"  v-permission="{ page: permissionPage, action: 'edit' }"/><input v-model.trim="form[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" required  v-permission="{ page: permissionPage, action: 'edit' }"/></span>
                </label>
            </div>
            <label class="appearance-zoom">地图初始镜头倍率 <span><input v-model.number="form.mapZoom" type="range" min="0.8" max="1.5" step="0.01"  v-permission="{ page: permissionPage, action: 'edit' }"/>{{ form.mapZoom.toFixed(2) }}×</span><small>仅影响重置视角时的距离；拖拽和滚轮仍可自由调整。</small></label>


</section>
<section v-show="activeSection==='map'" :id="`${sectionPrefix}-panel-map`" role="tabpanel" :aria-labelledby="`${sectionPrefix}-tab-map`" tabindex="0" data-map-section="map" class="appearance-tab-panel appearance-map-panel">
                <div class="appearance-level-fields">
                    <label>镜头倍率<input type="range" min="0.8" max="1.5" step="0.01" :value="levelPreview.mapZoom" @input="setLevelField('mapZoom',Number($event.target.value))" /><small>{{ levelPreview.mapZoom.toFixed(2) }}×</small></label>
                    <label v-for="item in [{key:'background',name:'画布底色'},{key:'accent',name:'区域高光'},{key:'mapBase',name:'地图底色'},{key:'markerPrimary',name:'光束主色'},{key:'markerTip',name:'光束顶色'}]" :key="item.key">{{ item.name }}<span><input type="color" :value="levelPreview[item.key]" @input="setLevelField(item.key,$event.target.value)" /><input :value="levelPreview[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" @change="setLevelField(item.key,$event.target.value)" /></span></label>
                </div>

</section>
                </fieldset>
            </div>
            <footer class="appearance-save-row"><button type="submit" :disabled="loading || busy || uploading" v-permission="{ page: permissionPage, action: 'edit' }">{{ busy?'保存中…':'保存配置' }}</button><span v-if="message" :class="['appearance-message',{failed}]" role="status">{{ message }}</span></footer>
        </form>
    </section>
</template>
<style scoped>
.group-appearance-admin{margin-top:20px;padding:20px;border:1px solid #e1e6ee;border-radius:12px;background:#fff;color:#273347}.group-appearance-admin h3{margin:0 0 16px;font-size:calc(18px * var(--admin-font-scale, 1))}.appearance-section-tabs{display:flex;gap:6px;overflow-x:auto;margin:0 0 16px;padding:7px;border:1px solid #e1e6ee;border-radius:10px;background:#f6f8fb}.appearance-section-tabs button{flex:none;padding:9px 15px;border:0;border-radius:7px;background:transparent;color:#64748b;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));white-space:nowrap;cursor:pointer}.appearance-section-tabs button[aria-selected=true]{background:#fff;color:#245dc5;box-shadow:0 2px 8px #243c6420;font-weight:600}.appearance-section-tabs button:focus-visible,.appearance-level-tabs button:focus-visible{outline:2px solid #84caff;outline-offset:1px}
.appearance-edit-controls{display:contents;border:0;margin:0;padding:0;min-width:0}.appearance-section-body{max-height:min(560px,max(240px,calc(100vh - 600px)));overflow-y:auto;scrollbar-gutter:stable;padding:0 5px 2px 0}.appearance-tab-panel{outline:none}.appearance-fields,.appearance-colors,.appearance-level-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:2px 0 16px}.appearance-colors{grid-template-columns:repeat(4,minmax(0,1fr))}.group-appearance-admin label{display:grid;gap:7px;color:#53627a;font-size:calc(12px * var(--admin-font-scale, 1))}.group-appearance-admin input:not([type=color]):not([type=checkbox]):not([type=range]),.group-appearance-admin select{box-sizing:border-box;min-width:0;width:100%;padding:9px 10px;border:1px solid #d0d9e7;border-radius:7px;background:#fff;color:#273347;font:inherit}.group-appearance-admin input[type=color]{width:36px;height:34px;padding:2px;border:1px solid #d0d9e7;border-radius:6px;background:#fff}.appearance-colors label span,.appearance-level-fields label span{display:flex;align-items:center;gap:6px}.appearance-level-fields input:not([type=color]){min-width:0}.appearance-logo-url,.appearance-logo-upload{margin:12px 0}.appearance-logo-upload input[type=file]{font-size:calc(12px * var(--admin-font-scale, 1))}.appearance-zoom{max-width:390px;margin:16px 0}.appearance-zoom>span{display:flex;align-items:center;gap:10px}.appearance-zoom small{display:none}.appearance-toggles{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 18px}.appearance-toggles label{display:flex!important;align-items:center;gap:6px}
.appearance-level-context{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 12px;color:#7a879b;font-size:calc(11px * var(--admin-font-scale, 1))}.appearance-level-tabs{display:flex;gap:5px;flex-wrap:wrap}.appearance-level-tabs button,.appearance-reset-level{padding:7px 11px;border:1px solid #d5deeb;border-radius:6px;background:#fff;color:#536983;font:inherit;font-size:calc(11px * var(--admin-font-scale, 1));cursor:pointer}.appearance-level-tabs button.active{color:#245dc5;background:#eef4ff;border-color:#a9c4f5}.appearance-reset-level{margin-left:auto}.appearance-empty{font-size:calc(11px * var(--admin-font-scale, 1));line-height:1.5;color:#7a879b}
.appearance-preview{position:relative;display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:100px;margin-top:16px;padding:16px 22px;border-radius:9px;overflow:hidden;background:var(--preview-background);color:var(--preview-text)}.appearance-preview>div,.appearance-preview aside{position:relative;display:grid;gap:7px}.appearance-preview small{font-size:calc(9px * var(--admin-font-scale, 1));letter-spacing:.1em;opacity:.7}.appearance-preview strong{font-size:calc(16px * var(--admin-font-scale, 1))}.appearance-logo-preview{width:30px;height:30px;object-fit:contain}.preview-map{position:absolute;left:43%;font-size:calc(70px * var(--admin-font-scale, 1));color:var(--preview-accent);opacity:.4}.appearance-preview aside{width:130px;padding:12px;background:var(--preview-surface);border-radius:7px}.appearance-preview aside i{height:3px;background:var(--preview-accent);opacity:.3}.appearance-save-row{display:flex;align-items:center;gap:12px;min-height:36px;margin-top:16px;padding-top:14px;border-top:1px solid #e7ecf3}.appearance-save-row>button{flex:none;padding:9px 16px;border:1px solid #3269db;border-radius:7px;background:#3269db;color:#fff;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));cursor:pointer}.group-appearance-admin button:disabled{opacity:.5;cursor:default}.appearance-message{color:#21764e;font-size:calc(12px * var(--admin-font-scale, 1));overflow-wrap:anywhere}.appearance-message.failed{color:#b64250}@media(max-width:900px){.appearance-fields,.appearance-colors,.appearance-level-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:620px){.group-appearance-admin{padding:14px}.appearance-level-context>.appearance-reset-level{margin-left:0}}
</style>
