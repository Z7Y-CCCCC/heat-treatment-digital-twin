import { normalizePagePermissions } from './pagePermissions.mjs'

export const CAPABILITY_PAGE_LINKS = Object.freeze({ cast: 'settings.runtime', backup: 'settings.database' })

// Quick capability choices expose their page, not unrelated settings writes,
// backup deletion or restoration. Saved server denials remain explicit until
// an administrator edits/applies a template in the account dialog.
export function withCapabilityPageReads(grants, permissions) {
  const pages = normalizePagePermissions(grants)
  for (const [capability, page] of Object.entries(CAPABILITY_PAGE_LINKS)) {
    if (permissions?.[capability] === true) pages[page].view = true
  }
  return pages
}

// A template is an explicit starting point, never a fallback over saved denials.
export function defaultAccountPagePermissions(role) {
  return normalizePagePermissions(role === 'customer' ? {
    devices: { view: true },
    'point-monitor': { view: true }
  } : undefined)
}
