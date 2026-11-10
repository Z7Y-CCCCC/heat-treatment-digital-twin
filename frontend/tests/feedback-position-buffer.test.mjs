import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import { FeedbackPositionBuffer, FEEDBACK_POSITION_CAPACITY, feedbackSmoothingDelay } from '../src/three/FeedbackPositionBuffer.js'
import { receiveMotionSignal, stepMotionSignal, PortableMotionPlayer } from '../src/three/PortableMotionPlayer.js'

const epoch = 1000000
const bindingFor = (patch = {}) => ({ actionId: 'clip:pose', enabled: true, kind: 'clip', clipId: 'pose', mode: 'position',
  dataItemId: 'point:pose', trigger: { mode: 'range' }, inputMin: 0, inputMax: 100,
  invert: false, speed: 1, transitionSeconds: 10, feedbackSmoothingMs: 200, ...patch })
const frame = (value, source, now = source, patch = {}) => ({ timestamp: epoch + now * 1000, motionInputOnly: true,
  motionInputs: { 'clip:pose': { dataItemId: 'point:pose', value, quality: 'good', timestamp: epoch + source * 1000,
    staleMs: 10000000, ...patch } } })
const read = (state, binding, value, source, now = source, patch) =>
  receiveMotionSignal(state, binding, frame(value, source, now, patch), now, epoch + now * 1000)
