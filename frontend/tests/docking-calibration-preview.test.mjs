import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DockingCalibrationPreview, configureDockingPreviewControls } from '../src/three/DockingCalibrationPreview.js'

function eventTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler) },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler) },
    dispatch(type, event) { for (const handler of listeners.get(type) || []) handler(event) }
  }
}
function observer(allowRotate = true) {
  const document = eventTarget()
  const element = { ...eventTarget(), style: {}, ownerDocument: document, clientWidth: 800, clientHeight: 480,
    getRootNode: () => document, setPointerCapture() {}, releasePointerCapture() {} }
  const camera = new T.OrthographicCamera(-8, 8, 4.8, -4.8, .01, 10000); camera.position.set(5, 4, 6)
  const controls = configureDockingPreviewControls(new OrbitControls(camera, element), { allowRotate })
  camera.updateMatrixWorld(true)
  const pointer = (button, x, y) => ({ pointerId: 1, pointerType: 'mouse', button, buttons: button === 2 ? 2 : 1, clientX: x, clientY: y, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {} })
  function drag(button, from = [200, 180], to = [280, 220]) {
    element.dispatch('pointerdown', pointer(button, ...from))
    document.dispatch('pointermove', pointer(button, ...to))
    document.dispatch('pointerup', { ...pointer(button, ...to), buttons: 0 })
    for (let index = 0; index < 180; index++) controls.update()
    camera.updateMatrixWorld(true)
  }
  return { controls, camera, element, document, drag }
}
const closeVector = (actual, expected, tolerance = 1e-7) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance, `${actual} != ${expected}`))

test('inline camera maps left rotation, right pan and middle/wheel zoom exactly like the model canvas', () => {
  const f = observer()
  assert.equal(f.controls.enableRotate, true); assert.equal(f.controls.enablePan, true); assert.equal(f.controls.enableZoom, true)
  assert.equal(f.controls.mouseButtons.LEFT, T.MOUSE.ROTATE); assert.equal(f.controls.mouseButtons.RIGHT, T.MOUSE.PAN); assert.equal(f.controls.mouseButtons.MIDDLE, T.MOUSE.DOLLY)
  assert.equal(f.controls.touches.ONE, T.TOUCH.ROTATE); assert.equal(f.controls.touches.TWO, T.TOUCH.DOLLY_PAN)
  assert.equal(f.controls.enableDamping, true); assert.equal(f.controls.dampingFactor, .12)
  const beforeRotation = f.camera.position.clone(), beforeTarget = f.controls.target.clone()
  f.drag(0)
  assert.ok(f.camera.position.distanceTo(beforeRotation) > .1, 'a real left-button pointer gesture rotates the observer')
  closeVector(f.controls.target.toArray(), beforeTarget.toArray())
  const beforePan = f.controls.target.clone(), direction = f.camera.quaternion.clone()
  f.drag(2)
  assert.ok(f.controls.target.distanceTo(beforePan) > .1, 'a real right-button pointer gesture pans the observer')
  assert.ok(f.camera.quaternion.angleTo(direction) < 1e-7)
  const zoom = f.camera.zoom
  f.element.dispatch('wheel', { deltaY: -120, deltaMode: 0, ctrlKey: false, clientX: 400, clientY: 240, preventDefault() {} })
  assert.ok(f.camera.zoom > zoom, 'a real wheel gesture zooms the orthographic camera')
  f.controls.dispose()
})

test('standalone default stays locked against left rotation while preserving pan and zoom', () => {
  const f = observer(false), before = f.camera.position.clone()
  f.drag(0)
  assert.equal(f.controls.enableRotate, false); closeVector(f.camera.position.toArray(), before.toArray())
  const target = f.controls.target.clone(); f.drag(2)
  assert.ok(f.controls.target.distanceTo(target) > .1)
  f.controls.dispose()
})

test('front/top reset drains camera inertia and cannot change entity transforms, port positions or calibration values', () => {
  const f = observer()
  const device = new T.Group(), cart = new T.Group(); device.position.set(-10, 2, -4); cart.position.set(-10, 0, 0)
  const plan = { position: { x: 10, y: 2 }, devicePort: [-10, 3, -3], cartPort: [-10, 1, -1] }
  const preview = Object.assign(Object.create(DockingCalibrationPreview.prototype), {
    camera: f.camera, controls: f.controls, center: new T.Vector3(1, 2, 3), span: 10,
    bounds: new T.Box3(new T.Vector3(-2, -1, -10), new T.Vector3(2, 1, 10)),
    container: { clientWidth: 800, clientHeight: 480 }, renderer: { setSize() {} }, plan, groups: [device, cart]
  })
  const original = { plan: structuredClone(plan), device: device.position.toArray(), cart: cart.position.toArray() }
  for (const view of ['front', 'top']) {
    f.controls._sphericalDelta.theta = .8; f.controls._sphericalDelta.phi = .2; f.controls._panOffset.set(.5, .3, .2); f.controls._scale = .7
    preview.setView(view)
    closeVector(f.controls.target.toArray(), [1, 2, 3]); assert.equal(f.camera.zoom, 1)
    closeVector(f.camera.position.toArray(), view === 'front' ? [1, 2, 43] : [1, 42, 3], 1e-4)
    const stationary = f.camera.position.toArray()
    for (let frame = 0; frame < 30; frame++) f.controls.update()
    closeVector(f.camera.position.toArray(), stationary)
    assert.equal(f.controls.enableRotate, true)
    assert.deepEqual({ plan, device: device.position.toArray(), cart: cart.position.toArray() }, original)
  }
  f.controls.dispose()
})

test('resizing an orbited inline camera uses projected bounds, retains observer pose and leaves physical alignment unchanged', () => {
  const f = observer(), bounds = new T.Box3(new T.Vector3(-2, -1, -10), new T.Vector3(2, 1, 10))
  const preview = Object.assign(Object.create(DockingCalibrationPreview.prototype), {
    camera: f.camera, controls: f.controls, center: new T.Vector3(), span: 10, bounds,
    container: { clientWidth: 800, clientHeight: 480 }, renderer: { setSize() {} }
  })
  preview.setView('front'); const frontHeight = f.camera.top
  assert.ok(frontHeight < 2, 'unprojected front/back spacing cannot shrink the standard front view')
  f.drag(0, [200, 180], [320, 180])
  const original = { position: f.camera.position.toArray(), quaternion: f.camera.quaternion.toArray(), target: f.controls.target.toArray(), zoom: f.camera.zoom, bounds: [bounds.min.toArray(), bounds.max.toArray()] }
  preview.resize()
  assert.ok(f.camera.top > frontHeight, 'rotated depth contributes only when it is actually projected')
  assert.deepEqual({ position: f.camera.position.toArray(), quaternion: f.camera.quaternion.toArray(), target: f.controls.target.toArray(), zoom: f.camera.zoom, bounds: [bounds.min.toArray(), bounds.max.toArray()] }, original)
  f.controls.dispose()
})
