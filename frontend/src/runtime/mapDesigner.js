import { GROUP_MAP_LEVELS, groupPortalAppearanceForLevel } from './groupPortalAppearance.js'
import { factoryDirectorySites, sitesAtHierarchyLevel, groupHierarchyEntries } from './groupTopology.js'

export const MAP_DESIGNER_FIELDS = [
  ['factsFactoryCount','登记工厂','座'],['factsLocalCount','已接入工厂','座'],['factsDeviceCount','设备配置数','台'],
  ['dockFactoryCount','登记工厂','座'],['dockLocalCount','已接入工厂','座'],['dockAssignedCount','已归属区县','座'],
  ['dockCoverage','行政区归属率','%'],['dockWorkshops','车间','个'],['dockLines','产线','条'],['dockDevices','设备','台']
].map(([key,label,unit])=>({key,label,unit,path:`map.${key}`}))

function sceneNamespace(sceneId) {
  if(!sceneId || sceneId==='scene_factory_overview')return ''
  let hash=0xcbf29ce484222325n
  for(const byte of new TextEncoder().encode(sceneId))hash=BigInt.asUintN(64,(hash ^ BigInt(byte))*0x100000001b3n)
  return `${hash.toString(16).padStart(16,'0')}_`
}

// Read-only presentation migration. Only an explicit designer save persists it.
// Existing authored widgets, camera hierarchy, data sources and PLC config stay intact.
export function upgradeMapDesignerDocument(source, appearance) {
  if(!source?.scene?.views || source.metadata?.unifiedMapDesigner===1)return source
  const doc=JSON.parse(JSON.stringify(source)),width=Number(doc.canvas?.width || 1920),height=Number(doc.canvas?.height || 1080)
  doc.widgets ||= []
  for(const level of GROUP_MAP_LEVELS) {
    const view=doc.scene.views.find(v=>v.id===`map_${level.key}`);if(!view)continue
    const a=groupPortalAppearanceForLevel(appearance,level.key),prefix=`map_${level.key}_${sceneNamespace(doc.sceneId)}`,state=view.componentState ||= {show:[],hide:[]}
    state.show ||= [];state.hide ||= []
    const add=(id,type,title,box,content,data,group,shown=true)=>{
      id=prefix+id
      if(doc.widgets.some(w=>w.id===id))return
      const [x,y,w,h]=box
      doc.widgets.push({id,type,title,frame:{x:x*width/100,y:y*height/100,width:w*width/100,height:h*height/100,rotation:0},
        content:{showDeviceLabel:false,...content}, data:{mode:'static',readOnly:true,...data,deviceScope:'global'},groupId:prefix+group,visible:true,locked:false,zIndex:20,runtimeTarget:'overlay',
        style:{color:'#e6dff4',backgroundOpacity:.26,borderRadius:8,fontSize:18},visibility:{viewIds:[view.id],viewModes:[],rules:[],matchBoundDevice:false},events:[],conditions:[],animation:{type:'none'}})
      state.show.push(id);if(!shown)state.hide.push(id)
    }
    const point=(key,x,y)=>[a.layout?.[key]?.x ?? x,a.layout?.[key]?.y ?? y]
    const [bx,by]=point('brand',3,5)
    if(a.logoUrl)add('logo','image','Logo',[bx,by,3.5,6],{url:'',fit:'contain',showTitle:false},{mode:'runtime',path:'map.logoUrl'},'brand',a.showBrand)
    add('brand','text','标题',[bx+(a.logoUrl?4.5:0),by,30,7],{text:'{value}',showTitle:false},{mode:'runtime',path:'map.brandText'},'brand',a.showBrand)
    const metrics=(key,title,box,keys,shown)=>{
      const fields=keys.map(key=>MAP_DESIGNER_FIELDS.find(f=>f.key===key))
      if(fields.some(f=>a.dataBindings?.[f.key])) {
        // Mixed old HTTP sources become individually editable standard value widgets.
        fields.forEach((f,index)=>add(`${key}_${f.key}`,'value',f.label,[box[0],box[1]+index*box[3]/fields.length,box[2],box[3]/fields.length-1],{label:f.label,shape:'card',showTitle:false},a.dataBindings?.[f.key]?{...a.dataBindings[f.key],legacyMapMetric:f.key,unit:f.unit}:{mode:'runtime',path:f.path,unit:f.unit,decimals:0},key,shown))
      } else add(key,'hud_kpi_panel',title,box,{showRing:false,items:fields.map(f=>({label:f.label,path:f.path,unit:f.unit,decimals:0}))},{mode:'runtime',path:'map'},key,shown)
    }
    const [fx,fy]=point('facts',3,26)
    metrics('facts',a.factsTitle,[fx,fy,19,28],['factsFactoryCount','factsLocalCount','factsDeviceCount'],a.showFacts)
    const [px,py]=point('panel',73,17)
    add('regions','map_region_list',a.panelTitle,[px,py,23,63],{limit:300,showCounts:true,showMeters:true},a.dataBindings?.panelRegionRows?{...a.dataBindings.panelRegionRows,legacyMapMetric:'panelRegionRows'}:{mode:'runtime',path:'map.records'},'panel',a.showPanel)
    const [dx,dy]=point('dock',3,76)
    metrics('network',a.dockNetworkTitle,[dx,dy,20,20],['dockFactoryCount','dockLocalCount'],a.showDock)
    metrics('coverage',a.dockLocationTitle,[dx+21.5,dy,20,20],['dockAssignedCount','dockCoverage'],a.showDock)
    metrics('structure',a.dockHierarchyTitle,[dx+43,dy,22,20],['dockWorkshops','dockLines','dockDevices'],a.showDock)
  }
  doc.metadata={...doc.metadata,unifiedMapDesigner:1}
  return doc
}

export function createMapDesignerContext(config, {level='world',code='',regions,title}={}) {
  if(!config)return {}
  const visible=sitesAtHierarchyLevel(factoryDirectorySites(config),level,code),local=visible.filter(s=>s.runtime==='local')
  const assigned=visible.filter(s=>s.location.country==='CHN'?s.location.districtCode:s.location.regionName)
  const totals=local.reduce((t,s)=>({workshops:t.workshops+s.workshops,lines:t.lines+s.lines,devices:t.devices+s.devices}),{workshops:0,lines:0,devices:0})
  const entries=regions || groupHierarchyEntries(factoryDirectorySites(config),level,code)
  const isFactory=level==='district'||level==='country'&&code!=='CHN'
  const records=isFactory?visible.map(s=>({kind:'factory',id:s.id,name:s.name,count:s.devices,workshops:s.workshops,lines:s.lines,devices:s.devices,runtime:s.runtime})):entries.map(r=>({...r,kind:'region'}))
  const appearance=groupPortalAppearanceForLevel(config.settings?.group_portal_config,level)
  return {title:title || '工厂分布',brandText:`${appearance.brandTitle}\n${appearance.brandSubtitle}`,logoUrl:appearance.logoUrl,level,code,timestamp:Date.now(),records,factsFactoryCount:visible.length,factsLocalCount:local.length,factsDeviceCount:totals.devices,
    dockFactoryCount:visible.length,dockLocalCount:local.length,dockAssignedCount:assigned.length,dockCoverage:visible.length?Math.round(assigned.length/visible.length*100):0,
    dockWorkshops:totals.workshops,dockLines:totals.lines,dockDevices:totals.devices}
}
