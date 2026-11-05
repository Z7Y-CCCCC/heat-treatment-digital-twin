<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute,useRouter } from 'vue-router'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { createDashboardDataStore } from '../runtime/DataStore.js'
import { createFactoryVoiceController } from '../runtime/factoryVoice.js'
import { createJsonPollingScope } from '../runtime/pollingRequests.js'
import { createNativeViewNavigator } from '../runtime/nativeViewNavigation.js'
import { openAdminSurface, openCustomerOperations } from '../runtime/nativeAdminNavigation.js'
import { adminFetch, adminSession, refreshAdminSession, startAdminSessionTracking, stopAdminSessionTracking, canOpenAdmin } from '../runtime/adminSession.js'
import { factoryDirectorySites,configuredOverseasCountries,sitesAtHierarchyLevel,groupHierarchyEntries,hierarchyMapPoints,worldHierarchyMapPoints } from '../runtime/groupTopology.js'
import { streetEntryStatus } from '../runtime/factoryNavigationReadiness.js'
import { loadChinaAdminMap } from '../runtime/chinaAdminMaps.js'
import { createFactoryMapMarker } from '../runtime/groupMapMarkers.js'
import { createGroupNavigationCrumbs } from '../runtime/groupHierarchyPath.js'
import { isNativeUnitySurface, NATIVE_SURFACE_CHANNEL, requestNativeSceneSurface } from '../runtime/nativeSurfaceBridge.js'
import AdminWindowChrome from './admin/components/AdminWindowChrome.vue'
import GroupHierarchyCapsule from './GroupHierarchyCapsule.vue'
import LoadingExperience from '../components/LoadingExperience.vue'
import MapSurfaceWidgets from './MapSurfaceWidgets.vue'
import {upgradeMapDesignerDocument,createMapDesignerContext} from '../runtime/mapDesigner.js'
import { disposeSceneObject } from '../runtime/ConfiguredFactoryScene.js'
import { groupPortalAppearanceForLevel } from '../runtime/groupPortalAppearance.js'

const route=useRoute(),router=useRouter(),mapHost=ref(null),config=ref(null),error=ref(''),busy=ref(false),ready=ref(false),loadingStage=ref(false),features=ref([])
const pollingRequests=createJsonPollingScope(adminFetch)
const nativeLoadingManaged=ref(Boolean(window.__DIGITAL_TWIN_NATIVE_LOADING__)),mapLoadingProgress=ref(7),mapLoadingPhase=ref(0),mapLoadingStep=ref('正在读取工厂与区域资料')
function reportMapLoading(progress,phase,step){mapLoadingProgress.value=progress;mapLoadingPhase.value=phase;mapLoadingStep.value=step;window.dispatchEvent(new CustomEvent('digital-twin-loading-progress',{detail:{progress,phase,step}}))}
const appearance=computed(()=>groupPortalAppearanceForLevel(config.value?.settings?.group_portal_config,level.value))
const appearanceStyle=computed(()=>({'--group-background':appearance.value.background,'--group-surface':appearance.value.panelSurface,'--group-accent':appearance.value.accent,'--group-text':appearance.value.text}))
const sites=computed(()=>config.value ? factoryDirectorySites(config.value) : [])
const factorySummaries=ref({})
const factorySummary=factoryId=>factorySummaries.value[String(factoryId)] || null
const visibleTotals=computed(()=>visibleSites.value.reduce((totals,item)=>({workshops:totals.workshops+Number(item.workshops||0),lines:totals.lines+Number(item.lines||0),devices:totals.devices+Number(item.devices||0)}),{workshops:0,lines:0,devices:0}))
const clearCountries=computed(()=>configuredOverseasCountries(sites.value))
const level=computed(()=>{
  if(['world','country','province','city','district'].includes(String(route.query.level || '')))return String(route.query.level)
  const legacy=String(route.query.region || '')
  return legacy ? /^\d{6}$/.test(legacy) ? 'province' : 'country' : 'world'
})
const selected=computed(()=>String(route.query.code || route.query.region || ''))
const navigationNotice=computed(()=>String(route.query.navigationNotice || '').slice(0,180))
const visibleSites=computed(()=>sitesAtHierarchyLevel(sites.value,level.value,selected.value))
const visibleLocalSites=computed(()=>visibleSites.value.filter(item=>item.runtime==='local'))
const districtAssignedSites=computed(()=>visibleSites.value.filter(item=>item.location.country==='CHN' ? item.location.districtCode : item.location.regionName))
const districtCoverage=computed(()=>visibleSites.value.length ? Math.round(districtAssignedSites.value.length/visibleSites.value.length*100) : null)
const markerLabels=ref([]),selectedSiteId=ref(''),hoveredRegionId=ref(''),childFeatures=ref([]),municipalityLevel=ref(false)
const labelElements=new Map()
const selectedFeature=computed(()=>features.value.find(feature=>String(feature.properties.adcode ?? feature.properties.ADM0_A3)===selected.value))
const regionTitle=computed(()=>level.value==='world' ? '工厂分布' : String(route.query[`${level.value}Name`] || selectedFeature.value?.properties?.name || selectedFeature.value?.properties?.NAME_ZH || selectedFeature.value?.properties?.ADMIN || selected.value || '区域总览'))
const selectedFactory=computed(()=>visibleSites.value.find(item=>item.id===selectedSiteId.value))
const mapValues=ref({})
const mapValuesLevel=ref('')
let mapValueRequestId=0
function mapNumber(key,fallback,maximum=1000000){
  if(mapValuesLevel.value!==level.value)return fallback
  const entry=mapValues.value[key]
  if(entry?.quality!=='good')return fallback
  const value=Number(entry.value)
  return Number.isFinite(value) && value>=0 && value<=maximum ? Math.round(value) : fallback
}
function hasMapMetric(key){return mapValuesLevel.value===level.value && mapValues.value[key]?.quality==='good'}
const factsFactoryCount=computed(()=>mapNumber('factsFactoryCount',visibleSites.value.length))
const factsLocalCount=computed(()=>mapNumber('factsLocalCount',visibleLocalSites.value.length))
const dockFactoryCount=computed(()=>mapNumber('dockFactoryCount',visibleSites.value.length))
const dockLocalCount=computed(()=>Math.min(dockFactoryCount.value,mapNumber('dockLocalCount',visibleLocalSites.value.length)))
const dockAssignedCount=computed(()=>mapNumber('dockAssignedCount',districtAssignedSites.value.length))
const dockCoverageValue=computed(()=>mapNumber('dockCoverage',districtCoverage.value,100))
const regionRows=computed(()=>{
  const overrides=mapValuesLevel.value===level.value && mapValues.value.panelRegionRows?.quality==='good'
    ? new Map((mapValues.value.panelRegionRows.rows || []).filter(row=>row && typeof row==='object' && !Array.isArray(row) && row.code != null).map(row=>[String(row.code),row]))
    : new Map()
  const merge=rows=>rows.map(row=>{
    const source=overrides.get(String(row.code))
    if(!source)return row
    const next={...row}
    for(const field of ['count','localCount','registeredCount','districtAssignedCount']){
      const value=Number(source[field])
      if(source[field]!==undefined && Number.isFinite(value) && value>=0 && value<=1000000)next[field]=Math.round(value)
    }
    return next
  }).sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name,'zh-CN'))
  if(level.value==='province' && municipalityLevel.value){
    return merge(groupHierarchyEntries(sites.value,'city',selected.value,childFeatures.value))
  }
  return merge(groupHierarchyEntries(sites.value,level.value,selected.value,childFeatures.value))
})
const mapDesignerDocument=computed(()=>upgradeMapDesignerDocument(config.value?.platform?.document,config.value?.settings?.group_portal_config))
const legacyMapValues=computed(()=>config.value?.platform?.document?.metadata?.unifiedMapDesigner===1?{}:mapValues.value)
const mapDesignerData=computed(()=>({...createMapDesignerContext(config.value,{level:level.value,code:selected.value,regions:regionRows.value,title:regionTitle.value}),
  records:createMapDesignerContext(config.value,{level:level.value,code:selected.value,regions:regionRows.value}).records?.map(row=>{if(row.kind!=='factory')return row;const factory=visibleSites.value.find(f=>f.id===row.id),status=streetEntryStatus(factory);return {...row,allowed:status.allowed,message:status.message,...factorySummary(row.id)}}),
  factsFactoryCount:factsFactoryCount.value,factsLocalCount:factsLocalCount.value,factsDeviceCount:mapNumber('factsDeviceCount',visibleTotals.value.devices),
  dockFactoryCount:dockFactoryCount.value,dockLocalCount:dockLocalCount.value,dockAssignedCount:dockAssignedCount.value,dockCoverage:dockCoverageValue.value,
  dockWorkshops:mapNumber('dockWorkshops',visibleTotals.value.workshops),dockLines:mapNumber('dockLines',visibleTotals.value.lines),dockDevices:mapNumber('dockDevices',visibleTotals.value.devices)}))
