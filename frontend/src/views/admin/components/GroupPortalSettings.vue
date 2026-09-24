<script setup>
import { computed, onMounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { GROUP_MAP_LEVELS, groupPortalAppearanceForLevel, normalizeGroupLogoUrl, normalizeGroupPortalAppearance } from '../../../runtime/groupPortalAppearance.js'

const form = ref(normalizeGroupPortalAppearance())
const busy = ref(false)
const message = ref('')
const failed = ref(false)
const selectedLevel = ref('world')
const levelPreview = computed(() => groupPortalAppearanceForLevel(form.value, selectedLevel.value))

function setLevelField(key, value) {
    form.value.levels = { ...form.value.levels, [selectedLevel.value]: { ...form.value.levels[selectedLevel.value], [key]: value } }
}

function resetLevel() {
    const levels = { ...form.value.levels }
    delete levels[selectedLevel.value]
    form.value.levels = levels
}

async function load() {
    try {
        const settings = await adminApi.getSettings()
        form.value = normalizeGroupPortalAppearance(settings.group_portal_config)
    } catch (error) { failed.value = true; message.value = error.message || '读取集团首页外观失败' }
}

async function save() {
    busy.value = true; failed.value = false; message.value = ''
    try {
        if (form.value.logoUrl && !normalizeGroupLogoUrl(form.value.logoUrl)) throw new Error('Logo 请填写站内路径或 HTTPS 图片地址')
        await adminApi.saveSettings({ group_portal_config: form.value })
        message.value = '已保存。地图页将在下一次配置同步时更新。'
    } catch (error) { failed.value = true; message.value = error.message || '保存失败' }
    finally { busy.value = false }
}

onMounted(load)
</script>

<template>
    <section class="group-appearance-admin" aria-labelledby="group-appearance-title">
        <header><div><h3 id="group-appearance-title">地图层级与品牌组件</h3><p>配置全球、国家、省份、城市、区县各级地图的组件、颜色和镜头。工厂、车间、产线与设备视角在下方画布编排。</p></div><span>WORLD → FACTORY</span></header>
        <form @submit.prevent="save">
            <div class="appearance-fields">
                <label>大屏 Logo / 标题<input v-model.trim="form.brandTitle" maxlength="60" required /></label>
                <label>英文副标题<input v-model.trim="form.brandSubtitle" maxlength="80" required /></label>
                <label>右侧栏目标题<input v-model.trim="form.panelTitle" maxlength="60" required /></label>
            </div>
            <label class="appearance-logo-url">Logo 图片地址（可选，留空使用默认标识）<input v-model.trim="form.logoUrl" maxlength="400" placeholder="/uploads/brand/logo.png 或 https://..." /><small>图片与标题同属大屏品牌组件；请使用站内路径或 HTTPS 图片。</small></label>
            <div class="appearance-colors">
                <label v-for="item in [{key:'background',name:'画布底色'},{key:'panelSurface',name:'组件底色'},{key:'accent',name:'区域高光'},{key:'text',name:'主文字色'},{key:'mapBase',name:'中国及区域底色'},{key:'mapMuted',name:'周边弱化底色'},{key:'markerPrimary',name:'位置光束主色'},{key:'markerTip',name:'光束顶端颜色'}]" :key="item.key">
                    {{ item.name }}<span><input v-model="form[item.key]" type="color" /><input v-model.trim="form[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" required /></span>
                </label>
            </div>
            <label class="appearance-zoom">地图初始镜头倍率 <span><input v-model.number="form.mapZoom" type="range" min="0.8" max="1.5" step="0.01" />{{ form.mapZoom.toFixed(2) }}×</span><small>仅影响重置视角时的距离；拖拽和滚轮仍可自由调整。</small></label>
            <div class="appearance-preview" :style="{'--preview-background':levelPreview.background,'--preview-surface':levelPreview.panelSurface,'--preview-accent':levelPreview.accent,'--preview-text':levelPreview.text}"><span class="preview-map">◇</span><div><img v-if="form.logoUrl && normalizeGroupLogoUrl(form.logoUrl)" :src="form.logoUrl" alt="Logo 预览" class="appearance-logo-preview" /><small>{{ form.brandSubtitle }}</small><strong>{{ form.brandTitle }}</strong></div><aside><small>{{ levelPreview.panelTitle }}</small><i></i><i></i><i></i></aside></div>
            <div class="appearance-toggles"><label><input v-model="form.showFacts" type="checkbox" />左侧统计</label><label><input v-model="form.showPanel" type="checkbox" />右侧分布面板</label><label><input v-model="form.showDock" type="checkbox" />底部概览</label><label><input v-model="form.showHelp" type="checkbox" />操作说明</label></div>
            <section class="appearance-level-editor" aria-label="地图分层配置">
                <div class="appearance-level-heading"><strong>分层画面</strong><span>每一层可覆盖上方通用配置；未修改的属性继续继承。</span></div>
                <div class="appearance-level-tabs" role="tablist" aria-label="地图层级">
                    <button v-for="level in GROUP_MAP_LEVELS" :key="level.key" type="button" role="tab" :aria-selected="selectedLevel===level.key" :class="{active:selectedLevel===level.key}" @click="selectedLevel=level.key">{{ level.label }}</button>
                </div>
                <div class="appearance-level-fields">
                    <label>栏目标题<input :value="levelPreview.panelTitle" maxlength="60" @input="setLevelField('panelTitle',$event.target.value)" /></label>
                    <label>镜头倍率<input type="range" min="0.8" max="1.5" step="0.01" :value="levelPreview.mapZoom" @input="setLevelField('mapZoom',Number($event.target.value))" /><small>{{ levelPreview.mapZoom.toFixed(2) }}×</small></label>
                    <label v-for="item in [{key:'background',name:'画布底色'},{key:'panelSurface',name:'组件底色'},{key:'accent',name:'区域高光'},{key:'mapBase',name:'地图底色'},{key:'markerPrimary',name:'光束主色'},{key:'markerTip',name:'光束顶色'}]" :key="item.key">{{ item.name }}<span><input type="color" :value="levelPreview[item.key]" @input="setLevelField(item.key,$event.target.value)" /><input :value="levelPreview[item.key]" pattern="#[0-9a-fA-F]{6}" maxlength="7" @change="setLevelField(item.key,$event.target.value)" /></span></label>
                </div>
                <div class="appearance-toggles"><label v-for="item in [{key:'showFacts',name:'左侧统计'},{key:'showPanel',name:'右侧分布'},{key:'showDock',name:'底部概览'},{key:'showHelp',name:'操作说明'}]" :key="item.key"><input type="checkbox" :checked="levelPreview[item.key]" @change="setLevelField(item.key,$event.target.checked)" />{{ item.name }}</label></div>
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
</style>
