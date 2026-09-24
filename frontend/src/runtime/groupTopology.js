import { parseSpatialObject } from '../utils/spatialLayout.js'

export function normalizeFactoryLocation(value) {
  const raw=parseSpatialObject(value)
  const adcode=value=>/^\d{6}$/.test(String(value ?? '').trim()) ? String(value).trim() : ''
  const country=String(raw.country || 'CHN').trim().toUpperCase()
  return {country:country==='CN' ? 'CHN':country,regionCode:adcode(raw.regionCode),regionName:String(raw.regionName || ''),cityCode:adcode(raw.cityCode),city:String(raw.city || ''),districtCode:adcode(raw.districtCode),districtName:String(raw.districtName || ''),
    }
}
const hasRegionAssignment=location=>location.country==='CHN' ? Boolean(location.regionCode) : Boolean(location.regionName)
const hasDistrictAssignment=location=>location.country==='CHN' ? Boolean(location.districtCode) : Boolean(location.regionName)
const directMunicipalityCodes=new Set(['110000','120000','310000','500000'])
export function currentFactorySite(config={}) {
  const devices=new Set()
  let lineCount=0
  for(const ws of config.workshops || []) {
    for(const line of ws.lines || []) {lineCount++; for(const device of line.devices || []) if(device.id!=null)devices.add(String(device.id))}
    for(const device of ws.devices || []) if(device.id!=null)devices.add(String(device.id))
  }
  return {id:config.factoryId || config.platform?.activeProject?.id || 'current_factory',name:config.settings?.factory_name || '当前工厂',
    location:normalizeFactoryLocation(config.settings?.factory_location),workshops:config.workshops?.length || 0,lines:lineCount,devices:devices.size}
}

export function factoryDataModePresentation(config={}) {
  const mode=String(config.settings?.data_mode || '').trim().toLowerCase()
  if(mode==='simulation')return {kind:'simulation',label:'模拟数据',detail:'由模拟引擎生成 · 非 PLC 实采'}
  if(mode==='integrated_plc')return {kind:'plc',label:'PLC 采集配置',detail:'连接状态以实时采集通路为准'}
  return {kind:'unknown',label:'数据模式未确认',detail:'设备数量仅代表配置，不代表在线'}
}

export function factoryDirectorySites(config = {}) {
  if(Array.isArray(config.factories) && config.factories.length){
    return config.factories.filter(factory=>factory?.enabled!==false).map(factory=>({
      id:String(factory.id),name:String(factory.name || '未命名工厂').slice(0,120),
      location:normalizeFactoryLocation(factory.location),runtime:'local',
      workshops:Number(factory.workshopCount || 0),lines:Number(factory.lineCount || 0),devices:Number(factory.deviceCount || 0)
    }))
  }
  const current = { ...currentFactorySite(config), runtime: 'local' }
  const raw = parseSpatialObject(config.settings?.factory_directory)
  const seen = new Set([current.id])
  const registered = (Array.isArray(raw.sites) ? raw.sites : []).slice(0,200).flatMap(row => {
    const id = String(row?.id || ''), name = String(row?.name || '').trim()
    if (!/^site_[a-zA-Z0-9_-]{1,80}$/.test(id) || !name || seen.has(id)) return []
    seen.add(id)
    return [{ id, name:name.slice(0,120), location:normalizeFactoryLocation(row.location), runtime:'registered', workshops:null, lines:null, devices:null }]
  })
  return [current, ...registered]
}

export function sitesInMapScope(sites, scope, region = '') {
  return sites.filter(site => {
    if (scope === 'china' && site.location.country !== 'CHN') return false
    if (!region) return true
    if (region === 'unassigned') return scope === 'china' ? !site.location.regionCode : !hasRegionAssignment(site.location)
    return scope === 'world' ? site.location.country === region : site.location.regionCode === region
  })
}

