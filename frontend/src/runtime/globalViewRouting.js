import { API_BASE } from './backendEndpoint.js'
import { adminFetch } from './adminSession.js'
import { globalViewEnabled } from '../../../shared/viewNavigation.mjs'

export function globalViewForRoute(route) {
  if (route.path === '/site') return route.query?.stage === 'factory' ? 'site_factory' : 'site_street'
  if (route.path !== '/group') return ''
  const level = route.query?.level || (route.query?.region ? (/^\d{6}$/.test(route.query.region) ? 'province' : 'country') : 'world')
  return `map_${['world','country','province','city','district'].includes(level) ? level : 'world'}`
}
export async function globalEntryRedirect(route, policy) {
  const viewId = globalViewForRoute(route)
  if (!viewId || (policy && globalViewEnabled(policy, viewId))) return null
  const params = new URLSearchParams({ ...route.query, viewId })
  const response = await adminFetch(`${API_BASE}/view-navigation/resolve?${params}`, { cache:'no-store', signal:AbortSignal.timeout(10000) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '视角入口读取失败')
  if (result.allowed || !result.route) return null
  // Preserve host identity, not stale geographic / native-entry parameters.
  const query = Object.fromEntries(['embedded','surface','scope'].filter(key=>route.query?.[key]).map(key=>[key,route.query[key]]))
  return { ...result.route, query:{ ...query, ...result.route.query }, replace:true }
}
export function visibleGlobalCrumbs(crumbs, policy) {
  return crumbs.filter(crumb => {
    const id = crumb.to ? globalViewForRoute(crumb.to) : crumb.level ? (['street','factory'].includes(crumb.level) ? `site_${crumb.level}` : `map_${crumb.level}`) : ''
    return !id || globalViewEnabled(policy,id)
  })
}
