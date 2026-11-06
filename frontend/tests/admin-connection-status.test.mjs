import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileStyle } from 'vue/compiler-sfc'
import { createRenderer, h, nextTick, proxyRefs } from 'vue'
import { installBrowser } from './helpers.mjs'

const base = new URL('../src/views/admin/components/', import.meta.url)
const source = await readFile(new URL('AdminConnectionStatus.vue', base), 'utf8')
const iconSource = await readFile(new URL('ConnectionPlugIcon.vue', base), 'utf8')
const vueImports = code => code.replace(/from (['"])vue\1/g, `from ${JSON.stringify(import.meta.resolve('vue'))}`)
const iconCode = vueImports(compileScript(parse(iconSource).descriptor, { id: 'connection-icon-test', inlineTemplate: true }).content)
const iconUrl = `data:text/javascript;base64,${Buffer.from(iconCode).toString('base64')}`
const exposed = source.replace('</script>', '\ndefineExpose({ root, visible, enter, leave, focusIn, focusOut, toggle, close, outside, keys, resume, suspend })\n</script>')
const componentCode = vueImports(compileScript(parse(exposed).descriptor, { id: 'connection-status-test', inlineTemplate: true }).content)
  .replace(/from (['"])\.\/ConnectionPlugIcon\.vue\1/g, `from ${JSON.stringify(iconUrl)}`)
const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(componentCode).toString('base64')}`)
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null,
  contains(target) { for (let current = target; current; current = current.parent) if (current === this) return true; return false } })
const all = root => [root, ...root.children.flatMap(all)]
const content = root => root.text + root.children.map(content).join('')
const summary = (tone = 'is-partial') => ({ modeLabel: '模拟运行', label: '模拟运行 · 2 台设备', detail: '模拟数据', tone,
  total: 2, online: 1, deviceRows: [{ id: 'a', name: '炉 A', connected: true, state: 'connected', tone: 'is-online' },
    { id: 'b', name: '炉 B', connected: false, state: 'offline', tone: 'is-offline' }] })
async function fixture(t, extra = {}) {
  const environment = installBrowser(t), root = node('root')
  const renderer = createRenderer({
    createElement: type => node(type), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (element, value) => element.text = value, setElementText: (element, value) => { element.text = value; element.children = [] },
    parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    patchProp: (element, key, previous, value) => element.props[key] = value,
    insert(element, parent, anchor) {
      if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
      element.parent = parent
      const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element)
    },
    remove(element) { if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element) }
  })
  const props = { unityConnected: true, unityClass: 'is-online', summary: summary(), ...extra }
  let vm
  async function render(patch = {}) {
    Object.assign(props, patch)
    const vnode = h(Component, { ...props }); renderer.render(vnode, root)
    vm = proxyRefs(vnode.component.exposed); await nextTick()
  }
  environment.beforeRestore(() => renderer.render(null, root)); await render()
  return { root, environment, get vm() { return vm }, render, unmount: () => renderer.render(null, root), elements: predicate => all(root).filter(predicate) }
}

test('header status buttons render the same plug silhouette with distinct assembled and separated geometry', async t => {
  const f = await fixture(t)
  const buttons = f.elements(item => item.type === 'button')
  assert.deepEqual(buttons.map(content), ['Unity', '模拟运行'])
  assert.equal(buttons[0].props['data-connection-kind'], 'unity')
  assert.equal(buttons[1].props['data-connection-kind'], 'devices')
  const icons = f.elements(item => item.type === 'svg')
  assert.deepEqual(icons.map(item => item.props['data-plug-state']), ['connected', 'disconnected'])
  assert.equal(icons[0].props['aria-hidden'], 'true')
  assert.equal(all(icons[0]).some(item => item.props.transform === 'translate(3 0)'), true)
  assert.equal(all(icons[1]).some(item => item.props.transform === 'translate(-3 0)'), true)
  assert.equal(f.elements(item => item.type === 'i').length, 0)
  await f.render({ unityConnected: false, unityClass: 'is-offline' })
  assert.equal(f.elements(item => item.type === 'svg')[0].props['data-plug-state'], 'disconnected')
})

test('hover tooltip renders device names and per-device connection icons without visible status words', async t => {
  const f = await fixture(t)
  f.vm.enter(); await nextTick()
  const rows = f.elements(item => item.type === 'li')
  assert.deepEqual(rows.map(content), ['炉 A', '炉 B'])
  assert.deepEqual(rows.map(item => item.props['data-device-id']), ['a', 'b'])
  assert.deepEqual(rows.map(item => all(item).find(child => child.type === 'svg').props['data-plug-state']), ['connected', 'disconnected'])
  assert.equal(rows[0].props['aria-label'], '炉 A：已连接')
  assert.equal(rows[1].props['aria-label'], '炉 B：未连接')
  const tooltip = f.elements(item => item.props.role === 'tooltip')[0]
  assert.doesNotMatch(content(tooltip), /已连接|未连接|在线|离线/)
  const button = f.elements(item => item.props['data-connection-kind'] === 'devices')[0]
  assert.equal(button.props['aria-describedby'], tooltip.props.id)
  f.vm.leave(); await nextTick()
  assert.equal(f.elements(item => item.props.role === 'tooltip').length, 0)
})

test('focus and click pinning keep the tooltip usable while Escape and outside click dismiss it', async t => {
  const f = await fixture(t)
  f.vm.focusIn(); await nextTick(); assert.equal(f.vm.visible, true)
  f.vm.toggle(); f.vm.leave(); await nextTick(); assert.equal(f.vm.visible, true)
  let prevented = false
  f.vm.keys({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() {} })
  await nextTick(); assert.equal(f.vm.visible, false); assert.equal(prevented, true)
  f.vm.toggle(); await nextTick(); assert.equal(f.vm.visible, true)
  f.vm.outside({ target: f.vm.root }); await nextTick(); assert.equal(f.vm.visible, true)
  f.vm.outside({ target: node('outside') }); await nextTick(); assert.equal(f.vm.visible, false)
  f.vm.focusIn(); f.vm.focusOut({ relatedTarget: f.vm.root }); assert.equal(f.vm.visible, true)
  f.vm.focusOut({ relatedTarget: null }); await nextTick(); assert.equal(f.vm.visible, false)
})

test('live updates recolor the badge and icons without freezing rows, and modes remain distinct', async t => {
  const f = await fixture(t)
  f.vm.enter(); await nextTick()
  const next = summary('is-online'); next.online = 2; next.deviceRows.forEach(item => { item.connected = true; item.tone = 'is-online' })
  await f.render({ summary: next })
  assert.equal(f.elements(item => item.props['data-connection-kind'] === 'devices')[0].props.class.includes('is-online'), true)
  assert.equal(f.elements(item => item.type === 'li').every(item => all(item).find(child => child.type === 'svg').props['data-plug-state'] === 'connected'), true)
  await f.render({ summary: { modeLabel: '外部接口', label: '外部接口', total: 0, online: 0, tone: 'is-unknown', deviceRows: [] } })
  assert.equal(f.vm.visible, false)
  const button = f.elements(item => item.props['data-connection-kind'] === 'devices')[0]
  assert.equal(content(button), '外部接口')
  assert.equal(all(button).find(item => item.type === 'svg').props['data-plug-state'], 'disconnected')
})

test('unknown devices and empty lists are not presented as connected and listeners are cleaned up', async t => {
  const f = await fixture(t, { summary: { ...summary(), online: 0, tone: 'is-unknown', deviceRows: [{ id: 'waiting', name: '等待读数设备', connected: false, state: 'pending', tone: 'is-unknown' }] } })
  f.vm.enter(); await nextTick()
  assert.equal(f.elements(item => item.type === 'li')[0].props['aria-label'], '等待读数设备：状态未知')
  await f.render({ summary: { ...summary(), deviceRows: [] } })
  assert.match(content(f.elements(item => item.props.role === 'tooltip')[0]), /尚未取得设备明细/)
  assert.equal(f.environment.browser.listeners.get('keydown').size, 1)
  f.vm.suspend(); await nextTick()
  assert.equal(f.vm.visible, false)
  assert.equal(f.environment.browser.listeners.get('keydown').size, 0)
  f.vm.resume(); f.vm.resume()
  assert.equal(f.environment.browser.listeners.get('keydown').size, 1)
  // The fixture unmount hook runs before restoring the browser globals.
  await f.render({ summary: { ...summary(), modeLabel: '现场采集' } })
  assert.equal(f.vm.visible, false)
  f.unmount()
  assert.equal(f.environment.browser.listeners.get('keydown').size, 0)
  assert.equal(f.environment.browser.listeners.get('pointerdown').size, 0)
})

test('tooltip style places a hoverable bounded list below the badge and retains accessible colors', () => {
  const descriptor = parse(source).descriptor
  const css = compileStyle({ source: descriptor.styles[0].content, id: 'connection-status-test', scoped: true })
  assert.deepEqual(css.errors, [])
  assert.match(css.code, /top:calc\(100% \+ 10px\)/)
  assert.match(css.code, /overflow:auto/)
  assert.match(css.code, /max-height:min\(340px,calc\(100vh - 140px\)\)/)
  assert.match(css.code, /\.is-online[^}]*#176b3a/)
  assert.match(css.code, /\.is-partial[^}]*#936208/)
  assert.match(css.code, /\.is-offline[^}]*#b42318/)
  assert.match(source, /onActivated\(resume\)/)
  assert.match(source, /onDeactivated\(suspend\)/)
})
