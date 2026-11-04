// Shared policy vocabulary. Missing grants are always false; editing one page
// never turns a user into the legacy owner/admin role.
import { ADMIN_PAGES, PAGE_ACTIONS } from './adminPages.mjs'
export { PAGE_ACTIONS }
export const PAGE_PERMISSIONS = ADMIN_PAGES
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function normalizePagePermissions(value, { owner = false } = {}) {
  if (value !== undefined) {
    if (!plainObject(value)) throw new TypeError('页面权限必须是对象')
    for (const [key, grants] of Object.entries(value)) {
      const definition = PAGE_PERMISSIONS.find(p => p.key === key)
      if (!definition || !plainObject(grants)) throw new TypeError('未知页面或页面权限格式无效')
      for (const [action, enabled] of Object.entries(grants)) {
        if (!definition.actions.includes(action) || typeof enabled !== 'boolean'
          || (definition.ownerOnly && enabled && !owner)) throw new TypeError('页面操作权限无效或不可委派')
      }
      if (!owner && grants.view !== true && Object.entries(grants).some(([a, enabled]) => a !== 'view' && enabled)) {
        throw new TypeError('操作权限必须同时授予该页面的查看权限')
      }
    }
  }
  return Object.fromEntries(PAGE_PERMISSIONS.map(p => {
    // These settings already existed under the designer. Migrate old stored
    // grants only when no explicit grant/denial exists for the moved page.
    const grants = value?.[p.key] ?? (p.migratedFrom ? value?.[p.migratedFrom] : undefined)
    return [p.key, Object.fromEntries(p.actions.map(a => [a, owner || (!p.ownerOnly && grants?.view === true && grants?.[a] === true)]))]
  }))
}

// Read compatibility only: previous versions stored this boolean even for
// accounts with no model publishing grant. Retiring the action must not make
// the whole credential file unreadable. New permission writes remain strict.
export function normalizeStoredPagePermissions(value) {
  if (plainObject(value) && plainObject(value.models) && typeof value.models.publish === 'boolean') {
    const { publish: retired, ...models } = value.models
    return normalizePagePermissions({ ...value, models })
  }
  return normalizePagePermissions(value)
}

export function canPage(grants, key, action = 'view') {
  const definition = PAGE_PERMISSIONS.find(p => p.key === key)
  return !!definition && definition.actions.includes(action)
    && grants?.[key]?.view === true && grants?.[key]?.[action] === true
}
export function canAccessAdmin(grants) { return PAGE_PERMISSIONS.some(p => canPage(grants, p.key)) }
export function pagePermission(key, action = 'view') { return `page:${key}:${action}` }

// Requirements compose AND/OR explicitly. Unknown names/empty groups deny even
// for an owner, so a typo or newly added route cannot silently grant access.
export function allowsRequirement(requirement, { owner = false, active = false, permissions = {}, pagePermissions = {} } = {}) {
  if (typeof requirement === 'string') {
    if (['admin', 'owner', 'edit'].includes(requirement)) return owner && active
    if (requirement === 'session') return active
    if (requirement === 'account') return true // cookie/CSRF already checked; switching never unlocks a session
    if (['view', 'launch', 'cast', 'backup'].includes(requirement)) return permissions[requirement] === true
    const match = /^page:([^:]+):([^:]+)$/.exec(requirement)
    return !!match && active && canPage(pagePermissions, match[1], match[2])
  }
  if (!plainObject(requirement)) return false
  if (Array.isArray(requirement.any) && requirement.any.length) return requirement.any.some(r => allowsRequirement(r, { owner, active, permissions, pagePermissions }))
  if (Array.isArray(requirement.all) && requirement.all.length) return requirement.all.every(r => allowsRequirement(r, { owner, active, permissions, pagePermissions }))
  return false
}
