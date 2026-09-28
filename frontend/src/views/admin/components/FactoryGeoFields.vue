<script setup>
import { computed, ref, watch } from 'vue'
import { loadChinaAdminMap } from '../../../runtime/chinaAdminMaps.js'
import { loadOverseasAdminCatalog, OVERSEAS_CATALOG_COUNTRIES } from '../../../runtime/overseasAdminCatalog.js'
import { adminApi } from '../../../config/factoryConfig.js'

const props=defineProps({modelValue:{type:Object,required:true},provinces:{type:Array,default:()=>[]},countries:{type:Array,default:()=>[]}})
const emit=defineEmits(['update:modelValue'])
const cities=ref([]),districts=ref([]),directDistricts=ref([]),loadingCities=ref(false),loadingDistricts=ref(false),geoError=ref('')
const country=computed(()=>String(props.modelValue.country || 'CHN'))
const provinceCode=computed(()=>String(props.modelValue.regionCode || ''))
const cityCode=computed(()=>String(props.modelValue.cityCode || ''))
const directMunicipality=computed(()=>directDistricts.value.length>0)
const selectedCountry=computed(()=>props.countries.find(item=>item.id===country.value))
const overseasCatalog=ref(null),loadingOverseas=ref(false),manualOverseas=ref(false),cityFilter=ref('')
const hasOverseasCatalog=computed(()=>OVERSEAS_CATALOG_COUNTRIES.has(country.value))
const overseasRegions=computed(()=>overseasCatalog.value?.states || [])
const selectedOverseasRegion=computed(()=>overseasRegions.value.find(item=>item.code===props.modelValue.regionCode || item.name===props.modelValue.regionName))
const overseasCities=computed(()=>selectedOverseasRegion.value?.cities || [])
const selectedOverseasCity=computed(()=>overseasCities.value.find(item=>item.id===props.modelValue.cityCode || item.name===props.modelValue.city))
const filteredOverseasCities=computed(()=>{
  const query=cityFilter.value.trim().toLocaleLowerCase()
  if(!query)return overseasCities.value
  const matched=overseasCities.value.filter(item=>item.name.toLocaleLowerCase().includes(query))
  if(selectedOverseasCity.value && !matched.includes(selectedOverseasCity.value))matched.unshift(selectedOverseasCity.value)
  return matched
})
const placeQuery=ref(''),placeResults=ref([]),searching=ref(false),lookupError=ref('')
let placeRequest=0
function patch(fields){emit('update:modelValue',{...props.modelValue,...fields})}
function normalizeName(value){return String(value || '').trim().replace(/[\s　]/g,'').replace(/(特别行政区|自治区|自治州|自治县|地区|省|市|区|县)$/,'')}

watch(country,async code=>{
  overseasCatalog.value=null;loadingOverseas.value=false;manualOverseas.value=false;cityFilter.value='';geoError.value=''
  if(!OVERSEAS_CATALOG_COUNTRIES.has(code))return
  loadingOverseas.value=true
  try{
    const data=await loadOverseasAdminCatalog(code)
    if(country.value!==code)return
    overseasCatalog.value=data
    if(props.modelValue.regionName && !data.states.some(item=>item.code===props.modelValue.regionCode || item.name===props.modelValue.regionName))manualOverseas.value=true
  }catch(error){if(country.value===code){geoError.value=error.message;manualOverseas.value=true}}
  finally{if(country.value===code)loadingOverseas.value=false}
},{immediate:true})

watch(provinceCode,async code=>{
  cities.value=[];districts.value=[];directDistricts.value=[];geoError.value=''
  if(country.value!=='CHN' || !/^\d{6}$/.test(code))return
  loadingCities.value=true
  try{
    const data=await loadChinaAdminMap('province',code)
    if(provinceCode.value!==code)return
    const rows=data.features.filter(feature=>/^\d{6}$/.test(String(feature.properties?.adcode || '')))
    const direct=rows.length>0 && rows.every(feature=>feature.properties?.level==='district')
    if(direct){
      directDistricts.value=rows
      const province=props.provinces.find(item=>item.id===code)
      cities.value=[{id:code,name:province?.name || props.modelValue.regionName || code,municipality:true}]
      patch({cityCode:code,city:province?.name || props.modelValue.regionName || code})
      districts.value=rows.map(feature=>({id:String(feature.properties.adcode),name:String(feature.properties.name || feature.properties.adcode)}))
    }else{
      cities.value=rows.map(feature=>({id:String(feature.properties.adcode),name:String(feature.properties.name || feature.properties.adcode),hasDistricts:Number(feature.properties?.childrenNum)>0}))
      const legacyCity=normalizeName(props.modelValue.city)
      const match=cities.value.find(item=>item.id===props.modelValue.cityCode || normalizeName(item.name)===legacyCity)
      if(match && !props.modelValue.cityCode)patch({cityCode:match.id,city:match.name})
      if(!match)patch({cityCode:'',districtCode:'',districtName:''})
    }
  }catch(error){if(provinceCode.value===code)geoError.value=error.message}
  finally{loadingCities.value=false}
},{immediate:true})