function handleMapWidgetAction(event){
  if(event.action==='map_enter_factory'){const factory=visibleSites.value.find(f=>f.id===event.id);if(factory && streetEntryStatus(factory).allowed)void openFactoryStreet(factory)}
  else if(event.action==='map_select_region' && regionRows.value.some(r=>String(r.code)===event.id))void selectRegion(event.id)
  else if(event.action==='map_hover_region')hoverRegion(regionRows.value.some(r=>String(r.code)===event.id)?event.id:'')
}
const levelNames={world:'全球',country:'国家',province:'省份',city:'城市',district:'区县'}
const hierarchyCrumbs=computed(()=>createGroupNavigationCrumbs({query:route.query,level:level.value,currentLabel:regionTitle.value}))
const data=createDashboardDataStore()
const factoryVoice=createFactoryVoiceController({available:()=>!adminSurface.value,onPlaybackError:error=>console.warn('[Voice]',error.message)})
const unlockFactoryVoice=()=>factoryVoice.unlock()
data.setDeviceDataHandler(frame=>factoryVoice.handleDeviceData(frame))
const configError=ref('')
const mapConfigSignature=value=>JSON.stringify({sites:factoryDirectorySites(value || {}).map(({id,name,location,runtime})=>({id,name,location,runtime})),appearance:value?.settings?.group_portal_config})
let renderer,scene,camera,controls,mapRoot,observer,raf,pollTimer,summaryPollTimer,focusFrame=0,disposed=false,dirty=true,geometryGeneration=0,down,surfaceChannel,configLoading=false,configRefreshPending=false,mapMotionEnabled=true,lastMarkerFrame=0,regionVisuals=new Map(),mapTransition=null,activeProject=null
const adminSurface=computed(()=>isNativeUnitySurface(route.query.embedded,window.chrome?.webview) && route.query.surface==='admin')
const sources={china:'/maps/china-provinces.geojson',world:'/maps/world-countries.geojson'},cache={}
const mapScale=2.7,chinaLongitude=104
const mercator=value=>Math.log(Math.tan(Math.PI/4+Math.max(-85,Math.min(85,value))*Math.PI/360))*180/Math.PI
function unwrapLongitude(longitude){let value=Number(longitude);while(value-chinaLongitude>180)value-=360;while(value-chinaLongitude < -180)value+=360;return value}
const projectRaw=([longitude,latitude])=>[(Number(longitude)-chinaLongitude)*mapScale,(mercator(latitude)-mercator(35))*mapScale]
const project=([longitude,latitude])=>projectRaw([unwrapLongitude(longitude),latitude])
function projectRing(coordinates){
  let previous=null
  return coordinates.map(point=>{
    let longitude=previous===null ? unwrapLongitude(point[0]) : Number(point[0])
    if(previous!==null){while(longitude-previous>180)longitude-=360;while(longitude-previous < -180)longitude+=360}
    previous=longitude
    return projectRaw([longitude,point[1]])
  })
}
const isChinaAdminFeature=feature=>/^\d{6}$/.test(String(feature?.properties?.adcode || '')) && Boolean(feature.geometry)
function mapPointInRing(longitude,latitude,ring){
  let inside=false
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=unwrapLongitude(ring[i][0]),yi=ring[i][1],xj=unwrapLongitude(ring[j][0]),yj=ring[j][1]
    if((yi>latitude)!==(yj>latitude) && longitude<(xj-xi)*(latitude-yi)/(yj-yi)+xi)inside=!inside
  }
  return inside
}
function featureContainsMapPoint(feature,point){
  const longitude=unwrapLongitude(point.longitude),latitude=point.latitude
  const polygons=feature.geometry.type==='Polygon' ? [feature.geometry.coordinates] : feature.geometry.type==='MultiPolygon' ? feature.geometry.coordinates : []
  return polygons.some(rings=>mapPointInRing(longitude,latitude,rings[0]) && !rings.slice(1).some(ring=>mapPointInRing(longitude,latitude,ring)))
}
function mapPointFromWorld(point){
  const mercatorLatitude=point.z/-mapScale+mercator(35)
  return {longitude:unwrapLongitude(point.x/mapScale+chinaLongitude),latitude:(2*Math.atan(Math.exp(mercatorLatitude*Math.PI/180))-Math.PI/2)*180/Math.PI}
}
function configuredCountryAt(point){
  if(!point)return ''
  const location=mapPointFromWorld(point)
  return features.value.find(feature=>{
    const code=String(feature.properties?.ADM0_A3 || '')
    return code && clearCountries.value.has(code) && featureContainsMapPoint(feature,location)
  })?.properties?.ADM0_A3 || ''
}
function createRegionFocusHalo(center,size,surfaceHeight){
  const material=new THREE.ShaderMaterial({
    uniforms:{tint:{value:new THREE.Color('#9b9df4')},transitionOpacity:{value:1}},
    transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
    vertexShader:'varying vec2 fieldUv;void main(){fieldUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:'uniform vec3 tint;uniform float transitionOpacity;varying vec2 fieldUv;void main(){float r=length((fieldUv-.5)*2.0);float edge=1.0-smoothstep(.72,1.0,r);float core=pow(max(0.0,1.0-r),3.0);float halo=exp(-pow((r-.48)*12.0,2.0));float alpha=(core*.16+halo*.075)*edge;gl_FragColor=vec4(tint,alpha*transitionOpacity);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}'
  })
  const halo=new THREE.Mesh(new THREE.PlaneGeometry(Math.max(8,size.x*1.42),Math.max(8,size.z*1.42)),material)
  halo.rotation.x=-Math.PI/2
  halo.position.set(center.x,surfaceHeight+.01,center.z)
  halo.renderOrder=1
  halo.userData.isRegionFocusHalo=true
  return halo
}
function reportRegions() {window.chrome?.webview?.postMessage({type:'overlay_regions',viewport:{width:innerWidth,height:innerHeight},regions:[{x:0,y:0,width:innerWidth,height:innerHeight}]})}
function hostMessage(event){if(event.data?.type==='overlay_host_state')reportRegions()}
function groupQuery(extra={}){
  const query={...route.query}
  for(const key of ['scope','region','level','code','country','countryName','province','provinceName','city','cityName','district','districtName','navigationNotice'])delete query[key]
  return {...query,...extra}
}
function hierarchyQuery(targetLevel,code='',name=''){
  const query=groupQuery()
  if(targetLevel==='world')return query
  const order=['country','province','city','district']
  for(const item of order){
    if(item===targetLevel){query[item]=code;query[`${item}Name`]=name || code;query.level=item;query.code=code;break}
    const ancestor=String(route.query[item] || (level.value===item ? selected.value : ''))
    if(ancestor){query[item]=ancestor;query[`${item}Name`]=String(route.query[`${item}Name`] || (level.value===item ? regionTitle.value : ancestor))}
  }
  const provinceCode=String(query.province || '')
  if(targetLevel==='district' && ['110000','120000','310000','500000'].includes(provinceCode) && !query.city){
    query.city=provinceCode
    query.cityName=String(query.provinceName || provinceCode)
  }
  return query
}
function navigateHierarchy(item){
  if(item.level==='factory'){const target=item.site || sites.value.find(site=>site.id===item.code);if(target)openFactoryStreet(target);return}
  selectedSiteId.value=''
  router.replace({path:'/group',query:hierarchyQuery(item.level,item.code,item.name || item.label)})
}
function navigateDesignedSurface(viewId){
  const targetLevel=String(viewId || '').replace(/^map_/,'')
  const ancestor=hierarchyCrumbs.value.find(item=>item.level===targetLevel)
  if(ancestor){navigateHierarchy(ancestor);return}
  if(viewId==='site_street'){
    const target=visibleSites.value.find(site=>site.id===selectedSiteId.value && site.runtime==='local')
    if(target)openFactoryStreet(target)
  }
}
function handleMapEscape(event){
  if(event.key!=='Escape' || event.defaultPrevented || event.isComposing)return
  if(event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'))return
  const ancestors=hierarchyCrumbs.value
  if(ancestors.length<2)return
  event.preventDefault()
  navigateHierarchy(ancestors[ancestors.length-2])
}
function selectRegion(id){const row=regionRows.value.find(item=>item.code===id);if(row)navigateHierarchy(row)}
function selectSite(id){
  const target=sites.value.find(item=>item.id===id)
  if(!target)return
  selectedSiteId.value=id
  highlightFactoryMarker(id)
  focusFactory(target)
}
function selectMarker(id){
  const marker=markerLabels.value.find(item=>item.id===id)
  if(!marker)return
  if(marker.factoryId){const target=sites.value.find(item=>item.id===marker.factoryId);if(target && (level.value==='district' || level.value==='country' && selected.value!=='CHN') && target.runtime==='local')openFactoryStreet(target);else selectSite(marker.factoryId)}
  else selectRegion(marker.targetRegion || 'unassigned')
}
function clearRegion(){navigateHierarchy({level:'world',code:'',name:'全球'})}
function openFactoryStreet(target){
  const status=streetEntryStatus(target)
  if(!status.allowed){
    if(target){selectedSiteId.value=target.id;highlightFactoryMarker(target.id)}
    error.value=status.message
    return
  }
  error.value=''
  selectedSiteId.value=target.id
  router.push({path:'/site',query:{...route.query,factoryId:target.id,stage:'street'}})
}
function highlightFactoryMarker(id=''){
  for(const marker of markerLabels.value)marker.setSelected?.(Boolean(id && marker.factoryId===id))
  dirty=true
}
function clearFactorySelection(){selectedSiteId.value='';highlightFactoryMarker()}
function hoverRegion(id='') {
  const next=String(id || '')
  if(hoveredRegionId.value===next)return
  const apply=(code,active)=>{
    const visuals=regionVisuals.get(code)
    if(!visuals)return
    const hoverColor=new THREE.Color(appearance.value.accent)
    const hoverEdge=hoverColor.clone().lerp(new THREE.Color('#ffffff'),.32)
    for(const item of visuals.surfaces){item.material.color.set(active ? hoverColor:item.color);item.material.opacity=active ? Math.min(.82,item.opacity+.16):item.opacity}
    for(const item of visuals.boundaries){item.material.color.set(active ? hoverEdge:item.color);item.material.opacity=active ? .96:item.opacity}
  }
  apply(hoveredRegionId.value,false)
  hoveredRegionId.value=next
  apply(next,true)
  dirty=true
}
function nearbySmallRegion(clientX,clientY){
  if(!(level.value==='country' && selected.value==='CHN' || level.value==='city') || !camera || !mapHost.value)return ''
  const rect=mapHost.value.getBoundingClientRect()
  let nearest='',distanceSquared=18*18
  for(const [code,visuals] of regionVisuals){
    if(!visuals.pickPoint || !visuals.pickSize)continue
    const center=visuals.pickPoint.clone().project(camera)
    if(center.z < -1 || center.z > 1)continue
    const edge=visuals.pickPoint.clone().add(new THREE.Vector3(visuals.pickSize,0,0)).project(camera)
    if(Math.abs(edge.x-center.x)*rect.width/2 > 14)continue
    const x=rect.left+(center.x+1)*rect.width/2,y=rect.top+(1-center.y)*rect.height/2
    const nextDistance=(x-clientX)**2+(y-clientY)**2
    if(nextDistance<distanceSquared){nearest=code;distanceSquared=nextDistance}
  }
  return nearest
}
function trackRegionHover(event) {
  if(!mapRoot || !camera || !mapHost.value || mapTransition)return
  if(down && Math.hypot(event.clientX-down[0],event.clientY-down[1])>5){hoverRegion('');return}
  const rect=mapHost.value.getBoundingClientRect()
  if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom){hoverRegion('');return}
  const ray=new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera)
  const hits=ray.intersectObjects(mapRoot.children,true)
  const hit=hits.find(item=>item.object.userData.isRegionSurface && item.object.userData.code)
  const country=hit ? '' : configuredCountryAt(hits.find(item=>item.object.userData.isWorldMapSurface)?.point)
  hoverRegion(nearbySmallRegion(event.clientX,event.clientY) || hit?.object.userData.code || country)
}
function openAdmin(){
  openAdminSurface({embedded:route.query.embedded,surface:adminSurface.value?'admin':undefined,webview:window.chrome?.webview,router})
}
function openFactoryLocationSettings(){
  openAdminSurface({embedded:route.query.embedded,surface:adminSurface.value?'admin':undefined,webview:window.chrome?.webview,router,focus:'factory-location'})
}
function returnToAdminWorkspace(){router.push({path:'/admin',query:route.query.embedded==='unity'?{embedded:'unity'}:{}})}
function transitionMaterials(root){
  if(root.userData.transitionMaterials)return root.userData.transitionMaterials
  const materials=new Set()
  root.traverse(object=>{
    if(!object.material)return
    for(const material of Array.isArray(object.material) ? object.material : [object.material])materials.add(material)
  })
  root.userData.transitionMaterials=[...materials].map(material=>({material,opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite}))
  return root.userData.transitionMaterials
}
function setMapRootOpacity(root,value){
  for(const item of transitionMaterials(root)){
    const {material}=item
    if(material.uniforms?.transitionOpacity){material.uniforms.transitionOpacity.value=value;continue}
    if(!material.transparent){material.transparent=true;material.needsUpdate=true}
    material.depthWrite=false;material.opacity=item.opacity*value
  }
  dirty=true
}
function restoreMapRootOpacity(root){
  for(const item of transitionMaterials(root)){
    const {material}=item
    if(material.uniforms?.transitionOpacity){material.uniforms.transitionOpacity.value=1;continue}
    material.opacity=item.opacity;material.transparent=item.transparent;material.depthWrite=item.depthWrite;material.needsUpdate=true
  }
  dirty=true
}
function finishMapTransition(){
  if(!mapTransition)return
  const {oldRoot,newRoot}=mapTransition
  if(oldRoot){scene.remove(oldRoot);disposeSceneObject(oldRoot)}
  if(newRoot)restoreMapRootOpacity(newRoot)
  mapHost.value?.style.setProperty('--map-label-opacity','1')
  mapTransition=null
}
function cancelMapFlight() {
  if(focusFrame){cancelAnimationFrame(focusFrame);focusFrame=0}
  finishMapTransition()
}
function animateMapTo(center,destination,{immediate=false,duration=760,preserveTransition=false,onProgress=()=>{},onComplete=()=>{}}={}) {
  if(!camera || !controls)return
  if(preserveTransition){if(focusFrame){cancelAnimationFrame(focusFrame);focusFrame=0}}
  else cancelMapFlight()
  const startPosition=camera.position.clone(),startTarget=controls.target.clone(),started=performance.now()
  const travel=immediate || !mapMotionEnabled ? 0 : duration
  const lift=Math.min(68,Math.max(0,startPosition.distanceTo(destination)*.12))
  const animate=now=>{
    if(disposed || !camera || !controls)return
    const progress=travel ? Math.min(1,(now-started)/travel):1
    const eased=progress<.5 ? 4*progress**3 : 1-(-2*progress+2)**3/2
    camera.position.lerpVectors(startPosition,destination,eased)
    if(travel)camera.position.y+=Math.sin(Math.PI*progress)*lift
    controls.target.lerpVectors(startTarget,center,eased)
    controls.update();onProgress(progress,eased);dirty=true
    if(progress<1)focusFrame=requestAnimationFrame(animate)
    else {focusFrame=0;onComplete()}
  }
  if(travel)focusFrame=requestAnimationFrame(animate)
  else animate(started)
}
function frameMap({immediate=false,preserveView=false}={}) {
  if(!mapRoot || !camera) return
  const bounds=mapRoot.userData.frameBounds
  if(!bounds || bounds.isEmpty())return
  const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3())
  center.y=.5
  const verticalFov=THREE.MathUtils.degToRad(camera.fov)
  const horizontalFov=2*Math.atan(Math.tan(verticalFov/2)*camera.aspect)
  const fitPadding=(level.value==='world' ? 1.07 : level.value==='country' && selected.value==='CHN' ? 1.02 : (level.value==='province' || level.value==='city') ? .76 : level.value==='district' ? 1.18 : 1.05)/appearance.value.mapZoom
  const fitDistance=Math.max(size.z/(2*Math.tan(verticalFov/2)),size.x/(2*Math.tan(horizontalFov/2)),level.value==='world'?34:24)*fitPadding
  const destination=preserveView ? camera.position.clone() : center.clone().add(new THREE.Vector3(fitDistance*.12,fitDistance*.72,fitDistance*.92))
  if(preserveView)center.copy(controls.target)
  const transition=mapTransition
  if(transition){
    animateMapTo(center,destination,{immediate,duration:level.value==='world'?1000:860,preserveTransition:true,
      onProgress:(progress)=>{
        const fade=Math.max(0,Math.min(1,(progress-.08)/.84))
        setMapRootOpacity(transition.oldRoot,1-fade)
        setMapRootOpacity(transition.newRoot,fade)
        mapHost.value?.style.setProperty('--map-label-opacity',String(Math.max(0,Math.min(1,(progress-.42)/.48))))
      },onComplete:finishMapTransition})
  }else animateMapTo(center,destination,{immediate})
}
function focusFactory(factory) {
  if(!camera || !controls)return
  const marker=markerLabels.value.find(item=>item.factoryId===factory.id)
  if(!marker?.mapPosition){frameMap();return}
  const {x,z}=marker.mapPosition
  const center=new THREE.Vector3(x,.68,z)
  const direction=camera.position.clone().sub(controls.target).normalize()
  const distance=Math.max(36,Math.min(88,controls.getDistance()*.38))
  animateMapTo(center,center.clone().add(direction.multiplyScalar(distance)))
}
async function buildMap({reframe=true}={}) {
  const generation=++geometryGeneration
  loadingStage.value=true;error.value=''
  if(!ready.value)reportMapLoading(11,0,'正在读取工厂与区域资料')
  try {
    const loadMap=async name=>{
      if(!cache[name]){const result=await fetch(sources[name]);if(!result.ok)throw new Error('离线地图资源未找到');cache[name]=await result.json()}
      return cache[name]
    }
    const [chinaMap,worldMap]=await Promise.all([loadMap('china'),loadMap('world')])
    if(disposed || generation!==geometryGeneration)return
    const worldFeatures=worldMap.features.filter(feature=>feature.geometry && feature.properties?.ADMIN!=='Antarctica')
    features.value=[...chinaMap.features.filter(isChinaAdminFeature),...worldFeatures]
    const stage=level.value,stageCode=selected.value
    let mapFeatures=[],nextChildFeatures=[],municipality=false
    if(stage==='world'){mapFeatures=worldFeatures;nextChildFeatures=worldFeatures}
    else if(stage==='country' && stageCode==='CHN'){
      mapFeatures=chinaMap.features.filter(isChinaAdminFeature);nextChildFeatures=mapFeatures
    }else if(stage==='country'){
      mapFeatures=worldFeatures.filter(feature=>feature.properties?.ADM0_A3===stageCode)
    }else if(stage==='province'){
      const data=await loadChinaAdminMap('province',stageCode)
      if(disposed || generation!==geometryGeneration)return
      mapFeatures=data.features.filter(feature=>feature.geometry)
      municipality=mapFeatures.length>0 && mapFeatures.every(feature=>feature.properties?.level==='district')
      nextChildFeatures=mapFeatures
    }else if(stage==='city'){
      const provinceCode=String(route.query.province || '')
      const data=await loadChinaAdminMap(stageCode===provinceCode?'province':'district',stageCode)
      if(disposed || generation!==geometryGeneration)return
      mapFeatures=data.features.filter(feature=>feature.geometry);nextChildFeatures=mapFeatures
    }else if(stage==='district'){
      const cityCode=String(route.query.city || ''),provinceCode=String(route.query.province || '')
      const data=await loadChinaAdminMap(cityCode===provinceCode?'province':'district',cityCode)
      if(disposed || generation!==geometryGeneration)return
      mapFeatures=data.features.filter(feature=>String(feature.properties?.adcode)===stageCode)
    }
    if(!mapFeatures.length)throw new Error('当前层级没有可显示的地图边界')
    if(!ready.value)reportMapLoading(38,1,'正在解析行政区地图边界')
    const rawBounds=new THREE.Box2()
    const activeAccent=new THREE.Color(appearance.value.accent)
    const mapBase=new THREE.Color(appearance.value.mapBase)
    const mapMuted=new THREE.Color(appearance.value.mapMuted)
    for(const feature of mapFeatures){
      const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[]
      for(const rings of polygons)for(const point of projectRing(rings[0] || []))rawBounds.expandByPoint(new THREE.Vector2(...point))
    }
    const rawCenter=rawBounds.getCenter(new THREE.Vector2()),rawWidth=Math.max(.01,rawBounds.getSize(new THREE.Vector2()).x)
    const stageScale=stage==='world' ? .34 : stage==='country' && stageCode==='CHN' ? 1 : stage==='country' ? Math.min(8,Math.max(1,90/rawWidth)) : stage==='province' ? Math.min(30,Math.max(1,88/rawWidth)) : stage==='city' ? Math.min(170,Math.max(1,78/rawWidth)) : Math.min(450,Math.max(1,70/rawWidth))
    const stageProject=coordinate=>{const [x,y]=project(coordinate);return [(x-rawCenter.x)*stageScale+rawCenter.x,(y-rawCenter.y)*stageScale+rawCenter.y]}
    const group=new THREE.Group(),nextRegionVisuals=new Map()
    const reliefDepth=stage==='world'?.42:stage==='district'?1.3:stage==='country' && stageCode==='CHN'?1.15:1.25
    const rows=stage==='province' && municipality
      ? groupHierarchyEntries(sites.value,'city',stageCode,mapFeatures)
      : groupHierarchyEntries(sites.value,stage,stageCode,nextChildFeatures)
    const counts=new Map(rows.map(row=>[row.code,row.count]))
    for(const feature of mapFeatures){
      const code=String(feature.properties?.adcode ?? feature.properties?.ADM0_A3 ?? '')
      const targetCode=code
      const count=counts.get(targetCode) || 0
      const active=count>0 || stage==='district'
      const isChina=code==='CHN' || stage==='country' && stageCode==='CHN'
      const surfaceColor=stage==='world' ? active ? mapBase.getHex():code==='CHN'?mapBase.clone().multiplyScalar(.82).getHex():mapMuted.getHex() : active ? mapBase.clone().lerp(activeAccent,.12).getHex() : isChina ? mapBase.clone().multiplyScalar(.84).getHex() : mapMuted.clone().lerp(mapBase,.42).getHex()
      const surfaceOpacity=stage==='world' ? (active ? .78 : code==='CHN' ? .56 : .38) : active ? .65 : .39
      const boundaryColor=active ? activeAccent.getHex():stage==='world' ? 0x767c8e:0x9195aa
      const boundaryOpacity=active ? .92:stage==='world'?.31:.44
      const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[]
      const region=new THREE.Group();region.userData.code=targetCode;region.userData.isRegionGeometry=true
      const visuals=nextRegionVisuals.get(targetCode) || {surfaces:[],boundaries:[]}
      for(const rings of polygons){
        if(!rings[0]?.length)continue
        const path=(coordinates,Type)=>{const shape=new Type();projectRing(coordinates).forEach(([rawX,rawY],index)=>{const x=(rawX-rawCenter.x)*stageScale+rawCenter.x,y=(rawY-rawCenter.y)*stageScale+rawCenter.y;index?shape.lineTo(x,y):shape.moveTo(x,y)});return shape}
        const shape=path(rings[0],THREE.Shape)
        for(const ring of rings.slice(1))shape.holes.push(path(ring,THREE.Path))
        const surfaceMaterial=new THREE.MeshBasicMaterial({color:surfaceColor,transparent:true,opacity:surfaceOpacity,side:THREE.FrontSide,depthWrite:false})
        const sideMaterial=new THREE.MeshBasicMaterial({color:active?0x383947:0x292b36,transparent:true,opacity:stage==='world'?.3:.78,side:THREE.DoubleSide,depthWrite:false})
        const mesh=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:reliefDepth,bevelEnabled:false}),[surfaceMaterial,sideMaterial])
        mesh.rotation.x=-Math.PI/2;mesh.userData.code=stage==='district'?'':targetCode;mesh.userData.isRegionSurface=stage!=='district';region.add(mesh);visuals.surfaces.push({material:surfaceMaterial,color:surfaceColor,opacity:surfaceOpacity})
        for(const ring of rings){
          const points=projectRing(ring).map(([rawX,rawY])=>new THREE.Vector3((rawX-rawCenter.x)*stageScale+rawCenter.x,reliefDepth+.03,-((rawY-rawCenter.y)*stageScale+rawCenter.y)))
          const boundaryMaterial=new THREE.LineBasicMaterial({color:boundaryColor,transparent:true,opacity:boundaryOpacity,depthWrite:false,blending:active?THREE.AdditiveBlending:THREE.NormalBlending})
          const boundary=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),boundaryMaterial)
          region.add(boundary);visuals.boundaries.push({material:boundaryMaterial,color:boundaryColor,opacity:boundaryOpacity})
        }
      }
      if(!visuals.pickPoint){
        const mapCenter=feature.properties?.centroid || feature.properties?.center
        const regionBounds=new THREE.Box3().setFromObject(region)
        if(!regionBounds.isEmpty()){
          const [x,y]=Array.isArray(mapCenter) ? stageProject(mapCenter) : [regionBounds.getCenter(new THREE.Vector3()).x,-regionBounds.getCenter(new THREE.Vector3()).z]
          visuals.pickPoint=new THREE.Vector3(x,reliefDepth+.04,-y)
          const size=regionBounds.getSize(new THREE.Vector3())
          visuals.pickSize=Math.max(size.x,size.z)/2
        }
      }
      nextRegionVisuals.set(targetCode,visuals);group.add(region)
    }
    if(stage==='world'){
      // Provincial outlines are decorative on the world map. The sole
      // interactive China beacon belongs to the country, not its provinces.
      const provinces=new THREE.Group()
      for(const feature of chinaMap.features.filter(isChinaAdminFeature)){
        const assigned=false
        const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[]
        for(const rings of polygons){
          if(!rings[0]?.length)continue
          const path=(coordinates,Type)=>{
            const shape=new Type()
            projectRing(coordinates).forEach(([rawX,rawY],index)=>{
              const x=(rawX-rawCenter.x)*stageScale+rawCenter.x,y=(rawY-rawCenter.y)*stageScale+rawCenter.y
              index?shape.lineTo(x,y):shape.moveTo(x,y)
            })
            return shape
          }
          const shape=path(rings[0],THREE.Shape)
          for(const ring of rings.slice(1))shape.holes.push(path(ring,THREE.Path))
          const mesh=new THREE.Mesh(new THREE.ExtrudeGeometry(shape,{depth:reliefDepth+.085,bevelEnabled:false}),
            [new THREE.MeshBasicMaterial({color:assigned?activeAccent:mapBase,transparent:true,opacity:assigned?.64:.23,depthWrite:false}),
              new THREE.MeshBasicMaterial({color:0x34353a,transparent:true,opacity:.12,depthWrite:false})])
          mesh.rotation.x=-Math.PI/2;provinces.add(mesh)
          for(const ring of rings){
            const points=projectRing(ring).map(([rawX,rawY])=>new THREE.Vector3((rawX-rawCenter.x)*stageScale+rawCenter.x,reliefDepth+.11,-((rawY-rawCenter.y)*stageScale+rawCenter.y)))
            provinces.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:assigned?activeAccent:0xa1a2ae,transparent:true,opacity:assigned?.94:.52,depthWrite:false})))
          }
        }
      }
      group.add(provinces)
    }
    const frameBounds=new THREE.Box3()
    for(const region of group.children.filter(child=>child.userData.isRegionGeometry))frameBounds.expandByObject(region)
    if(stage==='world'){
      // Keep the initial China emphasis, but widen the frame for configured
      // overseas sites so their country beacons are not outside the viewport.
      const focusBounds=new THREE.Box3()
      for(const coordinate of [[62,4],[147,64]]){
        const [x,y]=stageProject(coordinate)
        focusBounds.expandByPoint(new THREE.Vector3(x,reliefDepth,-y))
      }
      for(const site of sites.value.filter(item=>item.location.country!=='CHN')){
        const country=worldFeatures.find(feature=>feature.properties?.ADM0_A3===site.location.country)
        const props=country?.properties || {}
        const coordinate=Number.isFinite(props.LABEL_X) && Number.isFinite(props.LABEL_Y)
          ? [props.LABEL_X,props.LABEL_Y] : site.location.longitude!==null && site.location.latitude!==null
            ? [site.location.longitude,site.location.latitude] : null
        if(!coordinate)continue
        const [x,y]=stageProject(coordinate)
        focusBounds.expandByPoint(new THREE.Vector3(x,reliefDepth,-y))
      }
      group.userData.frameBounds=focusBounds
    }else if(stage==='country' && stageCode==='CHN'){
      const mainlandBounds=new THREE.Box3()
      for(const feature of mapFeatures){
        const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.type==='MultiPolygon'?feature.geometry.coordinates:[]
        for(const rings of polygons)for(const coordinate of rings[0] || []){
          if(coordinate[1]<17.5)continue
          const [x,y]=stageProject(coordinate)
          mainlandBounds.expandByPoint(new THREE.Vector3(x,reliefDepth,-y))
        }
      }
      group.userData.frameBounds=mainlandBounds.isEmpty()?frameBounds:mainlandBounds
    }else group.userData.frameBounds=frameBounds
    if(stage==='district' && !frameBounds.isEmpty())group.add(createRegionFocusHalo(frameBounds.getCenter(new THREE.Vector3()),frameBounds.getSize(new THREE.Vector3()),reliefDepth))
    const labels=[]
    const pointFeatures=stage==='district' || stage==='country' && stageCode!=='CHN' ? mapFeatures : nextChildFeatures
    const pointLevel=stage==='province' && municipality ? 'city' : stage
    const points=stage==='world'
      ? worldHierarchyMapPoints(sites.value,worldFeatures)
      : hierarchyMapPoints(sites.value,pointLevel,stageCode,pointFeatures)
    if(stage==='city'){
      const represented=new Set(points.map(point=>point.factoryId).filter(Boolean))
      const cityCenter=mapPointFromWorld(new THREE.Vector3(rawCenter.x,0,-rawCenter.y))
      visibleSites.value.filter(item=>!item.location.districtCode && !item.location.districtName && !represented.has(item.id)).forEach((factory,index)=>points.push({
        id:`site_unassigned_${factory.id}`,factoryId:factory.id,targetRegion:stageCode,name:`${factory.name} · 区县待归属`,count:1,
        localRuntimeCount:factory.runtime==='local'?1:0,runtime:factory.runtime,location:{mapCenter:[cityCenter.longitude,cityCenter.latitude]},mapOffset:[(index%3-1)*4,Math.floor(index/3)*4]
      }))
    }
    for(const point of points){
      const coordinate=point.location?.mapCenter
      if(!coordinate)continue
      const projected=stageProject(coordinate),offset=point.mapOffset || [0,0],position=[projected[0]+offset[0],projected[1]+offset[1]]
      const markerOptions=stage==='country' && stageCode==='CHN'?{footprint:false,radiusScale:.24}:stage==='province' || stage==='city'?{footprint:false,radiusScale:.4}:stage==='world'?{radiusScale:.62}:{}
      const marker=createFactoryMapMarker(point,position,stage==='country' && stageCode!=='CHN',{...markerOptions,...(stage==='district'?{footprint:false,radiusScale:.22,beamScale:.36}:{}),primary:appearance.value.markerPrimary,tip:appearance.value.markerTip})
      const markerScale=stage==='district'?.64:stage==='country' && stageCode==='CHN'?1.6:1
      const markerBase=marker.root.position.y
      marker.root.scale.setScalar(markerScale)
      const markerGround=reliefDepth+.03
      marker.root.position.y=markerGround
      marker.anchor.y=markerGround+(marker.anchor.y-markerBase)*markerScale
      marker.pin.y=markerGround+(marker.pin.y-markerBase)*markerScale
      group.add(marker.root);labels.push({...point,anchor:marker.anchor,pin:marker.pin,animate:marker.animate,setSelected:marker.setSelected,mapPosition:{x:position[0],z:-position[1]}})
    }
    if(!ready.value)reportMapLoading(78,2,'正在绘制区域与工厂位置')
    cancelMapFlight()
    const oldRoot=mapRoot
    mapRoot=group;activeProject=stageProject;regionVisuals=nextRegionVisuals;childFeatures.value=nextChildFeatures;municipalityLevel.value=municipality;scene.add(group);markerLabels.value=labels
    if(oldRoot){mapTransition={oldRoot,newRoot:group};setMapRootOpacity(group,0);mapHost.value?.style.setProperty('--map-label-opacity','0')}
    hoveredRegionId.value='';
    for(const marker of markerLabels.value)marker.setSelected?.(Boolean(selectedSiteId.value && marker.factoryId===selectedSiteId.value))
    frameMap({immediate:!ready.value,preserveView:!reframe})
    dirty=true;ready.value=true;loadingStage.value=false;reportMapLoading(100,3,'分布地图已就绪')
  } catch(e){if(!disposed && generation===geometryGeneration){error.value=e.message;loadingStage.value=false}}
}
async function refreshConfig() {
  if(disposed)return
  if(configLoading){configRefreshPending=true;return}
  configLoading=true
  try {
    const next=await pollingRequests.read('config',API_BASE+'/config',{cache:'no-store'}),changed=mapConfigSignature(next)!==mapConfigSignature(config.value)
    if(disposed)return
    config.value=next;factoryVoice.configure(next);configError.value=''
    if(changed && scene)buildMap({reframe:!ready.value})
  }catch(e){if(!disposed && e.name!=='AbortError')configError.value=e.message}finally{
    configLoading=false
    if(configRefreshPending && !disposed){configRefreshPending=false;void refreshConfig()}
  }
}
async function refreshMapValues(){
  if(config.value?.platform?.document?.metadata?.unifiedMapDesigner===1){mapValues.value={};return}
  const requestedLevel=level.value
  const requestId=++mapValueRequestId
  try{
    const result=await pollingRequests.read(`map:${requestedLevel}`,`${API_BASE}/data-sources/map-values?level=${encodeURIComponent(requestedLevel)}`,{cache:'no-store'})
    if(disposed || requestId!==mapValueRequestId || requestedLevel!==level.value)return
    mapValues.value=result.values || {};mapValuesLevel.value=requestedLevel
  }catch{if(!disposed && requestId===mapValueRequestId && requestedLevel===level.value){mapValues.value={};mapValuesLevel.value=requestedLevel}}
}
async function refreshFactorySummaries(){
  try{
    const result=await pollingRequests.read('summaries',`${API_BASE}/factories/live-summaries`,{cache:'no-store'})
    if(!disposed)factorySummaries.value=Object.fromEntries((result.summaries||[]).map(item=>[String(item.factoryId),item]))
  }catch{if(!disposed)factorySummaries.value={}}
}
const navigator=createNativeViewNavigator(async target=>{
  const response=await adminFetch(API_BASE+'/native-preview/navigate',{method:'POST',headers:{'Content-Type':'application/json','X-Factory-ID':target.factoryId},body:JSON.stringify({action:'view',viewId:target.viewId,focus:{mode:'factory'}})})
  if(!response.ok)throw new Error('进入工厂请求失败')
  return response.json()
})
async function enterFactory(target) {
  if(busy.value || !config.value)return
  if(!target || target.runtime!=='local'){error.value='该工厂尚未接入中控库。';return}
  busy.value=true;error.value=''
  try {
    const activate=await adminFetch(`${API_BASE}/factories/${encodeURIComponent(target.id)}/activate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    const activation=await activate.json().catch(()=>({}))
    if(!activate.ok)throw new Error(activation.error || '切换运行工厂失败')
    await navigator.go({viewId:'factory_overview',deviceId:'',factoryId:target.id})
    if(disposed)return
    if(adminSurface.value && window.chrome?.webview){requestNativeSceneSurface();await router.replace({path:'/admin',query:{embedded:'unity'}});window.chrome.webview.postMessage({type:'host_action',action:'show_dashboard'})}
    else await router.push({path:'/overlay',query:{...route.query,factoryId:target.id,scene:'1',fromGroup:selected.value || 'unassigned'}})
  }
  catch(e){if(!disposed)error.value=e.message}finally{busy.value=false}
}
function pick(event) {
  const start=down
  down=null
  if(mapTransition)return
  if(event.button!==0)return
  if(!start || Math.hypot(event.clientX-start[0],event.clientY-start[1])>5)return
  const rect=mapHost.value.getBoundingClientRect(),ray=new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera)
  const hits=ray.intersectObjects(mapRoot?.children || [],true)
  const markerHit=hits.find(item=>item.object.userData.siteId)
  const regionHit=hits.find(item=>item.object.userData.isRegionSurface && item.object.userData.code)
  const country=regionHit ? '' : configuredCountryAt(hits.find(item=>item.object.userData.isWorldMapSurface)?.point)
  const smallRegion=nearbySmallRegion(event.clientX,event.clientY)
  if(markerHit)selectMarker(markerHit.object.userData.siteId)
  else if(smallRegion || regionHit)selectRegion(smallRegion || regionHit.object.userData.code)
  else if(country)selectRegion(country)
}
watch([level,selected],()=>{mapValues.value={};void refreshMapValues();if(scene)buildMap()})
onMounted(async()=>{
  window.addEventListener('keydown',handleMapEscape,true)
  nativeLoadingManaged.value=Boolean(window.__DIGITAL_TWIN_NATIVE_LOADING__)
  startAdminSessionTracking()
  void refreshAdminSession()
  try {
    renderer=new THREE.WebGLRenderer({alpha:true,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));mapHost.value.appendChild(renderer.domElement)
    scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(36,mapHost.value.clientWidth/Math.max(1,mapHost.value.clientHeight),.1,5000);camera.position.set(0,260,340)
    controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minPolarAngle=.25;controls.maxPolarAngle=1.18;controls.minDistance=8;controls.maxDistance=2400;controls.zoomSpeed=.82
    controls.addEventListener('start',cancelMapFlight)
    scene.add(new THREE.HemisphereLight(0xced5ff,0x131621,2));const light=new THREE.DirectionalLight(0xcbd0ff,2);light.position.set(-60,150,70);scene.add(light)
    observer=new ResizeObserver(()=>{const w=mapHost.value.clientWidth,h=mapHost.value.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/Math.max(h,1);camera.updateProjectionMatrix();dirty=true;reportRegions()});observer.observe(mapHost.value)
    const projected=new THREE.Vector3(),projectedPin=new THREE.Vector3()
    mapMotionEnabled=!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const render=now=>{
      if(disposed)return
      const moved=controls.update()
      if(mapMotionEnabled && markerLabels.value.length && now-lastMarkerFrame>=1000/30){
        const seconds=now/1000
        for(const marker of markerLabels.value)marker.animate?.(seconds)
        lastMarkerFrame=now;dirty=true
      }
      if(moved || dirty){
        renderer.render(scene,camera);dirty=false
        for(const marker of markerLabels.value){
          const element=labelElements.get(marker.id)
          if(!element)continue
          projected.copy(marker.anchor).project(camera)
          const x=(projected.x+1)*mapHost.value.clientWidth/2,y=(1-projected.y)*mapHost.value.clientHeight/2
          projectedPin.copy(marker.pin || marker.anchor).project(camera)
          const pinX=(projectedPin.x+1)*mapHost.value.clientWidth/2,pinY=(1-projectedPin.y)*mapHost.value.clientHeight/2,leaderX=pinX-x,leaderY=pinY-y
          element.style.setProperty('--leader-x',`${leaderX}px`);element.style.setProperty('--leader-y',`${leaderY}px`)
          element.style.setProperty('--leader-length',`${Math.hypot(leaderX,leaderY)}px`);element.style.setProperty('--leader-angle',`${Math.atan2(leaderX,leaderY)*180/Math.PI}deg`)
          element.style.transform=`translate(${x}px,${y}px) translate(-50%,-100%)`
          element.style.visibility=Math.abs(projected.x)<.96 && Math.abs(projected.y)<.96 && Math.abs(projected.z)<1 && Math.abs(projectedPin.x)<1 && Math.abs(projectedPin.y)<1 && Math.abs(projectedPin.z)<1 ? 'visible':'hidden'
        }
      }
      raf=requestAnimationFrame(render)
    };render()
    await refreshConfig()
    if(disposed)return
    await Promise.all([buildMap(),refreshMapValues(),refreshFactorySummaries()])
    if(disposed)return
    pollTimer=setInterval(()=>{void refreshConfig();void refreshMapValues()},15000);summaryPollTimer=setInterval(()=>void refreshFactorySummaries(),5000)
    data.setMessageHandler(message=>{if(factoryVoice.handleMessage(message))return;if(['configuration_changed','realtime_resync_required'].includes(message.type))return refreshConfig();if(message.type==='dashboard_context_changed')navigator.accept(message.payload)})
    if(typeof BroadcastChannel!=='undefined' && !adminSurface.value){surfaceChannel=new BroadcastChannel(NATIVE_SURFACE_CHANNEL);surfaceChannel.onmessage=event=>{if(event.data?.type==='show_native_scene' && route.query.embedded==='unity')router.replace({path:'/overlay',query:{...route.query,scene:'1'}})}}
    window.addEventListener('pointerdown',unlockFactoryVoice,{passive:true});data.connect();window.chrome?.webview?.addEventListener('message',hostMessage);window.chrome?.webview?.postMessage({type:'overlay_ready'});reportRegions()
  }catch(e){error.value=e.message;window.chrome?.webview?.postMessage({type:'overlay_ready'})}
})
onUnmounted(()=>{factoryVoice.dispose();window.removeEventListener('pointerdown',unlockFactoryVoice);window.removeEventListener('keydown',handleMapEscape,true);stopAdminSessionTracking();disposed=true;mapValueRequestId++;geometryGeneration++;pollingRequests.dispose();surfaceChannel?.close();clearInterval(pollTimer);clearInterval(summaryPollTimer);cancelAnimationFrame(raf);cancelMapFlight();navigator.dispose();data.dispose();observer?.disconnect();controls?.removeEventListener('start',cancelMapFlight);controls?.dispose();disposeSceneObject(scene);renderer?.dispose();window.chrome?.webview?.removeEventListener('message',hostMessage);window.chrome?.webview?.postMessage({type:'overlay_regions',viewport:{width:innerWidth,height:innerHeight},regions:[]})})
</script>

<template>
  <LoadingExperience v-if="!ready && !error && !nativeLoadingManaged" :show="!ready" :progress="mapLoadingProgress" :phase="mapLoadingPhase" :step="mapLoadingStep" :config="config?.settings?.loading_experience_config" />
  <main class="group-portal" :class="{'admin-surface':adminSurface}" :style="appearanceStyle">
    <AdminWindowChrome v-if="adminSurface" @before-dashboard="router.replace({path:'/admin',query:{embedded:'unity'}})" @before-admin="returnToAdminWorkspace" />
    <div ref="mapHost" class="group-map" :class="{'group-map-detail':level==='province'||level==='city','group-map-national':level==='country' && selected==='CHN'}" aria-label="集团工厂分布地图，可拖拽旋转和滚轮缩放" @pointerdown="down=[$event.clientX,$event.clientY]" @pointermove="trackRegionHover" @pointerup="pick" @pointercancel="down=null" @pointerleave="hoverRegion('')">
      <button v-for="marker in markerLabels" :key="marker.id" :ref="element=>{if(element){labelElements.set(marker.id,element);dirty=true}else labelElements.delete(marker.id)}" class="group-map-label" :class="{registered:marker.runtime==='registered','is-selected':Boolean(selectedSiteId && selectedSiteId===marker.factoryId)}" :data-site-id="marker.id" :aria-label="`定位 ${marker.name}`" :title="`${marker.name}；${marker.located===false?'位置待完善':'标记表示位置，不代表产量'}`" @pointerdown.stop @pointerup.stop @click.stop="selectMarker(marker.id)"><i></i><span>{{ marker.name }}</span><small>{{ marker.factoryId ? factorySummary(marker.factoryId)?.status==='live' ? `${factorySummary(marker.factoryId).runningDevices}/${factorySummary(marker.factoryId).totalDevices} 台运行${factorySummary(marker.factoryId).mode==='simulation'?' · 模拟':''}` : '实时数据待接入' : marker.located===false?'位置待完善':`${marker.count} 座工厂` }}</small></button>
    </div>
    <div class="group-vignette"></div>
    <GroupHierarchyCapsule :crumbs="hierarchyCrumbs" @navigate="navigateHierarchy" />
    <div v-if="error || configError || navigationNotice" class="map-action-error" role="alert">{{error || configError || navigationNotice}}</div>
    <div class="group-map-controls"><button aria-label="复位地图视角" title="复位地图视角" @click="frameMap">⌖</button></div>
    <div v-if="loadingStage && ready" class="group-stage-loading" role="status">正在进入{{ levelNames[level] }}地图…</div>
    <MapSurfaceWidgets :document="mapDesignerDocument" :map-data="mapDesignerData" :legacy-values="legacyMapValues" :view-id="`map_${level}`" :factory-id="config?.factoryId || ''" :config="config" :data-store="data" @navigate="navigateDesignedSurface" @map-action="handleMapWidgetAction" />
  </main>
</template>

<style scoped>
.map-action-error{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);z-index:30;padding:8px 16px;border-radius:8px;background:#2b203ce6;color:#ecd5e5;font-size:12px}
.group-portal{position:fixed;inset:0;overflow:hidden;background:#141722;color:#d7ddef;font-family:var(--hud-font-text,'Segoe UI',sans-serif)}.group-map{position:absolute;inset:30px 14% 35px -6%}.group-map :deep(canvas){width:100%;height:100%;touch-action:none;display:block}.group-vignette{position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,#141722b0,transparent 24%,transparent 68%,#141722e8),linear-gradient(0deg,#10121dcc,transparent 35%,transparent 75%,#10121dcc)}.group-map-controls{position:absolute;bottom:12%;left:50%;display:flex;align-items:center;transform:translateX(-50%)}.group-map-controls button{width:32px;height:32px;border:1px solid #8a98c33b;border-radius:50%;background:#181e30;color:#a5b5e0;cursor:pointer}.group-loading{position:absolute;left:40%;top:50%;color:#9daacb;font-size:14px}button:focus-visible{outline:2px solid #97a6eb;outline-offset:4px}button:disabled{opacity:.55;cursor:wait}
</style>
<style scoped>
.group-portal{--group-font:"Inter Variable","Noto Sans SC Variable","Segoe UI","Microsoft YaHei UI",sans-serif;font-family:var(--group-font)!important;font-synthesis:none;-webkit-font-smoothing:antialiased}.group-map-label{font-family:var(--group-font)!important}.group-map-label>span{min-width:0;overflow:hidden;text-overflow:ellipsis}.group-map-label small{flex-shrink:0}
.group-map-label{position:absolute;left:0;top:0;z-index:2;visibility:hidden;display:flex;align-items:center;gap:7px;max-width:180px;padding:6px 9px;border:1px solid #9aace838;border-radius:5px;background:rgba(15,20,35,.76);color:#d0dcf4;font:400 10px var(--hud-font-text,'Segoe UI',sans-serif);white-space:nowrap;cursor:pointer;overflow:hidden;text-overflow:ellipsis}.group-map-label i{width:4px;height:4px;flex-shrink:0;border-radius:50%;background:#91d4cc;box-shadow:0 0 8px #83baf066}.group-map-label small{font-size:8px;color:#7f91b8}.group-map-label.registered i{background:#c2a2dc;box-shadow:none}.group-map-label:hover{border-color:#b4c5f4aa;color:white}.group-map-label:focus-visible{outline:2px solid #a7b2f1;outline-offset:3px}
</style>
<style scoped>.group-portal.admin-surface{top:46px}.group-portal.admin-surface :deep(.unity-window-chrome){position:fixed;top:0;left:0;right:0}</style>
<style scoped>
.group-portal{background:radial-gradient(ellipse 55% 48% at 48% 49%,rgba(76,77,104,.2),transparent 78%),linear-gradient(180deg,#181a25 0%,#12141e 100%)}
</style>
<style scoped>
.group-map-label{overflow:visible;isolation:isolate;border-color:rgba(154,172,224,.27);border-radius:6px;background:linear-gradient(115deg,rgba(19,25,43,.84),rgba(22,27,42,.66));box-shadow:0 5px 16px rgba(3,7,18,.22),inset 0 1px 0 rgba(225,232,255,.07);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.group-map-label>i,.group-map-label>span,.group-map-label>small{position:relative;z-index:1}
.group-map-label::after{content:"";position:absolute;z-index:0;left:50%;top:100%;width:1px;height:var(--leader-length,14px);transform:translateX(-50%) rotate(var(--leader-angle,0deg));transform-origin:top center;background:linear-gradient(180deg,rgba(160,185,244,.66),rgba(127,157,218,.2));pointer-events:none}
.group-map-label::before{content:"";position:absolute;z-index:0;left:calc(50% + var(--leader-x,0px));top:calc(100% + var(--leader-y,14px));width:4px;height:4px;transform:translate(-50%,-50%);border:1px solid rgba(196,214,255,.78);border-radius:50%;background:#899ee9;box-shadow:0 0 8px rgba(130,161,255,.55);pointer-events:none}
.group-map-label.registered{border-color:rgba(190,166,218,.26)}.group-map-label.registered::after{background:linear-gradient(180deg,rgba(192,169,220,.62),rgba(153,132,184,.18))}.group-map-label.registered::before{background:#b59bd1;border-color:rgba(224,207,242,.76);box-shadow:0 0 8px rgba(187,157,218,.48)}
.group-map-label:hover{border-color:rgba(190,207,255,.64);box-shadow:0 7px 20px rgba(3,7,18,.3),0 0 12px rgba(117,147,231,.12),inset 0 1px 0 rgba(235,240,255,.12)}
.group-map-label.is-selected{border-color:rgba(168,193,255,.8);background:linear-gradient(110deg,rgba(41,59,99,.92),rgba(23,30,52,.88));box-shadow:0 0 0 2px rgba(129,153,255,.13),0 0 18px rgba(119,150,255,.25),inset 0 1px 0 rgba(235,242,255,.15)}.group-map-label.is-selected i{background:#d4edff;box-shadow:0 0 0 3px rgba(132,177,255,.18),0 0 12px rgba(149,199,255,.8)}
.group-map-label{opacity:var(--map-label-opacity,1)}.group-stage-loading{position:absolute;left:50%;top:20%;transform:translateX(-50%);padding:7px 13px;border:1px solid rgba(133,154,215,.22);border-radius:99px;background:rgba(18,25,42,.75);color:#9cafcf;font-size:10px;letter-spacing:.08em;pointer-events:none}
.group-stage-enter-active,.group-stage-leave-active{transition:opacity .24s ease,transform .3s cubic-bezier(.2,.75,.25,1),filter .24s ease;will-change:opacity,transform,filter}.group-stage-enter-from{opacity:0;transform:translateY(7px);filter:blur(2px)}.group-stage-leave-to{opacity:0;transform:translateY(-4px);filter:blur(2px)}
@media(prefers-reduced-motion:reduce){.group-stage-enter-active,.group-stage-leave-active{transition:none}.group-stage-enter-from,.group-stage-leave-to{transform:none;filter:none}}
.group-map-detail{top:calc(30px - min(18vh,150px));bottom:calc(35px + min(18vh,150px))}
.group-map-national{top:-15px;bottom:80px}
.group-portal{background:radial-gradient(ellipse 62% 58% at 48% 44%,rgba(206,204,193,.085),transparent 72%),linear-gradient(140deg,#36373a 0%,#303134 52%,#292a2c 100%);color:#e5e3de}
.group-vignette{background:linear-gradient(90deg,rgba(21,21,22,.12),transparent 24%,transparent 70%,rgba(19,19,20,.18)),linear-gradient(0deg,rgba(17,17,18,.2),transparent 31%,transparent 78%,rgba(20,20,21,.12))}
.group-map-label{border-color:rgba(218,216,207,.2);background:linear-gradient(115deg,rgba(55,55,57,.88),rgba(43,43,45,.78));color:#e7e5df}
.group-map-label.is-selected{background:linear-gradient(110deg,rgba(83,82,88,.94),rgba(54,54,57,.9))}
.group-map-controls button{border-color:rgba(217,215,205,.2);background:rgba(57,57,59,.8);color:#dedcd5;backdrop-filter:blur(12px)}
.group-stage-loading{border-color:rgba(215,213,204,.18);background:rgba(54,54,56,.82);color:#d5d3cb;backdrop-filter:blur(14px)}
.group-portal{background:radial-gradient(ellipse 48% 43% at 47% 43%,rgba(208,204,194,.07),transparent 76%),linear-gradient(160deg,color-mix(in srgb,var(--group-background) 88%,#454347),var(--group-background) 65%,color-mix(in srgb,var(--group-background) 82%,#171719));color:var(--group-text)}.group-user{background:color-mix(in srgb,var(--group-surface) 42%,transparent);border-color:rgba(226,222,212,.1)}.group-user:hover{background:color-mix(in srgb,var(--group-surface) 63%,transparent)}.group-map-label{border-color:color-mix(in srgb,var(--group-accent) 28%,transparent);background:color-mix(in srgb,var(--group-surface) 88%,transparent)}
.group-portal{background:radial-gradient(ellipse 56% 64% at 43% 43%,color-mix(in srgb,var(--group-surface) 36%,transparent),transparent 74%),linear-gradient(145deg,color-mix(in srgb,var(--group-background) 89%,#5c5855),var(--group-background) 64%,color-mix(in srgb,var(--group-background) 85%,#19191b))}
.group-vignette{background:linear-gradient(90deg,rgba(18,18,20,.18),transparent 20%,transparent 66%,rgba(18,18,20,.16)),linear-gradient(0deg,rgba(16,16,18,.13),transparent 28%,transparent 78%,rgba(17,17,19,.08))}
.group-map-label{color:var(--group-text);box-shadow:0 8px 18px rgba(10,10,12,.14),inset 0 1px 0 rgba(255,255,255,.07)}
.group-map-label small{color:#b5b7c4}
.group-map-controls button{border-color:rgba(224,222,215,.23);background:color-mix(in srgb,var(--group-surface) 68%,transparent)}
</style>
