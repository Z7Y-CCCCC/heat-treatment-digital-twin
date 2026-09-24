const STORAGE_KEY = 'digital_twin_factory_scope_v1'
const CHANGE_EVENT = 'digital-twin-factory-scope-changed'

export function getFactoryScope() {
  if (typeof window === 'undefined') return ''
  try { return String(window.localStorage.getItem(STORAGE_KEY) || '') } catch { return '' }
}

export function setFactoryScope(factoryId) {
  if (typeof window === 'undefined') return
  const next = String(factoryId || '').trim()
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, next)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage may be disabled; server fallback remains the active factory */ }
  window.dispatchEvent?.(new CustomEvent(CHANGE_EVENT, { detail: { factoryId: next } }))
}

export const FACTORY_SCOPE_CHANGE_EVENT = CHANGE_EVENT
