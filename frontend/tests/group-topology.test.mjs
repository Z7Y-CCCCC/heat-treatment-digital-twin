import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { normalizeFactoryLocation,currentFactorySite,factoryDataModePresentation,isNativeMapEntry,factoryDirectorySites,sitesInMapScope,groupRegionEntries,groupMapPoints,configuredOverseasCountries,chinaRegionsWithFactories,sitesInUnifiedMap,groupUnifiedRegionEntries,groupUnifiedMapPoints,sitesAtHierarchyLevel,groupHierarchyEntries,hierarchyMapPoints,worldHierarchyMapPoints } from '../src/runtime/groupTopology.js'
import { adminFeatureCenter,adminFeatureCode,adminFeatureName,clearChinaAdminMapCache,loadChinaAdminMap } from '../src/runtime/chinaAdminMaps.js'
import { clearOverseasAdminCatalogCache, loadOverseasAdminCatalog, OVERSEAS_CATALOG_COUNTRIES } from '../src/runtime/overseasAdminCatalog.js'
const require=createRequire(import.meta.url)
const {normalizeSettingValue}=require('../../backend/routes/settings.js')
test('factory coordinates are optional and do not invent administrative assignment',()=>{
  for(const value of [null,'',{},'{broken}',{longitude:'',latitude:''}])assert.deepEqual(normalizeFactoryLocation(value),{country:'CHN',regionCode:'',regionName:'',cityCode:'',city:'',districtCode:'',districtName:'',latitude:null,longitude:null})
  const located=normalizeFactoryLocation({country:'CHN',regionCode:'510000',longitude:104.1,latitude:30.6})
  assert.equal(located.regionCode,'510000');assert.equal(located.longitude,104.1);assert.equal(located.latitude,30.6)
})
test('factory card counts the configured hierarchy and does not invent other factories',()=>{
  const site=currentFactorySite({settings:{factory_name:'现场 A'},workshops:[{lines:[{devices:[{id:'f1'},{id:'f2'}]}],devices:[{id:'cart'},{id:'f1'}]}]})
  assert.equal(site.devices,3);assert.equal(site.workshops,1);assert.equal(site.lines,1);assert.equal(site.name,'现场 A');assert.equal(site.location.regionCode,'')
})
test('group overview distinguishes simulation, PLC configuration and unknown data modes',()=>{
  assert.deepEqual(factoryDataModePresentation({settings:{data_mode:'simulation'}}),{kind:'simulation',label:'模拟数据',detail:'由模拟引擎生成 · 非 PLC 实采'})
  assert.deepEqual(factoryDataModePresentation({settings:{data_mode:'integrated_plc'}}),{kind:'plc',label:'PLC 采集配置',detail:'连接状态以实时采集通路为准'})
  assert.equal(factoryDataModePresentation({}).kind,'unknown')
})
test('native startup enters the map, while explicit scene entry and in-app navigation stay on scene',()=>{
  assert.equal(isNativeMapEntry({name:'dashboard-overlay',query:{embedded:'unity'}},{}),true)
  assert.equal(isNativeMapEntry({name:'dashboard-overlay',query:{embedded:'unity',scene:'1'}},{}),false)
  assert.equal(isNativeMapEntry({name:'dashboard-overlay',query:{embedded:'unity'}},{name:'group-overview'}),false)
  assert.equal(isNativeMapEntry({name:'dashboard-overlay',query:{}},{}),false)
})
test('backend persists validated factory coordinates alongside administrative assignment',()=>{
  const empty=JSON.parse(normalizeSettingValue('factory_location',{country:'CHN',longitude:null,latitude:null}))
  assert.deepEqual(Object.keys(empty).sort(),['city','cityCode','country','districtCode','districtName','latitude','longitude','regionCode','regionName'])
  const located=JSON.parse(normalizeSettingValue('factory_location',{country:'CHN',longitude:104,latitude:30,regionCode:'510000'}))
  assert.equal(located.regionCode,'510000');assert.equal(located.longitude,104);assert.equal(located.latitude,30)
  assert.throws(()=>normalizeSettingValue('factory_location',{longitude:181}),/经度/)
  assert.throws(()=>normalizeSettingValue('factory_location',{latitude:-91}),/纬度/)
  const detailed=JSON.parse(normalizeSettingValue('factory_location',{country:'CHN',regionCode:'130000',cityCode:'130100',districtCode:'130102',districtName:'长安区'}))
  assert.deepEqual([detailed.regionCode,detailed.cityCode,detailed.districtCode,detailed.districtName],['130000','130100','130102','长安区'])
  const invalidCodes=JSON.parse(normalizeSettingValue('factory_location',{regionCode:'bad',cityCode:'abc',districtCode:'10000000'}))
  assert.deepEqual([invalidCodes.regionCode,invalidCodes.cityCode,invalidCodes.districtCode],['','',''])
})

