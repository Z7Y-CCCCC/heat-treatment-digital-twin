import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileStyle } from 'vue/compiler-sfc'
import { DATA_SOURCE_CATALOG } from '../src/views/admin/utils/dataSourceCatalog.js'

const url = new URL('../src/views/admin/components/DataSourceWorkspace.vue', import.meta.url)
const source = await readFile(url, 'utf8')
const { descriptor, errors } = parse(source, { filename: url.pathname })
assert.deepEqual(errors, [])
const css = compileStyle({ source: descriptor.styles.find(style => !style.src).content, filename: url.pathname, id: 'density-source' })
assert.deepEqual(css.errors, [])
const values = selector => {
  let declarations
  css.rawResult.root.walkRules(rule => {
    if (rule.selector === selector && rule.parent.type !== 'atrule') declarations = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
  })
  assert.ok(declarations, `Missing ${selector}`)
  return declarations
}

test('source type catalog uses a compact adaptive grid, not a fixed-height clipped list', () => {
  const grid = values('.source-catalog'), card = values('.source-type-card'), logo = values('.source-type-card > img')
  assert.match(grid['grid-template-columns'], /auto-fill.*min\(100%,190px\)/)
  assert.equal(grid.gap, '8px')
  for (const property of ['height', 'max-height', 'overflow', 'overflow-y']) assert.equal(grid[property], undefined)
  assert.equal(card['min-height'], '54px')
  assert.equal(card.padding, '8px 10px')
  assert.equal(card.overflow, undefined, 'large-font wrapping must grow instead of hiding labels')
  assert.equal(logo.width, '44px')
  assert.equal(logo.height, '26px')
})

test('only source type captions and their search tools become smaller; configuration inputs stay readable', () => {
  assert.equal(values('.type-card-caption strong')['font-size'], 'calc(13.5px * var(--admin-font-scale, 1))')
  assert.equal(values('.type-card-caption em')['font-size'], 'calc(12.5px * var(--admin-font-scale, 1))')
  assert.equal(values('.picker-tools .input')['font-size'], 'calc(13px * var(--admin-font-scale,1))')
  assert.match(values('.input')['font-size'], /^calc\(15px \* var\(--admin-font-scale,\s*1\)\)$/)
  assert.equal(values('.type-card-caption strong').color, '#344054')
  assert.equal(values('.type-card-caption em').color, '#526174')
  assert.doesNotMatch(descriptor.styles.find(style => !style.src).content, /(?:zoom|transform):\s*(?:scale|[.\d])/)
})

test('source overview shows saved connections; all 28 compact type choices appear only inside New Source', () => {
  assert.equal(DATA_SOURCE_CATALOG.length, 28)
  assert.equal(new Set(DATA_SOURCE_CATALOG.map(item => item.key)).size, 28)
  assert.equal((descriptor.template.content.match(/v-for="entry in catalog"/g) || []).length, 1)
  const homepage = descriptor.template.content.slice(0, descriptor.template.content.indexOf('<Teleport'))
  assert.doesNotMatch(homepage, /class="source-catalog"|class="source-type-card"|v-for="entry in catalog"/)
  assert.match(homepage, /class="source-overview"/)
  assert.match(homepage, /sourceSummary\.total/)
  assert.match(homepage, /暂无已配置的数据源/)
  assert.match(descriptor.template.content.slice(descriptor.template.content.indexOf('<Teleport')), /v-if="pickerOpen"[\s\S]*v-for="entry in catalog"/)
  assert.match(descriptor.scriptSetup.content, /entry\.status === 'planned'.*暂未接入/)
  assert.match(descriptor.scriptSetup.content, /entry\.status === 'device'/)
  assert.doesNotMatch(descriptor.template.content, /catalog\.slice|style="[^"]*(?:display:none|font-size)/)
})
