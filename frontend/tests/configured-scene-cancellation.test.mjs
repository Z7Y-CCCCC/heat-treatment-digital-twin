import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as THREE from 'three'
import { loadConfiguredGltf, buildConfiguredFactoryScene } from '../src/runtime/ConfiguredFactoryScene.js'
import { deferred, settle } from './helpers.mjs'

test('actual Three loader cancellation closes a stalled local HTTP model request', async () => {
    const arrived = deferred(), disconnected = deferred()
    const server = createServer(request => { arrived.resolve(); request.once('close', () => disconnected.resolve()) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const controller = new AbortController()
    try {
        const result = loadConfiguredGltf(`http://127.0.0.1:${server.address().port}/stalled.glb`, { signal: controller.signal })
        const rejected = assert.rejects(result, error => error.name === 'AbortError')
        await arrived.promise
        controller.abort()
        await rejected
        await Promise.race([disconnected.promise, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('HTTP model request remained open')), 2000); timer.unref() })])
    } finally { controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('an unabortable parser result arriving after page cancellation releases GPU resources', async t => {
    const completion = deferred(), controller = new AbortController()
    let manager
    const result = loadConfiguredGltf('/fixture.glb', { signal: controller.signal, loaderFactory: value => { manager = value; return { loadAsync: () => completion.promise } } })
    const rejected = assert.rejects(result, error => error.name === 'AbortError')
    await settle()
    const abort = t.mock.method(manager, 'abort')
    controller.abort()
    await rejected
    assert.equal(abort.mock.callCount(), 1)
    const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial(), texture = new THREE.Texture()
    material.map = texture
    const root = new THREE.Group(); root.add(new THREE.Mesh(geometry, material))
    const geometryDispose = t.mock.method(geometry, 'dispose'), materialDispose = t.mock.method(material, 'dispose'), textureDispose = t.mock.method(texture, 'dispose')
    completion.resolve({ scene: root })
    await settle()
    assert.equal(geometryDispose.mock.callCount(), 1)
    assert.equal(materialDispose.mock.callCount(), 1)
    assert.equal(textureDispose.mock.callCount(), 1)
})

test('model deadline releases a scene build without waiting forever on the loader', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let manager
    const result = loadConfiguredGltf('/fixture.glb', { timeoutMs: 100, loaderFactory: value => { manager = value; return { loadAsync: () => new Promise(() => {}) } } })
    const rejected = assert.rejects(result, /模型加载超时/)
    await settle()
    const originalSignal = manager.abortController.signal
    t.mock.timers.tick(100)
    await rejected
    assert.equal(originalSignal.aborted, true)
})

test('scene builder propagates cancellation and never publishes a cancelled generation', async () => {
    const controller = new AbortController(), started = deferred()
    const transform = { position: { x: 0, y: 0, z: 0 }, yaw: 0, scale: [1, 1, 1] }
    const plan = { workshops: [{ id: 'w', name: 'Workshop', transform, hall: null }], lines: [], devices: [{ id: 'd', name: 'Device', workshopId: 'w', transform, url: '/fixture.glb' }] }
    const result = buildConfiguredFactoryScene(plan, { signal: controller.signal, load: (_url, options) => {
        assert.equal(options.signal, controller.signal)
        started.resolve()
        return loadConfiguredGltf('/fixture.glb', { ...options, loaderFactory: () => ({ loadAsync: () => new Promise(() => {}) }) })
    } })
    await started.promise
    controller.abort()
    assert.equal(await result, null)
})