test('directory metadata cannot impersonate the local runtime or populate invented metrics',()=>{
  const config={settings:{factory_directory:JSON.stringify({sites:[
    {id:'site_east',name:'华东登记厂',runtime:'local',devices:99,location:{country:'CHN',regionCode:'310000',longitude:121,latitude:31}},
    {id:'project_default',name:'伪装本机'}, {id:'site_east',name:'重复记录'}
  ]})},platform:{activeProject:{id:'project_default'}}}
  const sites=factoryDirectorySites(config)
  assert.equal(sites.length,2)
  assert.equal(sites[0].runtime,'local')
  assert.equal(sites[1].runtime,'registered')
  assert.equal(sites[1].devices,null)
})

test('region lists and region filters agree for administrative factory assignments',()=>{
  const sites=factoryDirectorySites({settings:{factory_directory:{sites:[
    {id:'site_southwest',name:'已定位',location:{country:'CHN',regionCode:'510000',longitude:104,latitude:30}},
    {id:'site_usa',name:'海外',location:{country:'USA',longitude:-100,latitude:40}},
    {id:'site_unknown',name:'未知',location:{country:'CHN'}}
  ]}}})
  assert.equal(sitesInMapScope(sites,'china').length,3)
  assert.equal(sitesInMapScope(sites,'china','510000').length,1)
  assert.equal(sitesInMapScope(sites,'world','USA').length,1)
  for(const scope of ['china','world'])for(const row of groupRegionEntries(sites,scope))assert.equal(sitesInMapScope(sites,scope,row.code).length,row.count)
})

test('backend registry validation rejects malformed IDs, duplicates and oversized lists',()=>{
  const valid={id:'site_a',name:'登记厂',runtime:'local',url:'http://example.invalid',location:{country:'CHN',longitude:104,latitude:30}}
  const clean=JSON.parse(normalizeSettingValue('factory_directory',{sites:[valid]}))
  assert.deepEqual(Object.keys(clean.sites[0]).sort(),['id','location','name'])
  assert.throws(()=>normalizeSettingValue('factory_directory',{sites:[valid,valid]}),/重复/)
  assert.throws(()=>normalizeSettingValue('factory_directory',{sites:[{...valid,id:'project_default'}]}),/ID/)
  assert.throws(()=>normalizeSettingValue('factory_directory',{sites:[{...valid,name:' '}]}),/名称/)
  assert.throws(()=>normalizeSettingValue('factory_directory',{sites:Array(201).fill(valid)}),/200/)
  const located=JSON.parse(normalizeSettingValue('factory_directory',{sites:[valid]}))
  assert.equal(located.sites[0].location.longitude,104)
  assert.equal(located.sites[0].location.latitude,30)
})

test('overview markers aggregate by area while preserving factory coordinates',()=>{
  const sites=factoryDirectorySites({settings:{factory_location:{country:'CHN',regionCode:'510000',longitude:104,latitude:30},factory_directory:{sites:[{id:'site_b',name:'登记 B',location:{country:'CHN',regionCode:'510000',longitude:105,latitude:31}}]}}})
  const overview=groupMapPoints(sites,'china')
  assert.equal(overview.length,1);assert.equal(overview[0].count,2);assert.equal(overview[0].localRuntimeCount,1)
  assert.equal(overview[0].targetRegion,'510000')
  const detail=groupMapPoints(sites,'china','510000')
  assert.equal(detail.length,1);assert.equal(detail[0].count,2)
  sites[1].location={...sites[0].location}
  const coincident=groupMapPoints(sites,'china','510000')
  assert.equal(coincident.length,1);assert.equal(coincident[0].count,2);assert.equal(coincident[0].location.longitude,104)
})

