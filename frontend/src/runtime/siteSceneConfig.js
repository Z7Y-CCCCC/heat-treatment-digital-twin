export const DEFAULT_STREET_IMAGE='/images/street-overview-v2.png'
export const DEFAULT_FACTORY_DESCRIPTION='点击厂区模型进入全厂总览，再从总览中选择具体车间。'
const LEGACY_FACTORY_DESCRIPTION='点击已配置的车间建筑进入 Unity 车间模型；办公与公辅建筑仅作园区示意。'

export function normalizeSiteSceneConfig(value){
  let raw=value
  if(typeof raw==='string'){try{raw=JSON.parse(raw)}catch{raw={}}}
  if(!raw || typeof raw!=='object' || Array.isArray(raw))raw={}
  const streetImageUrl=/^\/uploads\/appearance\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(String(raw.streetImageUrl || ''))?String(raw.streetImageUrl):''
  const buildingSlots={}
  const occupied=new Set()
  for(const [id,value] of Object.entries(raw.buildingSlots || {})){
    const slot=Number(value)
    if(!/^[\w-]{1,120}$/.test(id) || !Number.isInteger(slot) || slot<0 || slot>=40 || occupied.has(slot))continue
    occupied.add(slot);buildingSlots[id]=slot
  }
  const text=(key,fallback,limit)=>String(raw[key] ?? fallback).trim().slice(0,limit) || fallback
  const visible=key=>raw[key]===undefined ? true : raw[key]===true
  const accent=/^#[a-f0-9]{6}$/i.test(String(raw.accent || '')) ? String(raw.accent).toLowerCase() : '#aebaff'
  const factoryDescription=text('factoryDescription',DEFAULT_FACTORY_DESCRIPTION,240)
  return {version:1,streetImageUrl,buildingSlots,
    streetTitle:text('streetTitle','生产运营 · 街道视角',80),factoryTitle:text('factoryTitle','生产运营 · 工厂总览',80),
    streetDescription:text('streetDescription','工厂园区包含车间、办公与公辅建筑。鼠标拖动可改变观察方向，点击园区继续下探。',240),
    factoryDescription:[LEGACY_FACTORY_DESCRIPTION,'240'].includes(factoryDescription) ? DEFAULT_FACTORY_DESCRIPTION : factoryDescription,
    accent,showBrand:visible('showBrand'),showBreadcrumbs:visible('showBreadcrumbs'),
    showInfoPanel:visible('showInfoPanel'),showBeacon:visible('showBeacon'),showFooter:visible('showFooter')}
}

export function orderedSiteWorkshops(workshops,configuration){
  const slots=normalizeSiteSceneConfig(configuration).buildingSlots
  return workshops.map((item,index)=>({item,index})).sort((a,b)=>(slots[String(a.item.id)] ?? Infinity)-(slots[String(b.item.id)] ?? Infinity) || a.index-b.index).map(row=>row.item)
}
