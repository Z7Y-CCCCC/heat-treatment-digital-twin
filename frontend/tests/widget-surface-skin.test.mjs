import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveWidgetViewStyle, widgetSurfacePresentation, surfaceBackdropFilter, VIEW_STYLE_OVERRIDE_KEYS } from '../src/runtime/widgetSurfaceSkin.js'
import { normalizeDashboardWidget } from '../src/runtime/dashboardSchema.js'

test('unmarked legacy style remains the same object and gets no new skin or filters', () => {
  const style = { background: '#071C2D', borderRadius: 10, fontSize: 21, padding: 9 }
  assert.equal(resolveWidgetViewStyle(style, 'device_detail'), style)
  assert.deepEqual(widgetSurfacePresentation(style), { skin: '', backdrop: undefined, variables: {} })
  assert.deepEqual(widgetSurfacePresentation({ surfaceSkin: 'invalid', backdropFilter: 'url(https://invalid)' }), { skin: '', backdrop: undefined, variables: {} })
})

test('view-scoped glass styles leave all other contexts and original input untouched', () => {
  const style = { surfaceSkin: 'inline', backdropFilter: 'none', padding: 8, fontSize: 21, viewOverrides: {
    device_detail: { surfaceSkin: 'glass', surfaceAccent: '#68d5ff', background: '#241f2e', backgroundOpacity: 1, borderColor: '#ffc45f', borderRadius: 10, backdropFilter: 'blur(12px) saturate(125%)' }
  } }
  const before = JSON.stringify(style), resolved = resolveWidgetViewStyle(style, 'device_detail')
  assert.equal(resolved.surfaceSkin, 'glass')
  assert.equal(resolved.background, '#241f2e')
  assert.equal(resolved.padding, 8)
  assert.equal(resolved.fontSize, 21)
  assert.equal(resolveWidgetViewStyle(style, 'device_xray'), style)
  assert.equal(resolveWidgetViewStyle(style), style)
  assert.equal(JSON.stringify(style), before)
  assert.deepEqual(widgetSurfacePresentation(resolved), { skin: 'glass', backdrop: 'blur(12px) saturate(125%)', variables: { '--surface-accent': '#68d5ff', '--surface-backdrop-filter': 'blur(12px) saturate(125%)' } })
})

test('overrides cannot change binding, content, layout, visibility, nested overrides or arbitrary CSS', () => {
  const style = { color: '#123456', fontSize: 21, padding: 9, viewOverrides: { device_detail: {
    data: { pointId: 'other' }, content: { text: 'replaced' }, frame: { width: 20 }, visibility: {},
    fontSize: 100, padding: 100, viewOverrides: { x: {} }, '--custom': 'url(https://invalid)',
    background: 'url(https://invalid)', borderRadius: -1, opacity: 2, shadow: 'url(https://invalid)',
    surfaceSkin: 'other', surfaceAccent: '#ffffff; display:none', backdropFilter: 'blur(999px)',
    boxShadow: 'url(https://invalid)', color: '#abcdef'
  } } }
  assert.deepEqual(resolveWidgetViewStyle(style, 'device_detail'), { ...style, color: '#abcdef' })
  assert.ok(!VIEW_STYLE_OVERRIDE_KEYS.includes('viewOverrides'))
  const bad = JSON.parse('{"viewOverrides":{"__proto__":{"color":"#ffffff"}}}')
  assert.equal(resolveWidgetViewStyle(bad, '__proto__'), bad, 'prototype names are not applied as object fields')
})

test('inline removes duplicated inner glass; glass defaults keep the source accent and old backdrop', () => {
  assert.deepEqual(widgetSurfacePresentation({ surfaceSkin: 'inline' }), { skin: 'inline', backdrop: 'none', variables: { '--surface-backdrop-filter': 'none' } })
  assert.deepEqual(widgetSurfacePresentation({ surfaceSkin: 'glass' }), { skin: 'glass', backdrop: undefined, variables: { '--surface-accent': '#a2a7ed' } })
  assert.equal(widgetSurfacePresentation({ surfaceSkin: 'glass', surfaceAccent: 'url(bad)' }, '#68d5ff').variables['--surface-accent'], '#68d5ff')
  assert.equal(surfaceBackdropFilter('blur(12px) saturate(125%)'), 'blur(12px) saturate(125%)')
  for (const invalid of ['blur(41px)', 'blur(12px) saturate(301%)', 'blur(-1px)', 'url(#blur)', {}, 'none; color:red']) assert.equal(surfaceBackdropFilter(invalid), undefined)
})

test('normalization preserves skin and pure view style objects without normalizing the actual scene', () => {
  const style = { surfaceSkin: 'inline', backdropFilter: 'none', surfaceAccent: '#a2a7ed', viewOverrides: { device_detail: { surfaceSkin: 'glass', borderColor: '#ffc45f' } } }
  const widget = normalizeDashboardWidget({ id: 'isolated', type: 'trend', frame: { x: 0, y: 0, width: 406, height: 392 }, style })
  for (const key of Object.keys(style)) assert.deepEqual(widget.style[key], style[key])
  assert.notEqual(widget.style.viewOverrides, style.viewOverrides)
})

test('basic cards and approved modules share the actual surface rules without importing module flow/type sizing', async () => {
  const source = await readFile(new URL('../src/runtime/WidgetRenderer.vue', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/runtime/widgetSurfaceSkin.css', import.meta.url), 'utf8')
  const modules = await readFile(new URL('../src/runtime/hudModules.css', import.meta.url), 'utf8')
  assert.match(source, /resolveWidgetViewStyle\(objectValue\(props\.widget\.style/)
  assert.match(source, /'widget-surface-glass': surfacePresentation\.skin === 'glass'/)
  assert.match(source, /<style src="\.\/widgetSurfaceSkin\.css"><\/style>/)
  assert.match(modules, /var\(--module-accent\) 12%, transparent/)
  assert.match(modules, /width: min\(96px, 34%\)/)
  assert.match(modules, /\.hud-widget\.widget-type-trend \.widget-shell\.widget-surface-glass/)
  const { compileStyle } = await import('vue/compiler-sfc')
  const { rawResult, errors } = compileStyle({ source: modules, id: 'shared-surface-contract' })
  assert.deepEqual(errors, [])
  const shared = []
  rawResult.root.walkRules(rule => {
    if (rule.selector.includes('.hud-module-shell') && rule.selector.includes('.widget-surface-glass')) shared.push(rule)
  })
  assert.ok(shared.length >= 4, 'base surface, bloom, hairline and hover all have one shared rule')
  for (const rule of shared) rule.walkDecls(declaration => {
    assert.ok(!['padding','font-size','font-weight','letter-spacing','container-type'].includes(declaration.prop), 'shared surfaces must not rearrange basic children')
  })
  assert.doesNotMatch(css, /radial-gradient|linear-gradient|widget-surface-glass\s*[{:]/)
  assert.doesNotMatch(css, /(?:font-size|font-weight|letter-spacing|padding|container-type)\s*:/)
})