test('district markers use each factory coordinate and label unlocated factories',()=>{
  const feature={properties:{adcode:'120101',centroid:[117.2,39.12]},geometry:{type:'Polygon',coordinates:[[[117,39],[118,39],[118,40],[117,40],[117,39]]]}}
  const sites=[
    {id:'a',name:'A厂',runtime:'local',location:normalizeFactoryLocation({country:'CHN',regionCode:'120000',districtCode:'120101',latitude:39.11,longitude:117.19})},
    {id:'b',name:'B厂',runtime:'local',location:normalizeFactoryLocation({country:'CHN',regionCode:'120000',districtCode:'120101',latitude:39.16,longitude:117.24})},
    {id:'c',name:'C厂',runtime:'local',location:normalizeFactoryLocation({country:'CHN',regionCode:'120000',districtCode:'120101'})}
  ]
  const points=hierarchyMapPoints(sites,'district','120101',[feature])
  assert.equal(points.length,3)
  assert.deepEqual(points[0].location.mapCenter,[117.19,39.11])
  assert.deepEqual(points[1].location.mapCenter,[117.24,39.16])
  assert.equal(points[0].located,true)
  assert.equal(points[2].located,false)
  assert.deepEqual(points[2].location.mapCenter,[117.2,39.12])
})

test('overseas country view places factories at their own coordinates and flags missing locations',()=>{
  const feature={properties:{ADM0_A3:'KOR',LABEL_X:127.5,LABEL_Y:36.5}}
  const sites=[
    {id:'seoul',name:'首尔工厂',runtime:'local',location:normalizeFactoryLocation({country:'KOR',regionName:'首尔',latitude:37.56,longitude:126.98})},
    {id:'busan',name:'釜山工厂',runtime:'local',location:normalizeFactoryLocation({country:'KOR',regionName:'釜山',latitude:35.18,longitude:129.07})},
    {id:'pending',name:'待定位工厂',runtime:'local',location:normalizeFactoryLocation({country:'KOR'})}
  ]
  const points=hierarchyMapPoints(sites,'country','KOR',[feature])
  assert.deepEqual(points.map(point=>point.location.mapCenter),[[126.98,37.56],[129.07,35.18],[127.5,36.5]])
  assert.deepEqual(points.map(point=>point.located),[true,true,false])
})

test('the single China-centred map keeps China provinces and only promotes configured overseas countries',()=>{
  const sites=factoryDirectorySites({settings:{factory_location:{country:'CHN',regionCode:'510000',longitude:104,latitude:30},factory_directory:{sites:[
    {id:'site_japan',name:'日本工厂',location:{country:'JPN',longitude:139,latitude:36}},
    {id:'site_us_unlocated',name:'美国待定位工厂',location:{country:'USA'}},
    {id:'site_north',name:'华北工厂',location:{country:'CHN',regionCode:'110000',longitude:116,latitude:40}}
  ]}}})
  assert.deepEqual([...configuredOverseasCountries(sites)].sort(),['JPN','USA'])
  assert.deepEqual([...chinaRegionsWithFactories(sites)].sort(),['110000','510000'])
  assert.deepEqual(sitesInUnifiedMap(sites,'510000').map(site=>site.id),[sites[0].id])
  assert.deepEqual(sitesInUnifiedMap(sites,'JPN').map(site=>site.id),['site_japan'])
  assert.deepEqual(sitesInUnifiedMap(sites,'unassigned'),[])
  const entries=groupUnifiedRegionEntries(sites)
  assert.deepEqual(entries.map(row=>row.code).sort(),['110000','JPN','USA','510000'].sort())
  assert.equal(entries.find(row=>row.code==='USA').districtAssignedCount,0)
  assert.deepEqual(groupUnifiedMapPoints(sites,'JPN').map(point=>point.factoryId),['site_japan'])
  assert.deepEqual(groupUnifiedMapPoints(sites).map(point=>point.targetRegion).sort(),['110000','510000','JPN','USA'])
})

