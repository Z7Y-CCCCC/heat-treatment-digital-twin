export const GLOBAL_VIEW_KEY = 'global_view_navigation'
export const GLOBAL_VIEWS = Object.freeze([
  { id: 'map_world', name: '全球地图', level: 'world' }, { id: 'map_country', name: '国家地图', level: 'country' },
  { id: 'map_province', name: '省份 / 直辖市地图', level: 'province' }, { id: 'map_city', name: '城市地图', level: 'city' },
  { id: 'map_district', name: '区县地图', level: 'district' }, { id: 'site_street', name: '街道示意', level: 'street' },
  { id: 'site_factory', name: '工厂建筑', level: 'factory' }
])
export const isGlobalView = id => GLOBAL_VIEWS.some(view => view.id === (typeof id === 'object' ? id?.id : id))
export function normalizeGlobalViews(value) {
  let source = value
  try { if (typeof source === 'string') source = JSON.parse(source) } catch { source = null }
  return { version: 1, enabled: Object.fromEntries(GLOBAL_VIEWS.map(view => [view.id, source?.enabled?.[view.id] !== false])) }
}
export function globalViewEnabled(value, id) { return !isGlobalView(id) || normalizeGlobalViews(value).enabled[id] }
export function runtimeViewHidden(view) {
  return typeof view?.metadata?.runtimeHidden === 'boolean' ? view.metadata.runtimeHidden : view?.metadata?.hierarchyHidden === true
}
// Runtime projection only: keep all authoring views, widgets and original links.
export function applyViewNavigation(document, policy) {
  const result = structuredClone(document), views = result.scene?.views || [], normalized = normalizeGlobalViews(policy)
  const ordered = [...views].sort((a,b)=>(a.metadata?.hierarchyOrder ?? views.indexOf(a))-(b.metadata?.hierarchyOrder ?? views.indexOf(b)))
  for (const view of views) view.metadata = { ...view.metadata, runtimeHidden: isGlobalView(view) ? !normalized.enabled[view.id] : view.metadata?.hierarchyHidden === true }
  const local = ordered.filter(view => !isGlobalView(view) && !runtimeViewHidden(view))
  if (!local.length) {
    const rescue = views.find(view => view.id === 'factory_overview') || views.find(view => !isGlobalView(view))
    if (rescue) { rescue.metadata.runtimeHidden = false; local.push(rescue) }
  }
  const all = views.filter(view => !runtimeViewHidden(view)), ids = new Set(all.map(view => view.id)), byId = new Map(views.map(view => [view.id, view]))
  for (const view of all) for (const field of ['parentViewId', 'returnViewId']) {
    let id = view[field], seen = new Set([view.id])
    while (id && !ids.has(id) && !seen.has(id)) { seen.add(id); const parent = byId.get(id); id = parent?.[field] || parent?.parentViewId || '' }
    view[field] = seen.has(id) ? '' : id || ''
  }
  if (result.scene && !ids.has(result.scene.defaultViewId)) result.scene.defaultViewId = local[0]?.id || all[0]?.id || ''
  result.metadata = { ...result.metadata, globalViewNavigation: normalized }
  return result
}
