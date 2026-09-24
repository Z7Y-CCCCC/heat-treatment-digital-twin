<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import WidgetRenderer from '../runtime/WidgetRenderer.vue'
import AdminWindowChrome from './admin/components/AdminWindowChrome.vue'
import { createDashboardWidgetPreset } from '../runtime/dashboardSchema.js'
import { API_BASE, getBackendOrigin } from '../runtime/backendEndpoint.js'
import { adminFetch, startAdminSessionTracking, stopAdminSessionTracking } from '../runtime/adminSession.js'
import { createDashboardDataStore } from '../runtime/DataStore.js'
import { buildFactoryScenePlan, factorySceneSignature, nativeCameraPose } from '../runtime/factorySceneConfig.js'
import { buildConfiguredFactoryScene, disposeSceneObject } from '../runtime/ConfiguredFactoryScene.js'
import { createNativeViewNavigator } from '../runtime/nativeViewNavigation.js'
import { isNativeUnitySurface, requestNativeSceneSurface } from '../runtime/nativeSurfaceBridge.js'
import { applyLiveDevicePoses,applyLiveCamera,createProjectionReceiver,projectionViewport } from '../runtime/liveSceneProjection.js'

const router=useRouter(), route=useRoute()
const sceneHost=ref(null),artboard=ref(null),scale=ref(1),surfaceAlpha=ref(.24)
const empty=ref(false),loadingReplay=ref(false),sceneError=ref(''),sceneLoading=ref(true),syncing=ref(false)
const config=ref(null),anchors=ref([]),assetErrors=ref([]),syncedAt=ref('')
const notice=ref('正在读取与 Unity 共用的现场配置')
const store=createDashboardDataStore({sceneProjection:true})
const followUnityCamera=ref(true),projectionStatus=ref('waiting'),projectionDeviceCount=ref(0)
const projectionReceiver=createProjectionReceiver()
const projectionLabel=computed(()=>({waiting:'等待 Unity 实时位姿',live:'Unity 整机位姿已同步',stale:'Unity 位姿同步已暂停',parts:'拆解动画请在原生画面查看',switching:'等待匹配的场景配置'})[projectionStatus.value])
const navigating=ref(false)
const navigationRequest=new AbortController()
const nativeNavigator=createNativeViewNavigator(async target=>{
  const response=await adminFetch(API_BASE+'/native-preview/navigate',{method:'POST',headers:{'Content-Type':'application/json'},signal:navigationRequest.signal,
    body:JSON.stringify({action:'view',viewId:target.viewId,focus:{mode:'device',deviceId:target.deviceId}})})
  const result=await response.json()
  if(!response.ok) throw new Error(result.error || '视角请求失败')
  return result
})
const deviceStatus=store.deviceStatusMap
const devices=computed(()=>Object.fromEntries(anchors.value.map(anchor=>[anchor.id,deviceStatus[anchor.id] || {name:anchor.label,online:false,quality:'bad'}])))
const metrics=computed(()=>{
  const rows=Object.values(devices.value)
  return {...store.metrics,total_devices:rows.length,online_devices:rows.filter(row=>row.online).length,running_devices:rows.filter(row=>row.online && row.running).length,alarm_devices:rows.filter(row=>row.alarm).length}
})
const events=store.events,trend=store.trendPoints
const pending=computed(()=>loadingReplay.value || !store.wsConnected.value || (anchors.value.length>0 && !Object.values(devices.value).some(row=>row.lastSeen)))
const deviceCount=computed(()=>anchors.value.length)
const dataMode=computed(()=>config.value?.settings?.data_mode==='simulation' ? '实时模拟数据' : '实时采集数据')
const factoryName=computed(()=>config.value?.settings?.factory_name || '生产运行中心')
const configuredView=computed(()=>{
  const doc=config.value?.platform?.document
  return doc?.scene?.views?.find(view=>view.id==='factory_overview') || {camera:{yaw:-39,pitch:33,distanceScale:1.08}}
})
const modules=createDashboardWidgetPreset('factory_hud_modules')
const previewWidgets=computed(()=>modules.map(widget=>({...widget,style:{...widget.style,backgroundOpacity:surfaceAlpha.value},
  content:widget.type==='hud_chart_dock' ? {...widget.content,statLabel:'平均炉温',statUnit:'°C'} : widget.content})))
