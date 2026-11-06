import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { GLOBAL_VIEWS, normalizeGlobalViews } from '../../shared/viewNavigation.mjs'
import { installBrowser, json, settle } from './helpers.mjs'

const source = new URL('../src/views/admin/components/GlobalViewSection.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
let compiled = compileScript(descriptor, { id: 'global-section', inlineTemplate: true }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
  const name = match[2]
  const resolved = name.endsWith('/adminSession.js')
    ? 'data:text/javascript,export const adminFetch=(...args)=>globalThis.fetch(...args)'
    : name.startsWith('.') ? new URL(name, source).href : import.meta.resolve(name)
  compiled = compiled.replace(match[0], `from ${JSON.stringify(resolved)}`)
}
const { default: GlobalViewSection } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
const all = root => [root, ...root.children.flatMap(all)]
const hasClass = (element, name) => String(element.props.class || '').split(/\s+/).includes(name)

async function fixture(t, canEdit = true) {
  const environment = installBrowser(t), root = node('root'), requests = [], selected = []
  let config = normalizeGlobalViews({ enabled: Object.fromEntries(GLOBAL_VIEWS.map(view => [view.id, true])) })
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if (options.method === 'PUT') config = normalizeGlobalViews(JSON.parse(options.body).config)
    return json({ config, revision: 'test-revision' })
  })
  const renderer = createRenderer({
    createElement: type => node(type), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (element, value) => { element.text = value },
    setElementText: (element, value) => { element.text = value; element.children = [] },
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    patchProp: (element, key, previous, value) => { element.props[key] = value },
    insert(element, parent, anchor = null) {
      if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
      element.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element)
    },
    remove(element) { if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element) }
  })
  renderer.render(h(GlobalViewSection, { views: GLOBAL_VIEWS, selectedId: GLOBAL_VIEWS[0].id, canEdit,
    onSelect: id => selected.push(id) }), root)
  environment.beforeRestore(() => renderer.render(null, root))
  await settle(); await nextTick()
  return { root, requests, selected, find: name => all(root).find(element => hasClass(element, name)),
    rows: () => all(root).filter(element => hasClass(element, 'global-view-row')),
    putRequests: () => requests.filter(request => request.options.method === 'PUT') }
}

test('global views initially collapse, triangle and aria-expanded track only the heading toggle', async t => {
  const view = await fixture(t)
  assert.equal(view.rows().length, 0)
  assert.equal(view.find('section-heading').props['aria-expanded'], false)
  assert.equal(view.find('section-caret').props['aria-hidden'], 'true')
  assert.equal(view.find('section-caret').text, '▲')
  assert.equal(hasClass(view.find('section-caret'), 'expanded'), false)
  assert.ok(view.find('master'))
  view.find('section-heading').props.onClick(); await nextTick()
  assert.equal(view.rows().length, 7)
  assert.equal(view.find('global-view-rows').props.id, view.find('section-heading').props['aria-controls'])
  assert.equal(view.find('section-heading').props['aria-expanded'], true)
  assert.equal(hasClass(view.find('section-caret'), 'expanded'), true)
  view.find('global-view-name').props.onClick()
  assert.deepEqual(view.selected, [GLOBAL_VIEWS[0].id])
  view.find('section-heading').props.onClick(); await nextTick()
  assert.equal(view.rows().length, 0)
  assert.equal(view.putRequests().length, 0)
})

test('master enable switch remains usable while collapsed and does not expand the section', async t => {
  const view = await fixture(t)
  assert.equal(view.find('master').props['aria-checked'], true)
  assert.equal(view.find('master').props.disabled, false)
  view.find('master').props.onClick(); await settle(); await nextTick()
  assert.equal(view.putRequests().length, 1)
  const payload = JSON.parse(view.putRequests()[0].options.body)
  assert.ok(Object.values(payload.config.enabled).every(value => value === false))
  assert.equal(view.find('master').props['aria-checked'], false)
  assert.equal(view.rows().length, 0)
  assert.equal(view.find('section-heading').props['aria-expanded'], false)
  view.find('master').props.onClick(); await settle(); await nextTick()
  assert.equal(view.putRequests().length, 2)
  assert.ok(Object.values(JSON.parse(view.putRequests()[1].options.body).config.enabled).every(Boolean))
  assert.equal(view.rows().length, 0)
})

test('read-only users can expand global views but cannot mutate the independent master switch', async t => {
  const view = await fixture(t, false)
  assert.equal(view.find('master').props.disabled, true)
  view.find('master').props.onClick(); await settle()
  assert.equal(view.putRequests().length, 0)
  view.find('section-heading').props.onClick(); await nextTick()
  assert.equal(view.rows().length, 7)
})

test('triangle CSS points down when collapsed and respects reduced-motion preference', () => {
  assert.match(descriptor.styles[0].content, /\.section-caret\{[^}]*transform:rotate\(180deg\)/)
  assert.match(descriptor.styles[0].content, /\.section-caret\.expanded\{transform:rotate\(0deg\)/)
  assert.match(descriptor.styles[0].content, /@media\(prefers-reduced-motion:reduce\)\{\.section-heading \.section-caret\{transition:none\}/)
})
