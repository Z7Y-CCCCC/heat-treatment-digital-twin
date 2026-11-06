import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { receiveMotionSignal, stepMotionSignal, motionTestValue, PortableMotionPlayer } from '../src/three/PortableMotionPlayer.js'
import { captureMotionEndpointDisplayStates, restoreMotionEndpointDisplayStates } from '../src/three/motionEndpointDisplayState.js'

const binding = { actionId: 'clip:feed', enabled: true, kind: 'clip', mode: 'position', clipId: 'feed', transitionSeconds: 1, invert: false, trigger: { mode: 'endpoints', extended: { dataItemId: 'push-end' }, retracted: { dataItemId: 'return-end' } } }
function frame(now, extended, retracted, overrides = {}) {
  const timestamp = 1000000 + now * 1000
  return { timestamp, motionInputOnly: true, motionInputs: { 'clip:feed': { quality: 'good', endpointFeedback: {
    extended: { dataItemId: 'push-end', value: extended, quality: 'good', timestamp, staleMs: 5000, ...overrides.extended },
    retracted: { dataItemId: 'return-end', value: retracted, quality: 'good', timestamp, staleMs: 5000, ...overrides.retracted }
  } } } }
}

test('two switches only confirm end positions; both zero cannot start or complete a timed stroke', () => {
  const state = { seconds: 0 }
  receiveMotionSignal(state, binding, frame(0, false, false), 0)
  assert.equal(state.hasSample, undefined); assert.equal(state.position, undefined); assert.equal(state.reason, '等待到位反馈')
  receiveMotionSignal(state, binding, frame(1, false, true), 1)
  assert.equal(state.position, 0); assert.equal(state.target, 0); assert.equal(state.reason, '退回到位')
  receiveMotionSignal(state, binding, frame(2, false, false), 2)
  stepMotionSignal(state, binding, 1000, 2.1, 5000)
  assert.equal(state.position, 0); assert.equal(state.target, 0); assert.equal(state.reason, '等待到位反馈'); assert.equal(state.running, false)
  receiveMotionSignal(state, binding, frame(3, true, false), 3)
  assert.equal(state.target, 1); assert.equal(state.reason, '推料到位'); assert.equal(state.position, 0)
  stepMotionSignal(state, binding, .25, 3.25, 5000)
  assert.equal(state.position, .25); assert.equal(state.seconds, 0)
  receiveMotionSignal(state, binding, frame(4, false, false), 4)
  stepMotionSignal(state, binding, 10, 4.1, 5000)
  assert.equal(state.position, .25); assert.equal(state.endpointNeedsResync, false)
})

test('conflicting, missing or bad feedback freezes and a new confirmed end realigns instead of resuming the old transition', () => {
  const state = { seconds: 0 }
  receiveMotionSignal(state, binding, frame(0, false, true), 0)
  receiveMotionSignal(state, binding, frame(1, true, false), 1)
  stepMotionSignal(state, binding, .2, 1.2, 5000)
  receiveMotionSignal(state, binding, frame(2, true, true), 2)
  assert.equal(state.position, .2); assert.equal(state.endpointStage, 'conflict'); assert.equal(state.reason, '到位反馈冲突'); assert.equal(state.endpointNeedsResync, true)
  stepMotionSignal(state, binding, 10, 2.1, 5000); assert.equal(state.position, .2)
  receiveMotionSignal(state, binding, frame(3, false, true), 3)
  assert.equal(state.position, 0); assert.equal(state.endpointNeedsResync, false)
  receiveMotionSignal(state, binding, frame(4, true, false, { extended: { quality: 'bad' } }), 4)
  assert.equal(state.position, 0); assert.equal(state.reason, '数据无效')
  receiveMotionSignal(state, binding, frame(5, false, false), 5)
  assert.equal(state.reason, '等待到位反馈'); assert.equal(state.endpointNeedsResync, true)
  receiveMotionSignal(state, binding, frame(6, true, false), 6)
  assert.equal(state.position, 1); assert.equal(state.reason, '推料到位')
  receiveMotionSignal(state, binding, { timestamp: 1007000, motionInputs: {} }, 7)
  assert.equal(state.position, 1); assert.equal(state.usable, false)
})

