// Opt-in skinning of existing basic widgets. No document, binding, frame,
// visibility, or current view is ever changed by this renderer-only resolver.
export const VIEW_STYLE_OVERRIDE_KEYS = Object.freeze([
  'background', 'backgroundOpacity', 'color', 'borderColor', 'borderRadius',
  'opacity', 'shadow', 'boxShadow', 'surfaceSkin', 'surfaceAccent', 'backdropFilter'
])
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
const record = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const color = value => typeof value === 'string' && value.length <= 128
  && /^(?:transparent|#[\da-f]{3,8}|rgba?\([\d.,\s%]+\)|hsla?\([\d.,\s%]+\)|[a-z]{1,24})$/i.test(value.trim())

export function surfaceBackdropFilter(value) {
  if (value === 'none') return value
  if (typeof value !== 'string') return undefined
  // Only inert, bounded glass effects are accepted, never url()/SVG filters.
  const match = /^blur\((\d+(?:\.\d+)?)px\)(?: saturate\((\d+(?:\.\d+)?)%\))?$/.exec(value)
  return match && Number(match[1]) <= 40 && (!match[2] || Number(match[2]) <= 300) ? value : undefined
}

function validOverride(key, value) {
  if (['background', 'color', 'borderColor', 'surfaceAccent'].includes(key)) return color(value)
  if (['backgroundOpacity', 'opacity'].includes(key)) return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  if (key === 'borderRadius') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 80
  if (key === 'surfaceSkin') return ['glass', 'inline'].includes(value)
  if (key === 'backdropFilter') return surfaceBackdropFilter(value) !== undefined
  if (key === 'shadow') return ['none', 'soft', 'glow', 'strong'].includes(value)
  if (key === 'boxShadow') return typeof value === 'string' && value.length <= 256 && !/[;{}]|url\s*\(/i.test(value)
  return false
}

export function resolveWidgetViewStyle(style = {}, viewId = '') {
  // Preserve the exact legacy object/defaults when this new feature is absent.
  if (!record(style.viewOverrides) || ['__proto__', 'prototype', 'constructor'].includes(String(viewId)) || !/^[a-zA-Z0-9_-]{1,80}$/.test(String(viewId))
    || !own(style.viewOverrides, viewId) || !record(style.viewOverrides[viewId])) return style
  const source = style.viewOverrides[viewId], patch = {}
  for (const key of VIEW_STYLE_OVERRIDE_KEYS) if (own(source, key) && validOverride(key, source[key])) patch[key] = source[key]
  return Object.keys(patch).length ? { ...style, ...patch } : style
}

export function widgetSurfacePresentation(style = {}, fallbackAccent = '#a2a7ed') {
  const skin = ['glass', 'inline'].includes(style.surfaceSkin) ? style.surfaceSkin : ''
  const backdrop = surfaceBackdropFilter(style.backdropFilter) ?? (skin === 'inline' ? 'none' : undefined)
  return {
    skin,
    backdrop,
    variables: {
      ...(skin === 'glass' ? { '--surface-accent': color(style.surfaceAccent) ? style.surfaceAccent : fallbackAccent } : {}),
      ...(backdrop !== undefined ? { '--surface-backdrop-filter': backdrop } : {})
    }
  }
}
