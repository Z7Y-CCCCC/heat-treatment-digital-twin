<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { DEFAULT_STREET_IMAGE, normalizeSiteSceneConfig, orderedSiteWorkshops } from '../../../runtime/siteSceneConfig.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import { cacheFactoryDraft, clearFactoryDraft, readFactoryDraft } from '../../../runtime/factoryDraftCache.js'

const loading=ref(true),saving=ref(false),uploading=ref(false),error=ref(''),message=ref(''),page=ref(0)
const form=ref(normalizeSiteSceneConfig()),workshops=ref([]),order=ref([])
const draftFactoryId=getFactoryScope()
let savedSnapshot=''
const draftPayload=()=>({...form.value,version:1,buildingSlots:Object.fromEntries(order.value.map((id,index)=>[id,index]))})
const draftSnapshot=()=>JSON.stringify(draftPayload())
defineExpose({savePending:async()=>{if(!savedSnapshot || draftSnapshot()===savedSnapshot)return true;await save();if(error.value)throw new Error(error.value);return true}})
const pageCount=computed(()=>Math.max(1,Math.ceil(order.value.length/6)))
const current=computed(()=>order.value.slice(page.value*6,page.value*6+6))
const previewImage=computed(()=>form.value.streetImageUrl || DEFAULT_STREET_IMAGE)
onMounted(async()=>{
  try{
    const [settings,rows]=await Promise.all([adminApi.getSettings(),adminApi.getWorkshops()])
    form.value=normalizeSiteSceneConfig(settings.site_scene_config)
    workshops.value=Array.isArray(rows)?rows:Array.isArray(rows.workshops)?rows.workshops:[]
    order.value=orderedSiteWorkshops(workshops.value,form.value).map(item=>String(item.id))
    savedSnapshot=draftSnapshot()
    const pending=readFactoryDraft(draftFactoryId,'site-scene')
    if(pending?.value){form.value=normalizeSiteSceneConfig(pending.value);order.value=orderedSiteWorkshops(workshops.value,form.value).map(item=>String(item.id))}
  }catch(cause){error.value=cause.message || '工厂视角配置读取失败'}finally{loading.value=false}
})
function workshop(id){return workshops.value.find(item=>String(item.id)===id)}
function shift(id,delta){const index=order.value.indexOf(id),next=index+delta;if(index<0 || next<0 || next>=order.value.length)return;const copy=[...order.value];[copy[index],copy[next]]=[copy[next],copy[index]];order.value=copy;page.value=Math.floor(next/6)}
async function upload(event){
  const file=event.target.files?.[0];if(!file)return
  uploading.value=true;error.value='';message.value=''
  try{const result=await adminApi.uploadAppearanceImage(file);if(!result.url)throw new Error(result.error || '背景图片上传失败');form.value={...form.value,streetImageUrl:result.url};message.value='图片已上传；请保存工厂视角配置。'}
  catch(cause){error.value=cause.message}finally{uploading.value=false;event.target.value=''}
}
async function save(){
  saving.value=true;error.value='';message.value=''
  try{
    const buildingSlots=Object.fromEntries(order.value.map((id,index)=>[id,index]))
    const result=await adminApi.saveSettings({site_scene_config:{...form.value,version:1,buildingSlots}})
    if(result.error)throw new Error(result.error)
    form.value={...form.value,buildingSlots};savedSnapshot=draftSnapshot();clearFactoryDraft(draftFactoryId,'site-scene');message.value='已保存。街道背景和厂区建筑顺序在该工厂视角生效。'
  }catch(cause){error.value=cause.message || '保存失败'}finally{saving.value=false}
}
onUnmounted(()=>{if(!savedSnapshot)return;if(draftSnapshot()!==savedSnapshot)cacheFactoryDraft(draftFactoryId,'site-scene','setting',{key:'site_scene_config',value:JSON.parse(draftSnapshot())});else clearFactoryDraft(draftFactoryId,'site-scene')})
</script>

