import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { readFile } from 'node:fs/promises'
import { createSimpleRotatingCart } from '../src/three/simpleRotatingCart.js'
import { LoadingPortPreview } from '../src/three/LoadingPortPreview.js'
import { normalizeCartTransfer } from '../../shared/cartTransferConfig.mjs'

const ports = () => ({ version: 1, inlet: { position: [0, .5, 1], direction: [0, 0, 1], nodeName: '' }, outlet: { position: [0, .5, 1], direction: [0, 0, 1], nodeName: '' } })
const bounds = () => new THREE.Box3(new THREE.Vector3(-1.5, -.5, -1), new THREE.Vector3(1.5, .5, 1))
test('provisional cart rotates only its upper platform, shared mouth and payload', () => {
  const port = ports().outlet, original = structuredClone(port), b = bounds(), beforeBounds = b.clone()
  const cart = createSimpleRotatingCart(b, port); assert.ok(cart)
  const base = cart.root.getObjectByName('Rail chassis'), mouth = cart.root.getObjectByName('Physical shared loading mouth')
  const payload = new THREE.Object3D(); payload.position.set(.2, .2, 0); cart.upper.add(payload); cart.root.updateMatrixWorld(true)
  const basePosition = base.getWorldPosition(new THREE.Vector3()), before = mouth.getWorldPosition(new THREE.Vector3()), cargoBefore = payload.getWorldPosition(new THREE.Vector3())
  cart.upper.rotateY(Math.PI); cart.root.updateMatrixWorld(true)
  assert.ok(mouth.getWorldPosition(new THREE.Vector3()).z < 0 && before.z > 0)
  assert.ok(payload.getWorldPosition(new THREE.Vector3()).distanceTo(cargoBefore) > .3)
  assert.ok(base.getWorldPosition(new THREE.Vector3()).distanceTo(basePosition) < 1e-10)
  assert.deepEqual(port, original); assert.ok(b.equals(beforeBounds)); assert.equal(cart.root.name, '__SimpleRotatingCart')
})
test('new simple model still needs an authored mouth, never manufactures an origin port', () => {
  assert.equal(createSimpleRotatingCart(bounds(), null), null)
  assert.equal(createSimpleRotatingCart(new THREE.Box3(), ports().outlet), null)
})
test('preview swaps only the selected presentation and restores original visibility on return', () => {
  const root = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 2), new THREE.MeshBasicMaterial())
  root.add(body); root.updateMatrixWorld(true)
  const preview = { root, clearCartTransfer: LoadingPortPreview.prototype.clearCartTransfer }
  LoadingPortPreview.prototype.setCartTransfer.call(preview, { version: 1, kind: 'rotating', presentation: 'simple', turntableNodeName: '' }, ports())
  assert.equal(body.visible, false); assert.ok(root.getObjectByName('__SimpleCartUpper'))
  LoadingPortPreview.prototype.setCartTransfer.call(preview, normalizeCartTransfer(null), ports())
  assert.equal(body.visible, true); assert.equal(root.getObjectByName('__SimpleCartUpper'), undefined); assert.equal(root.children.length, 1)
})
test('fine-model adapter only names a turntable node; no PLC rotation feedback or physical tuning is required', () => {
  assert.deepEqual(normalizeCartTransfer({ version: 1, kind: 'rotating', presentation: 'model', turntableNodeName: 'Upper' }), { version: 1, kind: 'rotating', presentation: 'model', turntableNodeName: 'Upper' })
  for (const extra of ['anglePointId', 'speed', 'acceleration', 'distance']) assert.throws(() => normalizeCartTransfer({ version: 1, kind: 'rotating', presentation: 'simple', turntableNodeName: '', [extra]: 1 }))
})
test('model-management workspace hosts the device picker and retains unsaved editor guards', async () => {
  const source = await readFile(new URL('../src/views/admin/components/LoadingPortWorkspace.vue', import.meta.url), 'utf8')
  assert.match(source, /aria-label="选择进出料配置设备"/); assert.match(source, /model_type\) === String\(props.model.id\)/)
  assert.match(source, /if \(!await canLeave\(\)\)/); assert.match(source, /:device="selectedDevice"/)
  // The combined page must guard BOTH mounted editors, not whichever old tab
  // was active. Detailed save/discard/confirmation races are exercised by
  // loading-port-workspace-guards.test.mjs.
  assert.match(source, /const editors=\(\)=>\[editor.value,calibration.value\]\.filter\(Boolean\)/)
  assert.match(source, /for\(const item of editors\(\)\)if\(!await \(item\.savePending\?\.\(\)\?\?true\)\)return false/)
  assert.match(source, /for\(const item of editors\(\)\)if\(!await \(item\.canLeave\?\.\(\)\?\?true\)\)return false/)
  assert.match(source, /for\(const item of editors\(\)\)if\(item\.discardPending\?\.\(\)===false\)return false/)
  assert.match(source, /defineExpose\(\{ canLeave, savePending, discardPending, busy, dirty \}\)/)
})
