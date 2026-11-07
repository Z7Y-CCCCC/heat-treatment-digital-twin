import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'

const componentNames = ['DataSourceWorkspace', 'DataSetWorkspace', 'DataSourceConnectionForm', 'DataSourcePreview']

const sharedCssUrl = new URL('../src/views/admin/styles/form-controls.css', import.meta.url)
const sharedCss = await readFile(sharedCssUrl, 'utf8')
const views = new Map(await Promise.all(componentNames.map(async name => {
  const url = new URL(`../src/views/admin/components/${name}.vue`, import.meta.url)
  const source = await readFile(url, 'utf8')
  const parsed = parse(source, { filename: url.pathname })
  const ownCss = parsed.descriptor.styles.filter(style => !style.src).map(style => style.content).join('\n')
  const style = compileStyle({ source: ownCss, filename: url.pathname, id: `readability-${name}`, scoped: false })
  const shared = compileStyle({ source: sharedCss, filename: sharedCssUrl.pathname, id: 'readability-shared', scoped: false })
  return [name, { name, source, descriptor: parsed.descriptor, parseErrors: parsed.errors, ownCss, style, shared }]
})))

const normalizeSelector = selector => selector.trim().replace(/\s+/g, ' ')
function propertyFrom(root, selector, property) {
  let value
  root.walkRules(rule => {
    if (!rule.selectors.some(candidate => normalizeSelector(candidate) === normalizeSelector(selector))) return
    rule.walkDecls(declaration => {
      if (declaration.prop === property) value = declaration.value
      // font resets font-size too. In particular a local "font:inherit" must
      // not accidentally be treated as the shared .input's larger 14px font.
      if (property === 'font-size' && declaration.prop === 'font') value = 'inherit'
    })
  })
  return value
}
function propertyAt(view, selector, property) {
  return propertyFrom(view.style.rawResult.root, selector, property)
    ?? propertyFrom(view.shared.rawResult.root, selector, property)
}
function scaledFont(view, selectors, minimum, label) {
  let value
  for (const selector of selectors) {
    const candidate = propertyAt(view, selector, 'font-size')
    if (candidate && candidate !== 'inherit') { value = candidate; break }
  }
  assert.ok(value, `${view.name}: ${label} has no explicit/resolved font size`)
  return scaledValue(view, value, minimum, label)
}
function scaledValue(view, value, minimum, label) {
  const match = value.match(/^calc\(\s*(\d+(?:\.\d+)?)px\s*\*\s*var\(--admin-font-scale(?:\s*,\s*1)?\)\s*\)$/)
  assert.ok(match, `${view.name}: ${label} must retain --admin-font-scale, got ${value}`)
  assert.ok(Number(match[1]) >= minimum, `${view.name}: ${label} is ${match[1]}px; requires >= ${minimum}px before the user's scale`)
  return Number(match[1])
}

