import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileTemplate } from 'vue/compiler-sfc'

const url = new URL('../src/views/admin/components/MobileDeviceMotion.vue', import.meta.url)
const source = await readFile(url, 'utf8')

test('motion channel badge describes the configured sampling interval, not measured latency', () => {
  const { descriptor, errors } = parse(source)
  assert.deepEqual(errors, [])
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'motion-sampling-label' }).errors, [])
  assert.match(descriptor.template.content, /运动点位采集周期 · 100ms/)
  assert.match(descriptor.template.content, /title="保存运动绑定后，相关点位的采集周期设为 100ms。这不是实测传输延迟/)
  assert.doesNotMatch(descriptor.template.content, /实时通道 · 100ms/)
})

test('the sampling explanation matches the movement save route without claiming an end-to-end limit', async () => {
  const route = await readFile(new URL('../../backend/routes/devices.js', import.meta.url), 'utf8')
  assert.match(route, /UPDATE data_points SET sample_interval_ms = \? WHERE id = \? AND device_id = \?',[\s]*\[100, id, device.id\]/)
  assert.match(source, /画面响应还受 PLC 通信、数据传输和 Unity 渲染影响/)
})