watch([cityCode,()=>cities.value.length,()=>directDistricts.value.length],async([code])=>{
  districts.value=directDistricts.value.map(feature=>({id:String(feature.properties.adcode),name:String(feature.properties.name || feature.properties.adcode)}))
  if(directMunicipality.value && code===provinceCode.value)return
  if(!/^\d{6}$/.test(code) || code===provinceCode.value){districts.value=[];return}
  const selectedCity=cities.value.find(item=>item.id===code)
  if(!selectedCity || !selectedCity.hasDistricts)return
  loadingDistricts.value=true;geoError.value=''
  try{
    const data=await loadChinaAdminMap('district',code)
    if(cityCode.value!==code)return
    districts.value=data.features.filter(feature=>/^\d{6}$/.test(String(feature.properties?.adcode || ''))).map(feature=>({id:String(feature.properties.adcode),name:String(feature.properties.name || feature.properties.adcode)}))
    const match=districts.value.find(item=>item.id===props.modelValue.districtCode || normalizeName(item.name)===normalizeName(props.modelValue.districtName))
    if(!match)patch({districtCode:'',districtName:''})
    else if(!props.modelValue.districtCode)patch({districtCode:match.id,districtName:match.name})
  }catch(error){if(cityCode.value===code)geoError.value=error.message}
  finally{loadingDistricts.value=false}
},{immediate:true})

function changeCountry(value){placeRequest++;searching.value=false;placeQuery.value='';placeResults.value=[];lookupError.value='';patch({country:value,regionCode:'',regionName:'',cityCode:'',city:'',districtCode:'',districtName:'',latitude:null,longitude:null})}
function changeProvince(value){const province=props.provinces.find(item=>item.id===value);patch({regionCode:value,regionName:province?.name || '',cityCode:'',city:'',districtCode:'',districtName:'',latitude:null,longitude:null})}
function changeCity(value){const city=cities.value.find(item=>item.id===value);patch({cityCode:value,city:city?.name || '',districtCode:'',districtName:'',latitude:null,longitude:null})}
function changeDistrict(value){const district=districts.value.find(item=>item.id===value);patch({districtCode:value,districtName:district?.name || '',latitude:null,longitude:null})}
function changeOverseasRegion(value){
  const region=overseasRegions.value.find(item=>item.code===value)
  cityFilter.value=''
  patch({regionCode:region?.code || '',regionName:region?.name || '',cityCode:'',city:'',districtCode:'',districtName:'',latitude:null,longitude:null})
}
function changeOverseasCity(value){
  const city=overseasCities.value.find(item=>item.id===value)
  patch({cityCode:city?.id || '',city:city?.name || '',districtCode:'',districtName:'',latitude:city ? city.latitude : null,longitude:city ? city.longitude : null})
}

async function searchPlace(){
  const isoA2=selectedCountry.value?.isoA2
  const query=placeQuery.value.trim()
  if(!/^[A-Z]{2}$/.test(isoA2 || '')){lookupError.value='该国家缺少地点查询代码，请手动填写位置';return}
  if(query.length<3){lookupError.value='请输入至少 3 个字的城市、区县或地址';return}
  const current=++placeRequest
  searching.value=true;lookupError.value='';placeResults.value=[]
  try{
    const result=await adminApi.searchFactoryPlace(isoA2,query)
    if(current!==placeRequest)return
    placeResults.value=result.results || []
    if(!placeResults.value.length)lookupError.value='未找到该国家内的匹配地点，请换个地名或手动填写'
  }catch(error){if(current===placeRequest)lookupError.value=error.message || '地点查询失败，可手动填写'}
  finally{if(current===placeRequest)searching.value=false}
}

