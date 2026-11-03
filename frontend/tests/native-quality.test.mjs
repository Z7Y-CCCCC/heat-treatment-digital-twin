import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileTemplate } from 'vue/compiler-sfc'
import { createNativeQualityControl, QUALITY_PROFILES } from '../src/runtime/nativeQuality.js'

function fixture() {
  const state = { profile: '', enabled: false, pending: '', notice: '', error: false }, sent = [], timers = new Map()
  let timerId = 0
  const control = createNativeQualityControl({ state, post: message => sent.push(message), later: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId }, cancel: id => timers.delete(id) })
  let revision = 0
  const ack = (patch = {}) => control.receive({ type: 'native_quality_state', revision: ++revision,
    profile: 'balanced', enabled: true, hotkeysEnabled: true, notify: false, ...patch })
  return { state, sent, timers, control, ack }
}

test('capsule selection changes only after the actual native acknowledgement, never optimistically', () => {
  const { state, sent, control, ack } = fixture()
  assert.equal(control.request('showcase'), false)
  ack()
  assert.equal(state.profile, 'balanced')
  assert.equal(state.notice, '')
  assert.equal(control.request('showcase'), true)
  assert.equal(state.profile, 'balanced')
  assert.equal(state.pending, 'showcase')
  assert.equal(sent[0].action, 'set_quality_profile')
  ack({ profile: 'showcase', notify: true, requestId: sent[0].requestId })
  assert.equal(state.profile, 'showcase')
  assert.equal(state.pending, '')
  assert.equal(state.notice, '画质已切换：高画质')
  assert.equal(state.error, false)
})

test('F1–F4 use the same native temporary-switch protocol; modifiers and repeats do not', () => {
  const { control, sent, ack } = fixture(); ack()
  let prevented = 0
  for (const [key, profile] of [['F1', 'integrated_gpu'], ['F2', 'balanced'], ['F3', 'showcase'], ['F4', 'auto']]) {
    control.keydown({ key, preventDefault() { prevented++ }, stopPropagation() {} })
    assert.equal(sent.at(-1).action, 'quality_hotkey')
    assert.equal(sent.at(-1).profile, profile)
  }
  for (const patch of [{ repeat: true }, { altKey: true }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
    control.keydown({ key: 'F1', ...patch, preventDefault() { assert.fail('must leave modified keys alone') } })
  }
  assert.equal(prevented, 4)
  assert.equal(sent.length, 4)
  assert.ok(sent.every(message => message.type === 'dashboard_action' && !Object.hasOwn(message, 'persist')))
})

test('stale or malformed snapshots cannot overwrite a newer profile or produce false success', () => {
  const { state, control, ack } = fixture(); ack({ revision: 10, profile: 'showcase' })
  assert.equal(control.receive({ type: 'native_quality_state', revision: 9, profile: 'integrated_gpu', notify: true }), false)
  assert.equal(control.receive({ type: 'native_quality_state', revision: 11, profile: 'unknown', notify: true }), false)
  assert.equal(state.profile, 'showcase')
  assert.equal(state.notice, '')
})

test('missing native acknowledgement times out without changing the last confirmed profile', () => {
  const { state, control, timers, ack } = fixture(); ack()
  control.request('integrated_gpu')
  const timeout = [...timers.values()].find(timer => timer.ms === 8000)
  timeout.fn()
  assert.equal(state.profile, 'balanced')
  assert.equal(state.pending, '')
  assert.equal(state.error, true)
  assert.match(state.notice, /未确认/)
})

test('repeated selections refresh one short-lived bubble; initialization and disposal never pop old success', () => {
  const { state, control, ack, timers } = fixture()
  control.query()
  ack({ profile: 'integrated_gpu' })
  assert.equal(state.notice, '')
  ack({ profile: 'integrated_gpu', notify: true })
  ack({ profile: 'integrated_gpu', notify: true })
  assert.equal([...timers.values()].filter(timer => timer.ms === 2800).length, 1)
  const expiry = [...timers.values()].find(timer => timer.ms === 2800)
  expiry.fn()
  assert.equal(state.notice, '')
  control.dispose()
  assert.equal(timers.size, 0)
  assert.equal(control.request('showcase'), false)
  assert.equal(ack({ profile: 'showcase', notify: true }), false)
})

test('both native surfaces display feedback, and the account menu contains the three-position capsule', async () => {
  const group = await readFile(new URL('../src/views/DashboardAccountDock.vue', import.meta.url), 'utf8')
  const overlay = await readFile(new URL('../src/views/DashboardOverlay.vue', import.meta.url), 'utf8')
  assert.match(group, /<QualityCapsule :state="qualityState" @select="setQuality" @query="queryQuality"/)
  assert.match(group, /<QualityNotice :state="qualityState"/)
  for (const file of ['QualityCapsule.vue', 'QualityNotice.vue']) {
    const { descriptor } = parse(await readFile(new URL(`../src/components/${file}`, import.meta.url), 'utf8'))
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: file, id: 'quality' }).errors, [])
  }
  assert.deepEqual(QUALITY_PROFILES.map(p => p.shortcut), ['F1', 'F2', 'F3'])
})

test('admin quality selector follows current runtime state and does not present a fake geometry-policy input', async () => {
  const admin=await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
  assert.match(admin,/v-model="qualitySelection"/)
  assert.match(admin,/relay: true, hotkeys: false/)
  assert.doesNotMatch(admin,/模型几何策略/)
  assert.doesNotMatch(admin,/始终保留导入模型完整几何/)
})
