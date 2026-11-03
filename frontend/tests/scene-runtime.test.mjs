import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { deferred, settle } from './helpers.mjs'

let modelFactory, batchFactory, batchInfo = null, shouldBatch = false
const managers = []
class FakeSceneManager {
    furnaces = []
    batches = []
    disposeCount = 0
    constructor(_container, _level, _select, _interaction, renderOptions) { this.renderOptions = renderOptions; managers.push(this) }
    addFurnace(model) { assert.equal(this.disposeCount, 0); this.furnaces.push(model) }
    addBatchRenderer(batch) { assert.equal(this.disposeCount, 0); this.batches.push(batch) }
    setTopologyConfig() { assert.equal(this.disposeCount, 0) }
    animate() { this.animated = true }
    dispose() { this.disposeCount += 1; this.furnaces.forEach(model => model.dispose()); this.batches.forEach(batch => batch.dispose()) }
}

mock.module('../src/three/SceneManager.js', { namedExports: { SceneManager: FakeSceneManager } })
mock.module('../src/runtime/DeviceRenderer.js', { namedExports: {
    createConfiguredDeviceModel: (...args) => modelFactory(...args),
    applyConfiguredDeviceTransform() {}, applyRealtimeToDeviceModel() {}
} })
mock.module('../src/runtime/BatchDeviceRenderer.js', { namedExports: {
    getBatchableModelInfo: () => batchInfo,
    createBatchedDeviceRenderer: (...args) => batchFactory(...args)
} })
mock.module('../src/runtime/modelOptimization.js', { namedExports: { shouldOptimizeModelGroup: () => shouldBatch } })
const { SceneRuntime } = await import('../src/runtime/SceneRuntime.js')

function model() { return { userData: {}, disposeCount: 0, dispose() { this.disposeCount += 1 } } }
function fixture(t, count = 1) {
    managers.length = 0
    batchInfo = null
    shouldBatch = false
    const runtime = new SceneRuntime({}, {
        workshops: [{ id: 'W', lines: [{ id: 'L', devices: Array.from({ length: count }, (_, i) => ({ id: `D${i}`, name: `Device ${i}`, model_type: 'builtin_furnace' })) }] }],
        models: []
    })
    t.after(() => runtime.dispose())
    return runtime
}

test('composer label policy is forwarded to original and batched models and to its private renderer', async t => {
    for (const batched of [false, true]) {
        const runtime = fixture(t)
        runtime.options.deviceLabelConfig = { enabled: false }
        runtime.options.renderOptions = { labelLayer: false }
        const received = []
        modelFactory = (_definition, _models, options) => { received.push(options.labelConfig); return Promise.resolve(model()) }
        batchInfo = batched ? { id: 'batch', file_path: '/model.glb' } : null
        shouldBatch = batched
        batchFactory = (_model, _definitions, options) => { received.push(options.labelConfig); return Promise.resolve({ batchRenderer: { dispose() {} }, deviceModels: [model()] }) }
        await runtime.start()
        assert.deepEqual(received, [{ enabled: false }])
        assert.equal(managers[0].renderOptions.labelLayer, false)
        runtime.dispose()
    }
})

test('placed static workshop auxiliaries render without a rail; pending props and unbound rail carts do not', async t => {
    const runtime = fixture(t), registered = []
    const prop = (id, patch = {}) => ({ id, model_type: 'cad_support', line_id: 'L', pos_x: 5, pos_y: -4.4, pos_z: 2,
        coordinate_space: 'line_local', instance_config: { role: 'auxiliary', workshop_id: 'W', layoutPlaced: true, placementPending: false, ...patch } })
    runtime.options.workshops = [{ id: 'W', lines: [{ id: 'L', layout: { version: 2, lanes: [{ id: 'lane', offsetZ: 0 }], rails: [] }, devices: [] }],
        devices: [prop('static-prop'), prop('pending', { placementPending: true }), prop('cart', { role: 'transfer_cart' }), prop('stale-rail', { railId: 'missing' })] }]
    modelFactory = definition => { registered.push(definition); return Promise.resolve(model()) }
    await runtime.start()
    assert.equal(registered.length, 1)
    assert.equal(registered[0].deviceCfg.id, 'static-prop')
    assert.equal(registered[0].deviceCfg.pos_y, -4.4)
    assert.equal(registered[0].deviceCfg.pos_z, 2)
    assert.equal(registered[0].isLineMember, false)
})

test('concurrent starts share a renderer and completed resources dispose once', async t => {
    const runtime = fixture(t)
    const response = deferred(), device = model()
    modelFactory = () => response.promise
    const first = runtime.start()
    const second = runtime.start()
    assert.equal(first, second)
    response.resolve(device)
    await first
    assert.equal(managers.length, 1)
    assert.equal(managers[0].furnaces.length, 1)
    runtime.dispose()
    runtime.dispose()
    assert.equal(device.disposeCount, 1)
    assert.equal(managers[0].disposeCount, 1)
})

test('a model that finishes after teardown is disposed without touching the dead scene', async t => {
    const runtime = fixture(t)
    const response = deferred(), device = model()
    modelFactory = () => response.promise
    const starting = runtime.start()
    runtime.dispose()
    response.resolve(device)
    await starting
    assert.equal(device.disposeCount, 1)
    assert.equal(managers[0].furnaces.length, 0)
    assert.equal(managers[0].animated, undefined)
    assert.equal(runtime.furnaces.size, 0)
})

test('failed scene startup disposes already-loaded models and the renderer', async t => {
    const runtime = fixture(t, 2)
    const failure = deferred(), device = model()
    modelFactory = definition => definition.deviceCfg.id === 'D0' ? Promise.resolve(device) : failure.promise
    const starting = runtime.start()
    const rejected = assert.rejects(starting, /model failed/)
    await settle()
    failure.reject(new Error('model failed'))
    await rejected
    assert.equal(device.disposeCount, 1)
    assert.equal(managers[0].disposeCount, 1)
    assert.equal(runtime.disposed, true)
})

test('a late batch renderer is reclaimed when its owner was disposed during loading', async t => {
    const runtime = fixture(t)
    const response = deferred()
    const batch = { disposeCount: 0, dispose() { this.disposeCount += 1 } }
    batchInfo = { id: 'batch', file_path: '/model.glb' }
    shouldBatch = true
    batchFactory = () => response.promise
    const starting = runtime.start()
    runtime.dispose()
    response.resolve({ batchRenderer: batch, deviceModels: [model()] })
    await starting
    assert.equal(batch.disposeCount, 1)
    assert.equal(managers[0].batches.length, 0)
})