function selectPlace(place){
  const region=overseasRegions.value.find(item=>item.name.toLocaleLowerCase()===String(place.regionName || '').toLocaleLowerCase())
  const city=region?.cities.find(item=>item.name.toLocaleLowerCase()===String(place.city || '').toLocaleLowerCase())
  if(hasOverseasCatalog.value)manualOverseas.value=!region || Boolean(place.city && !city)
  patch({regionCode:region?.code || '',regionName:place.regionName,cityCode:city?.id || '',city:place.city,districtCode:'',districtName:place.districtName,latitude:place.latitude,longitude:place.longitude})
  placeResults.value=[]
  lookupError.value='已填入地点与坐标；请核对行政区后保存'
}
</script>

<template>
  <div class="factory-geo-fields">
    <label>国家／地区<select :value="country" @change="changeCountry($event.target.value)"><option value="CHN">中国</option><option v-for="item in countries.filter(row=>row.id!=='CHN')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <template v-if="country==='CHN'">
      <label>省级区域<select :value="provinceCode" @change="changeProvince($event.target.value)"><option value="">待定位</option><option v-for="item in provinces" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>{{ directMunicipality?'市辖区':'城市' }}<select :value="cityCode" :disabled="!provinceCode || loadingCities || !cities.length" @change="changeCity($event.target.value)"><option value="">{{ loadingCities?'载入城市…':'请选择' }}</option><option v-for="item in cities" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>区／县<select :value="props.modelValue.districtCode || ''" :disabled="!cityCode || loadingDistricts || !districts.length" @change="changeDistrict($event.target.value)"><option value="">{{ loadingDistricts?'载入区县…':cityCode?'可选':'请先选城市' }}</option><option v-for="item in districts" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    </template>
    <template v-else-if="hasOverseasCatalog && !manualOverseas">
      <label>省／州／行政区<select :value="selectedOverseasRegion?.code || ''" :disabled="loadingOverseas || !overseasCatalog" @change="changeOverseasRegion($event.target.value)"><option value="">{{ loadingOverseas?'载入行政区…':'请选择' }}</option><option v-for="item in overseasRegions" :key="item.code" :value="item.code">{{ item.name }}</option></select></label>
      <label>城市／市辖区<span class="overseas-city-picker"><input v-model="cityFilter" type="search" :disabled="!selectedOverseasRegion" placeholder="筛选城市名称" aria-label="筛选城市" /><select :value="selectedOverseasCity?.id || ''" :disabled="!selectedOverseasRegion || !overseasCities.length" @change="changeOverseasCity($event.target.value)"><option value="">{{ selectedOverseasRegion?'请选择城市':'请先选行政区' }}</option><option v-for="item in filteredOverseasCities" :key="item.id" :value="item.id">{{ item.name }}</option></select></span></label>
      <label>区县／详细区域（可选）<input :value="props.modelValue.districtName || ''" maxlength="100" @input="patch({districtCode:'',districtName:$event.target.value})" /></label>
    </template>
    <div v-if="country!=='CHN'" class="overseas-place-search">
      <label>查找海外地点<input v-model="placeQuery" maxlength="160" placeholder="输入城市、区县或详细地址" @keydown.enter.prevent="searchPlace" /></label>
      <button type="button" :disabled="searching || !selectedCountry?.isoA2" @click="searchPlace">{{ searching?'查询中…':'查找地点' }}</button>
      <p class="place-search-note">{{ hasOverseasCatalog?'城市下拉框填入的是城市中心近似坐标，请按厂区实际位置修正；':'此国家暂未提供离线行政区下拉框，可搜索或手填。' }}仅点击查找时向 OpenStreetMap 发送查询词，不自动附带工厂名称。地图数据 © OpenStreetMap contributors。</p>
      <div v-if="placeResults.length" class="place-search-results" role="listbox" aria-label="地点查询结果"><button v-for="(place,index) in placeResults" :key="index" type="button" role="option" :aria-selected="false" @click="selectPlace(place)"><strong>{{ place.displayName }}</strong><small>{{ place.latitude.toFixed(5) }}, {{ place.longitude.toFixed(5) }}</small></button></div>
      <p v-if="lookupError" class="place-search-feedback" role="status">{{ lookupError }}</p>
    </div>
    <button v-if="hasOverseasCatalog" type="button" class="overseas-manual-toggle" @click="manualOverseas=!manualOverseas">{{ manualOverseas?'返回行政区下拉选择':'找不到地点？手动填写' }}</button>
    <label v-if="country!=='CHN' && (!hasOverseasCatalog || manualOverseas)">区域名称<input :value="props.modelValue.regionName || ''" maxlength="100" @input="patch({regionCode:'',regionName:$event.target.value,cityCode:'',latitude:null,longitude:null})" /></label>
    <label v-if="country==='CHN' || !hasOverseasCatalog || manualOverseas">{{ country==='CHN'?'城市名称（自动）':'城市／地址说明' }}<input :value="props.modelValue.city || ''" :readonly="country==='CHN'" maxlength="200" @input="patch({cityCode:'',city:$event.target.value,latitude:null,longitude:null})" /></label>
    <label v-if="country!=='CHN' && (!hasOverseasCatalog || manualOverseas)">区县／区域<input :value="props.modelValue.districtName || ''" maxlength="100" @input="patch({districtCode:'',districtName:$event.target.value})" /></label>
    <label>纬度（工厂定位）<input type="number" step="any" min="-90" max="90" :value="props.modelValue.latitude ?? ''" placeholder="例如 39.123456" @input="patch({latitude:$event.target.value})" /></label>
    <label>经度（工厂定位）<input type="number" step="any" min="-180" max="180" :value="props.modelValue.longitude ?? ''" placeholder="例如 117.123456" @input="patch({longitude:$event.target.value})" /></label>
    <p class="geo-coordinate-note">经纬度用于工厂定位；海外城市下拉选择仅给出城市中心坐标，保存前请调整到实际厂区，或使用地点搜索。留空时显示“位置待完善”，不影响车间模型坐标。行政区目录 © Countries States Cities Database contributors（ODbL 1.0）。</p>
    <p v-if="geoError" class="factory-geo-error" role="status">{{ geoError }}</p>
  </div>
