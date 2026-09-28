<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { adminFetch } from '../runtime/adminSession.js'
import { createDashboardDataStore } from '../runtime/DataStore.js'
import { createNativeViewNavigator } from '../runtime/nativeViewNavigation.js'
import { isNativeUnitySurface, requestNativeSceneSurface } from '../runtime/nativeSurfaceBridge.js'
import { createGroupNavigationCrumbs } from '../runtime/groupHierarchyPath.js'
import { DEFAULT_STREET_IMAGE, normalizeSiteSceneConfig, orderedSiteWorkshops } from '../runtime/siteSceneConfig.js'
import { overviewEntryStatus, streetEntryStatus } from '../runtime/factoryNavigationReadiness.js'
import GroupHierarchyCapsule from './GroupHierarchyCapsule.vue'
import AdminWindowChrome from './admin/components/AdminWindowChrome.vue'
import MapSurfaceWidgets from './MapSurfaceWidgets.vue'

const route=useRoute(),router=useRouter(),host=ref(null),factory=ref(null),config=ref(null),loading=ref(true),busy=ref(false),error=ref(''),page=ref(0)
const hoveredBuilding=ref(null),sceneExpanded=ref(false)
const factoryId=computed(()=>String(route.query.factoryId || ''))
const stage=computed(()=>route.query.stage==='factory'?'factory':'street')
const adminSurface=computed(()=>isNativeUnitySurface(route.query.embedded,window.chrome?.webview) && route.query.surface==='admin')
const siteScene=computed(()=>normalizeSiteSceneConfig(config.value?.settings?.site_scene_config))
const streetImage=computed(()=>siteScene.value.streetImageUrl || DEFAULT_STREET_IMAGE)
const workshops=computed(()=>orderedSiteWorkshops(config.value?.workshops || [],siteScene.value))
const pageCount=computed(()=>Math.max(1,Math.ceil(workshops.value.length/6)))
const visibleWorkshops=computed(()=>workshops.value.slice(page.value*6,page.value*6+6))
const lineCount=computed(()=>workshops.value.reduce((count,workshop)=>count+(workshop.lines?.length || 0),0))
const overviewReadiness=computed(()=>overviewEntryStatus(config.value?.workshops))
const crumbs=computed(()=>{
  const mapLevel=String(route.query.level || 'district')
  const map=createGroupNavigationCrumbs({query:route.query,level:mapLevel,currentLabel:String(route.query[`${mapLevel}Name`] || route.query.code || '地图')})
  return [...map,{key:'street',label:'街道',level:'street'},...(stage.value==='factory'?[{key:'factory',label:'工厂',level:'factory'}]:[])]
})
const data=createDashboardDataStore()
const navigator=createNativeViewNavigator(async target=>{
  const response=await adminFetch(`${API_BASE}/native-preview/navigate`,{method:'POST',headers:{'Content-Type':'application/json','X-Factory-ID':factoryId.value},body:JSON.stringify({action:'view',viewId:target.viewId,focus:{mode:'factory'}})})
  const body=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(body.error || '车间视角请求失败')
  return body
},25000)

