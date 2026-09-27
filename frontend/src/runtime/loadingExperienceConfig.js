export const DEFAULT_LOADING_EXPERIENCE = Object.freeze({
  preset: 'interactive',
  title: '正在准备生产现场',
  kicker: 'HEAT TREATMENT / DIGITAL TWIN',
  imageUrl: '',
  background: '#28282b',
  accent: '#a8c3b1'
})

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
  for (const key of ['background', 'accent']) {
    if (typeof value[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(value[key])) result[key] = value[key].toLowerCase()
  }
  if (typeof value.imageUrl === 'string' && /^\/uploads\/appearance\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(value.imageUrl)) result.imageUrl = value.imageUrl
  return result
}
