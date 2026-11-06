import test from 'node:test'
import assert from 'node:assert/strict'
import { adminApi } from '../src/config/factoryConfig.js'
import { applyLoadingAppearance, loadingAppearance, patchLoadingAppearance, readLoadingAppearance } from '../src/runtime/loadingAppearanceState.js'
import { deferred } from './helpers.mjs'

test('a stale appearance GET cannot undo a confirmed theme change', async t => {
  const originalGet = adminApi.getLoadingExperience, originalPatch = adminApi.patchLoadingExperience
  t.after(() => { adminApi.getLoadingExperience = originalGet; adminApi.patchLoadingExperience = originalPatch })
  applyLoadingAppearance({ theme: 'light', title: '保留标题' })
  const oldRead = deferred(), writes = []
  adminApi.getLoadingExperience = () => oldRead.promise
  adminApi.patchLoadingExperience = async patch => { writes.push(patch); return { success: true, config: { theme: 'dark', title: '保留标题' } } }
  const pending = readLoadingAppearance()
  await patchLoadingAppearance({ theme: 'dark' })
  oldRead.resolve({ config: { theme: 'light', title: '旧标题' } }); await pending
  assert.equal(loadingAppearance.value.theme, 'dark')
  assert.equal(loadingAppearance.value.title, '保留标题')
  assert.deepEqual(writes, [{ theme: 'dark' }])
})

test('failed theme saves leave the confirmed choice intact', async t => {
  const original = adminApi.patchLoadingExperience
  t.after(() => { adminApi.patchLoadingExperience = original })
  applyLoadingAppearance({ theme: 'light' })
  adminApi.patchLoadingExperience = async () => ({ error: '服务暂不可用' })
  await assert.rejects(patchLoadingAppearance({ theme: 'dark' }), /服务暂不可用/)
  assert.equal(loadingAppearance.value.theme, 'light')
})

test('the latest opened appearance reader wins without disturbing local reading preferences', async t => {
  const original = adminApi.getLoadingExperience, first = deferred(), second = deferred()
  t.after(() => { adminApi.getLoadingExperience = original })
  applyLoadingAppearance({ theme: 'light' })
  let count = 0; adminApi.getLoadingExperience = () => (++count === 1 ? first.promise : second.promise)
  const a = readLoadingAppearance(), b = readLoadingAppearance()
  second.resolve({ config: { theme: 'dark' } }); await b
  first.resolve({ config: { theme: 'light' } }); await a
  assert.equal(loadingAppearance.value.theme, 'dark')
})

test('matching WebSocket and save acknowledgements notify the native host only once', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window'), messages = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chrome: { webview: { postMessage: message => messages.push(message) } } } })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'window', descriptor); else delete globalThis.window })
  applyLoadingAppearance({ theme: 'light' })
  applyLoadingAppearance({ theme: 'dark' }, true)
  applyLoadingAppearance({ theme: 'dark' }, true)
  assert.equal(messages.length, 1)
})
