export const DEFAULT_LOADING_EXPERIENCE = Object.freeze({
  preset: 'interactive',
  title: '正在准备生产现场',
  kicker: 'HEAT TREATMENT / DIGITAL TWIN',
  imageUrl: '',
  theme: 'light',
  background: '#f5f7fb',
  accent: '#2563eb'
})

export const LOADING_APPEARANCE_CACHE_KEY = 'digital_twin_loading_appearance_v1'

export function initialLoadingExperience(raw) {
  let cached = null
  try { cached = JSON.parse(globalThis.localStorage?.getItem(LOADING_APPEARANCE_CACHE_KEY) || 'null') } catch { /* Optional cosmetic cache. */ }
  const hostTheme = typeof window === 'undefined' ? '' : window.__DIGITAL_TWIN_WINDOW_THEME__
  if (raw !== undefined && raw !== null) return normalizeLoadingExperience(raw)
  return normalizeLoadingExperience(['light','dark'].includes(hostTheme) ? { ...cached, theme: hostTheme } : cached)
}

export function cacheLoadingExperience(config) {
  const next = normalizeLoadingExperience(config)
  try { globalThis.localStorage?.setItem(LOADING_APPEARANCE_CACHE_KEY, JSON.stringify(next)) } catch { /* Optional cosmetic cache. */ }
  return next
}

export function normalizeLoadingExperience(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { value = null }
  }
  const result = { ...DEFAULT_LOADING_EXPERIENCE }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  if (['interactive', 'quiet'].includes(value.preset)) result.preset = value.preset
  for (const [key, limit] of [['title', 48], ['kicker', 72]]) {
    if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim().slice(0, limit)
  }
  result.theme = ['light', 'dark'].includes(value.theme) ? value.theme
    : ['#28282b', '#29292c'].includes(String(value.background).toLowerCase()) ? 'dark' : 'light'
  result.background = result.theme === 'dark' ? '#28282b' : '#f5f7fb'
  result.accent = result.theme === 'dark' ? '#a8c3b1' : '#2563eb'
  if (typeof value.imageUrl === 'string' && /^\/uploads\/appearance\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(value.imageUrl)) result.imageUrl = value.imageUrl
  return result
}
