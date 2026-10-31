import { normalizePagePermissions } from './pagePermissions.mjs'

// A template is an explicit starting point, never a fallback over saved denials.
export function defaultAccountPagePermissions(role) {
  return normalizePagePermissions(role === 'customer' ? {
    devices: { view: true },
    'point-monitor': { view: true }
  } : undefined)
}
