import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

test('hover snapshots serialize loads, cancel stale work, dispose GPU resources and bound the image cache', async t => {
  let loads = 0, activeLoads = 0, maxLoads = 0, renders = 0, disposed = 0, lost = 0, rootsDisposed = 0
  await t.mock.module('three', { namedExports: { ...THREE, WebGLRenderer: class {
    constructor() { this.domElement = { toDataURL: () => 'image-' + renders } }
    setSize() {} setPixelRatio() {} render() { renders++ } dispose() { disposed++ } forceContextLoss() { lost++ }
  } } })
  await t.mock.module('../src/runtime/ConfiguredFactoryScene.js', { namedExports: {
    loadConfiguredGltf: async (url, { signal }) => {
      loads++; activeLoads++; maxLoads = Math.max(maxLoads, activeLoads)
      try {
        await new Promise(resolve => setTimeout(resolve, 5)); signal.throwIfAborted()
        if (url.includes('bad')) throw new Error('missing model')
        return { scene: new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()) }
      } finally { activeLoads-- }
    },
    disposeSceneObject: root => { rootsDisposed++; root.geometry.dispose(); root.material.dispose() }
  } })
  await t.mock.module('../src/three/ModelFactory.js', { namedExports: { resolveBackendAssetUrl: file => file } })
  const { modelHoverSnapshot, previewModelForDevice } = await import('../src/runtime/modelHoverSnapshot.js')
  const model = { id: 'a', file_path: '/library.glb', name: 'library' }
  assert.equal(previewModelForDevice({ model_type: 'a', model_file: '/custom.glb' }, [model]).file, '/custom.glb')
  assert.equal(previewModelForDevice({ model_type: 'a' }, [model]).file, '/library.glb')
  const source = i => ({ key: String(i), file: '/' + i + '.glb' }), signal = () => new AbortController().signal
  const first = await modelHoverSnapshot(source(0), signal()); assert.equal(await modelHoverSnapshot(source(0), signal()), first)
  assert.equal(loads, 1, 'cached CPU image does not reload or render')
  await Promise.all([1, 2, 3, 4].map(i => modelHoverSnapshot(source(i), signal())))
  assert.equal(maxLoads, 1)
  const cancellation = new AbortController(), blocker = modelHoverSnapshot(source(5), signal())
  const stale = modelHoverSnapshot(source('stale'), cancellation.signal); cancellation.abort()
  await assert.rejects(stale, { name: 'AbortError' }); await blocker
  assert.equal(loads, 6, 'aborted queued work never starts a GLB load')
  for (let i = 6; i < 18; i++) await modelHoverSnapshot(source(i), signal())
  const before = loads; await modelHoverSnapshot(source(0), signal()); assert.equal(loads, before + 1, 'oldest image evicted after twelve entries')
  await assert.rejects(modelHoverSnapshot(source('bad'), signal()), /missing model/)
  assert.equal(disposed, renders); assert.equal(lost, renders); assert.equal(rootsDisposed, renders)
})
