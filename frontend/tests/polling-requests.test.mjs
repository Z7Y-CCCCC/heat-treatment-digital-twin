import test from 'node:test'
import assert from 'node:assert/strict'
import { createJsonPollingScope } from '../src/runtime/pollingRequests.js'
import { deferred, json } from './helpers.mjs'

test('slow response bodies coalesce hundreds of polling ticks but resources remain independent', async () => {
    const body = deferred(), calls = []
    const scope = createJsonPollingScope(async (url, options) => {
        calls.push({ url, options })
        return url === '/summary' ? { ok: true, json: () => body.promise } : json({ value: 3 })
    })
    const first = scope.read('summary', '/summary')
    for (let index = 0; index < 200; index++) assert.equal(scope.read('summary', '/summary'), first)
    assert.deepEqual(await scope.read('map', '/map'), { value: 3 })
    assert.equal(calls.length, 2)
    body.resolve({ total: 4 })
    assert.deepEqual(await first, { total: 4 })
    const retry = scope.read('summary', '/summary')
    await retry
    assert.equal(calls.length, 3)
    scope.dispose()
})

test('polling deadline aborts hung transport and allows the next attempt', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let calls = 0, signal
    const scope = createJsonPollingScope((_url, options) => {
        calls++
        signal = options.signal
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }, 100)
    const first = scope.read('summary', '/summary')
    const rejected = assert.rejects(first, /aborted/)
    t.mock.timers.tick(100)
    await rejected
    assert.equal(signal.aborted, true)
    const second = scope.read('summary', '/summary')
    const again = assert.rejects(second, /aborted/)
    assert.equal(calls, 2)
    scope.dispose()
    await again
})

test('unmount aborts every resource and blocks further reads', async () => {
    const signals = []
    const scope = createJsonPollingScope((_url, options) => {
        signals.push(options.signal)
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    })
    const first = assert.rejects(scope.read('map', '/map'), /aborted/)
    const second = assert.rejects(scope.read('summary', '/summary'), /aborted/)
    scope.dispose()
    await Promise.all([first, second])
    assert.equal(signals.every(signal => signal.aborted), true)
    await assert.rejects(scope.read('summary', '/summary'), /disposed/)
    assert.equal(signals.length, 2)
})
