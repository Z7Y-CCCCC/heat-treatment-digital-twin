import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileStyle } from 'vue/compiler-sfc'

const sourceUrl = new URL('../src/views/admin/components/DataCenterWorkspace.vue', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const { descriptor, errors } = parse(source)
assert.deepEqual(errors, [])
const style = descriptor.styles[0]
const plain = compileStyle({ source: style.content, filename: sourceUrl.pathname, id: 'data-v-center-readability' })
assert.deepEqual(plain.errors, [])
const declarations = new Map()
plain.rawResult.root.walkRules(rule => {
  if (rule.parent.type === 'atrule') return
  const values = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
  for (const selector of rule.selector.split(',').map(value => value.trim())) {
    declarations.set(selector, { ...declarations.get(selector), ...values })
  }
})
function property(selector, name) {
  assert.ok(declarations.has(selector), `Missing style for ${selector}`)
  return declarations.get(selector)[name]
}
function fontSize(selector) {
  const value = property(selector, 'font-size')
  assert.match(value, /^calc\(\d+px \* var\(--admin-font-scale,\s*1\)\)$/)
  return Number(value.match(/\d+/)[0])
}
function luminance(color) {
  assert.match(color, /^#(?:[\da-f]{3}|[\da-f]{6})$/i)
  const hex = color.length === 4 ? [...color.slice(1)].map(value => value + value).join('') : color.slice(1)
  return [0, 2, 4].map(index => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
}
function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + .05) / (values[1] + .05)
}

test('data center readability changes remain scoped and do not reach sibling admin pages or slot internals', () => {
  assert.equal(descriptor.styles.length, 1)
  assert.equal(style.scoped, true)
  assert.doesNotMatch(style.content, /:deep\(|:global\(|:slotted\(|\b(?:html|body)\s*\{|#app/)
  const compiled = compileStyle({ source: style.content, filename: sourceUrl.pathname, id: 'data-v-center-readability', scoped: true })
  assert.deepEqual(compiled.errors, [])
  compiled.rawResult.root.walkRules(rule => assert.match(rule.selector, /\[data-v-center-readability\]/))
})

test('all data center text preserves admin scaling and no helper text falls below 13px at normal scale', () => {
  const fontDeclarations = []
  plain.rawResult.root.walkDecls('font-size', declaration => fontDeclarations.push(declaration))
  assert.ok(fontDeclarations.length >= 35)
  for (const declaration of fontDeclarations) {
    assert.match(declaration.value, /^calc\(\d+px \* var\(--admin-font-scale,\s*1\)\)$/,
      `${declaration.parent.selector} must retain admin font scaling`)
    assert.ok(Number(declaration.value.match(/\d+/)[0]) >= 13, `${declaration.parent.selector} text is too small`)
  }
  for (const selector of ['.data-center', '.fields-table', '.data-center input', '.data-center select', '.table-card strong']) {
    assert.equal(fontSize(selector), 15)
  }
  for (const selector of ['.center-button', '.category-choice', '.category-actions button', '.category-form button', '.field-edit', '.fields-table th']) {
    assert.ok(fontSize(selector) >= 14 && fontSize(selector) <= 15)
  }
  for (const selector of ['.category-note', '.table-card-meta', '.table-card>small', '.fields-table td:first-child small', '.field-value>small', '.quality-label', '.fields-section>footer']) {
    assert.equal(fontSize(selector), 13)
  }
})

test('normal text, field names, values, category counts and actions meet WCAG 4.5:1 on their actual light surfaces', () => {
  const cases = [
    ['.data-center'], ['.catalog-topline p'],
    ['.center-button', '.center-button'], ['.center-button.primary', '.center-button.primary'],
    ['.category-sidebar>header', '.category-sidebar'], ['.category-choice', '.category-sidebar'],
    ['.category-choice', '.category-choice:hover'], ['.category-choice small', '.category-sidebar'],
    ['.category-choice.active', '.category-choice.active'], ['.category-choice.active small', '.category-choice.active'],
    ['.category-actions button', '.category-sidebar'], ['.category-form label', '.category-sidebar'],
    ['.category-form button', '.category-sidebar'], ['.category-note', '.category-sidebar'],
    ['.data-center input'], ['.data-center input::placeholder'], ['.catalog-caption'], ['.catalog-caption>small'],
    ['.table-card strong', '.table-card'], ['.table-card strong', '.table-card.active'],
    ['.table-card-meta', '.table-card.active'], ['.table-card-meta i', '.table-card.active'], ['.table-card>small', '.table-card.active'],
    ['.fields-section h4'], ['.fields-section header p'], ['.fields-section header>span'],
    ['.fields-table th', '.fields-table th'], ['.fields-table td'], ['.fields-table td', '.fields-table tbody tr:hover'],
    ['.fields-table td strong'], ['.fields-table td:first-child small', '.fields-table tbody tr:hover'],
    ['.field-value>span'], ['.field-value>small', '.fields-table tbody tr:hover'], ['.field-edit'], ['.fields-section>footer'],
    ['.catalog-empty'], ['.catalog-empty h4'], ['.small-empty'],
    ['.field-save', '.field-save'], ['.data-center .field-inline-input', '.data-center .field-inline-input'],
    ['.external-table-guide', '.external-table-guide'], ['.external-table-guide button', '.external-table-guide']
  ]
  for (const [selector, surface] of cases) {
    const foreground = property(selector, 'color')
    const background = surface ? property(surface, 'background') : '#fff'
    const ratio = contrast(foreground, background)
    assert.ok(ratio >= 4.5, `${selector} on ${surface || 'white'} has only ${ratio.toFixed(2)}:1 contrast`)
  }
  assert.ok(contrast(property('.center-button.primary', 'color'), property('.center-button.primary:hover', 'background')) >= 4.5)
})

test('normal, configured, stale and bad reading states retain readable labels rather than pastel-only indicators', () => {
  for (const selector of ['.quality-label', '.quality-label.good', '.quality-label.configured', '.quality-label.stale', '.quality-label.bad', '.center-message', '.center-message.error']) {
    const ratio = contrast(property(selector, 'color'), property(selector, 'background'))
    assert.ok(ratio >= 4.5, `${selector} state label has only ${ratio.toFixed(2)}:1 contrast`)
  }
  assert.equal(property('.quality-label i', 'background'), 'currentColor')
  assert.equal(property('.quality-label', 'white-space'), 'nowrap')
})

test('larger fonts have breathing room and responsive controls can grow with admin scale', () => {
  assert.equal(property('.data-center', 'line-height'), '1.6')
  assert.equal(property('.fields-table', 'line-height'), '1.6')
  assert.equal(property('.fields-table td', 'padding'), '16px')
  assert.match(property('.center-button', 'min-height'), /42px \* var\(--admin-font-scale/)
  assert.match(property('.catalog-search', 'height'), /42px \* var\(--admin-font-scale/)
  assert.match(property('.catalog-tools select', 'min-height'), /42px \* var\(--admin-font-scale/)
  assert.equal(property('.catalog-caption', 'flex-wrap'), 'wrap')
  assert.equal(property('.catalog-actions', 'flex-wrap'), 'wrap')
  assert.match(style.content, /@media\(max-width:1150px\)/)
  assert.match(style.content, /@media\(max-width:760px\)/)
})
