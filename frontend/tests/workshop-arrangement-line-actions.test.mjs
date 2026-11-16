import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileStyle } from 'vue/compiler-sfc'

const url = new URL('../src/views/admin/components/WorkshopArrangement.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(url, 'utf8'))
assert.deepEqual(errors, [])
const compiled = compileScript(descriptor, {
  id: 'workshop-line-actions-test', inlineTemplate: true,
  templateOptions: { compilerOptions: { hoistStatic: false } }
}).content.replace(/from (['"])vue\1/g, `from ${JSON.stringify(import.meta.resolve('vue'))}`)
const { default: Arrangement } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null, style: {},
  addEventListener() {}, removeEventListener() {}
})
const all = root => [root, ...root.children.flatMap(all)]
const content = root => root.type === '#comment' ? '' : root.text + root.children.map(content).join('')
const hasClass = (element, name) => String(element.props.class || '').split(/\s+/).includes(name)
const byClass = (root, name) => all(root).filter(element => hasClass(element, name))
const byLabel = (root, label) => all(root).find(element => element.type === 'button' && element.props['aria-label'] === label)

async function fixture(t, extra = {}) {
  const renderer = createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (element, text) => element.text = text,
    setElementText: (element, text) => { element.text = text; element.children = [] },
    patchProp: (element, key, previous, value) => element.props[key] = value,
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    insert(element, parent, anchor) {
      if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
      element.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element)
    },
    remove(element) {
      if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
      element.parent = null
    }
  })
  const events = [], root = node('root'), props = {
    workshops: [{ id: 'w1', name: '第一车间' }], workshopId: 'w1', lineId: 'l1', layer: 'line',
    lines: [{ id: 'l1', workshop_id: 'w1', name: 'A 产线' }, { id: 'l2', workshop_id: 'w1', name: 'B 产线' },
      { id: 'other', workshop_id: 'w2', name: '其他车间产线' }],
    devices: [{ id: 'd1', name: '炉', arrangementWorkshopId: 'w1', arrangementLineId: 'l1' }],
    canViewLines: true, canViewDevices: true, canCreateLine: true, canDeleteLine: true,
    onCreateLine: () => events.push(['create-line']), onEditLine: id => events.push(['edit-line', id]),
    onDeleteLine: id => events.push(['delete-line', id]), onLine: id => events.push(['line', id]),
    onOverview: () => events.push(['overview']), ...extra
  }
  async function render(patch = {}) {
    Object.assign(props, patch)
    renderer.render(h(Arrangement, { ...props }), root)
    await nextTick()
  }
  t.after(() => renderer.render(null, root))
  await render()
  return { root, events, render }
}

async function click(button) {
  assert.ok(button, 'the action button exists')
  assert.equal(Boolean(button.props.disabled), false, 'the action is enabled')
  let stopped = false
  const event = { target: button, stopPropagation: () => { stopped = true } }
  for (let element = button; element; element = element.parent) {
    element.props.onClick?.(event)
    if (stopped) break
  }
  await nextTick()
  return stopped
}

function assertIcon(button) {
  assert.equal(content(button).trim(), '', 'the button displays an icon without action text')
  assert.equal(button.props.title, button.props['aria-label'], 'a tooltip preserves the action meaning')
  const icons = all(button).filter(element => element.type === 'svg')
  assert.equal(icons.length, 1)
  assert.equal(icons[0].props['aria-hidden'], 'true')
}

test('add-line icon belongs to the production-line section, not the object-list or workshop overview', async t => {
  const f = await fixture(t)
  const title = byClass(f.root, 'arrangement-tree-title')[0], linesTitle = byClass(f.root, 'arrangement-lines-title')[0]
  const add = byLabel(f.root, '新增产线'), overview = byClass(f.root, 'arrangement-workshop-row')[0]
  assert.ok(linesTitle)
  assert.match(content(linesTitle), /产线/)
  assert.match(content(linesTitle), /2/)
  assert.ok(all(linesTitle).includes(add))
  assert.ok(!all(title).includes(add))
  assert.ok(!all(overview).includes(add))
  assert.match(content(overview), /第一车间.*总览/)
  assertIcon(add)
  await click(add)
  assert.deepEqual(f.events, [['create-line']])
  await click(overview)
  assert.deepEqual(f.events, [['create-line'], ['overview']], 'overview remains an independent navigation action')
  await f.render({ lines: [] })
  assert.ok(byLabel(f.root, '新增产线'), 'a workshop with no lines can still create its first line')
})