test('boolean feedback identities, types, qualities and timestamps must all be valid independently', () => {
  for (const bad of [{ value: 1 }, { value: 'true' }, { quality: undefined }, { dataItemId: 'other-device-point' }, { timestamp: 0 }, { timestamp: undefined }, { timestamp: 1005000 }]) {
    const state = { seconds: 0 }
    receiveMotionSignal(state, binding, frame(0, false, true), 0)
    receiveMotionSignal(state, binding, frame(1, true, false, { extended: bad }), 1)
    assert.equal(state.position, 0); assert.equal(state.usable, false); assert.equal(state.endpointNeedsResync, true)
  }
})

test('a malformed bad-quality summary cannot override good individual endpoint samples', () => {
  const state = { seconds: 0 }, data = frame(1, true, false)
  receiveMotionSignal(state, binding, frame(0, false, true), 0)
  data.motionInputs['clip:feed'].quality = 'bad'
  receiveMotionSignal(state, binding, data, 1)
  assert.equal(state.usable, false); assert.equal(state.position, 0); assert.equal(state.reason, '数据无效')
  data.motionInputs['clip:feed'].endpointFeedback.retracted.value = true
  receiveMotionSignal(state, binding, data, 1)
  assert.equal(state.reason, '到位反馈冲突')
})

test('independent read clocks reject stale/out-of-order packets and repeated transport cannot refresh a feedback source', () => {
  const state = { seconds: 0 }, direct = { ...binding, transitionSeconds: 0 }
  receiveMotionSignal(state, direct, frame(0, false, true), 0)
  receiveMotionSignal(state, direct, frame(1, true, false), 1)
  receiveMotionSignal(state, direct, frame(2, false, true, { extended: { timestamp: 1000000 } }), 2)
  assert.equal(state.position, 1); assert.equal(state.reason, '推料到位')
  receiveMotionSignal(state, direct, frame(3, true, false, { extended: { timestamp: 1001000 } }), 3)
  assert.equal(state.endpointReceivedAt.extended, 1); assert.equal(state.endpointReceivedAt.retracted, 3)
  receiveMotionSignal(state, direct, frame(7, false, true, { extended: { timestamp: 1001000 } }), 7)
  assert.equal(state.usable, false); assert.equal(state.reason, '数据超时'); assert.equal(state.position, 1)
  receiveMotionSignal(state, direct, frame(8, false, true), 8)
  assert.equal(state.position, 0)
  stepMotionSignal(state, direct, 0, 9.1, 1000)
  assert.equal(state.usable, false); assert.equal(state.endpointNeedsResync, true)
})

test('inversion changes only the displayed action direction, not the real endpoint names', () => {
  const state = { seconds: 0 }, reverse = { ...binding, invert: true, transitionSeconds: 0 }
  receiveMotionSignal(state, reverse, frame(0, false, true), 0)
  assert.equal(state.position, 1); assert.equal(state.reason, '退回到位')
  receiveMotionSignal(state, reverse, frame(1, true, false), 1)
  assert.equal(state.position, 0); assert.equal(state.reason, '推料到位')
})

test('asynchronous endpoint reads use their own TTL deadlines, not the oldest read with the smallest unrelated TTL', () => {
  const state = { seconds: 0 }
  receiveMotionSignal(state, binding, frame(3, true, false, { extended: { staleMs: 1000 }, retracted: { timestamp: 1001000, staleMs: 5000 } }), 3)
  assert.equal(state.usable, true); assert.equal(state.position, 1)
  stepMotionSignal(state, binding, .1, 3.1, 5000)
  assert.equal(state.usable, true, 'new 1s source and old-but-valid 5s source are both fresh')
  stepMotionSignal(state, binding, .1, 4.01, 5000)
  assert.equal(state.usable, false); assert.equal(state.reason, '数据超时')
})

test('local preview synthesizes a typed switch pair, not a pretend continuous field', () => {
  assert.deepEqual(motionTestValue(binding, 0), { extended: false, retracted: true })
  assert.deepEqual(motionTestValue(binding, .5), { extended: false, retracted: false })
  assert.deepEqual(motionTestValue(binding, 1), { extended: true, retracted: false })
  assert.deepEqual(motionTestValue(binding, 2), { extended: true, retracted: true })
})