<template>
  <section class="site-scene-designer" aria-label="街道与工厂建筑配置">
    <header><div><strong>街道示意 · 工厂建筑</strong><p>每个工厂独立配置。街道层展示可旋转的工厂园区；点击厂区建筑先进入全厂总览，随后才选择真实车间。</p></div><span>STREET → CAMPUS → OVERVIEW → WORKSHOP</span></header>
    <div class="site-scene-grid">
      <section class="street-image-editor"><h3>街道背景</h3><div class="image-preview" :style="{backgroundImage:`url('${previewImage}')`}"><span>工厂缩略图显示在视觉中心</span></div><label>上传背景图（PNG / JPEG / WebP）<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="uploading" @change="upload"  v-permission="{ page: 'platform.designer', action: 'edit' }"/></label><button v-if="form.streetImageUrl" type="button" @click="form={...form,streetImageUrl:''}">恢复默认示意图</button></section>
      <section class="building-editor"><h3>厂区建筑展示顺序</h3><p>按真实车间排列厂区示意建筑。点击厂区模型进入全厂总览；车间下钻在总览内选择，不会跳过总览。</p><div v-if="loading" class="empty">正在读取车间…</div><div v-else-if="!order.length" class="empty">此工厂还没有车间；请先在工厂建模中添加车间。</div><div v-else class="building-grid"><div v-for="(id,index) in current" :key="id" class="building-card"><span class="building-number">{{ String(page*6+index+1).padStart(2,'0') }}</span><strong>{{ workshop(id)?.name || id }}</strong><div><button type="button" :disabled="page*6+index===0" :aria-label="`将${workshop(id)?.name || id}前移`" @click="shift(id,-1)">←</button><button type="button" :disabled="page*6+index===order.length-1" :aria-label="`将${workshop(id)?.name || id}后移`" @click="shift(id,1)">→</button></div></div></div><div v-if="pageCount>1" class="pager"><button type="button" :disabled="page===0" @click="page--">上一组</button><span>{{ page+1 }} / {{ pageCount }}</span><button type="button" :disabled="page===pageCount-1" @click="page++">下一组</button></div></section>
    </div>
    <section class="scene-components"><h3>两级画面组件</h3><p>街道和工厂视角共用这套组件开关；名称、说明、主色独立于 Unity 车间模型。</p>
      <div class="scene-fields"><label>街道页标题<input v-model="form.streetTitle" maxlength="80"  v-permission="{ page: 'platform.designer', action: 'edit' }"/></label><label>工厂页标题<input v-model="form.factoryTitle" maxlength="80"  v-permission="{ page: 'platform.designer', action: 'edit' }"/></label><label>强调色<input v-model="form.accent" type="color"  v-permission="{ page: 'platform.designer', action: 'edit' }"/></label><label>街道页说明<textarea v-model="form.streetDescription" maxlength="240" rows="2" v-permission="{ page: 'platform.designer', action: 'edit' }"></textarea></label><label>工厂页说明<textarea v-model="form.factoryDescription" maxlength="240" rows="2" v-permission="{ page: 'platform.designer', action: 'edit' }"></textarea></label></div>
      <div class="scene-toggles"><label><input v-model="form.showBrand" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 页眉标题</label><label><input v-model="form.showBreadcrumbs" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 地图层级导航</label><label><input v-model="form.showInfoPanel" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 右侧信息面板</label><label><input v-model="form.showBeacon" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 工厂光标</label><label><input v-model="form.showFooter" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 底部操作提示</label><label><input v-model="form.showViewControls" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 视角罗盘 / 缩放 / 放大</label><label><input v-model="form.showHoverGlow" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 建筑悬停底座高光</label><label><input v-model="form.showBuildingTooltip" type="checkbox"  v-permission="{ page: 'platform.designer', action: 'edit' }"/> 建筑悬停详情卡</label></div>
    </section>
    <footer><button type="button" :disabled="loading || saving || uploading" @click="save" v-permission="{ page: 'platform.designer', action: 'edit' }">{{ saving?'保存中…':'保存当前工厂视角' }}</button><span v-if="message" role="status">{{ message }}</span><span v-if="error" class="error" role="alert">{{ error }}</span></footer>
  </section>
</template>