function luminance(color) {
  const hex = color.trim().replace(/^#/, '')
  assert.match(hex, /^(?:[a-f\d]{3}|[a-f\d]{6})$/i, `Contrast fixture needs an opaque hex color, got ${color}`)
  const expanded = hex.length === 3 ? [...hex].map(channel => channel + channel).join('') : hex
  const [r, g, b] = expanded.match(/../g).map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrastRatio(foreground, background) {
  const first = luminance(foreground), second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}
function readableColor(view, selector, background = '#ffffff', fallback) {
  const foreground = propertyAt(view, selector, 'color') ?? fallback
  assert.ok(foreground, `${view.name}: ${selector} requires a text color or documented inherited color`)
  const ratio = contrastRatio(foreground, background)
  assert.ok(ratio >= 4.5, `${view.name}: ${selector} text ${foreground} on ${background} is ${ratio.toFixed(2)}:1; requires >= 4.5:1`)
}

for (const [name, view] of views) {
  test(`${name}: child SFC parses and compiles with component-scoped readability styles`, () => {
    assert.deepEqual(view.parseErrors, [])
    assert.equal(view.descriptor.script, null, 'These components remain script-setup-only')
    assert.ok(view.descriptor.scriptSetup)
    assert.doesNotThrow(() => compileScript(view.descriptor, { id: `readability-${name}` }))
    assert.deepEqual(compileTemplate({ source: view.descriptor.template.content, filename: `${name}.vue`, id: `readability-${name}` }).errors, [])
    assert.deepEqual(view.style.errors, [])
    assert.deepEqual(view.shared.errors, [])
    assert.ok(view.descriptor.styles.every(style => style.scoped), 'Readability styles must stay component-scoped')
  })

  test(`${name}: ordinary text stays at least 13px; compact source captions retain readable explicit user scaling`, () => {
    let count = 0
    view.style.rawResult.root.walkDecls('font-size', declaration => {
      // Only real font sizes are tested, not borders, dot dimensions, outlines
      // or disabled opacity. Decorative SVG/icon colors are checked separately
      // from textual status labels by the explicit color matrix below.
      const compactCaption = name === 'DataSourceWorkspace' && declaration.parent.selector === '.type-card-caption em'
      scaledValue(view, declaration.value, compactCaption ? 12.5 : 13, declaration.parent.selector)
      count++
    })
    assert.ok(count >= 3, 'The child must have independently readable typography, not rely solely on its parent root')
  })
}

test('source and table editors keep permission checks on both script operations and visible controls', () => {
  for (const name of ['DataSourceWorkspace', 'DataSetWorkspace']) {
    const view = views.get(name)
    assert.match(view.descriptor.scriptSetup.content, /canAdminPage\(props\.permissionPage,\s*'edit'\)/)
    assert.match(view.descriptor.scriptSetup.content, /canAdminPage\(props\.permissionPage,\s*'delete'\)/)
    assert.match(view.descriptor.template.content, /:disabled="[^"]*!canEdit[^"]*"/)
    assert.match(view.descriptor.template.content, /:disabled="[^"]*!canDelete[^"]*"/)
  }
  assert.match(views.get('DataSetWorkspace').descriptor.template.content, /<fieldset\s+:disabled="busy\s*\|\|\s*!canEdit">/)
})

test('connection form still applies edit permission and blocks mutations during upload/save', () => {
  const view = views.get('DataSourceConnectionForm')
  assert.match(view.descriptor.scriptSetup.content, /permissionDirective\s+as\s+vPermission/)
  assert.match(view.descriptor.template.content, /<fieldset[^>]*:disabled="busy\s*\|\|\s*uploading"[^>]*v-permission="\{\s*page:\s*permissionPage,\s*action:\s*'edit'\s*\}"/)
})

test('source preview remains read-only and disables reads for unavailable or busy connections', () => {
  const view = views.get('DataSourcePreview')
  const calls = [...view.descriptor.scriptSetup.content.matchAll(/adminApi\.([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1])
  assert.ok(calls.length > 0)
  assert.ok(calls.every(method => /^(?:get|inspect|preview)/.test(method)), 'A readability change cannot turn the preview into a management write')
  assert.match(view.descriptor.template.content, /:disabled="busy\s*\|\|\s*!connection\.enabled/)
})

test('child input values remain at least 15px even in table cells and special selects', () => {
  const contracts = {
    DataSourceWorkspace: [['.input'], ['.source-pager select', '.source-pager']],
    DataSetWorkspace: [['.input'], ['td .input', '.input'], ['.request-line .method-select', '.input']],
    DataSourceConnectionForm: [['.input', 'label', '.source-form']],
    DataSourcePreview: [['.input', 'label', '.source-preview']]
  }
  for (const [name, selectors] of Object.entries(contracts)) {
    for (const chain of selectors) scaledFont(views.get(name), chain, 15, chain[0])
  }
})

test('small supporting labels own their font size instead of falling back to the smaller user-agent font', () => {
  const contracts = {
    DataSourceWorkspace: ['.standalone-heading small', '.source-row-copy small', '.source-detail-heading small', '.source-health small'],
    DataSetWorkspace: ['.dataset-list-copy small', '.result-table th small'],
    DataSourcePreview: ['.preview-result small', '.preview-result-tabs small']
  }
  for (const [name, selectors] of Object.entries(contracts)) {
    for (const selector of selectors) scaledFont(views.get(name), [selector], 13, selector)
  }
})

test('text action buttons remain at least 14px without the shared btn-sm reset', () => {
  const contracts = {
    DataSourceWorkspace: [['.btn'], ['.workspace-tabs button'], ['.source-editor-tabs button'], ['.source-pager button', '.source-pager']],
    DataSetWorkspace: [['.btn'], ['nav button'], ['.text-button'], ['.dataset-list-copy strong']],
    DataSourcePreview: [['.btn'], ['.preview-result-tabs button']]
  }
  for (const [name, selectors] of Object.entries(contracts)) {
    for (const chain of selectors) scaledFont(views.get(name), chain, 14, chain[0])
  }
})

test('source labels, instructions, statuses and picker captions have normal-text contrast', () => {
  const view = views.get('DataSourceWorkspace')
  for (const selector of ['.source-workspace', '.standalone-heading strong', '.standalone-heading small', '.source-row-copy strong', '.source-row-copy small', '.source-status', '.source-status.healthy', '.source-status.unknown', '.source-status.disabled', '.source-pager', '.source-detail-heading small', '.draft-indicator', '.source-message', '.source-health', '.source-health.healthy', '.source-health>span', '.source-empty', '.type-card-caption strong', '.type-card-caption em', '.type-card-caption em.ready', '.type-card-caption em.device', '.source-footnote', '.input::placeholder']) readableColor(view, selector)
  for (const selector of ['.workspace-tabs button', '.workspace-tabs button span']) readableColor(view, selector, '#f4f6f9')
  readableColor(view, '.workspace-tabs button.active')
  readableColor(view, '.source-editor-tabs button')
  readableColor(view, '.source-editor-tabs button[aria-selected=true]')
  readableColor(view, '.btn')
  readableColor(view, '.btn-primary', propertyAt(view, '.btn-primary', 'background'))
  readableColor(view, '.btn-danger')
})

test('table editor labels, metadata, results and real status text have normal-text contrast', () => {
  const view = views.get('DataSetWorkspace')
  for (const selector of ['.dataset-workspace', '.manual-table', '.list-caption', '.list-caption span', '.dataset-list-copy small', '.dataset-detail-heading p', '.source-kind', '.dataset-state', '.dataset-state.off', 'label', '.input', '.input::placeholder', '.input-suffix span', '.section-heading strong', '.section-heading strong span', '.small-empty', '.text-button', 'td', '.preview-caption', '.result-state', '.result-state.bad', '.result-table th small', '.row-index', '.dataset-placeholder', '.dataset-placeholder strong', '.delete-dataset', '.draft-text', '.footer-note', '.dataset-message', '.bad']) readableColor(view, selector)
  readableColor(view, '.intro-step', '#fafcff')
  readableColor(view, '.dataset-intro p', '#fafcff')
  readableColor(view, '.mapping-guide', '#f7faff')
  readableColor(view, 'th', '#f8fafc')
  readableColor(view, '.request-line .method-select', '#f8faff')
  readableColor(view, 'nav button')
  readableColor(view, 'nav button[aria-selected=true]')
  readableColor(view, '.btn-primary', propertyAt(view, '.btn-primary', 'background'))
})

test('connection form instructions, labels, entered values and placeholders remain legible', () => {
  const view = views.get('DataSourceConnectionForm')
  for (const selector of ['label', '.hint', '.input', '.input::placeholder']) readableColor(view, selector)
})

test('source preview labels, sample results, tabs, counts and placeholders remain legible', () => {
  const view = views.get('DataSourcePreview')
  for (const selector of ['label', '.note', '.input', '.input::placeholder', '.preview-result strong', '.preview-result small', '.preview-result-tabs button', '.preview-result-tabs button[aria-pressed=true]', '.preview-result-tabs small', '.preview-error', '.btn']) readableColor(view, selector)
  readableColor(view, 'th', '#f4f7fb')
})

test('teleported source picker owns its scaled typography and color independently of DataCenter ancestry', () => {
  const view = views.get('DataSourceWorkspace')
  assert.match(view.descriptor.template.content, /<Teleport\s+to="body">[\s\S]*class="source-picker"/)
  assert.ok(propertyAt(view, '.source-picker', 'font-size'), 'The picker cannot rely on the non-teleported .source-workspace font')
  scaledFont(view, ['.source-picker'], 15, 'body-teleported picker')
  readableColor(view, '.source-picker', propertyAt(view, '.source-picker', 'background'))
  scaledFont(view, ['.input'], 15, 'teleported picker search/select')
  scaledFont(view, ['.type-card-caption strong'], 13.5, 'compact teleported picker card title')
  scaledFont(view, ['.type-card-caption em'], 12.5, 'compact teleported picker supporting caption')
  assert.match(view.ownCss, /\.source-picker\s*\{[^}]*line-height\s*:\s*1\.6/)
})

test('contrast calculation rejects formerly faint text without treating border/icon colors as text', () => {
  assert.ok(contrastRatio('#98a2b3', '#ffffff') < 4.5)
  assert.ok(contrastRatio('#667085', '#ffffff') >= 4.5)
  assert.ok(contrastRatio('#ffffff', '#3269df') >= 4.5)
  assert.equal(contrastRatio('#000000', '#ffffff'), 21)
})
