<script setup>
import { computed, ref, watch } from 'vue'
import { loadChinaAdminMap } from '../../../runtime/chinaAdminMaps.js'

const props=defineProps({modelValue:{type:Object,required:true},provinces:{type:Array,default:()=>[]},countries:{type:Array,default:()=>[]}})
const emit=defineEmits(['update:modelValue'])
const cities=ref([]),districts=ref([]),directDistricts=ref([]),loadingCities=ref(false),loadingDistricts=ref(false),geoError=ref('')
const country=computed(()=>String(props.modelValue.country || 'CHN'))
const provinceCode=computed(()=>String(props.modelValue.regionCode || ''))
const cityCode=computed(()=>String(props.modelValue.cityCode || ''))
const directMunicipality=computed(()=>directDistricts.value.length>0)
function patch(fields){emit('update:modelValue',{...props.modelValue,...fields})}
function normalizeName(value){return String(value || '').trim().replace(/[\s　]/g,'').replace(/(特别行政区|自治区|自治州|自治县|地区|省|市|区|县)$/,'')}

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

function changeCountry(value){patch({country:value,regionCode:'',regionName:'',cityCode:'',city:'',districtCode:'',districtName:''})}
function changeProvince(value){const province=props.provinces.find(item=>item.id===value);patch({regionCode:value,regionName:province?.name || '',cityCode:'',city:'',districtCode:'',districtName:''})}
function changeCity(value){const city=cities.value.find(item=>item.id===value);patch({cityCode:value,city:city?.name || '',districtCode:'',districtName:''})}
function changeDistrict(value){const district=districts.value.find(item=>item.id===value);patch({districtCode:value,districtName:district?.name || ''})}
</script>

<template>
  <div class="factory-geo-fields">
    <label>国家／地区<select :value="country" @change="changeCountry($event.target.value)"><option value="CHN">中国</option><option v-for="item in countries.filter(row=>row.id!=='CHN')" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <template v-if="country==='CHN'">
      <label>省级区域<select :value="provinceCode" @change="changeProvince($event.target.value)"><option value="">待定位</option><option v-for="item in provinces" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>{{ directMunicipality?'市辖区':'城市' }}<select :value="cityCode" :disabled="!provinceCode || loadingCities || !cities.length" @change="changeCity($event.target.value)"><option value="">{{ loadingCities?'载入城市…':'请选择' }}</option><option v-for="item in cities" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>区／县<select :value="props.modelValue.districtCode || ''" :disabled="!cityCode || loadingDistricts || !districts.length" @change="changeDistrict($event.target.value)"><option value="">{{ loadingDistricts?'载入区县…':cityCode?'可选':'请先选城市' }}</option><option v-for="item in districts" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    </template>
    <label v-else>区域名称<input :value="props.modelValue.regionName || ''" maxlength="100" @input="patch({regionName:$event.target.value})" /></label>
    <label>{{ country==='CHN'?'城市名称（自动）':'城市／地址说明' }}<input :value="props.modelValue.city || ''" :readonly="country==='CHN'" maxlength="200" @input="patch({city:$event.target.value})" /></label>
    <label v-if="country!=='CHN'">区县／区域<input :value="props.modelValue.districtName || ''" maxlength="100" @input="patch({districtName:$event.target.value})" /></label>
    <p v-if="geoError" class="factory-geo-error" role="status">{{ geoError }}</p>
  </div>
</template>

<style scoped>
.factory-geo-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.factory-geo-fields label{display:grid;gap:7px;min-width:0;font-size:12px;color:#505c73}.factory-geo-fields input,.factory-geo-fields select{box-sizing:border-box;width:100%;min-width:0;padding:9px;border:1px solid #d4dae3;border-radius:6px;background:#fff;color:#273246}.factory-geo-fields input[readonly]{background:#f3f5f8;color:#657188}.factory-geo-fields select:disabled{opacity:.62}.factory-geo-error{grid-column:1/-1;margin:0;color:#ad4050;font-size:11px}@media(max-width:900px){.factory-geo-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
