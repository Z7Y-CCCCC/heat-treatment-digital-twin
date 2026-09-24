const mapLoads = new Map()
const CODE_PATTERN = /^\d{6}$/

export function adminFeatureCode(feature) {
  return String(feature?.properties?.adcode || '')
}

export function adminFeatureName(feature) {
  return String(feature?.properties?.name || adminFeatureCode(feature))
}

export function adminFeatureCenter(feature) {
  const center=feature?.properties?.centroid || feature?.properties?.center
  if(!Array.isArray(center) || center.length<2)return null
  const longitude=Number(center[0]),latitude=Number(center[1])
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude,latitude] : null
}

export function isAdminFeatureCollection(value) {
  return Boolean(value && value.type==='FeatureCollection' && Array.isArray(value.features))
}

export async function loadChinaAdminMap(level, code, fetcher=globalThis.fetch) {
  const normalized=String(code || '')
  if(!CODE_PATTERN.test(normalized))throw new Error('行政区代码无效')
  if(!['province','district'].includes(level))throw new Error('行政区地图层级无效')
  const url=level==='province'
    ? `/maps/china-admin/provinces/${normalized}.geojson`
    : `/maps/china-admin/districts/${normalized}.geojson`
  if(!mapLoads.has(url)){
    const task=Promise.resolve().then(async()=>{
      const response=await fetcher(url)
      if(!response?.ok)throw new Error(`本地${level==='province'?'城市':'区县'}地图不可用（${normalized}）`)
      const data=await response.json()
      if(!isAdminFeatureCollection(data))throw new Error(`本地行政区地图格式无效（${normalized}）`)
      return data
    })
    mapLoads.set(url,task)
    task.catch(()=>{if(mapLoads.get(url)===task)mapLoads.delete(url)})
  }
  return mapLoads.get(url)
}

export function clearChinaAdminMapCache() {
  mapLoads.clear()
}
