import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import loading from '../../shared/sceneLoading.cjs'
const { normalizeSceneLoading } = loading
const sample = { loadId: 'load-1', stage: 'models', completed: 2, total: 8, modelName: '3号井式炉' }
test('scene progress is derived from completed native instances, never elapsed time or supplied percentages', () => {
  assert.deepEqual(normalizeSceneLoading({ ...sample, progress: .99 }, false), { ...sample, progress: .25 })
  assert.equal(normalizeSceneLoading({ ...sample, stage: 'environment' }, false).progress, null)
  assert.equal(normalizeSceneLoading(sample, true), null)
  assert.equal(normalizeSceneLoading({ ...sample, completed: 50 }, false).progress, 1)
  for (const total of [NaN, Infinity, -1, '8', 100001]) assert.equal(normalizeSceneLoading({ ...sample, total }, false).progress, null)
  for (const value of [null, [], {}, { ...sample, loadId: '' }, { ...sample, stage: 'invented' }]) assert.equal(normalizeSceneLoading(value, false), null)
  assert.equal(normalizeSceneLoading({ ...sample, modelName: 'x'.repeat(500) }, false).modelName.length, 180)
})
test('compact ring compiles, exposes real progress and honors reduced motion without showing a fake percentage', async () => {
  const source = await readFile(new URL('../src/components/SceneLoadingIndicator.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  compileScript(descriptor, { id: 'scene-loading' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'SceneLoadingIndicator.vue', id: 'scene-loading' }).errors, [])
  assert.match(source, /role="progressbar"/); assert.match(source, /prefers-reduced-motion/)
  assert.doesNotMatch(source, /setInterval|Math\.random|progress\.value\s*\+=/)
  assert.match(source, /clearTimeout\(timer\)/)
  const site = await readFile(new URL('../src/views/FactoryDrilldown.vue', import.meta.url), 'utf8')
  assert.match(site, /<SceneLoadingIndicator :show="busy" :loading="entryLoading"/)
  assert.match(site, /String\(message\.payload\?\.factoryId \|\| ''\)===factoryId\.value/)
  assert.match(site, /await navigator\.go/)
  assert.doesNotMatch(site, /正在等待 Unity 确认全厂总览/)
})
