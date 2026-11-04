export const ADMIN_READING_KEY = 'digital_twin_admin_reading_v1'
export const DEFAULT_TEXT_SIZE = 115
export function normalizeTextSize(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 100 && n <= 200 ? Math.round(n / 5) * 5 : DEFAULT_TEXT_SIZE
}
export function readTextSize(storage) {
  try { return normalizeTextSize(JSON.parse(storage.getItem(ADMIN_READING_KEY) || '{}').textSize) }
  catch { return DEFAULT_TEXT_SIZE }
}
export function saveTextSize(storage, value) {
  const textSize = normalizeTextSize(value)
  try { storage.setItem(ADMIN_READING_KEY, JSON.stringify({ textSize })) } catch { /* Optional local preference. */ }
  return textSize
}