<style scoped>
.site-scene-designer{padding:20px;border:1px solid #dfe2e7;border-radius:0 0 12px 12px;background:#fff;color:#273044}.site-scene-designer header{display:flex;align-items:start;justify-content:space-between;gap:18px;border-bottom:1px solid #e4e7ec;padding-bottom:14px}.site-scene-designer header strong{font-size:calc(17px * var(--admin-font-scale, 1))}.site-scene-designer header p,.building-editor>p{max-width:760px;margin:5px 0 0;color:#667085;font-size:calc(12px * var(--admin-font-scale, 1));line-height:1.7}.site-scene-designer header>span{color:#98a2b3;font-size:calc(10px * var(--admin-font-scale, 1));white-space:nowrap}.site-scene-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,1fr);gap:24px;margin-top:18px}.site-scene-designer h3{margin:0 0 12px;font-size:calc(14px * var(--admin-font-scale, 1))}.image-preview{display:grid;place-items:center;aspect-ratio:16/9;max-height:390px;border-radius:9px;background-color:#262934;background-position:center;background-size:cover;overflow:hidden}.image-preview span{padding:7px 12px;border:1px solid #ffffff44;border-radius:4px;background:#10151ab9;color:#e9edff;font-size:calc(11px * var(--admin-font-scale, 1))}.street-image-editor label{display:grid;gap:8px;margin-top:14px;font-size:calc(11px * var(--admin-font-scale, 1));color:#667085}.street-image-editor input{font:inherit}.site-scene-designer button{border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#344054;font:inherit;font-size:calc(11px * var(--admin-font-scale, 1));cursor:pointer}.street-image-editor>button{margin-top:12px;padding:8px}.building-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:17px}.building-card{display:grid;gap:7px;min-height:85px;padding:10px;border:1px solid #dce3ef;border-radius:8px;background:#f7f9fc}.building-number{color:#4167bd;font-size:calc(10px * var(--admin-font-scale, 1))}.building-card strong{font-size:calc(11px * var(--admin-font-scale, 1));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.building-card div{display:flex;justify-content:flex-end;gap:4px}.building-card button{padding:3px 8px}.site-scene-designer button:disabled{opacity:.4;cursor:default}.pager{display:flex;justify-content:space-between;align-items:center;margin-top:13px;color:#667085;font-size:calc(11px * var(--admin-font-scale, 1))}.pager button{padding:6px 9px}.empty{margin:20px 0;padding:25px;border:1px dashed #d9e0ea;border-radius:8px;color:#667085;font-size:calc(12px * var(--admin-font-scale, 1));text-align:center}.site-scene-designer footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:20px}.site-scene-designer footer button{padding:10px 15px;border-color:#305fc7;background:#305fc7;color:#fff}.site-scene-designer footer span{font-size:calc(11px * var(--admin-font-scale, 1));color:#137452}.site-scene-designer footer .error{color:#bb3445}@media(max-width:900px){.site-scene-grid{grid-template-columns:1fr}.site-scene-designer header>span{display:none}}
</style>
<style scoped>
.scene-components{margin-top:24px;padding-top:19px;border-top:1px solid #e4e7ec}.scene-components>p{margin:0 0 14px;color:#667085;font-size:calc(11px * var(--admin-font-scale, 1))}.scene-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.scene-fields label{display:grid;gap:6px;color:#596579;font-size:calc(11px * var(--admin-font-scale, 1))}.scene-fields input:not([type=color]),.scene-fields textarea{box-sizing:border-box;width:100%;padding:9px;border:1px solid #d2d9e5;border-radius:6px;background:#fff;color:#263244;font:inherit}.scene-fields input[type=color]{width:65px;height:36px;padding:3px;border:1px solid #d2d9e5;border-radius:6px;background:#fff}.scene-fields textarea{resize:vertical}.scene-toggles{display:flex;flex-wrap:wrap;gap:9px;margin-top:15px}.scene-toggles label{display:flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid #dce3ef;border-radius:6px;background:#f8fafc;color:#475467;font-size:calc(11px * var(--admin-font-scale, 1))}@media(max-width:900px){.scene-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