export function groupRegionEntries(sites, scope) {
  const groups = new Map()
  for (const site of sitesInMapScope(sites,scope)) {
    const code = scope === 'world' ? site.location.country || 'unassigned' : site.location.regionCode || 'unassigned'
    if (!groups.has(code)) groups.set(code,{code,count:0,localCount:0,registeredCount:0,districtAssignedCount:0,name:code==='unassigned' ? '待定位区域' : site.location.regionName || code})
    const group=groups.get(code)
    group.count++
    if(site.runtime==='local')group.localCount++
    else group.registeredCount++
    if(hasDistrictAssignment(site.location))group.districtAssignedCount++
  }
  return [...groups.values()]
}

// The group overview is one China-centred map. China is always represented
// by province codes; overseas countries appear only when a factory is in the
// backend directory for that country.
export function configuredOverseasCountries(sites) {
  return new Set(sites.map(site=>site.location.country).filter(country=>country && country!=='CHN'))
}

export function chinaRegionsWithFactories(sites) {
  return new Set(sites.filter(site=>site.location.country==='CHN' && site.location.regionCode).map(site=>site.location.regionCode))
}

export function sitesInUnifiedMap(sites, region = '') {
  if (!region) return sites
  if (region === 'unassigned') return sites.filter(site=>site.location.country==='CHN' && !site.location.regionCode)
  if (/^\d{6}$/.test(String(region))) return sites.filter(site=>site.location.country==='CHN' && site.location.regionCode===String(region))
  return sites.filter(site=>site.location.country===String(region).toUpperCase())
}

export function groupUnifiedRegionEntries(sites) {
  const groups=new Map()
  for(const site of sites) {
    const country=site.location.country || 'CHN'
    const code=country==='CHN' ? site.location.regionCode || 'unassigned' : country
    if(!groups.has(code))groups.set(code,{code,count:0,localCount:0,registeredCount:0,districtAssignedCount:0,name:code==='unassigned' ? '待定位区域' : site.location.regionName || (country==='CHN' ? code : country),country})
    const group=groups.get(code)
    group.count++
    if(site.runtime==='local')group.localCount++
    else group.registeredCount++
    if(hasDistrictAssignment(site.location))group.districtAssignedCount++
  }
  return [...groups.values()]
}

export function groupUnifiedMapPoints(sites, region = '') {
  if (region && /^\d{6}$/.test(String(region))) return groupMapPoints(sites.filter(site=>site.location.country==='CHN'),'china',region)
  if (region === 'unassigned') return groupMapPoints(sites.filter(site=>site.location.country==='CHN'),'china','unassigned')
  if (region) return groupMapPoints(sites,'world',String(region).toUpperCase())
  return [
    ...groupMapPoints(sites.filter(site=>site.location.country==='CHN'),'china'),
    ...groupMapPoints(sites.filter(site=>site.location.country!=='CHN'),'world')
  ]
}

export function sitesAtHierarchyLevel(sites, level = 'world', code = '') {
  const key=String(code || '')
  if(level==='world')return [...sites]
  if(level==='country')return sites.filter(site=>site.location.country===key)
  if(level==='province')return sites.filter(site=>site.location.country==='CHN' && site.location.regionCode===key)
  if(level==='city')return sites.filter(site=>site.location.country==='CHN' && (directMunicipalityCodes.has(key) ? site.location.regionCode===key : site.location.cityCode===key))
  if(level==='district')return sites.filter(site=>site.location.country==='CHN' && site.location.districtCode===key)
  return []
}

function normalizeAdminName(value) {
  return String(value || '').trim().replace(/[\s　]/g,'').replace(/(特别行政区|自治区|自治州|自治县|地区|省|市|区|县)$/,'')
}

function sitesForChildFeature(sites, level, feature, parentCode) {
  const code=String(feature.properties?.adcode || feature.properties?.ADM0_A3 || '')
  const name=normalizeAdminName(feature.properties?.name || feature.properties?.NAME_ZH || feature.properties?.ADMIN)
  if(level==='world')return sites.filter(site=>site.location.country===code)
  if(level==='country')return sites.filter(site=>site.location.country===parentCode && site.location.regionCode===code)
  if(level==='province')return sites.filter(site=>site.location.regionCode===parentCode && (code===parentCode || site.location.cityCode===code || !site.location.cityCode && normalizeAdminName(site.location.city)===name))
  if(level==='city')return sites.filter(site=>{
    const belongsToCity=directMunicipalityCodes.has(parentCode) ? site.location.regionCode===parentCode : site.location.cityCode===parentCode
    return belongsToCity && (site.location.districtCode===code || !site.location.districtCode && normalizeAdminName(site.location.districtName)===name)
  })
  return []
}

