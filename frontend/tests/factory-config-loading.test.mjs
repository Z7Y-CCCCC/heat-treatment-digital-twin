import test from 'node:test'
import assert from 'node:assert/strict'
import { useFactoryConfig } from '../src/config/factoryConfig.js'
import { deferred, installBrowser, json } from './helpers.mjs'

const factory = useFactoryConfig()
function fixture(t) {
    installBrowser(t)
    Object.assign(factory.config, { settings: {}, workshops: [], lines: [], models: [], templatePacks: [], platform: {}, loaded: false })
    t.mock.method(console, 'log', () => {})
    t.mock.method(console, 'error', () => {})
    t.mock.method(console, 'warn', () => {})
}
const config = name => ({ settings: { factory_name: name }, workshops: [{ id: name, lines: [{ id: name, devices: [{ id: name }] }] }], models: [], platform: {} })

test('initial configuration failure keeps the runtime empty without invented equipment', async t => {
    fixture(t)
    t.mock.method(globalThis, 'fetch', async () => json({ error: 'offline' }, 503))
    await factory.loadConfig()
    assert.deepEqual(factory.config.workshops, [])
    assert.equal(factory.config.loaded, false)
    assert.match(factory.error.value, /503/)
})

test('temporary backend failure preserves the last complete factory configuration', async t => {
    fixture(t)
    const request = t.mock.method(globalThis, 'fetch', async () => json(config('real-factory')))
    await factory.loadConfig()
    request.mock.mockImplementation(async () => json({ error: 'offline' }, 503))
    await factory.loadConfig()
    assert.equal(factory.config.settings.factory_name, 'real-factory')
    assert.equal(factory.config.workshops[0].id, 'real-factory')
    assert.equal(factory.config.loaded, true)
    assert.match(factory.error.value, /503/)
})

test('superseded configuration requests cannot restore a previous factory or error', async t => {
    fixture(t)
    const old = deferred(), current = deferred()
    let calls = 0
    let oldSignal
    t.mock.method(globalThis, 'fetch', (_url, options) => {
        if (++calls === 1) { oldSignal = options.signal; return old.promise }
        return current.promise
    })
    const first = factory.loadConfig(), second = factory.loadConfig()
    assert.equal(oldSignal.aborted, true)
    current.resolve(json(config('current-factory')))
    await second
    old.resolve(json(config('old-factory')))
    await first
    assert.equal(factory.config.settings.factory_name, 'current-factory')
    assert.equal(factory.error.value, null)
    assert.equal(factory.loading.value, false)
})

test('invalid configuration cannot partially overwrite the last valid scene', async t => {
    fixture(t)
    const request = t.mock.method(globalThis, 'fetch', async () => json(config('saved')))
    await factory.loadConfig()
    request.mock.mockImplementation(async () => json({ settings: { factory_name: 'broken' }, workshops: 'invalid' }))
    await factory.loadConfig()
    assert.equal(factory.config.settings.factory_name, 'saved')
    assert.equal(factory.config.workshops[0].id, 'saved')
    assert.ok(factory.error.value)
})
