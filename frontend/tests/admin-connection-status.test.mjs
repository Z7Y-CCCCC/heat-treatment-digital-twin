import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileStyle } from 'vue/compiler-sfc'
import { createRenderer, h, nextTick, proxyRefs } from 'vue'
import { installBrowser } from './helpers.mjs'

const base = new URL('../src/views/admin/components/', import.meta.url)
const source = await readFile(new URL('AdminConnectionStatus.vue', base), 'utf8')
const vueImports = code => code.replace(/from (['"])vue\1/g, `from ${JSON.stringify(import.meta.resolve('vue'))}`)
const icons = {}
for (const name of ['ConnectionPlugIcon', 'ServiceConnectionIcon']) {
  const iconSource = await readFile(new URL(name + '.vue', base), 'utf8')
  const code = vueImports(compileScript(parse(iconSource).descriptor, { id: name + '-test', inlineTemplate: true }).content)
  icons[name] = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}
const exposed = source.replace('</script>', '\ndefineExpose({ root, panel, visible, activeKind, enter, leave, focusIn, focusOut, toggle, close, outside, keys, triggerKeys, runAction, resume, suspend })\n</script>')
const componentCode = vueImports(compileScript(parse(exposed).descriptor, { id: 'connection-status-test', inlineTemplate: true }).content)
  .replace(/from (['"])\.\/(ConnectionPlugIcon|ServiceConnectionIcon)\.vue\1/g, (_, quote, name) => `from ${JSON.stringify(icons[name])}`)
const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(componentCode).toString('base64')}`)
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null, focusCount: 0,
  focus() { this.focusCount++ },
  contains(target) { for (let current = target; current; current = current.parent) if (current === this) return true; return false },
  querySelector(selector) {
    if (selector.startsWith('[data-connection-kind=')) return all(this).find(item => item.props['data-connection-kind'] === selector.match(/"([^"]+)"/)[1])
    if (selector === '[data-connection-action]:not(:disabled)') return all(this).find(item => item.props['data-connection-action'] && !item.props.disabled)
    return null
  }
})
const all = root => [root, ...root.children.flatMap(all)]
const content = root => root.text + root.children.map(content).join('')
const plugs = root => all(root).filter(item => item.props['data-plug-state'])
const summary = (tone = 'is-partial') => ({ modeLabel: '模拟运行', label: '模拟运行 · 2 台设备', detail: '模拟数据', tone,
  total: 2, online: 1, deviceRows: [{ id: 'a', name: '炉 A', connected: true, state: 'connected', tone: 'is-online' },
    { id: 'b', name: '炉 B', connected: false, state: 'offline', tone: 'is-offline' }] })
const liveServices = () => [
  { key: 'unity', label: '场景就绪', detail: '实时通道已连接', tone: 'is-online', connected: true, lastSuccessAt: 1700000000000 },
  { key: 'devices', label: 'PLC 在线', detail: '最近读数有效', tone: 'is-online', connected: true, total: 2, online: 2,
    rows: summary().deviceRows.map(row => ({ ...row, connected: true, tone: 'is-online' })) },
  { key: 'data', label: '后台与数据库在线', detail: '数据库连接正常', tone: 'is-online', connected: true },
  { key: 'session', label: '会话有效', detail: '已登录', tone: 'is-online', connected: true }
]
async function fixture(t, extra = {}) {
  const environment = installBrowser(t), root = node('root'), events = []
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
  const props = { unityConnected: true, unityClass: 'is-online', summary: summary(), onAction: event => events.push(event), ...extra }
  let vm
  async function render(patch = {}) {
    Object.assign(props, patch)
    const vnode = h(Component, { ...props }); renderer.render(vnode, root)
    vm = proxyRefs(vnode.component.exposed); await nextTick()
  }
  environment.beforeRestore(() => renderer.render(null, root)); await render()
  return { root, environment, events, get vm() { return vm }, render, unmount: () => renderer.render(null, root),
    elements: predicate => all(root).filter(predicate), badge: kind => all(root).find(item => item.props['data-connection-kind'] === kind),
    dialog: () => all(root).find(item => item.props.role === 'dialog') }
}

test('four icon-only status pills preserve the plug silhouette and accessible semantic service names', async t => {
  const f = await fixture(t)
  const buttons = f.elements(item => item.props['data-connection-kind'])
  assert.deepEqual(buttons.map(item => item.props['data-connection-kind']), ['unity', 'devices', 'data', 'session'])
  assert.deepEqual(buttons.map(content), ['', '', '', ''])
  for (const button of buttons) {
    assert.ok(button.props['aria-label']); assert.equal(button.props.title, button.props['aria-label'])
    assert.equal(button.props['aria-haspopup'], 'dialog')
    assert.equal(plugs(button).length, 1)
    const semantic = all(button).find(item => item.props['data-service-icon'])
    assert.equal(semantic.props['data-service-icon'], button.props['data-connection-kind'])
    assert.equal(semantic.props['aria-hidden'], 'true')
  }
  assert.deepEqual(buttons.map(item => plugs(item)[0].props['data-plug-state']), ['connected', 'disconnected', 'disconnected', 'disconnected'])
  assert.equal(all(plugs(buttons[0])[0]).some(item => item.props.transform === 'translate(3 0)'), true)
  assert.equal(all(plugs(buttons[1])[0]).some(item => item.props.transform === 'translate(-3 0)'), true)
  assert.equal(f.elements(item => item.type === 'i').length, 0)
  await f.render({ unityConnected: false, unityClass: 'is-offline' })
  assert.equal(plugs(f.badge('unity'))[0].props['data-plug-state'], 'disconnected')
})

test('hover dialog preserves device names and each device plug without visible row status words', async t => {
  const f = await fixture(t)
  f.vm.enter(); await nextTick()
  const rows = f.elements(item => item.type === 'li')
  assert.deepEqual(rows.map(content), ['炉 A', '炉 B'])
  assert.deepEqual(rows.map(item => item.props['data-device-id']), ['a', 'b'])
  assert.deepEqual(rows.map(item => plugs(item)[0].props['data-plug-state']), ['connected', 'disconnected'])
  assert.equal(rows[0].props['aria-label'], '炉 A：已连接')
  assert.equal(rows[1].props['aria-label'], '炉 B：未连接')
  assert.equal(f.dialog().props['aria-modal'], 'false')
  assert.match(f.dialog().props['aria-label'], /设备采集/)
  assert.equal(f.badge('devices').props['aria-controls'], f.dialog().props.id)
  assert.equal(f.badge('devices').props['aria-expanded'], true)
  assert.equal(f.elements(item => item.props.role === 'tooltip').length, 0, 'interactive controls are never placed inside a tooltip role')
  f.vm.leave(); await nextTick()
  assert.equal(f.dialog(), undefined)
})

test('all service panels expose real status and communication time without inventing a recent success', async t => {
  const f = await fixture(t, { services: liveServices() })
  f.vm.enter('unity'); await nextTick()
  assert.match(content(f.dialog()), /场景就绪/)
  assert.equal(f.elements(item => item.type === 'time')[0].props.datetime, '2023-11-14T22:13:20.000Z')
  f.vm.enter('data'); await nextTick()
  assert.match(content(f.dialog()), /后台与数据库在线/)
  assert.match(content(f.dialog()), /尚无成功通信/)
  await f.render({ services: liveServices().map(item => ({ ...item, lastSuccessAt: 'invalid timestamp' })) })
  assert.equal(f.elements(item => item.type === 'time')[0].props.datetime, undefined)
  assert.match(content(f.dialog()), /尚无成功通信/)
  f.vm.enter('session'); await nextTick()
  assert.match(content(f.dialog()), /会话有效/)
})

test('green connected state requires verified online fresh unrestricted real communication', async t => {
  const states = [
    { connected: false }, { stale: true }, { restricted: true }, { tone: 'is-partial' }, { tone: 'is-unknown' }, { tone: 'unexpected' }
  ]
  const f = await fixture(t, { services: liveServices() })
  for (const patch of states) {
    const services = liveServices().map(item => item.key === 'unity' ? { ...item, ...patch } : item)
    await f.render({ services })
    assert.equal(plugs(f.badge('unity'))[0].props['data-plug-state'], 'disconnected')
    assert.equal(f.badge('unity').props.class.includes('is-online'), false)
  }
  await f.render({ services: liveServices().map(item => item.key === 'devices' ? { ...item, mode: 'simulation', label: '模拟运行' } : item) })
  assert.equal(f.badge('devices').props.class.includes('is-online'), false)
  assert.equal(plugs(f.badge('devices'))[0].props['data-plug-state'], 'disconnected')
  assert.match(f.badge('devices').props['aria-label'], /模拟运行/)
})

test('focus and click pinning keep panels usable while Escape restores trigger focus and outside click dismisses', async t => {
  const f = await fixture(t)
  f.vm.focusIn(); await nextTick(); assert.equal(f.vm.visible, true)
  f.vm.toggle(); f.vm.leave(); await nextTick(); assert.equal(f.vm.visible, true)
  let prevented = false
  f.vm.keys({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() {} })
  await nextTick(); assert.equal(f.vm.visible, false); assert.equal(prevented, true)
  assert.equal(f.badge('devices').focusCount, 1)
  f.vm.toggle(); await nextTick(); assert.equal(f.vm.visible, true)
  f.vm.outside({ target: f.vm.root }); await nextTick(); assert.equal(f.vm.visible, true)
  f.vm.outside({ target: node('outside') }); await nextTick(); assert.equal(f.vm.visible, false)
  f.vm.focusIn(); f.vm.focusOut({ relatedTarget: f.vm.root }); assert.equal(f.vm.visible, true)
  f.vm.focusOut({ relatedTarget: null }); await nextTick(); assert.equal(f.vm.visible, false)
  f.vm.focusIn('unity'); f.vm.toggle('unity'); f.vm.enter('devices'); await nextTick()
  assert.equal(f.vm.activeKind, 'unity', 'hovering another pill cannot steal a pinned action panel')
  f.vm.toggle('data'); await nextTick()
  assert.equal(f.vm.activeKind, 'data')
  assert.equal(f.badge('data').props['aria-expanded'], true)
  assert.equal(f.badge('unity').props['aria-expanded'], false)
})

test('icon-only whitelisted actions emit exactly once, reject disabled/unknown actions and show truthful feedback', async t => {
  const f = await fixture(t, { actions: { unity: [
    { id: 'check', label: '重新检测' }, { id: 'restart', label: '重启大屏', dangerous: true },
    { id: 'reconnect', label: '重连实时通道', disabled: true, reason: '远程展示不可操作' }, { id: 'shell', label: '任意命令' }
  ] }, feedback: { unity: { type: 'error', message: '握手超时，连接尚未恢复' } } })
  f.vm.enter('unity'); await nextTick()
  const buttons = f.elements(item => item.props['data-connection-action'])
  assert.deepEqual(buttons.map(item => item.props['data-connection-action']), ['check', 'restart', 'reconnect'])
  assert.deepEqual(buttons.map(content), ['', '', ''])
  assert.equal(buttons[0].props['aria-label'], '重新检测')
  assert.equal(buttons[1].props.class.includes('is-dangerous'), true)
  assert.equal(buttons[2].props.disabled, true); assert.match(buttons[2].props.title, /远程展示不可操作/)
  buttons[0].props.onClick()
  assert.deepEqual(f.events, [{ kind: 'unity', action: 'check' }])
  f.vm.runAction({ id: 'reconnect' }); f.vm.runAction({ id: 'shell' })
  assert.equal(f.events.length, 1)
  assert.equal(f.elements(item => item.props.role === 'alert')[0].text, '握手超时，连接尚未恢复')
  await f.render({ busy: 'unity', feedback: { unity: { type: 'success', message: '新握手已确认' } } })
  assert.equal(f.elements(item => item.props['data-connection-action']).every(item => item.props.disabled), true)
  assert.equal(f.dialog().props['aria-busy'], true)
  f.vm.runAction({ id: 'restart' }); assert.equal(f.events.length, 1)
  assert.equal(f.elements(item => item.props.role === 'status')[0].text, '新握手已确认')
  await f.render({ busy: { unity: true } })
  assert.equal(f.dialog().props['aria-busy'], true)
  await f.render({ busy: true }); assert.equal(f.dialog().props['aria-busy'], true)
})

test('ArrowDown opens and focuses a usable action; Enter and Space are left to native button activation', async t => {
  const f = await fixture(t, { actions: { data: [{ id: 'check', label: '重新检测' }] } })
  let prevented = false
  await f.vm.triggerKeys({ key: 'ArrowDown', preventDefault() { prevented = true } }, 'data')
  const action = f.elements(item => item.props['data-connection-action'] === 'check')[0]
  assert.equal(prevented, true); assert.equal(f.vm.visible, true); assert.equal(action.focusCount, 1)
  await f.vm.triggerKeys({ key: 'Enter', preventDefault() { assert.fail('native Enter must not be intercepted') } }, 'data')
  await f.vm.triggerKeys({ key: ' ', preventDefault() { assert.fail('native Space must not be intercepted') } }, 'data')
  assert.deepEqual(f.events, [])
  action.props.onClick(); assert.deepEqual(f.events, [{ kind: 'data', action: 'check' }])
})

test('an empty busy-kind string from AdminPanel means idle, not a Boolean prop true cast', async t => {
  const f = await fixture(t, { busy: '', actions: { data: [{ id: 'check', label: '重新检测' }] } })
  f.vm.enter('data'); await nextTick()
  const button = f.elements(item => item.props['data-connection-action'] === 'check')[0]
  assert.equal(button.props.disabled, false)
  assert.equal(f.dialog().props['aria-busy'], false)
  button.props.onClick()
  assert.deepEqual(f.events, [{ kind: 'data', action: 'check' }])
})

test('live updates refresh colors and rows; simulation, external mode and empty devices remain distinct', async t => {
  const f = await fixture(t)
  f.vm.enter(); await nextTick()
  const next = summary('is-online'); next.modeLabel = 'PLC 采集'; next.online = 2; next.deviceRows.forEach(item => { item.connected = true; item.tone = 'is-online' })
  await f.render({ summary: next })
  assert.equal(f.vm.visible, false, 'changing acquisition mode closes obsolete context')
  f.vm.enter(); await nextTick()
  assert.equal(f.badge('devices').props.class.includes('is-online'), true)
  assert.equal(f.elements(item => item.type === 'li').every(item => plugs(item)[0].props['data-plug-state'] === 'connected'), true)
  await f.render({ summary: { modeLabel: '外部接口', label: '外部接口', total: 0, online: 0, tone: 'is-unknown', deviceRows: [] } })
  assert.equal(f.vm.visible, false); assert.match(f.badge('devices').props['aria-label'], /外部接口/)
  assert.equal(plugs(f.badge('devices'))[0].props['data-plug-state'], 'disconnected')
  f.vm.enter(); await nextTick()
  assert.match(content(f.dialog()), /暂无可显示的设备/)
})

test('authoritative service mode ignores late legacy engine-summary changes but closes on its own context change', async t => {
  const services = liveServices().map(item => item.key === 'devices' ? { ...item, mode: 'integrated_plc' } : item)
  const f = await fixture(t, { services })
  f.vm.enter('devices'); await nextTick()
  await f.render({ summary: { ...summary(), modeLabel: '外部接口' } })
  assert.equal(f.vm.visible, true, 'late legacy polling cannot dismiss an authoritative service panel')
  await f.render({ services: services.map(item => item.key === 'devices' ? { ...item, mode: 'external' } : item) })
  assert.equal(f.vm.visible, false, 'the active service context itself still invalidates its panel')
})

test('unknown, stale and restricted devices never leak detail or render a connected plug; listeners clean up', async t => {
  const f = await fixture(t, { summary: { ...summary(), online: 0, tone: 'is-unknown', deviceRows: [{ id: 'waiting', name: '等待读数设备', connected: false, state: 'pending', tone: 'is-unknown' }] } })
  f.vm.enter(); await nextTick()
  assert.equal(f.elements(item => item.type === 'li')[0].props['aria-label'], '等待读数设备：状态未知')
  await f.render({ summary: { ...summary(), deviceRows: [] } })
  assert.match(content(f.dialog()), /尚未取得设备明细/)
  await f.render({ summary: { ...summary(), deviceRows: [{ id: 'stale', name: '过期设备', connected: true, stale: true, tone: 'is-online' }] } })
  assert.equal(plugs(f.elements(item => item.type === 'li')[0])[0].props['data-plug-state'], 'disconnected')
  assert.equal(f.elements(item => item.type === 'li')[0].props.class, 'is-partial')
  await f.render({ services: liveServices().map(item => item.key === 'devices' ? { ...item, restricted: true, label: '无权限查看', rows: [{ id: 'private', name: '不应泄露的设备' }] } : item) })
  f.vm.enter('devices'); await nextTick()
  assert.equal(f.elements(item => item.type === 'li').length, 0)
  assert.doesNotMatch(content(f.dialog()), /不应泄露/)
  assert.match(content(f.dialog()), /无权限查看设备明细/)
  assert.equal(f.environment.browser.listeners.get('keydown').size, 1)
  f.vm.suspend(); await nextTick()
  assert.equal(f.vm.visible, false); assert.equal(f.environment.browser.listeners.get('keydown').size, 0)
  f.vm.resume(); f.vm.resume(); assert.equal(f.environment.browser.listeners.get('keydown').size, 1)
  f.unmount()
  assert.equal(f.environment.browser.listeners.get('keydown').size, 0)
  assert.equal(f.environment.browser.listeners.get('pointerdown').size, 0)
  assert.equal(f.environment.browser.listeners.get('resize').size, 0)
})

test('panels and long device lists are bounded and scrollable, pill palette/size and lifecycle stay consistent', async () => {
  const descriptor = parse(source).descriptor
  const css = compileStyle({ source: descriptor.styles[0].content, id: 'connection-status-test', scoped: true })
  assert.deepEqual(css.errors, [])
  assert.match(css.code, /top:calc\(100% \+ 10px\)/)
  assert.match(css.code, /overflow:auto/)
  assert.match(css.code, /max-height:calc\(100dvh - 110px\)/)
  assert.match(css.code, /max-height:min\(340px,calc\(100dvh - 280px\)\)/)
  assert.match(css.code, /height:32px/)
  assert.match(css.code, /flex-wrap:wrap/)
  assert.match(css.code, /\.is-online[^}]*#176b3a/)
  assert.match(css.code, /\.is-partial[^}]*#936208/)
  assert.match(css.code, /\.is-offline[^}]*#b42318/)
  assert.match(source, /onActivated\(resume\)/)
  assert.match(source, /onDeactivated\(suspend\)/)
  const icon = parse(await readFile(new URL('ServiceConnectionIcon.vue', base), 'utf8')).descriptor
  assert.deepEqual(compileStyle({ source: icon.styles[0].content, id: 'service-icon-test', scoped: true }).errors, [])
  assert.match(icon.styles[0].content, /prefers-reduced-motion:reduce/)
})
