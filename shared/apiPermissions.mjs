import { PAGE_PERMISSIONS, pagePermission as p } from './pagePermissions.mjs'
const any = (...grants) => ({ any: grants })
const all = (...grants) => ({ all: grants })
const read = (pages, display = false) => any('admin', ...(display ? ['view'] : []), ...pages.map(k => p(k)))
const spatial = ['factories', 'workshops', 'lines', 'devices', 'composer', 'mobile-devices', 'disassembly-layout', 'models', 'model-animations', 'points', 'points.alarms', 'point-monitor', 'platform.scene', 'platform.designer', 'platform.environment']
export const SETTING_PAGES = {
  data_mode: 'settings.data', simulation_interval_ms: 'settings.data', realtime_stale_ms: 'settings.data',
  native_quality_profile: 'settings.performance', native_environment_config: 'platform.environment',
  native_dashboard_config: 'platform.designer', loading_experience_config: 'platform.loading',
  group_portal_config: 'platform.map', site_scene_config: 'platform.designer',
  factory_location: 'factories', factory_directory: 'factories', factory_name: 'factories', voice_enabled: 'points'
}

// The server chooses the policy from the actual URL/method/body, never from a
// caller-provided page name. Display-safe reads intentionally remain shared.
export function apiPermission(path, method = 'GET', body) {
  path = String(path).toLowerCase().replace(/\/+$/, '')
  method = String(method).toUpperCase()
  const safe = ['GET', 'HEAD'].includes(method)
  const action = safe ? 'view' : method === 'DELETE' ? 'delete' : 'edit'
  const resource = prefix => path === `/api/${prefix}` || path.startsWith(`/api/${prefix}/`)
  if (resource('license')) return safe ? read(['settings.license']) : 'admin'
  if (safe && ['/api/platform/metrics/latest', '/api/platform/events', '/api/data-sources/map-values'].includes(path)) return 'view'
  if (method === 'POST' && (/^\/api\/factories\/(?:[^/]+\/)?activate$/.test(path)
    || path === '/api/native-preview/navigate' || /^\/api\/platform\/scenes\/[^/]+\/activate-latest-release$/.test(path))) return 'launch'
  if (resource('mcp')) return 'admin' // nested tool calls stay owner-only
  if (resource('system/cast')) return any('cast', p('settings.runtime', action))
  if (resource('system/runtime')) return safe ? read(['settings.runtime']) : any('admin', p('settings.runtime', 'edit'))
  if (resource('database/backups') || resource('site-backups') || resource('data-sources/backups')) {
    if (/\/(restore|import)$/.test(path) && !safe) return 'admin' // restoring changes all pages, not just backup settings
    const destructive = method === 'DELETE' || /\/(restore|import|config)$/.test(path)
    return any('admin', ...(!destructive ? ['backup'] : []), p('settings.database', action))
  }
  if (resource('database') || resource('data-sources')) {
    if (method === 'POST' && path === '/api/data-sources/datasets/preview') return body?.datasetId ? read(['settings.database', 'platform.designer']) : any('admin', p('settings.database', 'edit'))
    if (safe && path === '/api/data-sources/runtime-values') return read(['points', 'points.alarms', 'point-monitor', 'platform.designer'], true)
    const pages = ['settings.database', 'platform.designer', 'platform.map']
    if (safe) return read(pages)
    if (method === 'POST' && /\/(preview|preview-http|inspect-http)$/.test(path)) return read(pages)
    return any('admin', p('settings.database', action))
  }
  if (resource('project-bundles')) return 'admin' // whole-project import/export affects every page
  if (resource('settings')) {
    if (path === '/api/settings/voice') return safe ? read(['points', 'points.alarms'], true) : method === 'PUT' ? any('admin', p('points', 'edit')) : 'admin'
    if (safe) return read(PAGE_PERMISSIONS.filter(p => !p.ownerOnly).map(p => p.key), true)
    if (method !== 'PUT' || path !== '/api/settings' || !body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) return 'admin'
    return any('admin', all(...Object.keys(body).map(key => SETTING_PAGES[key] ? p(SETTING_PAGES[key], 'edit') : 'admin')))
  }
  if (resource('platform')) {
    if (safe) return read(['platform.designer', 'platform.scene', 'platform.environment'])
    if (resource('platform/releases')) return any('admin', p('platform.designer', method === 'DELETE' ? 'delete' : 'publish'))
    if (/^\/api\/platform\/scenes\/[^/]+$/.test(path) && method === 'PUT') {
      // Activation is a distinct capability; plain scene edits omit is_active.
      return any('admin', all(p('platform.scene', 'edit'), ...(Object.hasOwn(body || {}, 'is_active') ? [p('platform.designer', 'publish')] : [])))
    }
    if (resource('platform/designer') || resource('platform/widgets')) return any('admin', p('platform.designer', action))
    return 'admin'
  }
  if (resource('native-preview')) {
    // The header's connection count is display-safe, not a draft-preview grant.
    // Keep this exact path separate from every authoring/navigation endpoint.
    if (safe && path === '/api/native-preview/status') return read(PAGE_PERMISSIONS.filter(p => !p.ownerOnly).map(p => p.key), true)
    const previewPages = ['composer', 'workshops', 'lines', 'models', 'disassembly-layout', 'platform.environment', 'platform.designer']
    // Draft previews are ephemeral, but require an authoring grant. Status is read-only.
    return safe ? read(previewPages) : any('admin', ...previewPages.map(k => p(k, 'edit')))
  }
  if (resource('devices')) {
    if (/\/animations$/.test(path)) return safe ? read(['model-animations']) : any('admin', p('model-animations', 'edit'))
    if (safe) return read(spatial, true)
    if (/\/inspection$/.test(path)) return any('admin', p('disassembly-layout', 'edit'))
    if ((path === '/api/devices/transforms' && method === 'PUT') || /\/transform$/.test(path)) return any('admin', p('composer', 'edit'), p('lines', 'edit'))
    if (/\/movement$/.test(path)) return any('admin', p('mobile-devices', 'edit'))
    return any('admin', p('devices', action))
  }
  if (resource('lines')) {
    if (safe) return read(spatial, true)
    if (/\/placement$/.test(path)) return any('admin', p('workshops', 'edit'))
    return any('admin', p('lines', action))
  }
  if (resource('workshops')) {
    if (/\/ground$/.test(path) && method === 'PUT') return any('admin', p('composer', 'edit'))
    return safe ? read(spatial, true) : any('admin', p('workshops', action))
  }
  if (resource('models')) {
    if (safe) return read(spatial, true)
    if (path === '/api/models/asset-export' && method === 'POST') return read(spatial, true)
    if (path === '/api/models/asset-inspect' && method === 'POST') return any('admin', p('models', 'edit'), p('model-animations', 'edit'))
    // Package import also creates a model; animation-only editors cannot
    // introduce/replace model assets by using the motion page.
    if (/^\/api\/models\/[^/]+\/(bindings|motion-actions)$/.test(path) && method === 'PUT') return any('admin', p('models', 'edit'), p('model-animations', 'edit'))
    if (/^\/api\/models\/[^/]+\/motion-actions\/preview$/.test(path) && method === 'POST') return any('admin', p('models', 'edit'), p('model-animations', 'edit'))
    if (/^\/api\/models\/[^/]+\/inspection$/.test(path) && method === 'PUT') return any('admin', p('disassembly-layout', 'edit'))
    return any('admin', p('models', action))
  }
  if (safe && path === '/api/factories/collection-status') return read(['settings.data'])
  if (/^\/api\/factories\/[^/]+\/collection$/.test(path)) return any('admin', p('settings.data', 'edit'))
  if (resource('factories')) return safe ? read(PAGE_PERMISSIONS.map(p => p.key), true) : any('admin', p('factories', 'edit'))
  if (resource('datapoints')) {
    if (path === '/api/datapoints/alarm-texts' && method === 'POST') return any('admin', p('points.alarms', 'edit'))
    if (path === '/api/datapoints/batch' && !safe) return any('admin', all(p('points', 'edit'), p('points', 'delete')))
    return safe ? read(['points', 'points.alarms', 'point-monitor', 'mobile-devices', 'model-animations', 'platform.designer'], true) : any('admin', p('points', action))
  }
  if (resource('plc') || resource('engine/status')) return safe ? read(['points', 'points.alarms', 'point-monitor', 'mobile-devices', 'settings.data'], true) : 'admin'
  if (path === '/api/engine/restart') return any('admin', p('settings.data', 'edit'))
  if (path === '/api/collector/status' && safe) return read(['settings.data', 'point-monitor', 'mobile-devices'])
  if (path === '/api/collector/mode' && method === 'PUT') return any('admin', p('settings.data', 'edit'))
  if (resource('appearance-assets')) return safe ? read(['platform.designer', 'platform.map', 'platform.loading', 'factories'], true) : any('admin', p('platform.designer', action), p('platform.map', action), p('platform.loading', action))
  if (resource('template-library') || resource('config') || resource('business-data')) return safe ? read(spatial, true) : 'admin'
  if (resource('acceptance-report')) return safe ? read(['models', 'platform.designer']) : 'admin'
  // Preserve existing display audio reads; system speech/control is administrative.
  if (resource('voice')) return safe ? read(['points', 'points.alarms', 'settings.runtime'], true) : any('admin', p('points', 'edit'), p('settings.runtime', 'edit'))
  return 'admin'
}