test('actual Three node transforms follow only confirmed endpoints and remain frozen during waiting or conflict', () => {
  const root = new T.Group(), node = new T.Group(); node.name = 'feed_carriage'; root.add(node)
  const pkg = { nodes: [{ name: node.name, v: [1] }], clips: [{ id: 'feed', duration: 4, count: 2, tracks: [{ node: node.name, channel: 'p', size: 3, values: [0, 0, 0, 0, 0, 2] }] }] }
  const player = new PortableMotionPlayer(root, pkg, [binding])
  player.receive(frame(0, false, true), 0); player.advance(.1, .1); assert.equal(node.position.z, 0)
  player.receive(frame(1, false, false), 1); player.advance(10, 1.1); assert.equal(node.position.z, 0)
  player.receive(frame(2, true, false), 2); player.advance(.5, 2.5); assert.equal(node.position.z, 1)
  player.receive(frame(3, false, false), 3); player.advance(10, 3.1); assert.equal(node.position.z, 1)
  player.receive(frame(4, true, true), 4); player.advance(10, 4.1); assert.equal(node.position.z, 1)
  player.receive(frame(5, true, false), 5); player.advance(.1, 5.1); assert.equal(node.position.z, 2)
  player.receive(frame(6, false, true), 6); player.advance(.5, 6.5); assert.equal(node.position.z, 1)
})

test('endpoint picker and preview compile without restoring removed custom-animation authoring', () => {
  for (const file of ['MotionEndpointPicker.vue', 'MotionLinkPreview.vue']) {
    const source = fs.readFileSync(new URL(`../src/views/admin/components/${file}`, import.meta.url), 'utf8'), descriptor = parse(source).descriptor, script = compileScript(descriptor, { id: file })
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: file, id: file, compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
    assert.doesNotMatch(source, /MotionActionEditor|工艺动作/)
  }
})

test('adding an unrelated action preserves an unchanged endpoint signal and its actual waiting pose during preview rebuild', () => {
  const root = new T.Group(), node = new T.Group(), other = new T.Group(); node.name = 'feed'; other.name = 'other'; root.add(node, other)
  const pkg = { nodes: [{ name: node.name, v: [1] }, { name: other.name, v: [1] }], clips: [{ id: 'feed', duration: 4, count: 2, tracks: [{ node: node.name, channel: 'p', size: 3, values: [0, 0, 0, 0, 0, 2] }] }, { id: 'other', duration: 1, count: 2, tracks: [{ node: other.name, channel: 'p', size: 3, values: [0, 0, 0, 1, 0, 0] }] }] }
  const oldPlayer = new PortableMotionPlayer(root, pkg, [{ ...binding, transitionSeconds: 0 }])
  oldPlayer.receive(frame(0, true, false), 0); oldPlayer.advance(.1, .1)
  oldPlayer.receive(frame(1, false, false), 1); assert.equal(node.position.z, 2)
  const saved = captureMotionEndpointDisplayStates(oldPlayer)
  node.position.set(0, 0, 0)
  const newPlayer = new PortableMotionPlayer(root, pkg, [{ ...binding, transitionSeconds: 0 }, { ...binding, actionId: 'clip:other', clipId: 'other', trigger: { mode: 'condition', operator: 'eq', value: true }, dataItemId: 'other-input', mode: 'running' }])
  restoreMotionEndpointDisplayStates(saved, newPlayer)
  newPlayer.receive(frame(1, false, false), 1); newPlayer.advance(10, 1.1)
  assert.equal(node.position.z, 2); assert.equal(newPlayer.entries[0].signal.reason, '等待到位反馈'); assert.equal(newPlayer.entries[0].signal.position, 1)
  const changed = new PortableMotionPlayer(root, pkg, [{ ...binding, transitionSeconds: 0, invert: true }])
  node.position.set(0, 0, 0); restoreMotionEndpointDisplayStates(saved, changed)
  assert.equal(changed.entries[0].signal.hasSample, undefined); assert.equal(node.position.z, 0, 'changed binding cannot inherit old source pose')
})