const step = (state, binding, now, delta = .01, staleMs = 10000) => stepMotionSignal(state, binding, delta, now, staleMs)
const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`)

test('feedback delay accepts only finite positive numeric position settings, never condition, endpoint or running semantics', () => {
  assert.equal(feedbackSmoothingDelay(bindingFor()), .2)
  assert.equal(feedbackSmoothingDelay(bindingFor({ feedbackSmoothingMs: 1000 })), 1)
  for (const feedbackSmoothingMs of [undefined, 0, -1, 1001, NaN, Infinity, '200', true, null]) {
    assert.equal(feedbackSmoothingDelay(bindingFor({ feedbackSmoothingMs })), 0)
  }
  for (const patch of [{ mode: 'running' }, { mode: undefined }, { trigger: { mode: 'condition' } }, { trigger: { mode: 'endpoints' } }]) {
    assert.equal(feedbackSmoothingDelay(bindingFor(patch)), 0)
  }
})

test('bounded position history aligns its first real sample, interpolates only real brackets and never predicts or rewinds', () => {
  const buffer = new FeedbackPositionBuffer(bindingFor())
  assert.equal(buffer.append(1, .3, epoch + 1000, 30), true)
  near(buffer.sample(.8), .3, 'first observation cannot invent an older pose')
  assert.equal(buffer.count, 1)
  assert.equal(buffer.append(1.2, .7, epoch + 1200, 70), false)
  near(buffer.sample(1.1), .5)
  near(buffer.sample(1.15), .6)
  near(buffer.sample(1.1), .6, 'regressed display time must not rewind')
  near(buffer.sample(2), .7, 'missing future observation holds the newest real position')
  near(buffer.sample(200), .7, 'long transport silence is not extrapolated')
})

test('200ms numeric feedback joins source segments each render step without stacking the old full-span slew', () => {
  const binding = bindingFor(), state = { seconds: 0 }
  read(state, binding, 0, 0); read(state, binding, 2, .2)
  near(state.target, .02); near(state.position, 0)
  for (let i = 1; i <= 20; i++) {
    const now = .2 + i * .01
    step(state, binding, now)
    near(state.position, (now - .2) * .1, 'small 2% sample must move on every render step')
  }
  read(state, binding, 4, .4); step(state, binding, .5); near(state.position, .03)
  read(state, binding, 2, .6); step(state, binding, .7); near(state.position, .03, 'real reversal survives')
  read(state, binding, 80, .8)
  assert.equal(state.rawValue, 80); assert.equal(state.numericValue, 80); assert.equal(state.target, .8); assert.equal(state.running, true)
  step(state, binding, .9); near(state.position, .41, 'large source change cannot add the retained 10s transition')
  near(state.seconds, .01, 'running clock is driven by the latest real input, not the delayed pose')
  step(state, binding, 1); near(state.position, .8)
  assert.equal(binding.transitionSeconds, 10, 'display smoothing must not rewrite the old authored setting')
})

test('brief sampled peaks are retained without delaying source target, stop interpretation or seconds', () => {
  const binding = bindingFor(), state = { seconds: 0 }
  read(state, binding, 0, 0); read(state, binding, 100, .2); read(state, binding, 0, .4)
  assert.equal(state.rawValue, 0); assert.equal(state.numericValue, 0); assert.equal(state.target, 0); assert.equal(state.running, false)
  for (const [now, expected] of [[.3, .5], [.4, 1], [.5, .5], [.6, 0]]) {
    step(state, binding, now); near(state.position, expected)
  }
  assert.equal(state.seconds, 0)
})

test('source age and cached age are included before the display delay rather than accumulating transport lag', () => {
  const binding = bindingFor(), aged = { seconds: 0 }
  read(aged, binding, 0, 0); read(aged, binding, 100, .2, .3)
  step(aged, binding, .3); near(aged.receivedAt, .2); near(aged.position, .5)
  step(aged, binding, .4); near(aged.position, 1)
  step(aged, binding, 2); near(aged.position, 1, 'no later sample means hold, not prediction')
  const cached = { seconds: 0 }, packet = frame(100, .4)
  read(cached, binding, 0, 0); packet.cachedAgeMs = 200
  receiveMotionSignal(cached, binding, packet, .4, epoch + 400)
  step(cached, binding, .4); near(cached.receivedAt, .2); near(cached.position, 1)
})

test('duplicate source time cannot renew freshness or add history; same-time changed raw values align even after clipping', () => {
  const binding = bindingFor(), state = { seconds: 0 }
  read(state, binding, 0, 0); read(state, binding, 80, .2); step(state, binding, .3)
  const count = state.feedbackPositionBuffer.count
  read(state, binding, 80, .2, .31)
  near(state.position, .4); near(state.receivedAt, .2); assert.equal(state.feedbackPositionBuffer.count, count)
  step(state, binding, .32); near(state.position, .48)
  step(state, binding, .30); near(state.position, .48, 'display clock regression never replays a pose')
  read(state, binding, 0, .1, .33)
  near(state.target, .8); assert.equal(state.rawValue, 80)
  step(state, binding, .34); near(state.position, .56)
  read(state, binding, 20, .2, .35)
  near(state.position, .2); near(state.receivedAt, .2); assert.equal(state.feedbackPositionBuffer.count, 1)
  assert.equal(state.numericValue, 20)
  read(state, binding, 40, .4); step(state, binding, .5); near(state.position, .3)
  const clipped = { seconds: 0 }
  read(clipped, binding, 0, 0); read(clipped, binding, 100, .2); step(clipped, binding, .3)
  read(clipped, binding, 120, .2, .31)
  near(clipped.position, 1, 'different raw input with unchanged normalized target is still a correction')
  assert.equal(clipped.numericValue, 120); assert.equal(clipped.feedbackPositionBuffer.count, 1)
})

test('fault, missing data and timeout freeze display immediately; recovery aligns its first actual pose and drops old history', () => {
  const binding = bindingFor(), state = { seconds: 0 }
  read(state, binding, 0, 0); read(state, binding, 80, .2); step(state, binding, .3)
  read(state, binding, 100, .35, .35, { quality: 'bad' }); step(state, binding, .36)
  near(state.position, .4); assert.equal(state.usable, false); assert.equal(state.running, false); assert.equal(state.feedbackPositionBuffer.count, 0)
  read(state, binding, 50, .4); near(state.position, .5, 'recovery cannot replay the pre-fault path')
  read(state, binding, 70, .6); step(state, binding, .7); near(state.position, .6)
  receiveMotionSignal(state, binding, { timestamp: epoch + 800, motionInputs: {} }, .8, epoch + 800)
  step(state, binding, .9); near(state.position, .6); assert.equal(state.usable, false)
  read(state, binding, 10, 1); near(state.position, .1)
  step(state, binding, 6.001, .01, 5000)
  near(state.position, .1); assert.equal(state.usable, false); assert.equal(state.reason, '数据超时')
  read(state, binding, 30, 6.1); near(state.position, .3)
  read(state, binding, 100, 6.2, 6.2, { dataItemId: 'point:foreign' })
  step(state, binding, 6.3); near(state.position, .3); assert.equal(state.usable, false)
})

test('absent and zero smoothing retain every legacy signal field and transition; malformed settings cannot silently opt in', () => {
  const zero = bindingFor({ feedbackSmoothingMs: 0, transitionSeconds: 2 }), absent = { ...zero }
  delete absent.feedbackSmoothingMs
  const a = { seconds: 0 }, b = { seconds: 0 }
  for (const [value, source] of [[0, 0], [100, .2], [20, .4], [80, .6]]) {
    read(a, zero, value, source); read(b, absent, value, source)
    step(a, zero, source + .1, .1); step(b, absent, source + .1, .1)
    assert.deepEqual(a, b)
    assert.equal(Object.hasOwn(a, 'feedbackPositionBuffer'), false)
  }
  for (const feedbackSmoothingMs of [-1, 1001, true, '200', null, NaN, Infinity]) {
    const binding = bindingFor({ feedbackSmoothingMs, transitionSeconds: 2 }), state = { seconds: 0 }
    read(state, binding, 0, 0); read(state, binding, 100, .2); step(state, binding, .7, .5)
    near(state.position, .25); assert.equal(Object.hasOwn(state, 'feedbackPositionBuffer'), false)
  }
})

test('BOOL, numeric strings, numeric conditions, running clips and endpoint confirmations keep their original semantics', () => {
  const legacy = bindingFor({ dataItemId: undefined, inputMax: 1, sourceGroup: 'doors', sourceKey: 'open', transitionSeconds: 2 })
  for (const values of [[false, true], ['0', '1']]) {
    const state = { seconds: 0 }
    receiveMotionSignal(state, legacy, { doors: { open: values[0] } }, 0)
    receiveMotionSignal(state, legacy, { doors: { open: values[1] } }, .2)
    step(state, legacy, .7, .5)
    near(state.position, .25); assert.equal(Object.hasOwn(state, 'feedbackPositionBuffer'), false)
    assert.equal(state.rawValue, values[1])
  }
  const condition = bindingFor({ transitionSeconds: 2, trigger: { mode: 'condition', operator: 'gte', value: 50 } })
  const conditional = { seconds: 0 }
  read(conditional, condition, 0, 0); read(conditional, condition, 100, .2); step(conditional, condition, .7, .5)
  near(conditional.position, .25); assert.equal(conditional.running, true); assert.equal(conditional.numericValue, 1)
  assert.equal(Object.hasOwn(conditional, 'feedbackPositionBuffer'), false)
  const running = bindingFor({ mode: 'running', transitionSeconds: 2 }), loop = { seconds: 0 }
  read(loop, running, 0, 0); read(loop, running, 100, .2); step(loop, running, .7, .5)
  near(loop.position, .25); near(loop.seconds, .5); assert.equal(Object.hasOwn(loop, 'feedbackPositionBuffer'), false)
  const endpoints = bindingFor({ transitionSeconds: 2, trigger: { mode: 'endpoints', extended: { dataItemId: 'e' }, retracted: { dataItemId: 'r' } } })
  const endpointFrame = (extended, now) => ({ timestamp: epoch + now * 1000, motionInputs: { 'clip:pose': { quality: 'good', endpointFeedback:
    Object.fromEntries(['extended', 'retracted'].map(side => [side, { dataItemId: side === 'extended' ? 'e' : 'r',
      value: side === 'extended' ? extended : !extended, quality: 'good', timestamp: epoch + now * 1000 }])) } } })
  const ends = { seconds: 0 }
  receiveMotionSignal(ends, endpoints, endpointFrame(false, 0), 0, epoch)
  receiveMotionSignal(ends, endpoints, endpointFrame(true, .2), .2, epoch + 200); step(ends, endpoints, .7, .5)
  near(ends.position, .25); assert.equal(ends.endpointStage, 'extended'); assert.equal(ends.running, false); assert.equal(ends.seconds, 0)
  assert.equal(Object.hasOwn(ends, 'feedbackPositionBuffer'), false)
  const strict = bindingFor(), rejected = { seconds: 0 }
  read(rejected, strict, 0, 0); read(rejected, strict, '100', .2)
  assert.equal(rejected.usable, false); assert.equal(rejected.reason, '数据类型无效'); near(rejected.position, 0)
})

test('64 unpresented samples saturate safely at the latest raw input, never drop source state or grow history', () => {
  const binding = bindingFor({ feedbackSmoothingMs: 1000 }), state = { seconds: 0 }
  read(state, binding, 0, 0)
  const buffer = state.feedbackPositionBuffer, times = buffer.times, positions = buffer.positions
  for (let i = 1; i < 64; i++) read(state, binding, i, i * .001)
  assert.equal(buffer.count, FEEDBACK_POSITION_CAPACITY)
  read(state, binding, 64, .064)
  near(state.position, .64); assert.equal(buffer.count, 1); assert.equal(state.rawValue, 64); assert.equal(state.numericValue, 64); near(state.target, .64)
  for (let i = 65; i < 1000; i++) {
    read(state, binding, i % 101, i * .01); step(state, binding, i * .01, .01, 100000)
    assert.ok(buffer.count <= FEEDBACK_POSITION_CAPACITY)
  }
  step(state, binding, 10.99, .01, 100000); near(state.position, state.target, 'high rate must not accumulate an unbounded replay delay')
  assert.equal(buffer.times, times); assert.equal(buffer.positions, positions)
  assert.equal(times.length, 64); assert.equal(positions.length, 64)
})

test('history pruning keeps the last presented left bracket and ring reuse does not allocate more storage', () => {
  const buffer = new FeedbackPositionBuffer(bindingFor()), times = buffer.times, positions = buffer.positions
  for (let i = 0; i < 64; i++) buffer.append(i * .01, i / 200, epoch + i * 10, i)
  near(buffer.sample(.245), .1225)
  assert.equal(buffer.times[buffer.start], .24); assert.equal(buffer.count, 40)
  for (let i = 64; i <= 120; i++) {
    assert.equal(buffer.append(i * .01, i / 200, epoch + i * 10, i), false)
    near(buffer.sample(i * .01 - .2), (i - 20) / 200)
    assert.ok(buffer.times[buffer.start] <= buffer.lastPresentedAt)
    assert.ok(buffer.count <= 64)
  }
  assert.equal(buffer.times, times); assert.equal(buffer.positions, positions)
})

test('binding, source fingerprint, device and factory changes cannot inherit an old interpolation path', () => {
  const binding = bindingFor(), data = { factoryId: 'one', furnace_id: 'a' }, buffer = new FeedbackPositionBuffer(binding, data)
  assert.equal(buffer.matchesInput(binding, { factory_id: 'one', device_id: 'a' }), true)
  for (const key of ['actionId', 'dataItemId', 'pointId', 'sourceGroup', 'sourceKey', 'sourceFingerprint', 'mode', 'inputMin', 'inputMax', 'invert', 'feedbackSmoothingMs']) {
    assert.equal(buffer.matchesBinding({ ...binding, [key]: key === 'invert' ? true : 'changed' }), false, key)
  }
  assert.equal(buffer.matchesBinding({ ...binding, trigger: { mode: 'condition' } }), false)
  assert.equal(buffer.matchesInput(binding, { ...data, factoryId: 'two' }), false)
  assert.equal(buffer.matchesInput(binding, { ...data, furnace_id: 'b' }), false)
  const state = { seconds: 0 }, send = (definition, value, source, context) =>
    receiveMotionSignal(state, definition, { ...frame(value, source), ...context }, source, epoch + source * 1000)
  send(binding, 0, 0, data); send(binding, 80, .2, data); step(state, binding, .3); near(state.position, .4)
  const original = state.feedbackPositionBuffer, changed = { ...binding, inputMax: 200 }
  send(changed, 60, .4, data); near(state.position, .3); assert.notEqual(state.feedbackPositionBuffer, original)
  send(changed, 80, .6, { ...data, furnace_id: 'b' }); near(state.position, .4)
  send(changed, 100, .8, { factoryId: 'two', furnace_id: 'b' }); near(state.position, .5)
})

test('non-increasing receivedAt from aged corrections aligns instead of manufacturing a time segment', () => {
  const binding = bindingFor(), state = { seconds: 0 }
  read(state, binding, 0, 0); read(state, binding, 80, .2); step(state, binding, .3)
  const packet = frame(50, .4); packet.cachedAgeMs = 300
  receiveMotionSignal(state, binding, packet, .4, epoch + 400)
  near(state.receivedAt, .1); near(state.position, .5); assert.equal(state.feedbackPositionBuffer.count, 1)
  assert.equal(state.sourceTimestamp, epoch + 400); assert.equal(state.rawValue, 50)
})

test('portable playback applies the delayed true numeric pose to actual model transforms while source state stays current', () => {
  const root = new T.Group(), node = new T.Group(); node.name = 'carriage'; root.add(node)
  const pkg = { nodes: [{ name: node.name, v: [1] }], clips: [{ id: 'pose', duration: 4, count: 2,
    tracks: [{ node: node.name, channel: 'p', size: 3, values: [0, 0, 0, 0, 0, 2] }] }] }
  const player = new PortableMotionPlayer(root, pkg, [bindingFor()])
  player.receive(frame(0, 0), 0, epoch); player.advance(.01, .01); near(node.position.z, 0)
  player.receive(frame(100, .2), .2, epoch + 200); player.advance(.01, .3); near(node.position.z, 1)
  assert.equal(player.entries[0].signal.target, 1); assert.equal(player.entries[0].signal.rawValue, 100)
  player.advance(.01, .4); near(node.position.z, 2)
  player.receive(frame(0, .5, .5, { quality: 'bad' }), .5, epoch + 500); player.advance(1, 1)
  near(node.position.z, 2, 'invalid feedback freezes every mechanical channel')
})