export function groupHierarchyEntries(sites, level, parentCode, childFeatures = []) {
  const current=level==='province' ? sitesAtHierarchyLevel(sites,'province',parentCode) : sitesAtHierarchyLevel(sites,level,parentCode)
  if(level==='district')return current.map(site=>({code:site.id,name:site.name,count:1,localCount:site.runtime==='local'?1:0,registeredCount:site.runtime==='registered'?1:0,districtAssignedCount:hasDistrictAssignment(site.location)?1:0,level:'factory',site}))
  const childLevel=level==='world' ? 'country' : level==='country' ? 'province' : level==='province' ? 'city' : level==='city' ? 'district' : ''
  if(!childLevel)return []
  if(level==='world'){
    const counts=new Map()
    for(const site of current){const code=site.location.country || 'CHN';if(!counts.has(code))counts.set(code,[]);counts.get(code).push(site)}
    return childFeatures.flatMap(feature=>{
      const code=String(feature.properties?.ADM0_A3 || feature.properties?.adcode || ''),rows=counts.get(code) || []
      if(!code || !rows.length)return []
      return [summarizeHierarchyRows(code,feature.properties?.NAME_ZH || feature.properties?.name || feature.properties?.ADMIN || code,childLevel,rows)]
    }).concat([...counts.entries()].filter(([code])=>!childFeatures.some(feature=>String(feature.properties?.ADM0_A3 || feature.properties?.adcode)===code)).map(([code,rows])=>summarizeHierarchyRows(code,rows[0]?.location.countryName || code,childLevel,rows)))
  }
  return childFeatures.map(feature=>{
    const code=String(feature.properties?.adcode || ''),name=String(feature.properties?.name || code)
    const rows=sitesForChildFeature(current,level,feature,parentCode)
    return summarizeHierarchyRows(code,name,childLevel,rows)
  }).filter(row=>row.code)
}

function summarizeHierarchyRows(code,name,level,rows) {
  return {code,name,level,count:rows.length,localCount:rows.filter(site=>site.runtime==='local').length,registeredCount:rows.filter(site=>site.runtime==='registered').length,districtAssignedCount:rows.filter(site=>hasDistrictAssignment(site.location)).length}
}

function adminMapCenter(feature) {
  const props=feature?.properties || {}
  const point=props.centroid || props.center || (Number.isFinite(props.LABEL_X) && Number.isFinite(props.LABEL_Y) ? [props.LABEL_X,props.LABEL_Y] : null)
  if(Array.isArray(point) && point.length>=2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))return [Number(point[0]),Number(point[1])]
  const coordinates=[]
  const polygons=feature?.geometry?.type==='Polygon'?[feature.geometry.coordinates]:feature?.geometry?.type==='MultiPolygon'?feature.geometry.coordinates:[]
  for(const rings of polygons)for(const value of rings[0] || [])if(Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1])))coordinates.push(value)
  if(!coordinates.length)return null
  const bounds=coordinates.reduce((result,value)=>({minX:Math.min(result.minX,value[0]),maxX:Math.max(result.maxX,value[0]),minY:Math.min(result.minY,value[1]),maxY:Math.max(result.maxY,value[1])}),{minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity})
  return [(bounds.minX+bounds.maxX)/2,(bounds.minY+bounds.maxY)/2]
}

