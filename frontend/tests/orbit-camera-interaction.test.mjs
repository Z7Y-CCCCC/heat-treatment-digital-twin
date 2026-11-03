import test from 'node:test'
import assert from 'node:assert/strict'
import { Vector3, PerspectiveCamera } from 'three'
import gsap from 'gsap'
import { SceneManager } from '../src/three/SceneManager.js'

test('manual orbit start kills both ends of an active camera flight and holds the current pose', () => {
  const scene = Object.create(SceneManager.prototype)
  scene.camera = { position: new Vector3(12, 8, 20) }
  scene.controls = { target: new Vector3(1, 2, 3) }
  const cameraFlight = gsap.to(scene.camera.position, { x: -200, duration: 2, paused: true })
  const targetFlight = gsap.to(scene.controls.target, { z: 90, duration: 2, paused: true })
  cameraFlight.progress(.25); targetFlight.progress(.25)
  const position = scene.camera.position.clone(), target = scene.controls.target.clone()
  scene.stopCameraTransition()
  assert.equal(gsap.getTweensOf(scene.camera.position).length, 0)
  assert.equal(gsap.getTweensOf(scene.controls.target).length, 0)
  gsap.globalTimeline.time(gsap.globalTimeline.time() + 10)
  assert.deepEqual(scene.camera.position.toArray(), position.toArray())
  assert.deepEqual(scene.controls.target.toArray(), target.toArray())
})

test('real OrbitControls start event takes over a flight and permits repeated turns', () => {
  const document = new EventTarget(), canvas = new EventTarget()
  Object.assign(canvas, { ownerDocument: document, style: {}, clientWidth: 1280, clientHeight: 720, getRootNode: () => document })
  const scene = Object.create(SceneManager.prototype)
  scene.camera = new PerspectiveCamera(42, 16 / 9, .1, 1000)
  scene.camera.position.set(0, 10, 20)
  scene.renderer = { domElement: canvas }
  scene.suppressConnectionBadges = () => {}
  scene.initControls()
  try {
    gsap.to(scene.camera.position, { x: 100, duration: 5, paused: true })
    gsap.to(scene.controls.target, { z: -100, duration: 5, paused: true })
    scene.controls.dispatchEvent({ type: 'start' })
    assert.equal(gsap.getTweensOf(scene.camera.position).length, 0)
    assert.equal(gsap.getTweensOf(scene.controls.target).length, 0)
    const pivot = scene.controls.target.clone()
    let previous = scene.controls.getAzimuthalAngle()
    for (let frame = 0; frame < 400; frame++) {
      scene.controls.rotateLeft(.1)
      scene.controls.update()
      const yaw = scene.controls.getAzimuthalAngle()
      const change = Math.atan2(Math.sin(yaw - previous), Math.cos(yaw - previous))
      assert.ok(change < 0 && change > -1, 'continued same-direction orbit cannot reverse at the angle seam')
      previous = yaw
    }
    for (let frame = 0; frame < 400; frame++) scene.controls.update()
    const settled = scene.camera.position.clone()
    for (let frame = 0; frame < 100; frame++) scene.controls.update()
    assert.ok(scene.camera.position.distanceTo(settled) < 1e-7, 'idle must not restore a preset')
    assert.ok(scene.controls.target.distanceTo(pivot) < 1e-7)
  } finally { scene.controls.dispose() }
})

function fixture() {
  const scene = Object.create(SceneManager.prototype)
  scene.renderer = { domElement: new EventTarget() }
  scene.interactionOptions = {}
  const element = scene.renderer.domElement
  scene.initRaycaster()
  const event = (type, x, y, pointerId = 1) => Object.assign(new Event(type), { button: 0, clientX: x, clientY: y, pointerId })
  return { scene, down: (x, y) => element.dispatchEvent(event('pointerdown', x, y)),
    move: (x, y, id) => window.dispatchEvent(event('pointermove', x, y, id)),
    up: (x, y) => window.dispatchEvent(event('pointerup', x, y)),
    cleanup: () => {
      element.removeEventListener('pointerdown', scene.boundBeginCanvasGesture, true)
      window.removeEventListener('pointermove', scene.boundTrackCanvasGesture)
      window.removeEventListener('pointerup', scene.boundEndCanvasGesture)
      window.removeEventListener('pointercancel', scene.boundEndCanvasGesture)
    }
  }
}

test('a complete orbit gesture never selects a device on release, including an out-and-back drag', () => {
  const oldWindow = globalThis.window
  globalThis.window = new EventTarget()
  const f = fixture()
  try {
    f.down(10, 10); f.move(300, 10); f.up(10, 10)
    assert.equal(f.scene.suppressNextClick, true)
    // Production click path returns before any picking/navigation can run.
    f.scene.handleCanvasClick({ clientX: 10, clientY: 10 })
    assert.equal(f.scene.suppressNextClick, false)
    f.down(10, 10); f.move(300, 10, 2); f.up(11, 10)
    assert.equal(f.scene.suppressNextClick, false, 'another pointer cannot contaminate a normal click')
    f.down(10, 10); f.up(40, 10)
    assert.equal(f.scene.suppressNextClick, true, 'release-only motion counts even without a move event')
    f.down(10, 10); f.up(10, 10)
    assert.equal(f.scene.suppressNextClick, false, 'the next genuine click remains usable')
  } finally { f.cleanup(); globalThis.window = oldWindow }
})
