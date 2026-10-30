import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

const requests = []
test.mock.module('three/examples/jsm/loaders/GLTFLoader.js', { namedExports: { GLTFLoader: class {
    load(url, resolve, _progress, reject) { requests.push({ url, resolve, reject }) }
} } })
const { loadGltf } = await import('../src/three/ModelFactory.js')
function model() {
    const scene = new THREE.Group()
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial()))
    return { scene }
}
async function load(url) {
    const request = loadGltf(url)
    requests.at(-1).resolve(model())
    return request
}

test('a transient model download failure retries the same URL instead of caching the rejection', async () => {
    const first = loadGltf('/temporarily-offline.glb')
    const rejected = assert.rejects(first, /offline/)
    requests.at(-1).reject(new Error('offline'))
    await rejected
    const before = requests.length
    const root = await load('/temporarily-offline.glb')
    assert.equal(requests.length, before + 1)
    assert.equal(root.children.length, 1)
})

test('hundreds of model revisions are bounded and eviction leaves active shared clones intact', async t => {
    const first = await load('/first-revision.glb')
    const active = first.clone(true)
    const geometry = active.children[0].geometry, material = active.children[0].material
    const geometryDispose = t.mock.method(geometry, 'dispose'), materialDispose = t.mock.method(material, 'dispose')
    for (let index = 0; index < 200; index++) await load(`/revision-${index}.glb`)
    const before = requests.length
    await load('/first-revision.glb')
    assert.equal(requests.length, before + 1, 'old revisions must leave the bounded cache')
    assert.equal(geometryDispose.mock.callCount(), 0)
    assert.equal(materialDispose.mock.callCount(), 0)
    assert.ok(geometry.attributes.position.count > 0)
    assert.equal(active.children[0].geometry, first.children[0].geometry)
})

test('recently used models remain shared and only least recently used entries are evicted', async () => {
    const root = await load('/frequently-used.glb')
    for (let index = 0; index < 32; index++) {
        assert.equal(await loadGltf('/frequently-used.glb'), root)
        await load(`/lru-${index}.glb`)
    }
    const before = requests.length
    assert.equal(await loadGltf('/frequently-used.glb'), root)
    assert.equal(requests.length, before)
})
