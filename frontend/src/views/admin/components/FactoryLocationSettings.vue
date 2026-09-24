<script setup>
import { onMounted, ref, reactive } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { normalizeFactoryLocation } from '../../../runtime/groupTopology.js'
import FactoryDirectorySettings from './FactoryDirectorySettings.vue'
import FactoryDistributionPreview from './FactoryDistributionPreview.vue'
import FactoryGeoFields from './FactoryGeoFields.vue'
const form=reactive({country:'CHN',regionCode:'',regionName:'',cityCode:'',city:'',districtCode:'',districtName:''})
const factoryName=ref('')
const provinces=ref([]),countries=ref([]),loading=ref(true),loaded=ref(false),saving=ref(false),message=ref(''),failure=ref(false)
const previewRevision=ref(0)
onMounted(async()=>{
  try {
    const [settings,china,world]=await Promise.all([adminApi.getSettings(),fetch('/maps/china-provinces.geojson').then(r=>r.json()),fetch('/maps/world-countries.geojson').then(r=>r.json())])
    const value=normalizeFactoryLocation(settings.factory_location)
    factoryName.value=String(settings.factory_name || '')
    Object.assign(form,value)
    provinces.value=china.features.filter(f=>f.properties.adcode).map(f=>({id:String(f.properties.adcode),name:f.properties.name}))
    countries.value=world.features.map(f=>({id:f.properties.ADM0_A3,name:f.properties.NAME_ZH || f.properties.ADMIN})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))
    loaded.value=true
  }catch(e){failure.value=true;message.value=e.message}finally{loading.value=false}
})
async function save(){
  if(saving.value || !loaded.value)return
  const value=normalizeFactoryLocation(form)
  saving.value=true;message.value='正在保存工厂位置…';failure.value=false
  try {await adminApi.saveSettings({factory_name:factoryName.value.trim(),factory_location:JSON.stringify(value)});previewRevision.value++;message.value='工厂资料已保存，分布预览会自动更新。'}catch(e){failure.value=true;message.value=e.message}finally{saving.value=false}
}
</script>
<template>
  <section class="factory-location-settings">
    <div class="factory-page-heading"><div><h3>工厂资料与地理位置</h3><p>维护当前后台配置范围工厂的名称与行政区归属；不会改变 Unity 内车间和设备的空间坐标。</p></div><span class="scope-chip">按工厂隔离</span></div>
    <label class="factory-name">工厂名称<input v-model="factoryName" maxlength="120" :disabled="loading || !loaded" /></label>
    <FactoryGeoFields :model-value="form" :provinces="provinces" :countries="countries" @update:model-value="Object.assign(form,$event)" />
    <div class="factory-location-actions">
      <button class="save-location" type="button" :disabled="loading || saving || !loaded" @click="save">{{ saving ? '保存中…':'保存工厂位置' }}</button>
      <FactoryDistributionPreview :refresh-key="previewRevision" />
      <p role="status" :class="{error:failure}">{{ message }}</p>
    </div>
  </section>
  <FactoryDirectorySettings :provinces="provinces" :countries="countries" @saved="previewRevision++" />
</template>
<style scoped>
.factory-location-settings{padding:0 0 24px}.factory-page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.factory-location-settings h3{margin:0;font-size:16px;color:#202635}.factory-location-settings p{font-size:12px;line-height:1.7;color:#778196}.scope-chip{padding:5px 9px;border:1px solid #dbe5f5;border-radius:20px;background:#f5f8fe;color:#58719b;font-size:10px;white-space:nowrap}.factory-name{display:grid;gap:6px;max-width:460px;margin:14px 0;color:#58657b;font-size:11px}.factory-name input{padding:9px 10px;border:1px solid #d4dae3;border-radius:6px;background:#fff;color:#273246;font:inherit}.factory-location-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px}.factory-location-actions .save-location{padding:9px 16px;border:0;border-radius:6px;background:#3269db;color:#fff;cursor:pointer}.factory-location-actions button:disabled{opacity:.5;cursor:wait}.factory-location-actions p{margin:0}.factory-location-actions .error{color:#b64250}
</style>