</template>

<style scoped>
.factory-geo-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.factory-geo-fields label{display:grid;gap:7px;min-width:0;font-size:12px;color:#505c73}.factory-geo-fields input,.factory-geo-fields select{box-sizing:border-box;width:100%;min-width:0;padding:9px;border:1px solid #d4dae3;border-radius:6px;background:#fff;color:#273246}.factory-geo-fields input[readonly]{background:#f3f5f8;color:#657188}.factory-geo-fields select:disabled{opacity:.62}.factory-geo-error{grid-column:1/-1;margin:0;color:#ad4050;font-size:11px}@media(max-width:900px){.factory-geo-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}
.geo-coordinate-note{grid-column:1/-1;margin:0;color:#7b879a;font-size:11px}
.overseas-place-search{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px;padding:11px;border:1px solid #dce5f2;border-radius:8px;background:#f8faff}.overseas-place-search>button{height:36px;padding:0 13px;border:1px solid #7ea5e9;border-radius:6px;background:#eaf2ff;color:#285cb5;cursor:pointer}.overseas-place-search>button:disabled{opacity:.6;cursor:default}.place-search-note,.place-search-feedback{grid-column:1/-1;margin:0;color:#73839b;font-size:10px;line-height:1.5}.place-search-feedback{color:#38669e}.place-search-results{grid-column:1/-1;display:grid;max-height:185px;overflow:auto;border:1px solid #dce5f2;border-radius:6px;background:#fff}.place-search-results button{display:flex;justify-content:space-between;gap:10px;text-align:left;padding:8px 10px;border:0;border-bottom:1px solid #eef2f7;background:#fff;color:#33465f;cursor:pointer}.place-search-results button:hover{background:#f0f6ff}.place-search-results strong{font-size:11px;font-weight:500}.place-search-results small{white-space:nowrap;color:#8290a4}
.overseas-city-picker{display:grid;gap:5px;min-width:0}.overseas-city-picker input{height:32px}.overseas-manual-toggle{grid-column:1/-1;justify-self:start;padding:0;border:0;background:transparent;color:#3869bc;font:inherit;font-size:11px;cursor:pointer}.overseas-manual-toggle:hover{text-decoration:underline}
</style>