const frameStyle=frame=>({left:frame.x+'px',top:frame.y+'px',width:frame.width+'px',height:frame.height+'px'})
const anchorElements=new Map()
const isEmbedded=computed(()=>isNativeUnitySurface(route.query.embedded,window.chrome?.webview))
const embeddedQuery=computed(()=>isEmbedded.value ? {embedded:'unity'} : {})
let renderer,scene,camera,controls,composer,scenePass,aoPass,outputPass,resizeObserver,animationFrame,ground,keyLight
let disposed=false,timer,pollTimer,refreshTimer,request,sceneState,signature='',cameraSignature='',refreshAgain=false
let renderNeeded=true
let renderRect=projectionViewport(1920/1080),lastPoseKey='',wasFollowing=false,hadProjection=false

function setProjectionViewport(aspect) {
  const rect=projectionViewport(aspect)
  if(Math.abs(rect.width-renderRect.width)>.1 || Math.abs(rect.height-renderRect.height)>.1){composer?.setSize(Math.round(rect.width),Math.round(rect.height));renderNeeded=true}
  renderRect=rect
  renderer?.setViewport(rect.x,1080-rect.y-rect.height,rect.width,rect.height)
}
function alignPublishedCamera(){followUnityCamera.value=false;resetCamera()}

function resetCamera() {
  if(!camera || !controls || !sceneState || sceneState.bounds.isEmpty()) return
  const pose=nativeCameraPose(sceneState.bounds,configuredView.value,1920/1080,sceneState.hasHall)
  camera.fov=pose.fov;camera.near=pose.near;camera.far=pose.far;camera.aspect=1920/1080;camera.up.set(0,1,0)
  camera.position.set(pose.position.x,pose.position.y,pose.position.z)
  controls.target.set(pose.target.x,pose.target.y,pose.target.z)
  camera.updateProjectionMatrix();controls.update();setProjectionViewport(1920/1080);lastPoseKey='';renderNeeded=true
}
function replayData() {
  clearTimeout(timer);loadingReplay.value=true
  timer=setTimeout(()=>{loadingReplay.value=false},1800)
}
function scheduleSync() {
  clearTimeout(refreshTimer)
  refreshTimer=setTimeout(()=>syncConfiguration(),150)
}
async function syncConfiguration() {
  if(disposed) return
  if(syncing.value) {refreshAgain=true;return}
  syncing.value=true
  request=new AbortController()
  try {
    const response=await adminFetch(API_BASE+'/config',{cache:'no-store',signal:request.signal})
    if(!response.ok) throw new Error('读取现场配置失败（'+response.status+'）')
    const next=await response.json()
    if(!Array.isArray(next.workshops) || !Array.isArray(next.models)) throw new Error('现场配置缺少车间或模型库')
    if(disposed) return
    const plan=buildFactoryScenePlan(next,getBackendOrigin()),nextSignature=factorySceneSignature(plan)
    if(nextSignature!==signature) {
      sceneLoading.value=!sceneState
      const nextScene=await buildConfiguredFactoryScene(plan,{cancelled:()=>disposed})
      if(!nextScene || disposed) return
      const previous=sceneState
      scene.add(nextScene.root);sceneState=nextScene
      if(previous){scene.remove(previous.root);previous.dispose()}
      signature=nextSignature;anchors.value=nextScene.anchors;assetErrors.value=nextScene.errors
      lastPoseKey=''
      const ids=new Set(plan.devices.map(row=>row.id))
      for(const id of Object.keys(deviceStatus)) if(!ids.has(id)){delete deviceStatus[id];delete store.deviceDataMap[id];store.latestDeviceDataMap.delete(id)}
      for(const row of plan.devices) {
        if(!deviceStatus[row.id]) store.registerDevice(row.config)
        else deviceStatus[row.id].name=row.name
      }
      if(!nextScene.bounds.isEmpty()) {
        const center=nextScene.bounds.getCenter(new THREE.Vector3()),size=nextScene.bounds.getSize(new THREE.Vector3()),span=Math.max(size.x,size.z,30)
        ground.position.set(center.x,nextScene.bounds.min.y-.1,center.z)
        ground.scale.setScalar(Math.max(1,span/160))
        keyLight.position.set(center.x-span*.4,center.y+span,center.z+span*.3)
        keyLight.target.position.copy(center);scene.add(keyLight.target)
        Object.assign(keyLight.shadow.camera,{left:-span,right:span,top:span,bottom:-span,far:span*4})
        keyLight.shadow.camera.updateProjectionMatrix()
      }
      cameraSignature=''
      renderNeeded=true
      renderer.shadowMap.needsUpdate=true
    }
    config.value=next
    const nextCamera=JSON.stringify(configuredView.value.camera)
    if(nextCamera!==cameraSignature){resetCamera();cameraSignature=nextCamera}
    sceneError.value=''
    syncedAt.value=new Date().toLocaleTimeString()
    notice.value='同源配置已同步 · '+plan.workshops.length+' 个车间 / '+plan.devices.length+' 台设备 · '+dataMode.value
  } catch(error) {
    if(!disposed && error.name!=='AbortError') {
      sceneError.value=error.message
      notice.value=sceneState ? '配置刷新失败，保留上一份已加载场景' : '未能读取现场配置，不显示虚构设备'
    }
  } finally {
    syncing.value=false;sceneLoading.value=false
    if(refreshAgain && !disposed){refreshAgain=false;scheduleSync()}
  }
}
async function enterDevice(id) {
  if(navigating.value) return
  const row=anchors.value.find(anchor=>anchor.id===id)
  if(!row) return
  notice.value='正在进入 '+row.label
  navigating.value=true
  try {
    await nativeNavigator.go({viewId:'device_detail',deviceId:id})
    if(disposed) return
    if(window.chrome?.webview && route.query.embedded==='unity') {
      requestNativeSceneSurface()
      // The preview runs in the admin host. Restore its chrome before exposing
      // the already-existing native dashboard, not an opaque second overlay.
      await router.replace({path:'/admin',query:{...embeddedQuery.value}})
      window.chrome.webview.postMessage({type:'host_action',action:'show_dashboard'})
    } else await router.push({path:'/overlay',query:{...embeddedQuery.value}})
  } catch(error){if(!disposed) notice.value=error.message}
  finally {navigating.value=false}
}
function onWidgetAction({event}) { if(event?.deviceId) enterDevice(event.deviceId) }
function onVisibility(){if(document.visibilityState==='visible') scheduleSync()}