test('edit and delete icons follow the selected line name in one header without nested buttons', async t => {
  const f = await fixture(t), header = byClass(f.root, 'arrangement-line-header')[0]
  const select = byClass(header, 'arrangement-line-row')[0], actions = byClass(header, 'arrangement-line-actions')[0]
  const count = byClass(header, 'arrangement-line-count')[0], edit = byLabel(header, '编辑产线 A 产线'), remove = byLabel(header, '删除产线 A 产线')
  assert.equal(header.type, 'div')
  assert.equal(select.parent, header)
  assert.equal(actions.parent, header)
  assert.equal(count.parent, header)
  assert.ok(header.children.indexOf(select) < header.children.indexOf(actions))
  assert.ok(header.children.indexOf(actions) < header.children.indexOf(count))
  assert.match(content(select), /A 产线/)
  assert.equal(content(count).trim(), '1')
  assert.equal(all(select).filter(element => element !== select && element.type === 'button').length, 0)
  assertIcon(edit); assertIcon(remove)
  assert.equal(await click(edit), true, 'edit stops propagation')
  assert.equal(await click(remove), true, 'delete stops propagation')
  assert.deepEqual(f.events, [['edit-line', 'l1'], ['delete-line', 'l1']], 'management icons cannot select a line')
  await click(select)
  assert.deepEqual(f.events.at(-1), ['line', 'l1'])
  await f.render({ lineId: 'l2' })
  assert.equal(byLabel(f.root, '编辑产线 A 产线'), undefined)
  assert.ok(byLabel(f.root, '编辑产线 B 产线'), 'actions remain scoped to the selected production line')
})

test('line-management icons preserve permission gates and busy disabling', async t => {
  const f = await fixture(t)
  await f.render({ busy: true })
  for (const label of ['新增产线', '编辑产线 A 产线', '删除产线 A 产线']) {
    assert.equal(byLabel(f.root, label).props.disabled, true, label)
  }
  await f.render({ busy: false, canCreateLine: false })
  assert.equal(byLabel(f.root, '新增产线'), undefined)
  assert.equal(byLabel(f.root, '编辑产线 A 产线'), undefined)
  assert.ok(byLabel(f.root, '删除产线 A 产线'))
  await f.render({ canCreateLine: true, canDeleteLine: false })
  assert.ok(byLabel(f.root, '新增产线'))
  assert.ok(byLabel(f.root, '编辑产线 A 产线'))
  assert.equal(byLabel(f.root, '删除产线 A 产线'), undefined)
  await f.render({ layer: 'workshop' })
  assert.equal(byClass(f.root, 'arrangement-line-actions').length, 0)
  await f.render({ canViewLines: false })
  assert.equal(byLabel(f.root, '新增产线'), undefined)
})

test('line header styles keep icon controls on one row and retain keyboard focus', () => {
  const css = descriptor.styles.map(style => style.content).join('\n')
  for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename: url.pathname, id: 'workshop-line-actions-test', scoped: style.scoped }).errors, [])
  assert.match(css, /\.arrangement-line-header\{[^}]*display:flex;[^}]*align-items:center/)
  assert.match(css, /\.arrangement-line-actions\{[^}]*display:flex;[^}]*flex:none/)
  assert.match(css, /\.arrangement-line-row\{[^}]*min-width:0/)
  assert.match(css, /\.arrangement-line-actions button[^}]*\{[^}]*width:/)
  assert.match(css, /button:focus-visible[^}]*outline:/)
})
