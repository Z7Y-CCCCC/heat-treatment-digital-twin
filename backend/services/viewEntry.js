const { GLOBAL_VIEWS, isGlobalView, runtimeViewHidden } = require('../../shared/viewNavigation.mjs')
const { getPolicy } = require('./globalViewNavigation')
const { getProjectAndScene, loadPublishedDocument } = require('./dashboardDocuments')
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value || {} } catch { return {} } }
async function resolveEntry(db, query = {}) {
  const policy = await getPolicy(db), requested = GLOBAL_VIEWS.find(view => view.id === query.viewId) || GLOBAL_VIEWS[0]
  if (policy.config.enabled[requested.id]) return { allowed: true, ...policy }
  const factories = await db.all('SELECT id,name,location_json,is_enabled FROM factories ORDER BY created_at,id')
  const visible = factories.filter(factory => Number(factory.is_enabled ?? 1))
  const active = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id'])
  const country = String(query.country || (requested.level === 'country' ? query.code : '') || '')
  const factory = visible.find(factory => factory.id === query.factoryId)
    || visible.find(factory => country && parse(factory.location_json).country === country)
    || visible.find(factory => factory.id === active?.value) || visible[0]
  const location = parse(factory?.location_json), sameCountry = !country || country === location.country
  const geo = { country: country || location.country || 'CHN', province: query.province || (sameCountry ? location.regionCode : ''),
    city: query.city || (sameCountry ? location.cityCode : ''), district: query.district || (sameCountry ? location.districtCode : '') }
  for (const view of GLOBAL_VIEWS.slice(GLOBAL_VIEWS.indexOf(requested) + 1)) {
    if (!policy.config.enabled[view.id]) continue
    if (view.id.startsWith('map_')) {
      const code = geo[view.level]
      if (!(view.level === 'country' ? /^[A-Z]{2,3}$/.test(code || '') : /^\d{6}$/.test(code || ''))) continue
      return { allowed: false, ...policy, route: { path: '/group', query: { ...geo, level: view.level, code } } }
    }
    if (factory) return { allowed: false, ...policy, route: { path: '/site', query: { ...geo, factoryId: factory.id, stage: view.id === 'site_street' ? 'street' : 'factory' } } }
  }
  if (!factory) return { allowed: false, ...policy, route: { path: '/overlay', query: { noVisibleFactory: '1', scene: '1' } } }
  const { project, scene } = await getProjectAndScene(db, '', factory.id), published = await loadPublishedDocument(db, project, scene)
  const views = (published.document.scene?.views || []).filter(view => !isGlobalView(view) && !runtimeViewHidden(view))
  const view = views.find(view => view.id === published.document.scene?.defaultViewId) || views[0]
  const viewId = view?.id || 'factory_overview', targetMode=view?.targetType==='device_part'?'device':view?.targetType, mode = ['factory', 'workshop', 'line', 'device'].includes(targetMode) ? targetMode : ['factory','workshop','line','device'].includes(view?.mode)?view.mode:'factory'
  const workshops = await db.all('SELECT id FROM workshops WHERE factory_id=? ORDER BY sort_order,id', [factory.id])
  const lines = await db.all('SELECT l.id,l.workshop_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? ORDER BY l.sort_order,l.id', [factory.id])
  const devices = await db.all('SELECT d.id,d.line_id FROM devices d JOIN `lines` l ON l.id=d.line_id JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? ORDER BY d.sort_order,d.id', [factory.id])
  const device = devices.find(item => mode==='device' && item.id === view?.targetId) || devices[0], line = lines.find(item => item.id === (mode==='line'?view?.targetId:device?.line_id)) || lines[0]
  const workshop = workshops.find(item => item.id === (mode==='workshop'?view?.targetId:line?.workshop_id)) || workshops[0]
  return { allowed: false, ...policy, route: { path: '/overlay', query: { factoryId: factory.id, scene: '1', entryViewId: viewId, entryMode: mode,
    ...(mode !== 'factory' && workshop ? { entryWorkshopId: workshop.id } : {}), ...(mode === 'line' || mode === 'device' ? { entryLineId: line?.id || '' } : {}), ...(mode === 'device' ? { entryDeviceId: device?.id || '' } : {}) } } }
}
module.exports = { resolveEntry }