let renderer,scene,camera,controls,observer,frame=0,root,disposed=false,down=null,renderDirty=true
const hitMeshes=[]
const hoverBases=new Map(),raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2()
function scheduleRender(){
  if(disposed || frame || !renderer || !scene || !camera || !controls)return
  frame=requestAnimationFrame(renderFrame)
}
function renderFrame(){
  frame=0
  if(disposed)return
  const moved=controls.update()
  if(moved || renderDirty){renderer.render(scene,camera);renderDirty=false}
  if(moved)scheduleRender()
}
function onControlsChange(){renderDirty=true;scheduleRender()}
const material=(color,{metalness=.16,roughness=.78,emissive=0,intensity=0}={})=>new THREE.MeshStandardMaterial({color,metalness,roughness,emissive,emissiveIntensity:intensity})
const wall=material(0x545d73),roof=material(0x6c7490,{metalness:.3,roughness:.7}),glass=material(0x4f668e,{metalness:.28,roughness:.42,emissive:0x273e74,intensity:.22})
const dark=material(0x252c3d),ground=material(0x343b50),trim=material(0x707b99,{metalness:.38}),shadow=material(0x34394d)
const warm=material(0x7693bf,{emissive:0x527cd0,intensity:.6}),gate=material(0x333a50,{metalness:.38}),fence=material(0x59637c,{metalness:.4})
const hoverLight=new THREE.MeshBasicMaterial({color:0x9f9dff,transparent:true,opacity:.85,depthWrite:false,toneMapped:false})
const hoverFill=new THREE.MeshBasicMaterial({color:0x9f9dff,transparent:true,opacity:.2,depthWrite:false,side:THREE.DoubleSide,toneMapped:false})
const sharedMaterials=new Set([wall,roof,glass,dark,ground,trim,shadow,warm,gate,fence,hoverLight,hoverFill])
function hoverBase(parent,width,depth,id){
  if(!id)return
  const base=new THREE.Group();base.visible=false;base.position.y=.155;parent.add(base)
  const w=width+.54,d=depth+.54,t=.13
  const wash=new THREE.Mesh(new THREE.PlaneGeometry(w+.28,d+.28),hoverFill)
  wash.rotation.x=-Math.PI/2;wash.position.y=-.14;wash.renderOrder=3;base.add(wash)
  for(const [size,position] of [ [[w,.035,t],[0,0,d/2]],[[w,.035,t],[0,0,-d/2]],[[t,.035,d],[w/2,0,0]],[[t,.035,d],[-w/2,0,0]] ]){
    const edge=new THREE.Mesh(new THREE.BoxGeometry(...size),hoverLight);edge.renderOrder=4;base.add(edge)
  }
  if(!hoverBases.has(id))hoverBases.set(id,[])
  hoverBases.get(id).push(base)
}
function clearHover(){
  const previous=hoveredBuilding.value?.id
  if(previous)for(const base of hoverBases.get(previous)||[])base.visible=false
  hoveredBuilding.value=null;renderDirty=true;scheduleRender()
}
function buildingDetails(id){
  if(stage.value==='street')return {title:factory.value?.name||'工厂园区',type:'工厂园区',workshops:workshops.value.length,lines:lineCount.value}
  const workshop=workshops.value.find(item=>String(item.id)===id)
  if(workshop)return {title:workshop.name||'车间建筑',type:'生产车间',workshops:1,lines:workshop.lines?.length||0}
  return {title:id==='office'?'行政办公楼':id==='warehouse'?'仓储物流楼':'能源与公辅设施',type:'园区配套',workshops:null,lines:null}
}
function onBuildingMove(event){
  if(!host.value || (!siteScene.value.showBuildingTooltip && !siteScene.value.showHoverGlow))return
  const rect=renderer.domElement.getBoundingClientRect()
  pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1)
  raycaster.setFromCamera(pointer,camera)
  const id=String(raycaster.intersectObjects(hitMeshes,false)[0]?.object.userData.workshopId||'')
  if(!id){if(hoveredBuilding.value)clearHover();return}
  const previous=hoveredBuilding.value?.id
  if(previous!==id){
    if(previous)for(const base of hoverBases.get(previous)||[])base.visible=false
    if(siteScene.value.showHoverGlow)for(const base of hoverBases.get(id)||[])base.visible=true
    renderDirty=true;scheduleRender()
  }
  const detail=buildingDetails(id)
  hoveredBuilding.value={id,...detail,x:Math.min(rect.width-220,Math.max(12,event.clientX-rect.left+18)),y:Math.min(rect.height-118,Math.max(12,event.clientY-rect.top-112))}
}
function resetView(){controls.reset();renderDirty=true;scheduleRender()}
function zoomView(direction){camera.zoom=Math.max(controls.minZoom,Math.min(controls.maxZoom,camera.zoom*(direction>0?1.2:1/1.2)));camera.updateProjectionMatrix();controls.update();renderDirty=true;scheduleRender()}
function industrialTexture(lines='vertical'){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256
  const ctx=canvas.getContext('2d');ctx.fillStyle='#ebebeb';ctx.fillRect(0,0,256,256)
  let seed=8179;for(let i=0;i<2800;i++){
    seed=(seed*1664525+1013904223)>>>0;const x=seed%256
    seed=(seed*1664525+1013904223)>>>0;const y=seed%256
    ctx.fillStyle=i%3===0?'#aeb1b426':'#ffffff17';ctx.fillRect(x,y,1,1)
  }
  ctx.strokeStyle='#737b8426';ctx.lineWidth=1
  for(let i=0;i<=256;i+=32){ctx.beginPath();if(lines==='vertical'){ctx.moveTo(i,0);ctx.lineTo(i,256)}else{ctx.moveTo(0,i);ctx.lineTo(256,i)}ctx.stroke()}
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=4
  return texture
}
const wallTexture=industrialTexture(),roofTexture=industrialTexture('horizontal');wall.map=wallTexture;roof.map=roofTexture
function contactShadow(parent,width,depth){
  const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128
  const ctx=canvas.getContext('2d'),gradient=ctx.createRadialGradient(64,64,5,64,64,62)
  gradient.addColorStop(0,'rgba(0,0,0,.55)');gradient.addColorStop(.55,'rgba(0,0,0,.22)');gradient.addColorStop(1,'rgba(0,0,0,0)')
  ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128)
  const texture=new THREE.CanvasTexture(canvas),mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,depth),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false}))
  mesh.rotation.x=-Math.PI/2;mesh.position.y=-.018;parent.add(mesh)
}
function disposeRoot(){root?.traverse(node=>{node.geometry?.dispose();if(node.material && !sharedMaterials.has(node.material)){node.material.map?.dispose();node.material.dispose()}})}
function box(parent,size,position,mat,workshopId=''){
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),mat)
  mesh.position.set(...position)
  mesh.castShadow=true;mesh.receiveShadow=true
  if(workshopId){mesh.userData.workshopId=workshopId;hitMeshes.push(mesh)}
  parent.add(mesh)
  return mesh
}
function siteLot(parent,width,depth,siteTarget=''){
  box(parent,[width,.22,depth],[0,-.17,0],ground,siteTarget)
  for(const x of [-width/2+.11,width/2-.11])box(parent,[.16,.08,depth],[x,-.01,0],trim)
  for(const z of [-depth/2+.11,depth/2-.11])box(parent,[width,.08,.16],[0,-.01,z],trim)
  for(const x of [-width/2+1.2,width/2-1.2])for(const z of [-depth/2+1,depth/2-1]){
    box(parent,[.08,.32,.08],[x,.16,z],fence)
    box(parent,[.12,.045,.12],[x,.34,z],warm)
  }
  for(let i=-1;i<=1;i++)box(parent,[.055,.012,.72],[i*.85,-.052,depth/2-.85],trim)
}
function building(parent,{x=0,z=0,width=6,depth=4,height=2.2,workshopId='',accent=false}={}){
  const group=new THREE.Group();group.position.set(x,0,z);parent.add(group)
  hoverBase(group,width,depth,workshopId)
  box(group,[width+.18,.16,depth+.18],[0,.05,0],dark,workshopId)
  box(group,[width,height,depth],[0,height/2+.14,0],wall,workshopId)
  box(group,[width+.28,.18,depth+.26],[0,height+.16,0],roof,workshopId)
  for(let i=1;i<9;i++)box(group,[.024,.026,depth+.08],[-width/2+i*width/9,height+.27,0],trim)
  for(const side of [-1,1]){
    box(group,[width*.3,.09,depth*.14],[side*width*.22,height+.29,-depth*.08],trim)
    box(group,[width*.27,.018,depth*.095],[side*width*.22,height+.345,-depth*.08],glass)
  }
  for(let i=-1;i<=1;i++){
    const px=i*width*.28
    box(group,[width*.21,height*.52,.052],[px,height*.31,depth/2+.042],gate)
    for(let stripe=0;stripe<4;stripe++)box(group,[width*.21,.018,.059],[px,height*.15+stripe*height*.12,depth/2+.075],trim)
    box(group,[width*.23,.09,.37],[px,.08,depth/2+.24],shadow)
    box(group,[.12,.065,.1],[px,height*.72,depth/2+.095],warm)
  }
  for(const side of [-1,1]){
    box(group,[.09,height+.12,.13],[side*width*.48,height*.51,depth/2+.075],trim)
    for(let i=-1;i<=1;i++){
      box(group,[.07,.37,depth*.16],[side*(width/2+.045),height*.61,i*depth*.24],dark)
      box(group,[.075,.27,depth*.12],[side*(width/2+.09),height*.61,i*depth*.24],glass)
    }
  }
  for(const [px,pz] of [[-width*.27,-depth*.28],[width*.25,depth*.18]]){
    box(group,[.76,.43,.65],[px,height+.49,pz],fence)
    for(let i=-1;i<=1;i++)box(group,[.65,.035,.025],[px,height+.48,pz+i*.16],trim)
  }
  for(const px of [-width*.38,width*.37]){
    box(group,[.16,.7,.16],[px,height+.6,-depth*.26],fence)
    box(group,[.29,.07,.29],[px,height+.96,-depth*.26],roof)
  }
  if(accent){
    const beacon=new THREE.Mesh(new THREE.ConeGeometry(.25,.48,4),new THREE.MeshBasicMaterial({color:new THREE.Color(siteScene.value.accent),transparent:true,opacity:.9}))
    beacon.rotation.y=Math.PI/4;beacon.position.set(0,height+2.2,0);group.add(beacon)
    const stem=box(group,[.02,1.45,.02],[0,height+1.13,0],new THREE.MeshBasicMaterial({color:new THREE.Color(siteScene.value.accent)}))
    stem.userData.workshopId=workshopId
  }
  return group
}
function officeBlock(parent,{x=0,z=0,workshopId=''}={}){
  const group=new THREE.Group();group.position.set(x,0,z);parent.add(group)
  hoverBase(group,2.05,1.8,workshopId)
  box(group,[2.05,2.65,1.8],[0,1.325,0],wall,workshopId)
  box(group,[2.18,.14,1.94],[0,2.72,0],roof,workshopId)
  for(let floor=0;floor<3;floor++)for(const column of [-.55,0,.55]){
    box(group,[.38,.33,.035],[column,.57+floor*.69,.925],glass)
    box(group,[.025,.38,.06],[column-.22,.57+floor*.69,.94],trim)
  }
  box(group,[.48,.72,.05],[0,.37,.95],dark)
  for(let floor=0;floor<3;floor++)box(group,[.055,.35,.47],[1.04,.57+floor*.69,0],glass)
  return group
}
function utilityBlock(parent,{x=0,z=0,workshopId=''}={}){
  const group=new THREE.Group();group.position.set(x,0,z);parent.add(group)
  hoverBase(group,1.55,1.55,workshopId)
  box(group,[1.55,1.15,1.55],[0,.58,0],wall,workshopId)
  box(group,[1.7,.14,1.68],[0,1.21,0],roof,workshopId)
  for(const offset of [-.38,.38]){
    const tank=new THREE.Mesh(new THREE.CylinderGeometry(.24,.24,.75,10),fence)
    tank.position.set(offset,1.68,-.13);tank.castShadow=true;group.add(tank)
    box(group,[.54,.07,.54],[offset,2.08,-.13],trim)
  }
  box(group,[.55,.59,.05],[0,.49,.81],gate)
  return group
}
function rebuild(){
  if(!scene)return
  if(hoveredBuilding.value)clearHover()
  if(root){scene.remove(root);disposeRoot()}
  root=new THREE.Group();scene.add(root);hitMeshes.length=0;hoverBases.clear();hoverLight.color.set(siteScene.value.accent);hoverFill.color.set(siteScene.value.accent)
  if(stage.value==='street'){
    contactShadow(root,9.6,6.7)
    const campus=new THREE.Group();campus.scale.setScalar(.72);root.add(campus)
    building(campus,{x:-1,z:1,width:5.1,depth:3.15,height:1.65,workshopId:'street_production',accent:true})
    officeBlock(campus,{x:-3.5,z:-2.3,workshopId:'street_office'})
    building(campus,{x:1.4,z:-2.35,width:3.45,depth:2.15,height:1.18,workshopId:'street_warehouse'})
    if(workshops.value.length>1)building(campus,{x:3.1,z:1.45,width:2.75,depth:2.2,height:1.28,workshopId:'street_annex'})
    else utilityBlock(campus,{x:3.35,z:1.65,workshopId:'street_utility'})
    camera.zoom=1
    camera.position.set(13,13,13);controls.target.set(0,1,0)
  }else{
    const rows=visibleWorkshops.value
    const columns=Math.min(3,Math.max(1,rows.length))
    const single=rows.length===1
    siteLot(root,single?15:Math.max(12,columns*5.3+2),single?10:rows.length>3?12:8.8)
    rows.forEach((workshop,index)=>building(root,{x:single?-1:(index%columns-(columns-1)/2)*5.2,z:single?1.3:(Math.floor(index/columns)-(rows.length>columns?.5:0))*5.5,width:single?6.5:4.15,depth:single?4:3.15,height:single?2.4:1.85,workshopId:String(workshop.id),accent:true}))
    if(single){officeBlock(root,{x:-5.1,z:-1.8,workshopId:'office'});building(root,{x:3.65,z:-2.05,width:4.55,depth:2.4,height:1.5,workshopId:'warehouse'});utilityBlock(root,{x:5.3,z:2.3,workshopId:'utility'})}
    camera.zoom=single?1.28:1
    camera.position.set(15,15,15);controls.target.set(0,.7,0)
  }
  camera.updateProjectionMatrix()
  controls.update()
  controls.saveState()
  renderDirty=true
  scheduleRender()
}
function reportRegions(){window.chrome?.webview?.postMessage({type:'overlay_regions',viewport:{width:innerWidth,height:innerHeight},regions:[{x:0,y:0,width:innerWidth,height:innerHeight}]})}
function onHostMessage(event){if(event.data?.type==='overlay_host_state')reportRegions()}
function mapQuery(){const query={...route.query};delete query.factoryId;delete query.stage;return query}
function navigateCrumb(crumb){
  if(crumb.level==='street'){router.push({path:'/site',query:{...route.query,stage:'street'}});return}
  const query=mapQuery(),order=['country','province','city','district'],index=order.indexOf(crumb.level)
  if(index<0){for(const key of ['level','code',...order,...order.map(item=>`${item}Name`)])delete query[key]}
  else{for(const key of order.slice(index+1)){delete query[key];delete query[`${key}Name`]};query.level=crumb.level;query.code=crumb.code}
  router.push({path:'/group',query})
}
function navigateDesignedSurface(viewId){
  if(viewId==='site_street'){if(stage.value!=='street')router.push({path:'/site',query:{...route.query,stage:'street'}});return}
  if(viewId==='site_factory'){enterFactory();return}
  const targetLevel=String(viewId || '').replace(/^map_/,'')
  const ancestor=crumbs.value.find(item=>item.level===targetLevel)
  if(ancestor)navigateCrumb(ancestor)
}
function enterFactory(){
  if(stage.value!=='street')return
  if(!workshops.value.length){error.value='尚未配置车间，请先在后台添加车间。';return}
  error.value=''
  router.push({path:'/site',query:{...route.query,stage:'factory'}})
}
function handleSiteEscape(event){
  if(event.key!=='Escape' || event.defaultPrevented || event.isComposing)return
  if(event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]'))return
  event.preventDefault()
  if(stage.value==='factory')router.push({path:'/site',query:{...route.query,stage:'street'}})
  else router.push({path:'/group',query:mapQuery()})
}
async function enterFactoryOverview(){
  if(busy.value)return
  if(!overviewReadiness.value.allowed){error.value=overviewReadiness.value.message;return}
  busy.value=true;error.value=''
  try{
    const response=await adminFetch(`${API_BASE}/factories/${encodeURIComponent(factoryId.value)}/activate`,{method:'POST',headers:{'Content-Type':'application/json','X-Factory-ID':factoryId.value},body:'{}'})
    const result=await response.json().catch(()=>({}))
    if(!response.ok)throw new Error(result.error || '切换运行工厂失败')
    await navigator.go({viewId:'factory_overview'})
    if(disposed)return
    if(adminSurface.value && window.chrome?.webview){requestNativeSceneSurface();await router.replace({path:'/admin',query:{embedded:'unity'}});window.chrome.webview.postMessage({type:'host_action',action:'show_dashboard'})}
    else await router.push({path:'/overlay',query:{...mapQuery(),factoryId:factoryId.value,scene:'1',fromGroup:String(route.query.code || '')}})
  }catch(cause){if(!disposed)error.value=cause.message}finally{busy.value=false}
}
function pick(event){
  if(!down || Math.hypot(event.clientX-down[0],event.clientY-down[1])>5){down=null;return}
  down=null
  const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera)
  const hit=ray.intersectObjects(hitMeshes,false)[0]
  if(!hit)return
  if(stage.value==='street')enterFactory()
  else void enterFactoryOverview()
}
async function load(){
  loading.value=true;error.value=''
  try{
    if(!factoryId.value)throw new Error('缺少工厂标识，请返回区级地图重新选择。')
    const [directory,details]=await Promise.all([
      adminFetch(`${API_BASE}/factories`,{cache:'no-store'}),
      adminFetch(`${API_BASE}/config`,{cache:'no-store',headers:{'X-Factory-ID':factoryId.value}})
    ])
    const listing=await directory.json(),payload=await details.json()
    if(!directory.ok || !details.ok)throw new Error(payload.error || listing.error || '工厂资料读取失败')
    const selected=listing.factories?.find(item=>String(item.id)===factoryId.value)
    if(!selected || !selected.enabled)throw new Error('工厂不存在或已停用')
    if(!Array.isArray(payload.workshops) || !payload.workshops.length){
      const notice=streetEntryStatus({name:selected.name,runtime:'local',workshops:0}).message
      await router.replace({path:'/group',query:{...mapQuery(),navigationNotice:notice}})
      return
    }
    factory.value=selected;config.value=payload;rebuild()
  }catch(cause){error.value=cause.message}finally{loading.value=false;window.chrome?.webview?.postMessage({type:'overlay_ready'});reportRegions()}
}
watch([stage,page],()=>rebuild())
onMounted(()=>{
  window.addEventListener('keydown',handleSiteEscape,true)
  renderer=new THREE.WebGLRenderer({alpha:true,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.04
  host.value.appendChild(renderer.domElement)
  scene=new THREE.Scene();scene.add(new THREE.HemisphereLight(0xc6d2dd,0x20252d,1.65))
  const sun=new THREE.DirectionalLight(0xe2dbcd,2.1);sun.position.set(-8,18,11);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-25;sun.shadow.camera.right=25;sun.shadow.camera.top=25;sun.shadow.camera.bottom=-25;sun.shadow.bias=-.00015;scene.add(sun)
  camera=new THREE.OrthographicCamera(-12,12,8.7,-8.7,.1,200)
  controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.enablePan=false;controls.minPolarAngle=.56;controls.maxPolarAngle=1.22;controls.minZoom=.7;controls.maxZoom=2
  controls.addEventListener('change',onControlsChange)
  observer=new ResizeObserver(()=>{if(!host.value)return;const width=host.value.clientWidth,height=host.value.clientHeight;renderer.setSize(width,height,false);const aspect=width/Math.max(height,1);camera.left=-8.7*aspect;camera.right=8.7*aspect;camera.top=8.7;camera.bottom=-8.7;camera.updateProjectionMatrix();renderDirty=true;scheduleRender()});observer.observe(host.value)
  scheduleRender()
  data.setMessageHandler(message=>{if(message.type==='dashboard_context_changed')navigator.accept(message.payload)})
  data.connect()
  window.chrome?.webview?.addEventListener('message',onHostMessage)
  void load()
})
onUnmounted(()=>{window.removeEventListener('keydown',handleSiteEscape,true);disposed=true;cancelAnimationFrame(frame);navigator.dispose();data.dispose();observer?.disconnect();controls?.removeEventListener('change',onControlsChange);controls?.dispose();disposeRoot();sharedMaterials.forEach(item=>item.dispose());wallTexture.dispose();roofTexture.dispose();renderer?.dispose();window.chrome?.webview?.removeEventListener('message',onHostMessage);window.chrome?.webview?.postMessage({type:'overlay_regions',viewport:{width:innerWidth,height:innerHeight},regions:[]})})
</script>

<template>
  <main class="factory-drilldown" :class="`stage-${stage}`" :style="{'--site-accent':siteScene.accent}">
    <AdminWindowChrome v-if="adminSurface" @before-dashboard="router.replace({path:'/group',query:mapQuery()})" @before-admin="router.push({path:'/admin',query:{embedded:'unity'}})" />
    <div class="street-backdrop" :style="{backgroundImage:`url('${streetImage}')`}" aria-hidden="true"></div>
    <div class="scene-dimmer" aria-hidden="true"></div>
    <header v-if="siteScene.showBrand" class="site-brand"><span class="site-mark" aria-hidden="true">◆</span><span><strong>{{ stage==='street'?siteScene.streetTitle:siteScene.factoryTitle }}</strong><small>FACTORY NAVIGATION</small></span></header>
    <GroupHierarchyCapsule v-if="siteScene.showBreadcrumbs" :crumbs="crumbs" @navigate="navigateCrumb" />
    <section class="site-scene" :class="{'is-expanded':sceneExpanded}" :aria-label="stage==='street'?'可旋转的工厂缩略图':'可旋转、可点击进入全厂总览的工厂园区'">
      <div ref="host" class="site-three" @pointerdown="down=[$event.clientX,$event.clientY]" @pointermove="onBuildingMove" @pointerleave="clearHover" @pointerup="pick" @pointercancel="down=null;clearHover()"></div>
      <div v-if="hoveredBuilding && siteScene.showBuildingTooltip" class="building-tooltip" :style="{left:`${hoveredBuilding.x}px`,top:`${hoveredBuilding.y}px`}" role="status"><small>{{ hoveredBuilding.type }}</small><strong>{{ hoveredBuilding.title }}</strong><div v-if="hoveredBuilding.workshops!==null"><span>车间 <b>{{ hoveredBuilding.workshops }}</b></span><span>产线 <b>{{ hoveredBuilding.lines }}</b></span></div><em>{{ stage==='street'?'点击进入工厂建筑':overviewReadiness.allowed?'点击进入全厂总览':overviewReadiness.message }}</em></div>
      <div v-if="siteScene.showViewControls" class="site-view-controls" aria-label="工厂视角控制"><button type="button" title="重置方向" aria-label="重置视角方向" @click="resetView">⌖</button><button type="button" title="放大" aria-label="放大工厂视角" @click="zoomView(1)">＋</button><button type="button" title="缩小" aria-label="缩小工厂视角" @click="zoomView(-1)">−</button><button type="button" :title="sceneExpanded?'退出放大视角':'放大视角'" :aria-label="sceneExpanded?'退出放大视角':'放大视角'" :aria-pressed="sceneExpanded" @click="sceneExpanded=!sceneExpanded">{{ sceneExpanded?'⊟':'⛶' }}</button></div>
      <button v-if="siteScene.showBeacon && !loading && !error && stage==='street'" class="site-beacon" type="button" @click="enterFactory"><i></i><span>{{ factory?.name }}<small>点击进入工厂</small></span></button>
    </section>
    <aside v-if="siteScene.showInfoPanel || error || loading || busy" class="site-info">
      <small>{{ stage==='street'?'STREET / SITE':'FACTORY / CAMPUS' }}</small>
      <h1>{{ factory?.name || '工厂视角' }}</h1>
      <p v-if="stage==='street'">{{ siteScene.streetDescription }}</p>
      <p v-else>{{ siteScene.factoryDescription }}</p>
      <p v-if="factory?.location" class="site-location">{{ [factory.location.regionName,factory.location.city,factory.location.districtName].filter((item,index,all)=>item && all.indexOf(item)===index).join(' / ') }}</p>
      <div v-if="stage==='factory'" class="workshop-list">
        <p>园区配置：{{ workshops.length }} 个车间 · {{ lineCount }} 条产线。进入全厂总览后，再选择具体车间。</p>
        <button class="site-overview-entry" :disabled="busy || !overviewReadiness.allowed" :title="overviewReadiness.message" type="button" @click="enterFactoryOverview"><span>{{ overviewReadiness.allowed ? '进入全厂总览' : '产线或设备待配置' }}</span><i v-if="overviewReadiness.allowed">↗</i></button>
        <p v-if="!overviewReadiness.allowed" class="site-error" role="status">{{ overviewReadiness.message }}</p>
        <div v-if="pageCount>1" class="site-pages"><button :disabled="page===0" @click="page--">上一组</button><span>{{ page+1 }} / {{ pageCount }}</span><button :disabled="page>=pageCount-1" @click="page++">下一组</button></div>
      </div>
      <button v-if="stage==='street'" class="site-primary" type="button" :disabled="loading" @click="enterFactory">查看工厂建筑 →</button>
      <p v-if="loading || busy" class="site-status" role="status">{{ busy?'正在等待 Unity 确认全厂总览…':'正在载入工厂资料…' }}</p>
      <p v-if="error" class="site-error" role="alert">{{ error }}</p>
    </aside>
    <footer v-if="siteScene.showFooter" class="site-footer"><span>鼠标拖动旋转视角 · 滚轮缩放</span><button type="button" @click="stage==='factory'?router.push({path:'/site',query:{...route.query,stage:'street'}}):router.push({path:'/group',query:mapQuery()})">← {{ stage==='factory'?'返回街道':'返回区级地图' }}</button></footer>
    <MapSurfaceWidgets :document="config?.platform?.document" :view-id="stage==='street'?'site_street':'site_factory'" :factory-id="factoryId" :config="config" :data-store="data" @navigate="navigateDesignedSurface" />
  </main>
</template>

<style scoped>
.factory-drilldown{position:fixed;inset:0;overflow:hidden;background:#25262b;color:#e7e8ec;font-family:Inter,'Noto Sans SC',sans-serif}.street-backdrop,.scene-dimmer{position:absolute;inset:0;pointer-events:none}.street-backdrop{background-position:center;background-size:cover;background-repeat:no-repeat;opacity:.96;transform:scale(1.015);transition:opacity .6s ease,transform 1s ease}.stage-factory .street-backdrop{opacity:.48;transform:scale(1.06)}.scene-dimmer{background:linear-gradient(90deg,rgba(20,23,34,.2),transparent 45%,rgba(16,19,30,.14) 65%,rgba(18,20,29,.76)),linear-gradient(0deg,rgba(15,18,28,.32),transparent 25%)}.site-brand{position:absolute;z-index:3;left:3%;top:3.5%;display:flex;align-items:center;gap:12px;padding:9px 20px 11px 8px;background:linear-gradient(90deg,rgba(28,31,43,.72),transparent);letter-spacing:.04em}.site-mark{color:#aebaff;font-size:27px}.site-brand strong,.site-brand small{display:block}.site-brand strong{font-size:17px}.site-brand small{margin-top:4px;color:#a9aab9;font-size:9px}.site-scene{position:absolute;inset:10% 36% 12% 2%;z-index:1}.site-three{position:absolute;inset:0;cursor:grab}.site-three:active{cursor:grabbing}.site-beacon{position:absolute;left:50%;top:16%;transform:translateX(-50%);display:grid;justify-items:center;gap:6px;border:0;background:none;color:#f1f3ff;cursor:pointer;text-shadow:0 2px 9px #0a1223}.site-beacon i{width:18px;height:18px;transform:rotate(45deg);background:linear-gradient(135deg,#396af7,#bfc8ff 55%,#bb82d4);box-shadow:0 0 18px #6883ff}.site-beacon span{padding:7px 12px;border:1px solid #9da7c277;border-radius:4px;background:#202536c7;font-size:12px}.site-beacon small{display:block;margin-top:3px;color:#abb9df;font-size:9px}.site-info{position:absolute;z-index:2;right:3%;top:19%;box-sizing:border-box;width:min(26vw,340px);max-height:68%;overflow:auto;padding:26px 23px;background:linear-gradient(135deg,rgba(36,38,48,.84),rgba(25,28,39,.7));border:1px solid #aeb6cb26;box-shadow:0 18px 45px #070a1455;backdrop-filter:blur(14px)}.site-info>small{color:#abb6d0;letter-spacing:.25em;font-size:9px}.site-info h1{font-size:22px;line-height:1.45;margin:13px 0}.site-info p{font-size:12px;line-height:1.8;color:#b6bbca}.site-info .site-location{color:#8f9cb9;font-size:10px}.site-primary,.workshop-list button,.site-pages button,.site-footer button{font:inherit;cursor:pointer}.site-primary{width:100%;margin-top:22px;padding:12px;border:1px solid #a2b4fa77;border-radius:5px;background:#7788ce33;color:#e9edff}.site-primary:hover,.workshop-list button:hover{background:#8b9de543}.workshop-list{display:grid;gap:8px;margin-top:20px}.workshop-list>button{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #a6b0c12e;border-radius:5px;background:#e7eaff0c;color:#e7e8ed;text-align:left}.workshop-list>button b{color:#9caff1;font-size:10px}.workshop-list>button span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.workshop-list>button i{color:#aab9e5;font-size:10px;font-style:normal}.site-pages{display:flex;justify-content:space-between;align-items:center;margin-top:6px;color:#afb9cb;font-size:10px}.site-pages button{border:0;background:none;color:#c0cef2}.site-pages button:disabled,.workshop-list button:disabled{opacity:.45;cursor:wait}.site-status{color:#c9d5f4!important}.site-error{color:#ffb8c0!important}.site-footer{position:absolute;z-index:2;left:3%;right:3%;bottom:3%;display:flex;align-items:center;justify-content:space-between;color:#aab0c0;font-size:10px;letter-spacing:.08em}.site-footer button{border:0;background:none;color:#d5defa;font-size:11px}.factory-drilldown :deep(.group-hierarchy-picker){top:11%;left:3%;max-width:52vw}.stage-factory .site-scene{inset:14% 25% 14% 8%}@media(max-width:900px){.site-info{width:31vw;right:2%;padding:16px}.site-scene{right:30%}.site-info h1{font-size:16px}.factory-drilldown :deep(.group-hierarchy-picker){max-width:60vw}}
</style>
<style scoped>
.site-mark{color:var(--site-accent)}.site-beacon i{background:var(--site-accent);box-shadow:0 0 18px var(--site-accent)}.site-primary{border-color:var(--site-accent);color:#f7f8ff}.workshop-list>button b{color:var(--site-accent)}.stage-street .site-scene{bottom:19%}
.factory-drilldown .site-scene.is-expanded{inset:0;z-index:1}.site-scene.is-expanded .site-three{inset:0}.site-view-controls{position:absolute;z-index:3;right:2%;bottom:18%;display:grid;gap:3px;padding:5px;border:1px solid #d5ddff36;border-radius:13px;background:#111827b8;box-shadow:0 12px 32px #05081475;backdrop-filter:blur(14px)}.site-view-controls button{display:grid;place-items:center;width:31px;height:31px;padding:0;border:0;border-radius:7px;background:transparent;color:#e5eaff;font:20px/1 inherit;cursor:pointer}.site-view-controls button:first-child{font-size:25px}.site-view-controls button:last-child{font-size:21px}.site-view-controls button:hover,.site-view-controls button[aria-pressed=true]{color:#fff;background:color-mix(in srgb,var(--site-accent) 28%,transparent)}.building-tooltip{position:absolute;z-index:4;box-sizing:border-box;width:208px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--site-accent) 40%,transparent);border-radius:9px;background:#151b2eea;box-shadow:0 14px 32px #080b188c,0 0 26px color-mix(in srgb,var(--site-accent) 16%,transparent);color:#e9edff;pointer-events:none;backdrop-filter:blur(14px)}.building-tooltip small,.building-tooltip strong,.building-tooltip em{display:block}.building-tooltip small{color:var(--site-accent);font-size:9px;letter-spacing:.17em}.building-tooltip strong{margin:6px 0 10px;font-size:13px;line-height:1.4}.building-tooltip>div{display:flex;gap:18px;padding:8px 0;border-top:1px solid #d8dfff20;color:#aebad4;font-size:10px}.building-tooltip b{margin-left:4px;color:#fff;font-size:13px}.building-tooltip em{margin-top:7px;color:#899dd0;font-size:9px;font-style:normal}
</style>