test('the softened surroundings map is geographically clipped to the China-centred viewport',()=>{
  const map=JSON.parse(readFileSync(new URL('../public/maps/china-surroundings.geojson',import.meta.url),'utf8'))
  const codes=new Set(map.features.map(feature=>feature.properties.ADM0_A3))
  assert.ok(codes.has('RUS'));assert.ok(codes.has('MNG'));assert.ok(codes.has('JPN'));assert.equal(codes.has('USA'),false)
  const visit=coordinates=>{for(const item of coordinates){if(typeof item[0]==='number'){assert.ok(item[0]>=53-1e-7 && item[0]<=155+1e-7);assert.ok(item[1]>=-12-1e-7 && item[1]<=76+1e-7)}else visit(item)}}
  for(const feature of map.features)visit(feature.geometry.coordinates)
})

test('global to district hierarchy groups configured countries and exact China administrative areas',()=>{
  const sites=factoryDirectorySites({settings:{factory_location:{country:'CHN',regionCode:'130000',regionName:'河北省',cityCode:'130100',city:'石家庄市',districtCode:'130102',districtName:'长安区'},factory_directory:{sites:[
    {id:'site_hebei',name:'登记厂',location:{country:'CHN',regionCode:'130000',regionName:'河北省',cityCode:'130100',city:'石家庄市',districtCode:'130102',districtName:'长安区'}},
    {id:'site_japan',name:'日本厂',location:{country:'JPN',regionName:'日本'} }
  ]}}})
  const countries=[{properties:{ADM0_A3:'CHN',NAME_ZH:'中国',centroid:[104,35]}},{properties:{ADM0_A3:'JPN',NAME_ZH:'日本',centroid:[138,37]}},{properties:{ADM0_A3:'USA',NAME_ZH:'美国',centroid:[-100,40]}}]
  const provinces=[{properties:{adcode:130000,name:'河北省',centroid:[114.5,38]}},{properties:{adcode:140000,name:'山西省',centroid:[112,37]}}]
  const cities=[{properties:{adcode:130100,name:'石家庄市',centroid:[114.5,38]}},{properties:{adcode:130200,name:'唐山市',centroid:[118,39]}}]
  const districts=[{properties:{adcode:130102,name:'長安區',centroid:[114.55,38.05]}}]
  assert.deepEqual(sitesAtHierarchyLevel(sites,'country','JPN').map(site=>site.id),['site_japan'])
  assert.deepEqual(groupHierarchyEntries(sites,'world','',countries).map(row=>row.code),['CHN','JPN'])
  assert.equal(groupHierarchyEntries(sites,'country','CHN',provinces).find(row=>row.code==='130000').count,2)
  assert.equal(groupHierarchyEntries(sites,'province','130000',cities).find(row=>row.code==='130100').count,2)
  assert.equal(groupHierarchyEntries(sites,'city','130100',districts).find(row=>row.code==='130102').count,2)
  assert.equal(groupHierarchyEntries(sites,'district','130102').find(row=>row.code==='current_factory').name,'当前工厂')
  const point=hierarchyMapPoints(sites,'city','130100',districts)[0]
  assert.equal(point.targetRegion,'130102');assert.deepEqual(point.location.mapCenter,[114.55,38.05])
})