export function hierarchyMapPoints(sites, level, code, childFeatures = []) {
  if(level==='district'){
    const feature=childFeatures.find(item=>String(item.properties?.adcode)===String(code)),center=adminMapCenter(feature)
    if(!center)return []
    return sitesAtHierarchyLevel(sites,level,code).map((site,index)=>({id:`site_${site.id}`,factoryId:site.id,targetRegion:code,name:site.name,count:1,localRuntimeCount:site.runtime==='local'?1:0,runtime:site.runtime,location:{mapCenter:center},mapOffset:[(index%3-1)*5,Math.floor(index/3)*5]}))
  }
  if(level==='country' && code!=='CHN')return areaFactoryPoints(sitesAtHierarchyLevel(sites,'country',code),code,childFeatures)
  const childLevel=level==='world'?'country':level==='country'?'province':level==='province'?'city':level==='city'?'district':''
  if(!childLevel)return []
  const entries=groupHierarchyEntries(sites,level,code,childFeatures)
  return entries.filter(entry=>entry.count>0).map(entry=>{
    const feature=childFeatures.find(item=>String(item.properties?.ADM0_A3 || item.properties?.adcode)===entry.code)
    const center=adminMapCenter(feature)
    if(!center)return null
    return {id:`area_${childLevel}_${entry.code}`,factoryId:'',targetRegion:entry.code,name:`${entry.name} · ${entry.count} 座`,count:entry.count,localRuntimeCount:entry.localCount,runtime:entry.localCount?'local':'registered',location:{mapCenter:center}}
  }).filter(Boolean)
}

// The opening map is global, but a China beacon must identify the province
// containing the registered site. Never place a province-assigned factory at
// China's geographical centre. Overseas sites remain grouped by country.
export function worldHierarchyMapPoints(sites, worldFeatures = [], chinaProvinceFeatures = []) {
  const countries = hierarchyMapPoints(sites, 'world', '', worldFeatures)
    .filter(point => point.targetRegion !== 'CHN')
  const provinces = hierarchyMapPoints(sites, 'country', 'CHN', chinaProvinceFeatures)
    .map(point => ({
      ...point,
      id: `world_${point.id}`,
      worldProvinceCode: point.targetRegion,
      worldProvinceName: point.name.split(' · ')[0]
    }))
  return [...countries, ...provinces]
}

function areaFactoryPoints(sites,code,features) {
  const feature=features.find(item=>String(item.properties?.ADM0_A3 || item.properties?.adcode)===String(code)),center=adminMapCenter(feature)
  if(!center)return []
  return sites.map((site,index)=>({id:`site_${site.id}`,factoryId:site.id,targetRegion:code,name:site.name,count:1,localRuntimeCount:site.runtime==='local'?1:0,runtime:site.runtime,location:{mapCenter:center},mapOffset:[(index%3-1)*5,Math.floor(index/3)*5]}))
}

// The overview aggregates by region/country; a drilled region shows factories.
// Coincident locations stay a cluster instead of inventing offset coordinates.
export function groupMapPoints(sites,scope,region='') {
  const buckets=new Map()
  for(const site of sitesInMapScope(sites,scope,region)){
    const targetRegion=scope==='world' ? site.location.country : site.location.regionCode
    const key=region ? site.location.districtCode || site.location.cityCode || site.location.regionCode || site.id : targetRegion || `factory_${site.id}`
    if(!buckets.has(key))buckets.set(key,{sites:[],targetRegion})
    buckets.get(key).sites.push(site)
  }
  return [...buckets.entries()].map(([key,bucket])=>{
    const first=bucket.sites[0],count=bucket.sites.length,localRuntimeCount=bucket.sites.filter(item=>item.runtime==='local').length
    const factoryId=region && count===1 || !bucket.targetRegion ? first.id : ''
    return {id:`map_${key}`,factoryId,targetRegion:region || bucket.targetRegion,
      name:factoryId ? first.name : region ? `同址工厂 · ${count} 座` : `${first.location.regionName || bucket.targetRegion} · ${count} 座`,
      count,localRuntimeCount,runtime:localRuntimeCount ? 'local':'registered',
      location:{...first.location}}
  })
}
export function isNativeMapEntry(to,from) {
  return to.name==='dashboard-overlay' && to.query?.embedded==='unity' && to.query?.scene!=='1' && !from.name
}
