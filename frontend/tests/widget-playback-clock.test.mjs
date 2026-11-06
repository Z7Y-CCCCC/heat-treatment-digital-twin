import test from 'node:test'
import assert from 'node:assert/strict'
import { computed } from 'vue'
import { createWidgetPlaybackController } from '../src/runtime/widgetPlayback.js'
import { playbackSelection } from '../../shared/widgetPlayback.mjs'

const widgets = [{ id: 'first' }, { id: 'second' }]
const devices = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const binding = { deviceScope: 'rotation', rotationIntervalMs: 2000, rotationDeviceIds: ['a', 'b', 'c'] }
const selected = (clock, widget, now) => playbackSelection(binding, {}, devices, clock.timeFor(widget, now)).device.id

test('hover freezes only its widget and resume preserves the remaining dwell time', () => {
  const clock = createWidgetPlaybackController()
  assert.equal(selected(clock, widgets[0], 2500), 'b')
  clock.setHovered(widgets[0], true, 2500)
  assert.equal(selected(clock, widgets[0], 7000), 'b')
  assert.equal(selected(clock, widgets[1], 7000), 'a')
  clock.setHovered(widgets[0], false, 7000)
  assert.equal(clock.timeFor(widgets[0], 7000), 2500)
  assert.equal(selected(clock, widgets[0], 8499), 'b')
  assert.equal(selected(clock, widgets[0], 8500), 'c')
})

test('repeated enter/leave events are idempotent and separate pauses accumulate', () => {
  const clock = createWidgetPlaybackController()
  clock.setHovered('first', true, 500)
  clock.setHovered(widgets[0], true, 1000)
  assert.equal(clock.timeFor('first', 3500), 500)
  clock.setHovered('first', false, 3500)
  clock.setHovered('first', false, 4000)
  assert.equal(clock.timeFor('first', 4000), 1000)
  clock.setHovered('first', true, 4200)
  clock.setHovered('first', false, 6200)
  assert.equal(clock.timeFor('first', 6200), 1200)
})

test('controller is reactive to hover without waiting for a clock tick', () => {
  let now = 2500
  const clock = createWidgetPlaybackController({ now: () => now })
  const time = computed(() => clock.timeFor('first', 4000))
  assert.equal(time.value, 4000)
  clock.setHovered('first', true)
  assert.equal(time.value, 2500)
  now = 6000
  clock.setHovered('first', false)
  assert.equal(time.value, 500)
})

test('unmount removal and surface reset clear held and resumed clocks', () => {
  const clock = createWidgetPlaybackController()
  clock.setHovered(widgets[0], true, 1000)
  clock.setHovered(widgets[1], true, 1500)
  clock.remove('first')
  assert.equal(clock.timeFor(widgets[0], 100000), 100000)
  assert.equal(clock.timeFor(widgets[1], 100000), 1500)
  clock.reset()
  assert.equal(clock.timeFor(widgets[1], 100000), 100000)
  assert.equal(clock.timeFor({}, 500), 500)
})

test('a long pause retains a valid nonnegative selection timestamp', () => {
  const clock = createWidgetPlaybackController()
  clock.setHovered('first', true, 2500)
  assert.equal(clock.timeFor('first', 120000), 2500)
  clock.setHovered('first', false, 120000)
  assert.equal(clock.timeFor('first', 120100), 2600)
  assert.equal(clock.timeFor('first', 0), 0)
})