test('the world map shows one country beacon for all Chinese factories',()=>{
  const sites=factoryDirectorySites({settings:{factory_location:{country:'CHN',regionCode:'120000',regionName:'天津市'},factory_directory:{sites:[
    {id:'site_hebei',name:'河北厂',location:{country:'CHN',regionCode:'130000',regionName:'河北省'}},
    {id:'site_japan',name:'日本厂',location:{country:'JPN'}}
  ]}}})
  const countries=[{properties:{ADM0_A3:'CHN',NAME_ZH:'中国',centroid:[104,35]}},{properties:{ADM0_A3:'JPN',NAME_ZH:'日本',centroid:[138,37]}}]
  const provinces=[{properties:{adcode:'120000',name:'天津市',centroid:[117.2,39.1]}},{properties:{adcode:'130000',name:'河北省',centroid:[114.5,38]}}]
  const points=worldHierarchyMapPoints(sites,countries)
  assert.deepEqual(points.map(point=>point.targetRegion).sort(),['CHN','JPN'])
  assert.equal(points.find(point=>point.targetRegion==='CHN').count,2)
  assert.equal(points.find(point=>point.targetRegion==='CHN').name,'中国 · 2 座')
  assert.deepEqual(points.find(point=>point.targetRegion==='CHN').location.mapCenter,[104,35])
  const inChina=hierarchyMapPoints(sites,'country','CHN',provinces)
  assert.deepEqual(inChina.map(point=>point.targetRegion).sort(),['120000','130000'])
})

test('a Chinese province marker appears only after entering China',()=>{
  const map=JSON.parse(readFileSync(new URL('../public/maps/china-provinces.geojson',import.meta.url),'utf8'))
  const tianjin=map.features.find(feature=>String(feature.properties?.adcode)==='120000')
  const sites=factoryDirectorySites({settings:{factory_location:{country:'CHN',regionCode:'120000',regionName:'天津市'}}})
  const [point]=hierarchyMapPoints(sites,'country','CHN',map.features)
  assert.equal(point.targetRegion,'120000')
  assert.deepEqual(point.location.mapCenter,tianjin.properties.centroid)
})

test('overseas selector offers offline state and city choices and keeps stable codes',async()=>{
  assert.equal(OVERSEAS_CATALOG_COUNTRIES.size,20)
  const korea=JSON.parse(readFileSync(new URL('../public/maps/overseas-admin/KOR.json',import.meta.url),'utf8'))
  const seoul=korea.states.find(state=>state.name==='Seoul')
  assert.ok(seoul?.cities.length)
  const saved=JSON.parse(normalizeSettingValue('factory_location',{country:'KOR',regionCode:seoul.code,regionName:seoul.name,cityCode:seoul.cities[0].id,city:seoul.cities[0].name,latitude:seoul.cities[0].latitude,longitude:seoul.cities[0].longitude}))
  assert.equal(saved.regionCode,seoul.code)
  assert.equal(saved.cityCode,seoul.cities[0].id)
  assert.equal(normalizeFactoryLocation(saved).regionCode,seoul.code)
  clearOverseasAdminCatalogCache()
  let calls=0
  const fetcher=async url=>{calls++;assert.equal(url,'/maps/overseas-admin/KOR.json');return {ok:true,json:async()=>korea}}
  assert.equal((await loadOverseasAdminCatalog('KOR',fetcher)).states.length,korea.states.length)
  assert.equal((await loadOverseasAdminCatalog('KOR',fetcher)).states.length,korea.states.length)
  assert.equal(calls,1)
  assert.equal(await loadOverseasAdminCatalog('ZZZ',fetcher),null)
})

test('local China admin maps validate level/codes and retry after a failed load',async()=>{
  assert.equal(adminFeatureCode({properties:{adcode:130100}}),'130100')
  assert.equal(adminFeatureName({properties:{name:'石家庄市'}}),'石家庄市')
  assert.deepEqual(adminFeatureCenter({properties:{centroid:[114.5,38]}}),[114.5,38])
  assert.equal(adminFeatureCenter({properties:{}}),null)
  await assert.rejects(()=>loadChinaAdminMap('province','bad',async()=>({ok:true,json:async()=>({})})),/行政区代码无效/)
  clearChinaAdminMapCache()
  let calls=0
  const fetcher=async()=>{calls++;return calls===1?{ok:false}:{ok:true,json:async()=>({type:'FeatureCollection',features:[]})}}
  await assert.rejects(()=>loadChinaAdminMap('district','130100',fetcher),/不可用/)
  assert.deepEqual(await loadChinaAdminMap('district','130100',fetcher),{type:'FeatureCollection',features:[]})
  assert.equal(calls,2)
})
