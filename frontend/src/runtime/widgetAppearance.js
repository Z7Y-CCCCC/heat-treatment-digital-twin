const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
export function colorChannels(value) {
  const text = String(value ?? '').trim()
  if (text.toLowerCase() === 'transparent') return { rgb: [88, 79, 137], alpha: 0 }
  const hex = text.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1]
  if (hex) {
    const full = hex.length < 5 ? [...hex].map(c => c + c).join('') : hex
    return { rgb: [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)), alpha: full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1 }
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  return rgb ? { rgb: rgb.slice(1, 4).map(v => clamp(Number(v), 0, 255)), alpha: rgb[4] === undefined ? 1 : clamp(Number(rgb[4]), 0, 1) } : null
}
export function colorAtOpacity(color, opacity) {
  const parsed = colorChannels(color)
  const alpha = clamp(Number(opacity), 0, 1)
  if (parsed) return `rgba(${parsed.rgb.join(', ')}, ${Number(alpha.toFixed(4))})`
  return alpha === 1 ? color : `color-mix(in srgb, ${color} ${Number((alpha * 100).toFixed(2))}%, transparent)`
}
export function effectiveWidgetBackground(style = {}) {
  const color = style.background || 'rgba(88, 79, 137, 0.22)'
  const opacity = style.backgroundOpacity === undefined || style.backgroundOpacity === '' ? colorChannels(color)?.alpha ?? 1 : Number(style.backgroundOpacity)
  return colorAtOpacity(color, Number.isFinite(opacity) ? opacity : 1)
}
export function updateWidgetBackground(style, color) {
  style.background = color
  const parsed = colorChannels(color)
  if (parsed) style.backgroundOpacity = parsed.alpha
}
export function updateWidgetBackgroundOpacity(style, opacity) {
  style.backgroundOpacity = clamp(Number(opacity), 0, 1)
  style.background = colorAtOpacity(style.background || 'rgba(88, 79, 137, 0.22)', style.backgroundOpacity)
}
export function widgetAppearanceVariables(style = {}, condition = {}) {
  const color = condition.color || style.color
  const size = (value, min, max) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? `${clamp(Number(value), min, max)}px` : undefined
  return {
    '--widget-border-color': condition.borderColor || style.borderColor || undefined,
    '--widget-radius': size(style.borderRadius, 0, 80),
    '--widget-padding': size(style.padding, 0, 100),
    '--hud-module-font-size': size(style.fontSize, 10, 120),
    '--module-text': color || undefined,
    '--module-muted': color ? `color-mix(in srgb, ${color} 76%, transparent)` : undefined,
    '--module-faint': color ? `color-mix(in srgb, ${color} 60%, transparent)` : undefined
  }
}