onMounted(async()=>{
  startAdminSessionTracking()
  try {
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true})
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true
    renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.9
    sceneHost.value.appendChild(renderer.domElement)
    scene=new THREE.Scene()
    camera=new THREE.PerspectiveCamera(38,1920/1080,.1,2000)
    controls=new OrbitControls(camera,renderer.domElement)
    controls.enableDamping=true;controls.minDistance=2.5;controls.maxDistance=1000
    controls.minPolarAngle=8*Math.PI/180;controls.maxPolarAngle=84*Math.PI/180
    scene.add(new THREE.HemisphereLight(0xf1f2fa,0x34343f,1.3))
    keyLight=new THREE.DirectionalLight(0xffffff,2.2);keyLight.castShadow=true;keyLight.shadow.mapSize.set(2048,2048)
    keyLight.shadow.bias=-.00015;keyLight.shadow.normalBias=.12;scene.add(keyLight)
    const fill=new THREE.DirectionalLight(0xe3e4f1,.8);fill.position.set(65,30,-50);scene.add(fill)
    ground=new THREE.Mesh(new THREE.PlaneGeometry(2000,2000),new THREE.MeshStandardMaterial({color:0x242530,roughness:.94}))
    ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground)
    composer=new EffectComposer(renderer);composer.setPixelRatio(1)
    scenePass=new RenderPass(scene,camera);aoPass=new SSAOPass(scene,camera,1920,1080,16)
    aoPass.kernelRadius=5;aoPass.minDistance=.001;aoPass.maxDistance=.035;outputPass=new OutputPass()
    composer.addPass(scenePass);composer.addPass(aoPass);composer.addPass(outputPass)
    resizeObserver=new ResizeObserver(()=>{
      if(!artboard.value || disposed) return
      scale.value=Math.min(artboard.value.clientWidth/1920,artboard.value.clientHeight/1080)
      renderer.setSize(1920,1080,false);composer.setSize(Math.round(renderRect.width),Math.round(renderRect.height));setProjectionViewport(camera.aspect);renderNeeded=true
    })
    resizeObserver.observe(artboard.value)
    const projected=new THREE.Vector3()
    const render=()=>{
      if(disposed) return
      const frame=projectionReceiver.current()
      const partStage=frame?.inspectionStage && frame.inspectionStage!=='solid'
      const matchingScene=!frame?.sceneId || frame.sceneId===config.value?.platform?.activeScene?.id
      const active=!!frame && !partStage && !!sceneState && matchingScene
      projectionStatus.value=!matchingScene ? 'switching':partStage ? 'parts':active ? 'live':hadProjection ? 'stale':'waiting'
      const following=active && followUnityCamera.value
      controls.enabled=!following
      if(wasFollowing && !following){camera.up.set(0,1,0);camera.lookAt(controls.target);renderNeeded=true}
      if(active){
        const key=JSON.stringify([frame.camera,frame.devices])
        if(key!==lastPoseKey || following!==wasFollowing){
          projectionDeviceCount.value=applyLiveDevicePoses(sceneState,frame)
          if(following){applyLiveCamera(camera,controls,frame);setProjectionViewport(frame.camera.aspect)}
          lastPoseKey=key;renderNeeded=true
        }
      }
      wasFollowing=following
      const cameraChanged=following ? false:controls.update()
      if(!cameraChanged && !renderNeeded){animationFrame=requestAnimationFrame(render);return}
      renderNeeded=false;renderer.setRenderTarget(null);renderer.clear();composer.render()
      for(const anchor of anchors.value) {
        const element=anchorElements.get(anchor.id)
        if(!element) continue
        projected.copy(anchor.position).project(camera)
        element.style.transform='translate('+(renderRect.x+(projected.x+1)*renderRect.width/2)+'px,'+(renderRect.y+(1-projected.y)*renderRect.height/2)+'px) translate(-50%,-100%)'
        element.style.visibility=anchor.visible===false || Math.abs(projected.z)>1 || Math.abs(projected.x)>1 || Math.abs(projected.y)>1 ? 'hidden':'visible'
      }
      animationFrame=requestAnimationFrame(render)
    }
    render()
    store.setMessageHandler(message=>{
      if(message.type==='scene_projection' && projectionReceiver.accept(message.payload)){if(message.payload?.available)hadProjection=true}
      if(message.type==='dashboard_context_changed') nativeNavigator.accept(message.payload)
      if(['configuration_changed','device_configuration_changed','dashboard_release_changed'].includes(message.type)) scheduleSync()
    })
    store.connect()
    await syncConfiguration()
    pollTimer=setInterval(()=>{if(!syncing.value)syncConfiguration()},5000)
    document.addEventListener('visibilitychange',onVisibility)
  } catch(error) {sceneError.value='场景初始化失败：'+error.message;sceneLoading.value=false}
})
onUnmounted(()=>{
  stopAdminSessionTracking()
  disposed=true;request?.abort();navigationRequest.abort();nativeNavigator.dispose();clearTimeout(timer);clearTimeout(refreshTimer);clearInterval(pollTimer);cancelAnimationFrame(animationFrame)
  document.removeEventListener('visibilitychange',onVisibility);projectionReceiver.clear();store.dispose();resizeObserver?.disconnect();controls?.dispose()
  scenePass?.dispose();aoPass?.dispose();outputPass?.dispose();composer?.dispose();disposeSceneObject(scene);renderer?.dispose()
})
</script>

