<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute,useRouter } from 'vue-router'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { createDashboardDataStore } from '../runtime/DataStore.js'
import { createNativeViewNavigator } from '../runtime/nativeViewNavigation.js'
import { setFactoryScope } from '../runtime/factoryScope.js'
import { openAdminSurface } from '../runtime/nativeAdminNavigation.js'
import { adminFetch, adminSession, refreshAdminSession, startAdminSessionTracking, stopAdminSessionTracking, changeAdminPassword, listAdminAccounts, addAdminAccount, activateAdminAccount, logoutCurrentAdminAccount } from '../runtime/adminSession.js'
import { currentFactorySite,factoryDirectorySites,configuredOverseasCountries,chinaRegionsWithFactories,sitesAtHierarchyLevel,groupHierarchyEntries,hierarchyMapPoints,worldHierarchyMapPoints } from '../runtime/groupTopology.js'
import { loadChinaAdminMap } from '../runtime/chinaAdminMaps.js'
import { createFactoryMapMarker } from '../runtime/groupMapMarkers.js'
import { createGroupNavigationCrumbs } from '../runtime/groupHierarchyPath.js'
import { isNativeUnitySurface, NATIVE_SURFACE_CHANNEL, requestNativeSceneSurface } from '../runtime/nativeSurfaceBridge.js'
import AdminWindowChrome from './admin/components/AdminWindowChrome.vue'
import GroupHierarchyCapsule from './GroupHierarchyCapsule.vue'
import LoadingExperience from '../components/LoadingExperience.vue'
import { disposeSceneObject } from '../runtime/ConfiguredFactoryScene.js'
import { groupPortalAppearanceForLevel } from '../runtime/groupPortalAppearance.js'

const route=useRoute(),router=useRouter(),mapHost=ref(null),config=ref(null),error=ref(''),busy=ref(false),ready=ref(false),loadingStage=ref(false),features=ref([])
const nativeLoadingManaged=ref(Boolean(window.__DIGITAL_TWIN_NATIVE_LOADING__)),mapLoadingProgress=ref(7),mapLoadingPhase=ref(0),mapLoadingStep=ref('正在读取工厂与区域资料')
function reportMapLoading(progress,phase,step){mapLoadingProgress.value=progress;mapLoadingPhase.value=phase;mapLoadingStep.value=step;window.dispatchEvent(new CustomEvent('digital-twin-loading-progress',{detail:{progress,phase,step}}))}
const site=computed(()=>currentFactorySite(config.value || {}))
const appearance=computed(()=>groupPortalAppearanceForLevel(config.value?.settings?.group_portal_config,level.value))
const appearanceStyle=computed(()=>({'--group-background':appearance.value.background,'--group-surface':appearance.value.panelSurface,'--group-accent':appearance.value.accent,'--group-text':appearance.value.text}))
const sites=computed(()=>config.value ? factoryDirectorySites(config.value) : [])
const clearCountries=computed(()=>configuredOverseasCountries(sites.value))
const factoryRegions=computed(()=>chinaRegionsWithFactories(sites.value))
const level=computed(()=>{
  if(['world','country','province','city','district'].includes(String(route.query.level || '')))return String(route.query.level)
  const legacy=String(route.query.region || '')
  return legacy ? /^\d{6}$/.test(legacy) ? 'province' : 'country' : 'world'
})
const selected=computed(()=>String(route.query.code || route.query.region || ''))
const visibleSites=computed(()=>sitesAtHierarchyLevel(sites.value,level.value,selected.value))
const unassignedCitySites=computed(()=>level.value==='city' ? visibleSites.value.filter(item=>!item.location.districtCode && !item.location.districtName) : [])
const visibleLocalSites=computed(()=>visibleSites.value.filter(item=>item.runtime==='local'))
const districtAssignedSites=computed(()=>visibleSites.value.filter(item=>item.location.country==='CHN' ? item.location.districtCode : item.location.regionName))
const districtCoverage=computed(()=>visibleSites.value.length ? Math.round(districtAssignedSites.value.length/visibleSites.value.length*100) : null)
const markerLabels=ref([]),selectedSiteId=ref(''),hoveredRegionId=ref(''),childFeatures=ref([]),municipalityLevel=ref(false)
const labelElements=new Map()
const selectedFeature=computed(()=>features.value.find(feature=>String(feature.properties.adcode ?? feature.properties.ADM0_A3)===selected.value))
const regionTitle=computed(()=>level.value==='world' ? '工厂分布' : String(route.query[`${level.value}Name`] || selectedFeature.value?.properties?.name || selectedFeature.value?.properties?.NAME_ZH || selectedFeature.value?.properties?.ADMIN || selected.value || '区域总览'))
const selectedFactory=computed(()=>visibleSites.value.find(item=>item.id===selectedSiteId.value))
const regionRows=computed(()=>{
  if(level.value==='province' && municipalityLevel.value){
    return groupHierarchyEntries(sites.value,'city',selected.value,childFeatures.value)
      .sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name,'zh-CN'))
  }
  return groupHierarchyEntries(sites.value,level.value,selected.value,childFeatures.value)
    .sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name,'zh-CN'))
})
const showAllRegions=ref(false)
const displayedRegionRows=computed(()=>showAllRegions.value?regionRows.value:regionRows.value.filter(row=>row.count>0))
const unregisteredRegionCount=computed(()=>regionRows.value.filter(row=>row.count===0).length)
const levelNames={world:'全球',country:'国家',province:'省份',city:'城市',district:'区县'}
const hierarchyCrumbs=computed(()=>createGroupNavigationCrumbs({query:route.query,level:level.value,currentLabel:regionTitle.value}))
const data=createDashboardDataStore()
const configError=ref('')
const accessStatus=computed(()=>!adminSession.ready?'读取账户状态…':!adminSession.configured?'首次设置密码':adminSession.authenticated?({owner:'系统管理员',customer:'现场客户',editor:'现场客户',viewer:'现场查看'}[adminSession.user?.role] || '已登录'):'未登录 · 需要登录')
const accountOpen=ref(false),accountBusy=ref(false),accountError=ref(''),accountNotice=ref(''),accountSessions=ref([]),accountAddOpen=ref(false),accountAddUsername=ref(''),accountAddPassword=ref(''),accountCurrentPassword=ref(''),accountNewPassword=ref(''),accountPasswordMode=ref(false)
const visibleAccountSessions=computed(()=>[...accountSessions.value].sort((a,b)=>Number(b.slotId===adminSession.accountSlotId)-Number(a.slotId===adminSession.accountSlotId)))
async function loadAccountSessions(){try{accountSessions.value=await listAdminAccounts()}catch(error){accountError.value=error.message}}
async function toggleAccount(){accountOpen.value=!accountOpen.value;accountError.value='';accountNotice.value='';if(accountOpen.value){await refreshAdminSession();await loadAccountSessions()}}
function requestAdminLogin(){accountOpen.value=false;const webview=window.chrome?.webview;if(isNativeUnitySurface(route.query.embedded,webview)){webview.postMessage({type:'host_action',action:'show_admin',returnToDashboard:true});return}router.push({path:'/admin',query:{redirect:route.fullPath}})}
function makeAccountSlotId(){const bytes=new Uint8Array(12);window.crypto.getRandomValues(bytes);return [...bytes].map(value=>value.toString(16).padStart(2,'0')).join('')}
async function addAccount(){accountBusy.value=true;accountError.value='';accountNotice.value='';try{await addAdminAccount(makeAccountSlotId(),accountAddUsername.value,accountAddPassword.value);accountAddUsername.value='';accountAddPassword.value='';accountAddOpen.value=false;await loadAccountSessions()}catch(error){accountError.value=error.message}finally{accountBusy.value=false}}
async function switchAccount(account){if(account.slotId===adminSession.accountSlotId)return;accountBusy.value=true;accountError.value='';accountNotice.value='';try{await activateAdminAccount(account.slotId,account.csrfToken);await loadAccountSessions()}catch(error){accountError.value=error.message;await loadAccountSessions()}finally{accountBusy.value=false}}
async function signOut(){accountBusy.value=true;accountError.value='';accountNotice.value='';try{await logoutCurrentAdminAccount();accountPasswordMode.value=false;accountAddOpen.value=false;await loadAccountSessions();accountNotice.value=accountSessions.value.length?'当前账户已退出，可从下方切换到其他已登录账户':'当前账户已退出'}catch(error){accountError.value=error.message}finally{accountBusy.value=false}}
async function changeOwnPassword(){accountBusy.value=true;accountError.value='';try{await changeAdminPassword(accountCurrentPassword.value,accountNewPassword.value);accountCurrentPassword.value='';accountNewPassword.value='';accountPasswordMode.value=false;accountError.value='密码已更新，其他会话已退出'}catch(error){accountError.value=error.message}finally{accountBusy.value=false}}
const mapConfigSignature=value=>JSON.stringify({sites:factoryDirectorySites(value || {}).map(({id,name,location,runtime})=>({id,name,location,runtime})),appearance:value?.settings?.group_portal_config})
let renderer,scene,camera,controls,mapRoot,observer,raf,pollTimer,focusFrame=0,disposed=false,dirty=true,geometryGeneration=0,request,down,surfaceChannel,configLoading=false,mapMotionEnabled=true,lastMarkerFrame=0,regionVisuals=new Map(),mapTransition=null,activeProject=null
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
  for(const key of ['scope','region','level','code','country','countryName','province','provinceName','city','cityName','district','districtName'])delete query[key]
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
  if(item.level==='factory'){const target=item.site || sites.value.find(site=>site.id===item.code);if(target)enterFactory(target);return}
  selectedSiteId.value=''
  router.replace({path:'/group',query:hierarchyQuery(item.level,item.code,item.name || item.label)})
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
  if(level.value==='world' && marker.worldProvinceCode){
    selectedSiteId.value=''
    router.replace({path:'/group',query:groupQuery({level:'province',code:marker.worldProvinceCode,country:'CHN',countryName:'中华人民共和国',province:marker.worldProvinceCode,provinceName:marker.worldProvinceName})})
    return
  }
  if(marker.factoryId){const target=sites.value.find(item=>item.id===marker.factoryId);if(target && (level.value==='district' || level.value==='country' && selected.value!=='CHN') && target.runtime==='local')enterFactory(target);else selectSite(marker.factoryId)}
  else selectRegion(marker.targetRegion || 'unassigned')
}
function clearRegion(){navigateHierarchy({level:'world',code:'',name:'全球'})}
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
      const active=(count>0 && !(stage==='world' && code==='CHN')) || stage==='district'
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
      // Provincial outlines remain visible in the China-centred first view.
      // They are decorative here: navigation still follows the country →
      // province hierarchy, while only configured provinces receive a glow.
      const provinces=new THREE.Group()
      for(const feature of chinaMap.features.filter(isChinaAdminFeature)){
        const assigned=factoryRegions.value.has(String(feature.properties.adcode))
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
      // Keep the entire world geometry draggable, but frame the first view on
      // China and nearby countries instead of shrinking the factory to a dot.
      const focusBounds=new THREE.Box3()
      for(const coordinate of [[62,4],[147,64]]){
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
      ? worldHierarchyMapPoints(sites.value,worldFeatures,chinaMap.features.filter(isChinaAdminFeature))
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
      const markerOptions=stage==='country' && stageCode==='CHN'?{footprint:false,radiusScale:.24}:stage==='province' || stage==='city'?{footprint:false,radiusScale:.4}:stage==='world' && point.worldProvinceCode?{footprint:false,radiusScale:.12,beamScale:.28}:stage==='world'?{radiusScale:.62}:{}
      const marker=createFactoryMapMarker(point,position,stage==='district' || stage==='country' && stageCode!=='CHN',{...markerOptions,primary:appearance.value.markerPrimary,tip:appearance.value.markerTip})
      const markerScale=stage==='district'?visibleSites.value.length===1?3.2:visibleSites.value.length<=3?2:1.25:stage==='country' && stageCode==='CHN'?1.6:1
      const markerBase=marker.root.position.y
      marker.root.scale.setScalar(markerScale)
      const markerGround=reliefDepth+(stage==='world' && point.worldProvinceCode ? .12 : .03)
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
  if(configLoading || disposed)return
  configLoading=true
  request=new AbortController()
  try {
    const result=await adminFetch(API_BASE+'/config',{signal:request.signal,cache:'no-store'})
    if(!result.ok)throw new Error('后台配置暂不可用')
    const next=await result.json(),changed=mapConfigSignature(next)!==mapConfigSignature(config.value)
    if(disposed)return
    config.value=next;configError.value=''
    if(changed && scene)buildMap({reframe:!ready.value})
  }catch(e){if(!disposed && e.name!=='AbortError')configError.value=e.message}finally{configLoading=false}
}
const navigator=createNativeViewNavigator(async target=>{
  const response=await adminFetch(API_BASE+'/native-preview/navigate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'view',viewId:target.viewId,focus:{mode:'factory'}})})
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
    setFactoryScope(target.id)
    await navigator.go({viewId:'factory_overview',deviceId:''})
    if(disposed)return
    if(adminSurface.value && window.chrome?.webview){requestNativeSceneSurface();await router.replace({path:'/admin',query:{embedded:'unity'}});window.chrome.webview.postMessage({type:'host_action',action:'show_dashboard'})}
    else await router.push({path:'/overlay',query:{...route.query,scene:'1',fromGroup:selected.value || 'unassigned'}})
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
watch([level,selected],()=>{showAllRegions.value=false;if(scene)buildMap()})
onMounted(async()=>{
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
    await refreshConfig();await buildMap();pollTimer=setInterval(refreshConfig,15000)
    data.setMessageHandler(message=>{if(message.type==='configuration_changed')refreshConfig();if(message.type==='dashboard_context_changed')navigator.accept(message.payload)})
    if(typeof BroadcastChannel!=='undefined' && !adminSurface.value){surfaceChannel=new BroadcastChannel(NATIVE_SURFACE_CHANNEL);surfaceChannel.onmessage=event=>{if(event.data?.type==='show_native_scene' && route.query.embedded==='unity')router.replace({path:'/overlay',query:{...route.query,scene:'1'}})}}
    data.connect();window.chrome?.webview?.addEventListener('message',hostMessage);window.chrome?.webview?.postMessage({type:'overlay_ready'});reportRegions()
  }catch(e){error.value=e.message;window.chrome?.webview?.postMessage({type:'overlay_ready'})}
})
onUnmounted(()=>{stopAdminSessionTracking();disposed=true;geometryGeneration++;request?.abort();surfaceChannel?.close();clearInterval(pollTimer);cancelAnimationFrame(raf);cancelMapFlight();navigator.dispose();data.dispose();observer?.disconnect();controls?.removeEventListener('start',cancelMapFlight);controls?.dispose();disposeSceneObject(scene);renderer?.dispose();window.chrome?.webview?.removeEventListener('message',hostMessage);window.chrome?.webview?.postMessage({type:'overlay_regions',viewport:{width:innerWidth,height:innerHeight},regions:[]})})
</script>

<template>
  <LoadingExperience v-if="!ready && !error && !nativeLoadingManaged" :show="!ready" :progress="mapLoadingProgress" :phase="mapLoadingPhase" :step="mapLoadingStep" />
  <main class="group-portal" :class="{'admin-surface':adminSurface,'no-panel':!appearance.showPanel,'no-facts':!appearance.showFacts,'no-dock':!appearance.showDock}" :style="appearanceStyle">
    <AdminWindowChrome v-if="adminSurface" @before-dashboard="router.replace({path:'/admin',query:{embedded:'unity'}})" @before-admin="returnToAdminWorkspace" />
    <div ref="mapHost" class="group-map" :class="{'group-map-detail':level==='province'||level==='city','group-map-national':level==='country' && selected==='CHN'}" aria-label="集团工厂分布地图，可拖拽旋转和滚轮缩放" @pointerdown="down=[$event.clientX,$event.clientY]" @pointermove="trackRegionHover" @pointerup="pick" @pointercancel="down=null" @pointerleave="hoverRegion('')">
      <button v-for="marker in markerLabels" :key="marker.id" :ref="element=>{if(element){labelElements.set(marker.id,element);dirty=true}else labelElements.delete(marker.id)}" class="group-map-label" :class="{registered:marker.runtime==='registered','is-selected':Boolean(selectedSiteId && selectedSiteId===marker.factoryId)}" :data-site-id="marker.id" :aria-label="`定位 ${marker.name}`" :title="`${marker.name}；标记表示位置，不代表产量`" @pointerdown.stop @pointerup.stop @click.stop="selectMarker(marker.id)"><i></i><span>{{ marker.name }}</span><small>{{ marker.localRuntimeCount ? `${marker.localRuntimeCount} 个运行端`:'仅登记' }}</small></button>
    </div>
    <div class="group-vignette"></div>
    <header class="group-brand"><img v-if="appearance.logoUrl" class="group-brand-image" :src="appearance.logoUrl" alt="大屏 Logo" /><i v-else></i><div><strong>{{ appearance.brandTitle }}</strong><small>{{ appearance.brandSubtitle }}</small></div></header>
    <button class="group-user" type="button" :aria-label="`${accessStatus}，打开账户菜单`" :aria-expanded="accountOpen" @click="toggleAccount"><span class="group-user-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" /></svg></span><span><strong>{{ adminSession.user?.displayName || (adminSession.configured ? '账户':'后台账户') }}</strong><small>{{ adminSession.authenticated ? accessStatus : '点击登录' }}</small></span><i class="group-user-state" :class="{verified:adminSession.authenticated}" aria-hidden="true"></i></button>
    <div v-if="accountOpen" class="group-account-menu" role="region" aria-label="账户设置">
      <template v-if="!adminSession.authenticated">
        <header class="group-account-profile"><span class="group-account-avatar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" /></svg></span><span><strong>{{ accountSessions.length ? '选择账户' : '尚未登录' }}</strong><small>{{ accountSessions.length ? '本机已保存有效登录会话' : '请登录后查看生产大屏与现场数据' }}</small></span></header>
        <section v-if="accountSessions.length" class="group-account-list" aria-label="已登录账户"><small>已登录账户 · {{ accountSessions.length }}</small><button v-for="account in visibleAccountSessions" :key="account.slotId" type="button" :disabled="accountBusy" @click="switchAccount(account)"><span class="group-account-avatar small">{{ (account.user?.displayName || account.user?.username || '?').slice(0,1) }}</span><span><strong>{{ account.user?.displayName || account.user?.username }}</strong><small>{{ account.user?.username }} · {{ ({owner:'系统管理员',customer:'现场客户',viewer:'现场查看'}[account.user?.role] || '已登录') }}</small></span><i>切换 →</i></button></section>
        <p class="group-account-message">{{ adminSession.configured ? '请使用后台管理页登录；登录成功后将自动返回实时大屏。' : '首次使用请在后台管理页完成管理员初始化。' }}</p>
        <button class="group-account-action group-account-primary" type="button" @click="requestAdminLogin">前往后台管理登录 <span>→</span></button>
      </template>
      <template v-else>
        <header class="group-account-profile"><span class="group-account-avatar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" /></svg></span><span><strong>{{ adminSession.user?.displayName }}</strong><small>{{ adminSession.user?.username }} · {{ accessStatus }}</small></span></header>
        <section v-if="accountSessions.length>1" class="group-account-list" aria-label="已登录账户"><small>已登录账户 · {{ accountSessions.length }}</small><button v-for="account in visibleAccountSessions" :key="account.slotId" type="button" :class="{active:account.slotId===adminSession.accountSlotId}" :disabled="accountBusy || account.slotId===adminSession.accountSlotId" @click="switchAccount(account)"><span class="group-account-avatar small">{{ (account.user?.displayName || account.user?.username || '?').slice(0,1) }}</span><span><strong>{{ account.user?.displayName || account.user?.username }}</strong><small>{{ account.user?.username }} · {{ ({owner:'系统管理员',customer:'现场客户',viewer:'现场查看'}[account.user?.role] || '已登录') }}</small></span><i>{{ account.slotId===adminSession.accountSlotId ? '当前账户':'切换 →' }}</i></button></section>
        <button v-if="adminSession.permissions.edit" class="group-account-action group-account-primary" type="button" @click="openAdmin">设置页面 <span>→</span></button>
        <button v-else-if="adminSession.permissions.cast || adminSession.permissions.backup" class="group-account-action group-account-primary" type="button" @click="router.push({path:'/customer',query:route.query})">现场操作中心 <span>→</span></button>
        <button class="group-account-action" type="button" :disabled="accountBusy || accountSessions.length>=8" @click="accountAddOpen=!accountAddOpen">{{ accountAddOpen ? '收起账户管理':'管理账户' }}<span>{{ accountAddOpen ? '−':'＋' }}</span></button>
        <form v-if="accountAddOpen" class="group-account-form" @submit.prevent="addAccount"><label>账号<input v-model.trim="accountAddUsername" autocomplete="username" required maxlength="32" /></label><label>密码<input v-model="accountAddPassword" type="password" autocomplete="current-password" required minlength="8" maxlength="128" /></label><button class="group-account-primary" type="submit" :disabled="accountBusy">{{ accountBusy ? '验证中…':'添加并切换' }}<span>→</span></button></form>
        <button class="group-account-action" type="button" @click="accountPasswordMode=!accountPasswordMode">{{ accountPasswordMode ? '收起修改密码':'修改我的密码' }}<span>{{ accountPasswordMode ? '−':'＋' }}</span></button>
        <form v-if="accountPasswordMode" class="group-account-form" @submit.prevent="changeOwnPassword"><label>当前密码<input v-model="accountCurrentPassword" type="password" autocomplete="current-password" minlength="8" required /></label><label>新密码<input v-model="accountNewPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required /></label><button class="group-account-primary" type="submit" :disabled="accountBusy">保存新密码<span>→</span></button></form>
        <button class="group-account-action group-account-exit" :disabled="accountBusy" type="button" @click="signOut">退出当前账户 <span>↗</span></button>
      </template>
      <p v-if="accountError" class="group-account-message error" role="alert">{{ accountError }}</p>
      <p v-if="accountNotice" class="group-account-message" role="status">{{ accountNotice }}</p>
    </div>
    <GroupHierarchyCapsule :crumbs="hierarchyCrumbs" @navigate="navigateHierarchy" />
    <aside v-if="appearance.showFacts" class="group-facts"><small>{{ level==='world' ? '全球':'当前区域' }}登记工厂</small><strong>{{ config ? visibleSites.length:'—' }} <em>座</em></strong><span>{{ visibleSites.filter(item=>item.runtime==='local').length }} 座运行端 · {{ visibleSites.filter(item=>item.runtime==='registered').length }} 座仅登记</span><small>本机现场设备配置数</small><strong>{{ visibleSites.some(item=>item.runtime==='local') ? site.devices:'—' }} <em>台</em></strong><span>配置数不代表设备实时在线</span></aside>
    <aside v-if="appearance.showPanel" class="group-panel">
      <small>{{ appearance.panelTitle }}</small>
      <Transition name="group-stage" mode="out-in">
        <div :key="`${level}-${selected}`" class="group-panel-stage">
          <h1>{{ regionTitle }}</h1>
          <p>{{ level==='district' || level==='country' && selected!=='CHN' ? '点击工厂进入三维场景' : `点击地图进入下一级；点击上方地址返回对应层级` }}</p>
          <div v-if="regionRows.length && level!=='district'" class="group-region-list">
            <button v-for="region in displayedRegionRows" :key="region.code" class="group-region-row" :class="{'is-map-hovered':hoveredRegionId===region.code,'is-empty':!region.count}" :aria-pressed="selected===region.code" @mouseenter="hoverRegion(region.code)" @mouseleave="hoverRegion('')" @focus="hoverRegion(region.code)" @blur="hoverRegion('')" @click="selectRegion(region.code)">
              <span class="group-region-copy">
                <strong>{{ region.name }}</strong>
                <small>{{ region.count ? '已登记工厂所在区域':'暂无登记工厂' }}</small>
                <small v-if="region.count" class="group-region-meta">{{ region.districtAssignedCount }} 区县已归属 <i>·</i> {{ region.localCount }} 本机运行端 <i>·</i> {{ region.registeredCount }} 仅登记</small>
                <span v-if="region.count" class="group-region-meters" aria-hidden="true">
                  <span><small>区县</small><i><b :style="{width:`${region.count ? region.districtAssignedCount / region.count * 100 : 0}%`}"></b></i><em>{{ region.count ? Math.round(region.districtAssignedCount / region.count * 100) : 0 }}%</em></span>
                  <span><small>运行</small><i class="runtime"><b :style="{width:`${region.count ? region.localCount / region.count * 100 : 0}%`}"></b></i><em>{{ region.count ? Math.round(region.localCount / region.count * 100) : 0 }}%</em></span>
                </span>
              </span>
              <span class="group-region-count"><b>{{ String(region.count).padStart(2,'0') }}</b><small>站点</small><i>↗</i></span>
            </button>
          </div>
          <button v-if="unregisteredRegionCount && level!=='district'" class="group-region-more" type="button" :aria-expanded="showAllRegions" @click="showAllRegions=!showAllRegions">{{ showAllRegions ? '收起未登记区域' : `查看其他 ${unregisteredRegionCount} 个区域` }}<span aria-hidden="true">{{ showAllRegions ? '↑':'↓' }}</span></button>
          <div v-for="factory in (level==='district' || level==='country' && selected!=='CHN' ? visibleSites : [])" :key="factory.id" class="group-site" :class="{selected:selectedSiteId===factory.id}" :data-factory-id="factory.id">
            <span class="group-site-tag" :class="{registered:factory.runtime==='registered'}">{{ factory.runtime==='local' ? '本机运行端':'仅登记 · 运行端未接入' }}</span>
            <h2><button class="group-site-focus" type="button" :aria-label="`选择并聚焦${factory.name}`" @click="selectSite(factory.id)"><span>{{ factory.name }}</span><small>区域视角 ↗</small></button></h2><p>{{ factory.location.districtName || factory.location.city || factory.location.regionName || factory.location.country }}</p>
            <dl v-if="factory.runtime==='local'"><div><dt>车间</dt><dd>{{ factory.workshops }}</dd></div><div><dt>产线</dt><dd>{{ factory.lines }}</dd></div><div><dt>设备</dt><dd>{{ factory.devices }}</dd></div></dl>
            <p v-else class="group-unconnected">未接入独立运行端，暂无生产指标。</p>
            <button v-if="factory.runtime==='local' && factory.location.country==='CHN' && !factory.location.districtCode" class="group-location-action" type="button" @click="openFactoryLocationSettings">补充行政区归属 →</button>
            <button v-if="factory.runtime==='local'" :disabled="busy" @click="enterFactory(factory)">{{ busy ? '等待 Unity 场景就绪…':'进入工厂 →' }}</button>
            <button v-else disabled>运行端待接入</button>
          </div>
          <div v-for="factory in unassignedCitySites" :key="`unassigned_${factory.id}`" class="group-site group-site-unassigned" :data-factory-id="factory.id">
            <span class="group-site-tag">区县待归属</span>
            <h2>{{ factory.name }}</h2>
            <p>当前按城市中心显示位置示意；补充区县后会落到对应区县，不使用经纬度。</p>
            <button v-if="factory.runtime==='local'" class="group-location-action" type="button" @click="openFactoryLocationSettings">补充区县归属 →</button>
          </div>
          <div v-if="level!=='world' && !visibleSites.length" class="group-empty">此区域暂无已登记工厂</div>
          <p v-if="appearance.showHelp" class="group-help">在“工厂与区域”维护行政区归属，在“大屏设计器”配置各级地图外观；标记按所属行政区中心示意。</p>
        </div>
      </Transition>
      <p v-if="error || configError" class="group-error" role="alert">{{ error || configError }}</p>
    </aside>
    <div v-if="appearance.showDock" class="group-dock" :aria-label="`${regionTitle}工厂网络摘要`">
      <section class="group-dock-network">
        <small>FACTORY NETWORK</small><h2>站点网络</h2>
        <div class="group-dock-number"><strong>{{ config ? visibleSites.length : '—' }}</strong><span>座登记工厂</span></div>
        <div class="group-dock-composition" role="img" :aria-label="`${visibleLocalSites.length} 座本机运行端，${visibleSites.length-visibleLocalSites.length} 座仅登记`">
          <i class="local" :style="{width:`${visibleSites.length ? visibleLocalSites.length / visibleSites.length * 100 : 0}%`}"></i>
          <i class="registered" :style="{width:`${visibleSites.length ? (visibleSites.length-visibleLocalSites.length) / visibleSites.length * 100 : 0}%`}"></i>
        </div>
        <div class="group-dock-legend"><span><i class="local"></i>本机运行端 <b>{{ visibleLocalSites.length }}</b></span><span><i class="registered"></i>仅登记 <b>{{ visibleSites.length-visibleLocalSites.length }}</b></span></div>
      </section>
      <section class="group-dock-location">
        <small>AREA ASSIGNMENT</small><h2>行政区归属</h2>
        <div class="group-dock-location-body">
          <div class="group-dock-location-ring" :style="{'--coverage':`${districtCoverage ?? 0}%`}" role="img" :aria-label="`行政区归属 ${districtCoverage ?? '未知'}%，已补充区县 ${districtAssignedSites.length} 座，共 ${visibleSites.length} 座`"><strong>{{ districtCoverage ?? '—' }}<em v-if="districtCoverage !== null">%</em></strong></div>
          <div class="group-dock-location-copy"><strong>{{ districtAssignedSites.length }}<i>/</i>{{ visibleSites.length }} <small>座已归属到区县</small></strong><p>地图按行政区中心放置示意标记</p></div>
        </div>
      </section>
      <section class="group-dock-hierarchy">
        <small>LOCAL SITE STRUCTURE</small><h2>本机现场配置</h2>
        <dl><div><dt>车间</dt><dd>{{ visibleLocalSites.length ? site.workshops : '—' }}</dd></div><div><dt>产线</dt><dd>{{ visibleLocalSites.length ? site.lines : '—' }}</dd></div><div><dt>设备</dt><dd>{{ visibleLocalSites.length ? site.devices : '—' }}</dd></div></dl>
        <p>配置数量 · 不代表实时在线</p>
      </section>
    </div>
    <div class="group-map-controls"><button aria-label="复位地图视角" title="复位地图视角" @click="frameMap">⌖</button></div>
    <div v-if="loadingStage && ready" class="group-stage-loading" role="status">正在进入{{ levelNames[level] }}地图…</div>
  </main>
</template>

<style scoped>
.group-portal{position:fixed;inset:0;overflow:hidden;background:#141722;color:#d7ddef;font-family:var(--hud-font-text,'Segoe UI',sans-serif)}.group-map{position:absolute;inset:30px 14% 35px -6%}.group-map :deep(canvas){width:100%;height:100%;touch-action:none;display:block}.group-vignette{position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,#141722b0,transparent 24%,transparent 68%,#141722e8),linear-gradient(0deg,#10121dcc,transparent 35%,transparent 75%,#10121dcc)}
.group-brand{position:absolute;left:3%;top:4%;display:flex;gap:15px;align-items:center}.group-brand i{width:26px;height:32px;background:linear-gradient(145deg,#bbc1ff,#6c75d9);clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)}.group-brand strong{font-size:21px;font-weight:500;letter-spacing:.03em}.group-brand small{display:block;margin-top:8px;font-size:9px;letter-spacing:.23em;color:#707d9b}.group-breadcrumb button{border:0;background:transparent;color:#7f89a5;font:inherit;cursor:pointer}
.group-breadcrumb{position:absolute;left:3%;top:13%;display:flex;gap:12px;align-items:center;font-size:11px;color:#8d9ab5;padding:7px 12px;border:1px solid #7c8cac26;border-radius:20px;background:rgba(20,23,34,.28)}.group-breadcrumb button{color:#b6c0d7}.group-facts{position:absolute;left:3.5%;top:23%;display:grid;gap:12px}.group-facts>small{margin-top:18px;color:#8793ad;font-size:11px}.group-facts strong{font-size:30px;font-weight:400;font-variant-numeric:tabular-nums}.group-facts em{font-size:10px;color:#8491a8;font-style:normal}.group-facts>span{font-size:10px;color:#77839d}
.group-panel{position:absolute;right:3%;top:17%;width:270px;max-width:27vw;padding:24px 18px;background:linear-gradient(120deg,#1015228c,#10152238);border-radius:4px}.group-panel>small{font-size:9px;color:#7c88a4;letter-spacing:.2em}.group-panel h1{font-size:18px;font-weight:500;margin:10px 0 20px}.group-panel-stage>p,.group-site>p{font-size:11px;line-height:1.8;color:#8996b2}.group-region-row{display:flex;align-items:center;justify-content:space-between;width:100%;padding:15px 0;margin:20px 0;border:0;border-top:1px solid #7b8aa522;border-bottom:1px solid #7b8aa522;background:transparent;color:#c7d0e8;font-size:12px;cursor:pointer;text-align:left}.group-region-row small{display:block;font-size:10px;color:#77849e;margin-top:7px}.group-region-row b{font-weight:400}.group-site{padding-top:20px}.group-site-tag{color:#9aade0;font-size:9px;letter-spacing:.07em}.group-site h2{font-size:15px;line-height:1.7;font-weight:500}.group-site dl{display:flex;justify-content:space-between;margin:22px 0}.group-site dt{color:#7686a5;font-size:10px}.group-site dd{font-size:25px;font-weight:300;margin:8px 0}.group-site>button{width:100%;padding:11px 8px;border:1px solid #8d9fe34d;border-radius:5px;background:#7484de20;color:#c1cdfa;font-size:12px;cursor:pointer}.group-site>button:hover{background:#7484de38}.group-panel .group-help{margin-top:26px;font-size:10px;color:#63728c}.group-panel .group-error{color:#efa3af}.group-empty{padding:30px 0;font-size:12px;color:#818faa}.group-map-controls{position:absolute;bottom:12%;left:50%;display:flex;align-items:center;transform:translateX(-50%)}.group-map-controls button{width:32px;height:32px;border:1px solid #8a98c33b;border-radius:50%;background:#181e30;color:#a5b5e0;cursor:pointer}.group-loading{position:absolute;left:40%;top:50%;color:#9daacb;font-size:14px}button:focus-visible{outline:2px solid #97a6eb;outline-offset:4px}button:disabled{opacity:.55;cursor:wait}@media(max-width:900px){.group-facts{display:none}.group-panel{width:210px;max-width:31vw;padding:16px 12px}.group-brand strong{font-size:16px}.group-brand small{font-size:7px}.group-panel h1{font-size:16px}}
</style>
<style scoped>
.group-portal{--group-font:"Inter Variable","Noto Sans SC Variable","Segoe UI","Microsoft YaHei UI",sans-serif;font-family:var(--group-font)!important;font-synthesis:none;-webkit-font-smoothing:antialiased}.group-map-label{font-family:var(--group-font)!important}.group-map-label>span{min-width:0;overflow:hidden;text-overflow:ellipsis}.group-map-label small{flex-shrink:0}
.group-panel{bottom:9%;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#414c6a transparent}.group-region-list{max-height:220px;overflow:auto;scrollbar-width:thin;scrollbar-color:#414c6a transparent}.group-region-list .group-region-row{margin:0;border-top:0;padding:13px 0}.group-site{margin-top:15px;padding:18px 0 20px;border-bottom:1px solid #7786a41c}.group-site.selected{background:linear-gradient(90deg,#8996e311,transparent);box-shadow:inset 2px 0 #97a2df;padding-left:10px}.group-site-tag.registered{color:#b4a1cc}.group-site .group-unconnected{font-size:10px;color:#77869e}.group-site>button:disabled{cursor:not-allowed;background:#75819d0c;border-color:#75819d24;color:#7f8aa4}
.group-map-label{position:absolute;left:0;top:0;z-index:2;visibility:hidden;display:flex;align-items:center;gap:7px;max-width:180px;padding:6px 9px;border:1px solid #9aace838;border-radius:5px;background:rgba(15,20,35,.76);color:#d0dcf4;font:400 10px var(--hud-font-text,'Segoe UI',sans-serif);white-space:nowrap;cursor:pointer;overflow:hidden;text-overflow:ellipsis}.group-map-label i{width:4px;height:4px;flex-shrink:0;border-radius:50%;background:#91d4cc;box-shadow:0 0 8px #83baf066}.group-map-label small{font-size:8px;color:#7f91b8}.group-map-label.registered i{background:#c2a2dc;box-shadow:none}.group-map-label:hover{border-color:#b4c5f4aa;color:white}.group-map-label:focus-visible{outline:2px solid #a7b2f1;outline-offset:3px}
.group-user{position:absolute;z-index:3;right:3%;top:4%;display:flex;align-items:center;gap:9px;padding:7px 11px 7px 7px;border:1px solid rgba(149,164,203,.2);border-radius:999px;background:linear-gradient(115deg,rgba(29,35,53,.74),rgba(19,23,37,.44));color:#d9deec;text-align:left;cursor:pointer;transition:border-color .2s ease,background .2s ease}.group-user:hover{border-color:rgba(166,179,224,.48);background:rgba(34,41,62,.8)}.group-user-icon{display:grid;place-items:center;width:29px;height:29px;border:1px solid rgba(154,169,218,.28);border-radius:50%;color:#c2c9e1;background:rgba(134,148,201,.1)}.group-user-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round}.group-user>span:nth-child(2){display:grid;gap:3px}.group-user strong{font-size:10px;font-weight:500;letter-spacing:.04em}.group-user small{font-size:9px;color:#8792aa;white-space:nowrap}.group-user-state{width:6px;height:6px;border-radius:50%;background:#c5a878;box-shadow:0 0 8px rgba(197,168,120,.42)}.group-user-state.verified{background:#63d2a7;box-shadow:0 0 9px rgba(99,210,167,.5)}.group-user:focus-visible{outline:2px solid #a7b2f1;outline-offset:3px}
.group-location-action{width:100%;margin:4px 0 8px;padding:8px 10px;border:1px solid rgba(145,163,205,.23);border-radius:5px;background:rgba(130,148,194,.08);color:#b7c4e3;text-align:left;font-size:11px;cursor:pointer;transition:background .18s ease,border-color .18s ease}.group-location-action:hover{border-color:rgba(159,178,231,.55);background:rgba(130,148,194,.15)}
</style>
<style scoped>.group-portal.admin-surface{top:46px}.group-portal.admin-surface :deep(.unity-window-chrome){position:fixed;top:0;left:0;right:0}</style>
<style scoped>
.group-brand{z-index:2;min-width:290px;padding:11px 30px 13px 12px;border:1px solid rgba(155,171,225,.13);border-radius:0 0 20px 0;background:linear-gradient(115deg,rgba(18,23,39,.72),rgba(18,23,39,.16));box-shadow:inset 0 -1px 0 rgba(119,137,236,.37),0 8px 26px rgba(5,9,21,.12)}
.group-portal{background:radial-gradient(ellipse 55% 48% at 48% 49%,rgba(76,77,104,.2),transparent 78%),linear-gradient(180deg,#181a25 0%,#12141e 100%)}
.group-brand::after{content:"";position:absolute;right:6px;bottom:-1px;width:78px;height:1px;background:linear-gradient(90deg,transparent,rgba(146,154,255,.8));box-shadow:0 0 11px rgba(131,143,255,.48)}
.group-brand i{box-shadow:0 0 18px rgba(132,144,255,.38)}
.group-facts{padding-left:13px;border-left:1px solid rgba(150,165,211,.25);gap:9px}
.group-facts>small{margin-top:15px;letter-spacing:.13em;text-transform:uppercase}
.group-facts strong{font-size:31px;line-height:1.05;color:#edf0fa;text-shadow:0 0 22px rgba(140,155,233,.16)}
.group-panel{z-index:2;border:1px solid rgba(142,159,207,.11);border-radius:9px;background:linear-gradient(125deg,rgba(23,29,48,.7),rgba(17,22,36,.48) 56%,rgba(15,20,34,.62));box-shadow:0 18px 38px rgba(2,6,17,.17),inset 0 1px 0 rgba(219,226,255,.045)}
.group-panel::before{content:"";position:absolute;top:0;left:18px;width:94px;height:1px;background:linear-gradient(90deg,rgba(155,160,245,.72),transparent);pointer-events:none}
.group-panel h1{color:#e9edf9;letter-spacing:.025em}
.group-dock{position:absolute;z-index:2;left:3%;right:30%;bottom:8%;display:grid;grid-template-columns:1.08fr 1fr 1.2fr;min-height:126px;overflow:hidden;border:1px solid rgba(149,165,215,.11);border-radius:9px;background:linear-gradient(110deg,rgba(20,25,42,.68),rgba(20,24,40,.53) 60%,rgba(16,20,34,.64));box-shadow:0 16px 34px rgba(3,6,17,.14),inset 0 1px 0 rgba(220,226,255,.05);font-variant-numeric:tabular-nums}
.group-dock::before{content:"";position:absolute;top:0;left:20px;width:140px;height:1px;background:linear-gradient(90deg,rgba(155,161,255,.68),rgba(96,195,221,.28),transparent);box-shadow:0 0 9px rgba(139,153,249,.22)}
.group-dock section{min-width:0;padding:16px 20px 13px}
.group-dock section+section{border-left:1px solid rgba(159,176,220,.11)}
.group-dock small{color:#7f8ca9;font-size:8px;letter-spacing:.18em}
.group-dock h2{margin:5px 0 8px;color:#e5e9f5;font-size:12px;font-weight:550;letter-spacing:.025em}
.group-dock-number{display:flex;align-items:baseline;gap:8px;white-space:nowrap}
.group-dock-number strong{color:#edf0fa;font:400 28px/1 var(--hud-font-number,"Segoe UI Variable",sans-serif);letter-spacing:-.035em}
.group-dock-number strong em{font-size:13px;font-style:normal;letter-spacing:0}
.group-dock-number span,.group-dock p{color:#91a0ba;font-size:9px}
.group-dock p{margin:10px 0 0;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.group-dock p span{padding:0 4px;color:#60708f}
.group-dock-live{display:inline-block;width:5px;height:5px;margin:0 7px 1px 0;border-radius:50%;background:#81d6ba;box-shadow:0 0 8px rgba(129,214,186,.55)}
.group-dock-meter{height:2px;margin-top:11px;background:rgba(156,171,211,.14)}
.group-dock-meter i{display:block;height:100%;background:linear-gradient(90deg,#6f94e8,#bca3ec);box-shadow:0 0 7px rgba(141,162,255,.54);transition:width .55s ease}
.group-dock-location p{margin-top:7px}
.group-dock-hierarchy dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0 0}
.group-dock-hierarchy dl div{min-width:0}
.group-dock-hierarchy dt{color:#8997b1;font-size:9px}
.group-dock-hierarchy dd{margin:5px 0 0;color:#e6eaf7;font:400 20px/1 var(--hud-font-number,"Segoe UI Variable",sans-serif)}
.group-dock-hierarchy p{margin-top:8px}
@media(max-width:1100px){.group-dock{right:32%;grid-template-columns:1fr 1fr}.group-dock-hierarchy{display:none}.group-dock section{padding:14px 15px 12px}}
@media(max-width:720px){.group-dock{left:3%;right:35%;bottom:8%;grid-template-columns:1fr;min-height:0}.group-dock-location{display:none}.group-dock-network p{white-space:normal}.group-brand{min-width:0}.group-panel{max-width:32vw}}
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
.group-breadcrumb-factory{color:#dfe5fa!important}.group-site-focus{display:flex;align-items:baseline;justify-content:space-between;width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.group-site-focus small{flex-shrink:0;margin-left:10px;color:#91a0c2;font-size:9px;font-weight:400;opacity:.55;transition:opacity .18s ease,color .18s ease}.group-site-focus:hover small,.group-site.selected .group-site-focus small{color:#c3cdf1;opacity:1}.group-site-focus:focus-visible{outline:2px solid #a7b2f1;outline-offset:4px;border-radius:2px}
.group-region-list .group-region-row{gap:14px;padding:14px 7px;border-bottom-color:rgba(151,166,203,.12);transition:background .18s ease,border-color .18s ease}.group-region-list .group-region-row:hover,.group-region-list .group-region-row.is-map-hovered{background:linear-gradient(100deg,rgba(120,139,202,.11),rgba(120,139,202,.015));border-bottom-color:rgba(157,174,226,.28)}.group-region-list .group-region-row.is-map-hovered{box-shadow:inset 2px 0 rgba(170,183,255,.72)}.group-region-copy{display:grid;gap:5px;min-width:0}.group-region-copy>strong{overflow:hidden;color:#dce3f4;font-size:12px;font-weight:500;text-overflow:ellipsis}.group-region-copy>small{margin:0!important;color:#7887a4!important;font-size:9px!important}.group-region-copy>.group-region-meta{white-space:nowrap;color:#9aa7c0!important;font-size:8px!important;letter-spacing:0}.group-region-meta i{padding:0 2px;color:#53617d;font-style:normal}.group-region-count{display:grid;grid-template-columns:auto auto;align-items:baseline;column-gap:4px;flex-shrink:0;color:#a8b5d1}.group-region-count>b{grid-row:1/3;color:#e0e7f4;font:400 21px/1 var(--hud-font-number,"Segoe UI Variable",sans-serif);font-variant-numeric:tabular-nums}.group-region-count>small{font-size:8px;color:#7c8ba8}.group-region-count>i{grid-column:2;grid-row:1/3;align-self:center;margin-left:5px;color:#8394bc;font-size:13px;font-style:normal;transition:transform .18s ease,color .18s ease}.group-region-row:hover .group-region-count>i{transform:translateX(3px);color:#d0dbfa}
.group-region-meters{display:grid;gap:5px;margin-top:2px}.group-region-meters>span{display:grid;grid-template-columns:24px minmax(42px,1fr) 25px;align-items:center;gap:7px}.group-region-meters>span>small{color:#7887a4;font-size:8px;letter-spacing:.03em}.group-region-meters>span>i{display:block;height:2px;overflow:hidden;border-radius:2px;background:rgba(148,163,199,.13)}.group-region-meters>span>i>b{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,rgba(145,155,235,.58),rgba(177,186,255,.9));box-shadow:0 0 6px rgba(155,166,246,.2);transition:width .35s ease}.group-region-meters>span>i.runtime>b{background:linear-gradient(90deg,rgba(93,191,175,.56),rgba(127,224,194,.9));box-shadow:0 0 6px rgba(111,211,181,.18)}.group-region-meters em{color:#7f8da8;font:400 8px/1 var(--hud-font-number,"Segoe UI Variable",sans-serif);font-style:normal;font-variant-numeric:tabular-nums;text-align:right}
.group-stage-enter-active,.group-stage-leave-active{transition:opacity .24s ease,transform .3s cubic-bezier(.2,.75,.25,1),filter .24s ease;will-change:opacity,transform,filter}.group-stage-enter-from{opacity:0;transform:translateY(7px);filter:blur(2px)}.group-stage-leave-to{opacity:0;transform:translateY(-4px);filter:blur(2px)}
@media(prefers-reduced-motion:reduce){.group-stage-enter-active,.group-stage-leave-active{transition:none}.group-stage-enter-from,.group-stage-leave-to{transform:none;filter:none}}
.group-dock{backdrop-filter:blur(18px) saturate(1.2);-webkit-backdrop-filter:blur(18px) saturate(1.2);background:linear-gradient(112deg,rgba(22,27,45,.66),rgba(22,27,43,.46) 58%,rgba(16,20,34,.61));border-color:rgba(164,179,224,.15);box-shadow:0 18px 42px rgba(3,6,17,.18),inset 0 1px 0 rgba(229,234,255,.065)}
.group-dock section{position:relative;padding:16px 20px 14px}.group-dock section+section{border-left-color:rgba(159,176,220,.13)}.group-dock h2{margin-bottom:12px}.group-dock-network .group-dock-number{margin-bottom:12px}
.group-dock-composition{display:flex;gap:2px;height:4px;overflow:hidden;border-radius:5px;background:rgba(156,171,211,.12);box-shadow:inset 0 1px 2px rgba(3,7,18,.2)}.group-dock-composition>i{display:block;height:100%;border-radius:4px;transition:width .45s cubic-bezier(.2,.75,.25,1)}.group-dock-composition>.local{background:linear-gradient(90deg,#57a99e,#8ce0c5);box-shadow:0 0 10px rgba(111,211,181,.3)}.group-dock-composition>.registered{background:linear-gradient(90deg,#7889bd,#b0a1dc);box-shadow:0 0 9px rgba(155,166,246,.2)}
.group-dock-legend{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px}.group-dock-legend>span{display:flex;align-items:center;gap:5px;color:#8997b1;font-size:8px;white-space:nowrap}.group-dock-legend>span>i{width:5px;height:5px;border-radius:50%;background:#75cdb6;box-shadow:0 0 7px rgba(111,211,181,.32)}.group-dock-legend>span>i.registered{background:#a89acb;box-shadow:0 0 7px rgba(168,154,203,.25)}.group-dock-legend b{color:#d9e1f1;font:500 9px/1 var(--hud-font-number,"Segoe UI Variable",sans-serif);font-variant-numeric:tabular-nums}
.group-dock-location-body{display:flex;align-items:center;gap:14px;margin-top:2px}.group-dock-location-ring{position:relative;isolation:isolate;display:grid;place-items:center;width:54px;height:54px;flex:none;border:1px solid rgba(179,188,245,.16);border-radius:50%;background:conic-gradient(from -90deg,#a4a8f4 0 var(--coverage),rgba(148,163,199,.15) var(--coverage) 100%);box-shadow:0 0 20px rgba(139,145,227,.11)}.group-dock-location-ring::before{content:"";position:absolute;z-index:-1;inset:4px;border:1px solid rgba(193,203,239,.12);border-radius:50%;background:linear-gradient(145deg,rgba(27,33,53,.98),rgba(18,22,37,.98))}.group-dock-location-ring>strong{color:#e8ebfa;font:500 12px/1 var(--hud-font-number,"Segoe UI Variable",sans-serif);font-variant-numeric:tabular-nums}.group-dock-location-ring>strong>em{margin-left:1px;color:#aeb5e9;font-size:7px;font-style:normal}.group-dock-location-copy{min-width:0}.group-dock-location-copy>strong{display:flex;align-items:baseline;gap:4px;color:#e5e9f6;font:400 18px/1 var(--hud-font-number,"Segoe UI Variable",sans-serif);font-variant-numeric:tabular-nums;white-space:nowrap}.group-dock-location-copy>strong>i{color:#697895;font-size:11px;font-style:normal}.group-dock-location-copy>strong>small{margin-left:3px;color:#93a0b8;font:400 8px/1.2 var(--group-font,"Segoe UI",sans-serif)}.group-dock-location-copy>p{margin:8px 0 0;color:#7887a2;font-size:8px}
.group-dock-hierarchy dl{gap:10px;margin-top:13px}.group-dock-hierarchy dl div{position:relative;padding-left:9px}.group-dock-hierarchy dl div::before{content:"";position:absolute;left:0;top:3px;bottom:3px;width:1px;background:linear-gradient(180deg,rgba(167,171,239,.56),rgba(107,202,191,.18))}.group-dock-hierarchy dd{margin-top:7px;font-size:22px}.group-dock-hierarchy p{margin-top:10px}
@media(max-width:720px){.group-dock-legend{gap:6px}.group-dock-legend>span{gap:4px;font-size:7px}.group-dock-location-body{gap:9px}.group-dock-location-ring{width:46px;height:46px}.group-dock-location-copy>strong{font-size:15px}}
.group-brand{z-index:3;box-sizing:border-box;width:min(31vw,450px);min-height:62px;padding:9px 42px 15px 17px;border:1px solid rgba(151,169,215,.1);border-top-color:rgba(151,169,215,.045);border-right-color:transparent;border-radius:0 0 26px 0;background:linear-gradient(103deg,rgba(27,34,54,.84),rgba(24,30,48,.58) 68%,rgba(19,24,40,.12));box-shadow:inset 0 1px 0 rgba(229,235,255,.055),0 10px 28px rgba(4,7,18,.08)}.group-brand::before{content:"";position:absolute;right:23px;top:-8px;width:1px;height:73px;transform:skewX(-27deg);background:linear-gradient(180deg,rgba(142,161,239,.07),rgba(144,159,232,.5) 72%,rgba(125,145,220,.2));box-shadow:0 0 8px rgba(124,145,235,.18);pointer-events:none}.group-brand::after{content:"";position:absolute;right:15px;bottom:-1px;width:136px;height:1px;transform:skewX(-27deg);background:linear-gradient(90deg,rgba(154,166,243,.52),rgba(114,145,219,.24),transparent);box-shadow:0 0 9px rgba(133,148,238,.18);pointer-events:none}.group-brand i{filter:drop-shadow(0 0 8px rgba(145,154,255,.28))}.group-brand strong{color:#e5e9f6;font-size:19px;letter-spacing:.015em}.group-brand small{margin-top:5px;color:#7987a3;font-size:8px;letter-spacing:.2em}
@media(max-width:900px){.group-brand{width:auto;min-width:0;max-width:58vw;padding:8px 28px 13px 11px}.group-brand strong{font-size:16px}.group-brand small{font-size:7px}.group-brand::before{right:12px;height:63px}.group-brand::after{width:72px}}
.group-panel{bottom:auto;max-height:calc(100% - 26%);overflow-y:auto}
.group-region-list{max-height:min(42vh,360px)}
.group-region-row.is-empty{padding-top:10px;padding-bottom:10px;opacity:.68}
.group-region-row.is-empty:hover,.group-region-row.is-empty.is-map-hovered{opacity:1}
.group-region-row.is-empty .group-region-copy{gap:3px}
.group-region-row.is-empty .group-region-count>b{font-size:16px}
.group-region-more{display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:8px;padding:11px 7px;border:1px solid rgba(150,167,210,.2);border-radius:5px;background:rgba(102,118,162,.09);color:#9eacc9;font:500 11px/1.2 var(--group-font);cursor:pointer;text-align:left;transition:background .2s ease,border-color .2s ease,color .2s ease}
.group-region-more:hover{border-color:rgba(163,185,240,.42);background:rgba(112,134,198,.15);color:#d2dcf5}
.group-region-more span{font-size:14px;color:#a5b9eb}
.group-map-detail{top:calc(30px - min(18vh,150px));bottom:calc(35px + min(18vh,150px))}
.group-map-national{top:-15px;bottom:80px}
.group-portal{background:radial-gradient(ellipse 62% 58% at 48% 44%,rgba(206,204,193,.085),transparent 72%),linear-gradient(140deg,#36373a 0%,#303134 52%,#292a2c 100%);color:#e5e3de}
.group-vignette{background:linear-gradient(90deg,rgba(21,21,22,.12),transparent 24%,transparent 70%,rgba(19,19,20,.18)),linear-gradient(0deg,rgba(17,17,18,.2),transparent 31%,transparent 78%,rgba(20,20,21,.12))}
.group-breadcrumb{border-color:rgba(215,213,204,.11);background:rgba(202,200,192,.065);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.group-brand{border-color:rgba(210,208,199,.085);background:linear-gradient(108deg,rgba(218,216,208,.11),rgba(218,216,208,.045) 70%,transparent);box-shadow:inset 0 1px 0 rgba(255,255,255,.045),0 10px 28px rgba(0,0,0,.035);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.group-brand::before{background:linear-gradient(180deg,rgba(204,203,194,.04),rgba(204,203,194,.28) 72%,rgba(204,203,194,.1));box-shadow:0 0 8px rgba(204,203,194,.07)}
.group-brand::after{background:linear-gradient(90deg,rgba(210,208,199,.28),rgba(210,208,199,.12),transparent);box-shadow:0 0 9px rgba(210,208,199,.08)}
.group-user{border-color:rgba(214,212,203,.12);background:linear-gradient(115deg,rgba(218,216,208,.13),rgba(218,216,208,.055));color:#e1dfda;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}
.group-user:hover{border-color:rgba(222,220,211,.25);background:rgba(218,216,208,.16)}
.group-user-icon{border-color:rgba(214,212,203,.2);background:rgba(205,203,195,.075);color:#dad8d1}
.group-location-action{border-color:rgba(215,213,204,.17);background:rgba(204,202,194,.07);color:#d5d3cc}
.group-location-action:hover{border-color:rgba(222,220,211,.32);background:rgba(204,202,194,.12)}
.group-panel{border-color:rgba(214,212,203,.105);background:linear-gradient(135deg,rgba(218,216,208,.105),rgba(218,216,208,.045) 58%,rgba(218,216,208,.018));box-shadow:0 18px 42px rgba(0,0,0,.075),inset 0 1px 0 rgba(255,255,255,.055);backdrop-filter:blur(20px) saturate(.76);-webkit-backdrop-filter:blur(20px) saturate(.76)}
.group-panel::before{background:linear-gradient(90deg,rgba(215,213,204,.42),transparent)}
.group-dock{border-color:rgba(214,212,203,.1);background:linear-gradient(112deg,rgba(218,216,208,.095),rgba(218,216,208,.045) 58%,rgba(218,216,208,.02));box-shadow:0 16px 38px rgba(0,0,0,.065),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(20px) saturate(.76);-webkit-backdrop-filter:blur(20px) saturate(.76)}
.group-dock section+section{border-left-color:rgba(216,214,204,.11)}
.group-dock::before{background:linear-gradient(90deg,rgba(215,213,204,.32),rgba(188,190,181,.14),transparent);box-shadow:0 0 9px rgba(215,213,204,.07)}
.group-map-label{border-color:rgba(218,216,207,.2);background:linear-gradient(115deg,rgba(55,55,57,.88),rgba(43,43,45,.78));color:#e7e5df}
.group-map-label.is-selected{background:linear-gradient(110deg,rgba(83,82,88,.94),rgba(54,54,57,.9))}
.group-map-controls button{border-color:rgba(217,215,205,.2);background:rgba(57,57,59,.8);color:#dedcd5;backdrop-filter:blur(12px)}
.group-stage-loading{border-color:rgba(215,213,204,.18);background:rgba(54,54,56,.82);color:#d5d3cb;backdrop-filter:blur(14px)}
.group-region-more{border-color:rgba(215,213,204,.16);background:rgba(87,87,87,.22)}
.group-account-menu{position:absolute;z-index:12;right:3%;top:calc(4% + 51px);width:min(318px,calc(100vw - 32px));max-height:min(76vh,620px);overflow:auto;box-sizing:border-box;padding:17px;border:1px solid rgba(224,222,214,.18);border-radius:16px;background:linear-gradient(148deg,rgba(57,57,60,.97),rgba(38,39,41,.98) 76%);box-shadow:0 20px 55px rgba(0,0,0,.23),inset 0 1px 0 rgba(255,255,255,.075);backdrop-filter:blur(24px) saturate(.82);-webkit-backdrop-filter:blur(24px) saturate(.82);color:#e8e7e1}
.group-account-profile{display:flex;align-items:center;gap:12px;padding:2px 2px 15px;border-bottom:1px solid rgba(229,226,218,.11)}.group-account-profile>span:last-child{display:grid;gap:5px;min-width:0}.group-account-profile strong{overflow:hidden;color:#f0efeb;font-size:14px;font-weight:570;text-overflow:ellipsis;white-space:nowrap}.group-account-profile small{overflow:hidden;color:#aaa9a5;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.group-account-avatar{display:grid;place-items:center;flex:0 0 auto;width:44px;height:44px;border:1px solid rgba(224,222,214,.13);border-radius:50%;background:rgba(222,220,213,.085);color:#d5d4cf;font-size:15px}.group-account-avatar svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.35;stroke-linecap:round}.group-account-avatar.small{width:31px;height:31px;font-size:12px}
.group-account-list{display:grid;gap:5px;padding:12px 0 6px}.group-account-list>small{padding:0 4px 3px;color:#aaa9a4;font-size:9px;letter-spacing:.06em}.group-account-list>button{display:flex;align-items:center;gap:9px;width:100%;margin:0;padding:8px 7px;border:1px solid transparent;border-radius:9px;background:transparent;color:#e8e7e1;text-align:left;cursor:pointer}.group-account-list>button:hover:not(:disabled){border-color:rgba(224,222,214,.13);background:rgba(229,226,218,.075)}.group-account-list>button.active{border-color:rgba(224,222,214,.11);background:rgba(229,226,218,.055)}.group-account-list>button>span:nth-child(2){display:grid;gap:3px;flex:1;min-width:0}.group-account-list>button strong{overflow:hidden;font-size:10px;font-weight:530;text-overflow:ellipsis;white-space:nowrap}.group-account-list>button small{overflow:hidden;color:#aaa9a4;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.group-account-list>button i{color:#b9c9bf;font-size:9px;font-style:normal;white-space:nowrap}
.group-account-action{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin:7px 0 0;padding:10px 11px;border:1px solid rgba(224,222,214,.13);border-radius:9px;background:rgba(225,223,215,.065);color:#e8e7e1;font:500 11px/1.25 var(--hud-font-text,'Inter','Noto Sans SC',sans-serif);text-align:left;cursor:pointer;transition:background .16s ease,border-color .16s ease}.group-account-action:hover:not(:disabled){border-color:rgba(224,222,214,.26);background:rgba(225,223,215,.105)}.group-account-action>span{color:#b8c8bd;font-size:14px}.group-account-menu .group-account-primary{border-color:rgba(205,213,204,.27);background:linear-gradient(110deg,rgba(205,213,204,.17),rgba(205,213,204,.09));color:#f0efea}.group-account-menu .group-account-primary:hover:not(:disabled){border-color:rgba(215,223,214,.43);background:rgba(205,213,204,.19)}.group-account-form{display:grid;gap:9px;margin:12px 0 4px;padding:12px;border:1px solid rgba(224,222,214,.11);border-radius:10px;background:rgba(16,16,18,.12)}.group-account-form label{display:grid;gap:5px;color:#bcbab4;font-size:9px}.group-account-form input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid rgba(224,222,214,.19);border-radius:7px;background:rgba(17,17,19,.28);color:#f0efeb;font:inherit;font-size:11px}.group-account-form input:focus{border-color:rgba(205,213,204,.48);outline:0;box-shadow:0 0 0 2px rgba(205,213,204,.08)}.group-account-form .group-account-primary{margin-top:2px;text-align:left}.group-account-form .group-account-primary>span{margin-left:auto}
.group-account-menu .group-account-exit{margin-top:12px;color:#ddc5bd}.group-account-menu button:disabled{opacity:.56;cursor:wait}.group-account-message{margin:11px 2px 0;color:#b8d4c1;font-size:10px;line-height:1.5}.group-account-message.error{color:#ecaaa1}
.group-portal{background:radial-gradient(ellipse 48% 43% at 47% 43%,rgba(208,204,194,.07),transparent 76%),linear-gradient(160deg,color-mix(in srgb,var(--group-background) 88%,#454347),var(--group-background) 65%,color-mix(in srgb,var(--group-background) 82%,#171719));color:var(--group-text)}
.group-panel,.group-dock{border-color:rgba(226,222,212,.07);background:linear-gradient(135deg,color-mix(in srgb,var(--group-surface) 64%,transparent),color-mix(in srgb,var(--group-surface) 28%,transparent) 62%,color-mix(in srgb,var(--group-background) 42%,transparent));box-shadow:0 22px 55px rgba(0,0,0,.08),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(18px) saturate(.84)}
.group-panel::before,.group-dock::before{background:linear-gradient(90deg,color-mix(in srgb,var(--group-accent) 54%,transparent),transparent);box-shadow:none}.group-brand{background:linear-gradient(100deg,color-mix(in srgb,var(--group-surface) 51%,transparent),transparent);border-color:rgba(226,222,212,.075)}.group-brand i{background:linear-gradient(145deg,var(--group-accent),color-mix(in srgb,var(--group-accent) 56%,#63536d));box-shadow:0 0 18px color-mix(in srgb,var(--group-accent) 25%,transparent)}.group-brand strong,.group-panel h1{color:var(--group-text)}.group-user{background:color-mix(in srgb,var(--group-surface) 42%,transparent);border-color:rgba(226,222,212,.1)}.group-user:hover{background:color-mix(in srgb,var(--group-surface) 63%,transparent)}.group-facts strong{color:var(--group-text);text-shadow:none}.group-map-label{border-color:color-mix(in srgb,var(--group-accent) 28%,transparent);background:color-mix(in srgb,var(--group-surface) 88%,transparent)}.group-region-row.is-map-hovered,.group-region-row:hover{border-color:color-mix(in srgb,var(--group-accent) 32%,transparent)}
.group-portal.no-panel .group-map{right:3%}.group-portal.no-facts .group-map{left:3%}.group-portal.no-dock .group-map{bottom:3%}
.group-portal{background:radial-gradient(ellipse 56% 64% at 43% 43%,color-mix(in srgb,var(--group-surface) 36%,transparent),transparent 74%),linear-gradient(145deg,color-mix(in srgb,var(--group-background) 89%,#5c5855),var(--group-background) 64%,color-mix(in srgb,var(--group-background) 85%,#19191b))}
.group-vignette{background:linear-gradient(90deg,rgba(18,18,20,.18),transparent 20%,transparent 66%,rgba(18,18,20,.16)),linear-gradient(0deg,rgba(16,16,18,.13),transparent 28%,transparent 78%,rgba(17,17,19,.08))}
.group-panel{border:0;border-left:1px solid color-mix(in srgb,var(--group-accent) 22%,transparent);border-radius:0 8px 8px 0;background:linear-gradient(90deg,color-mix(in srgb,var(--group-surface) 43%,transparent),color-mix(in srgb,var(--group-surface) 16%,transparent));box-shadow:none;backdrop-filter:blur(14px) saturate(.9);-webkit-backdrop-filter:blur(14px) saturate(.9)}
.group-panel::before{left:0;width:82px;height:1px;background:linear-gradient(90deg,var(--group-accent),transparent);opacity:.55}
.group-panel>small,.group-dock>section>small{color:#aaa9b1;letter-spacing:.2em}
.group-panel h1{font-size:21px;font-weight:570;letter-spacing:.01em}
.group-panel-stage>p,.group-site>p{color:#b9b9bb}
.group-region-copy>strong{color:var(--group-text);font-size:12px;font-weight:550}
.group-region-copy>small,.group-region-row small,.group-region-count>small{color:#a6a5af!important}
.group-region-count>b{color:var(--group-text)}
.group-region-list .group-region-row{border-bottom-color:rgba(220,216,210,.13)}
.group-region-list .group-region-row:hover,.group-region-list .group-region-row.is-map-hovered{background:linear-gradient(90deg,color-mix(in srgb,var(--group-accent) 12%,transparent),transparent)}
.group-dock{border:0;border-top:1px solid rgba(223,220,213,.14);border-radius:0 0 8px 8px;background:linear-gradient(180deg,color-mix(in srgb,var(--group-surface) 37%,transparent),color-mix(in srgb,var(--group-background) 15%,transparent));box-shadow:none;backdrop-filter:blur(15px) saturate(.9);-webkit-backdrop-filter:blur(15px) saturate(.9)}
.group-dock::before{left:0;width:110px;background:linear-gradient(90deg,var(--group-accent),transparent);opacity:.52}
.group-dock section+section{border-left-color:rgba(221,218,210,.11)}
.group-dock h2{color:var(--group-text);font-size:13px}
.group-dock-number strong,.group-dock-hierarchy dd,.group-dock-location-copy>strong{color:var(--group-text)}
.group-dock-number span,.group-dock p,.group-dock-location-copy>p,.group-dock-legend>span{color:#acaaad}
.group-dock-location-ring{background:conic-gradient(from -90deg,var(--group-accent) 0 var(--coverage),rgba(193,192,199,.16) var(--coverage) 100%)}
.group-dock-location-ring::before{background:var(--group-background)}
.group-map-label{color:var(--group-text);box-shadow:0 8px 18px rgba(10,10,12,.14),inset 0 1px 0 rgba(255,255,255,.07)}
.group-map-label small{color:#b5b7c4}
.group-facts{border-left-color:color-mix(in srgb,var(--group-accent) 36%,transparent)}
.group-facts>small,.group-facts>span{color:#b5b4b8}
.group-brand-image{width:36px;height:36px;flex:none;object-fit:contain}
.group-map-controls button{border-color:rgba(224,222,215,.23);background:color-mix(in srgb,var(--group-surface) 68%,transparent)}
</style>