<template>
  <main class="factory-hud-review" :class="{'is-embedded':isEmbedded}">
    <AdminWindowChrome v-if="isEmbedded" @before-dashboard="router.replace({path:'/admin',query:embeddedQuery})" />
    <div class="review-tools"><span>工厂 HUD · 同源场景</span><label>背景不透明度 <input v-model.number="surfaceAlpha" aria-label="背景不透明度" type="range" min="0" max=".6" step=".01">{{ Math.round(surfaceAlpha*100) }}%</label><button @click="replayData">重播数据入场</button><button :aria-pressed="empty" @click="empty=!empty">{{ empty ? '恢复实时数据' : '检查空数据' }}</button><label class="follow-unity"><input v-model="followUnityCamera" type="checkbox" /> 跟随 Unity 镜头</label><button @click="alignPublishedCamera">对齐发布视角</button><button :disabled="syncing" @click="syncConfiguration">{{ syncing ? '同步中…' : '同步现场配置' }}</button><RouterLink :to="{path:'/admin',query:embeddedQuery}">返回设计器</RouterLink></div>
    <div ref="artboard" class="review-viewport">
      <div class="review-artboard" :style="{ transform: `translate(-50%,-50%) scale(${scale})` }">
        <div ref="sceneHost" class="review-scene" aria-label="可拖动旋转的厂房模型"></div>
        <div class="review-edge-shade"></div>
        <button v-for="anchor in anchors" :key="anchor.id" :ref="element => element ? anchorElements.set(anchor.id,element) : anchorElements.delete(anchor.id)" class="review-anchor" :class="{ alarm:devices[anchor.id]?.alarm }" :aria-label="`进入${anchor.label}`" @click="enterDevice(anchor.id)"><span>{{ anchor.missingAsset ? '?' : devices[anchor.id]?.alarm ? '!' : '⌁' }}</span><small>{{ anchor.label }}</small><i></i></button>
        <header class="review-brand"><svg viewBox="0 0 32 38" aria-hidden="true"><path fill="#afb4f5" d="m16 0 16 9-16 10L0 9Z"/><path fill="#797de1" d="M0 9l16 10v19L0 28Z"/><path fill="#505ab5" d="m16 19 16-10v19L16 38Z"/></svg><span><strong>热处理 · 生产运行中心</strong><small>HEAT TREATMENT / DIGITAL TWIN</small></span></header>
        <nav class="review-nav" aria-label="预览视角"><span class="active">数据统计</span><span>工厂总览</span><span>智慧运维</span></nav>
        <div class="review-breadcrumb">工厂总览 <i>/</i> {{ factoryName }}</div>
        <div class="review-context"><i></i> {{ dataMode }} <small>SHARED SCENE / CONFIG</small></div>
        <aside class="review-left-kpis"><small>现场配置设备</small><strong>{{ deviceCount }} <em>台</em></strong><p>{{ config?.workshops?.length || 0 }} 个车间 · {{ config?.models?.length || 0 }} 项模型资产</p><div><i></i> 后台配置 → 自动装配</div></aside>
        <div v-for="widget in previewWidgets" :key="widget.id" class="hud-widget review-widget" :class="`widget-type-${widget.type}`" :style="frameStyle(widget.frame)"><WidgetRenderer :widget="widget" :metrics="empty ? {} : metrics" :device-status-map="empty ? {} : devices" :events="empty ? [] : events" :trend-points="empty ? [] : trend" :data-ready="!pending" overlay-mode preview @action="onWidgetAction" /></div>
        <section class="review-process"><small>CONFIGURATION SYNC</small><h2>场景同步</h2><div><span>设备数量</span><strong>{{ deviceCount }} <small>台</small></strong></div><div><span>模型加载异常</span><strong>{{ assetErrors.length }} <small>项</small></strong></div><p>最近同步 {{ syncedAt || '等待配置' }} · 与 Unity 共用后台数据</p></section>
        <section class="review-description"><small>SCENE / LIVE PROJECTION</small><h2>{{ projectionLabel }}</h2><p>已同步 {{ projectionDeviceCount }} 台整机位姿 · 不包含内部拆解动画</p><div class="review-key"><i></i><span>{{ followUnityCamera && projectionStatus==='live' ? '当前跟随 Unity 镜头':'左键旋转' }}<small>{{ followUnityCamera && projectionStatus==='live' ? '取消勾选可独立调整预览':'右键平移 · 滚轮缩放' }}</small></span></div><p>运行端断开时保留最后画面并标记同步暂停。</p></section>
        <footer class="review-footer"><i></i><span>{{ notice }}</span><span>{{ assetErrors[0] || '原始材质 · Web 与 Unity 光照仍分别渲染' }}</span></footer>
        <div v-if="sceneError" class="review-error" role="alert">{{ sceneError }}</div>
        <div v-else-if="sceneLoading" class="review-loading" role="status">正在载入厂房与设备资产…</div>
        <div v-if="navigating" class="review-switching" role="status"><span></span>正在等待 Unity 目标视角就绪…</div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.factory-hud-review { position:fixed;inset:0;background:#10121a;color:#e7e9f1;font-family:var(--hud-font-text);font-synthesis:none }
.review-tools { height:48px;display:flex;align-items:center;gap:18px;padding:0 22px;background:#171a25;border-bottom:1px solid #303346;font-size:11px;white-space:nowrap;overflow:auto }.review-tools>span { margin-right:auto;color:#d0d4e4 }.review-tools label { display:flex;align-items:center;gap:8px;color:#949cb4 }.review-tools input { width:88px;accent-color:#929bea }.review-tools button,.review-tools a { border:1px solid #333a50;border-radius:5px;background:transparent;color:#aeb8d7;padding:5px 10px;font:inherit;text-decoration:none;cursor:pointer }.review-tools button:hover,.review-tools a:hover { background:#2a3048 }.review-tools button:focus-visible,.review-tools a:focus-visible { outline:2px solid #929bea }
.review-viewport { position:absolute;inset:48px 0 0;overflow:hidden }.review-artboard { position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:center;background:#191b27;overflow:hidden }.review-scene { position:absolute;inset:35px 220px 60px -170px }.review-scene :deep(canvas) { width:100%;height:100%;display:block;touch-action:none }.review-edge-shade { position:absolute;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(15,17,28,.7),transparent 21%,transparent 72%,rgba(15,17,28,.7)),linear-gradient(0deg,rgba(15,17,28,.85),transparent 35%,transparent 86%,rgba(15,17,28,.8)) }
.review-brand { position:absolute;left:35px;top:26px;display:flex;align-items:center;gap:16px;padding:10px 30px 22px 0;border-bottom:1px solid #6b73b765;border-radius:0 0 25px 0 }.review-brand svg { width:30px;height:36px }.review-brand span { display:grid;gap:8px }.review-brand strong { font-size:23px;font-weight:500;letter-spacing:.01em }.review-brand small { color:#82889d;font-size:9px;letter-spacing:.24em }.review-nav { position:absolute;top:44px;left:770px;display:flex;gap:52px;color:#6b7188;font-size:12px }.review-nav span { padding-bottom:11px }.review-nav .active { color:#d3d8eb;border-bottom:2px solid #929af0;box-shadow:0 6px 10px -7px #b0b9ff }
.review-breadcrumb { position:absolute;left:40px;top:122px;border:1px solid #a6b0db26;border-radius:20px;padding:8px 14px;color:#9ea7c0;font-size:11px;display:flex;gap:12px }.review-breadcrumb i { color:#515c78;font-style:normal }.review-context { position:absolute;right:38px;top:40px;display:flex;align-items:center;gap:9px;font-size:11px;color:#939cb5 }.review-context i { width:5px;height:5px;background:#919ddd;border-radius:50% }.review-context small { margin-left:22px;color:#686f89;font-size:9px;letter-spacing:.1em }
.review-left-kpis { position:absolute;left:46px;top:217px;display:grid;gap:12px }.review-left-kpis>small { font-size:11px;color:#8d95ae }.review-left-kpis>strong { font:400 31px var(--hud-font-number);color:#ebedf5 }.review-left-kpis em { font:400 9px var(--hud-font-text);color:#8f97b3;margin-left:8px }.review-left-kpis p { color:#7a829a;font-size:11px;margin:0 }.review-left-kpis>div { display:flex;gap:9px;align-items:center;margin-top:22px;color:#9cabc7;font-size:10px }.review-left-kpis i { width:4px;height:4px;background:#93b5c3;border-radius:50% }
.review-process,.review-description { position:absolute;top:849px;height:204px;padding:19px 22px;box-sizing:border-box }.review-process { left:28px;width:390px }.review-description { left:1102px;width:395px }.review-process>small,.review-description>small { color:#727e9a;font-size:9px;letter-spacing:.17em }.review-process h2,.review-description h2 { margin:6px 0 20px;color:#e1e5f0;font-size:14px;font-weight:500 }.review-process>div { display:flex;align-items:baseline;justify-content:space-between;margin-top:18px;font-size:12px;color:#929eb7 }.review-process strong { color:#b4bfdc;font:400 22px var(--hud-font-number) }.review-process strong small { font-size:10px;color:#77849f }.review-process p,.review-description p { color:#707d98;font-size:10px;line-height:1.8 }.review-key { display:flex;gap:12px;align-items:center;margin-top:16px;color:#abb5ce;font-size:12px }.review-key i { width:23px;height:33px;border:1px solid #7d8cc0;border-radius:12px;position:relative }.review-key i::before { content:'';position:absolute;height:7px;width:1px;background:#8b99d1;top:5px;left:10px }.review-key small { display:block;font-size:10px;color:#6e7d9b;margin-top:4px }
.review-footer { position:absolute;left:45px;right:40px;bottom:8px;height:20px;display:flex;align-items:center;gap:8px;color:#718099;font-size:9px }.review-footer span:last-child { margin-left:auto }.review-footer i { width:4px;height:4px;border-radius:50%;background:#808fcc }.review-error { position:absolute;top:50%;left:30%;color:#e9b1bd;font-size:16px }
.review-scene { inset:0; }
.factory-hud-review.is-embedded .review-tools { margin-top:46px; }.factory-hud-review.is-embedded .review-viewport { top:94px; }
.review-loading { position:absolute;left:35%;top:47%;color:#949db6;font-size:13px;letter-spacing:.1em;pointer-events:none; }
.review-switching { position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;gap:14px;background:rgba(13,17,29,.4);color:#d8dff3;font-size:16px; }.review-switching span { width:20px;height:20px;border:1px solid #929fd333;border-top-color:#a0b1ff;border-radius:50%;animation:review-spin 1s linear infinite; }@keyframes review-spin { to { transform:rotate(360deg) } }
.review-process,.review-description { top:805px; }
.review-anchor { position:absolute;top:0;left:0;z-index:2;visibility:hidden;display:flex;flex-direction:column;align-items:center;border:0;padding:0;background:none;color:#a8b0f2;cursor:pointer }.review-anchor>span { width:27px;height:27px;display:grid;place-content:center;background:#7e8bd5;border:1px solid #abb6f9;border-radius:50%;box-shadow:0 0 0 8px #8d9efa14,0 0 24px #8d9efa30;color:#fafbff;font:400 17px sans-serif }.review-anchor small { margin-top:9px;padding:4px 8px;background:#171c3099;border:1px solid #a1b3e822;border-radius:3px;font:400 10px var(--hud-font-text);color:#d5daf1 }.review-anchor>i { height:27px;width:1px;background:linear-gradient(#8c9df4,#8c9df418) }.review-anchor.alarm>span { background:#cc607e;border-color:#f59db5;box-shadow:0 0 0 8px #dd6b9b15,0 0 24px #dd6b9b30 }.review-anchor:focus-visible { outline:1px solid #b7c0fe;outline-offset:5px }
</style>
