import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LoadingPortPreview, LoadingPortPointerGesture, LoadingPortLabelLayer, projectLoadingPortLabel, loadingPortCameraDistance, loadingPortSurfacePoint, loadingPortHeightLabel, stopLoadingPortOrbitDamping, collectLoadingPortNodes, nodeBoundsInLoadingRoot } from '../src/three/LoadingPortPreview.js'

const closeVector = (actual, expected) => actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-8, `${actual} != ${expected}`))
const pointer = (values = {}) => ({ pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: 30, clientY: 40, ...values })
const up = (values = {}) => pointer({ buttons: 0, ...values })

test('node bounds and center/bottom coordinates include authored hierarchy but exclude owner root transforms', () => {
  const root = new THREE.Group(); root.position.set(100, 40, -70); root.scale.set(2, 3, 4); root.rotation.y = .5
  const group = new THREE.Group(); group.position.set(5, 1, 6); root.add(group)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 6)); mesh.position.set(2, 3, 0); group.add(mesh)
  const original = { position: root.position.toArray(), scale: root.scale.toArray(), rotation: root.rotation.toArray(), node: mesh.position.toArray() }
  const originalBounds = mesh.geometry.boundingBox
  const box = nodeBoundsInLoadingRoot(group, root)
  const center = box.getCenter(new THREE.Vector3()).toArray()
  center.forEach((value, axis) => assert.ok(Math.abs(value - [7, 4, 6][axis]) < 1e-8)); assert.ok(Math.abs(box.min.y - 3) < 1e-8)
  assert.deepEqual({ position: root.position.toArray(), scale: root.scale.toArray(), rotation: root.rotation.toArray(), node: mesh.position.toArray() }, original)
  assert.equal(mesh.geometry.boundingBox, originalBounds, 'measurement must not populate or mutate asset geometry bounds')
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { root, nodes: collectLoadingPortNodes(root) })
  const point = preview.nodePoint(group.uuid, true); assert.ok(Math.abs(point.position[1] - 3) < 1e-8)
  mesh.geometry.dispose()
})

test('editor markers never pollute node bounds and node picker keeps duplicate names distinct', () => {
  const root = new THREE.Group(), one = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)), two = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
  one.name = two.name = 'same'; two.position.x = 3; root.add(one, two)
  const entries = collectLoadingPortNodes(root); assert.equal(entries.filter(entry => entry.name === 'same').length, 2); assert.notEqual(entries[1].id, entries[2].id)
  const marker = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000)); marker.userData.loadingPortEditor = true; root.add(marker)
  const bounds = nodeBoundsInLoadingRoot(root, root); assert.equal(bounds.min.x, -1); assert.equal(bounds.max.x, 4)
  for (const mesh of [one, two, marker]) mesh.geometry.dispose()
})

test('preview disposal is idempotent and releases animation, resize, controls, renderer and pointer hooks', () => {
  const counts = {}, count = name => counts[name] = (counts[name] || 0) + 1
  const dom = { removeEventListener: name => count(name), remove: () => count('dom') }
  const pointerDocument = { removeEventListener: (name, handler, capture) => { assert.equal(capture, true); count(name) } }
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { disposed: false, pointerDocument, labels: { dispose: () => count('labels') }, gesture: { reset: () => count('gesture') }, renderer: { domElement: dom, setAnimationLoop: value => { assert.equal(value, null); count('loop') }, dispose: () => count('renderer'), forceContextLoss: () => count('context') }, controls: { dispose: () => count('controls') }, observer: { disconnect: () => count('resize') }, clearAsset: () => count('assets') })
  preview.dispose(); preview.dispose()
  assert.deepEqual(counts, { loop: 1, resize: 1, pointerdown: 1, pointermove: 1, pointerup: 1, pointercancel: 1, lostpointercapture: 1, wheel: 1, gesture: 1, controls: 1, assets: 1, labels: 1, renderer: 1, context: 1, dom: 1 })
})

test('surface pick retains the exact root-local point with nested rotations and uniform owner scale', () => {
  const root = new THREE.Group(); root.position.set(100, 40, -70); root.scale.setScalar(3); root.rotation.y = .7
  const group = new THREE.Group(); group.position.set(5, 2, -6); group.rotation.y = 1.2; group.scale.setScalar(.4); root.add(group)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)); mesh.name = '口下沿'; mesh.position.set(.5, 2, -1); group.add(mesh)
  root.updateMatrixWorld(true)
  const meshPoint = new THREE.Vector3(.2, -.99927, 1), world = mesh.localToWorld(meshPoint.clone())
  const expected = meshPoint.clone().applyMatrix4(mesh.matrix).applyMatrix4(group.matrix)
  const result = loadingPortSurfacePoint({ point: world, object: mesh, face: { normal: new THREE.Vector3(0, 0, 1) } }, root)
  closeVector(result.position, expected.toArray()); assert.equal(result.nodeName, '口下沿')
  closeVector(result.direction, new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), 1.2).toArray())
  assert.notEqual(result.position[1], 2, 'must not use node center or bounds bottom instead of clicked point')
  closeVector(world.toArray(), mesh.localToWorld(meshPoint.clone()).toArray())
  mesh.geometry.dispose()
})

test('tiny uniform root scale does not discard a valid exact surface point', () => {
  const root = new THREE.Group(); root.scale.setScalar(.00001)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry()); mesh.position.set(2, 3, 4); root.add(mesh); root.updateMatrixWorld(true)
  const point = mesh.localToWorld(new THREE.Vector3(0, -.25, .5))
  const result = loadingPortSurfacePoint({ object: mesh, point, face: { normal: new THREE.Vector3(0, 0, 1) } }, root)
  closeVector(result.position, [2, 2.75, 4.5]); closeVector(result.direction, [0, 0, 1]); mesh.geometry.dispose()
})

test('surface normals use inverse-transpose through nested nonuniform transforms', () => {
  const root = new THREE.Group(); root.rotation.y = -.8; root.scale.setScalar(2)
  const group = new THREE.Group(); group.rotation.y = .3; group.scale.set(2, .4, 5); root.add(group)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry()); mesh.rotation.y = .9; group.add(mesh); root.updateMatrixWorld(true)
  const normal = new THREE.Vector3(0, 0, 1), relative = group.matrix.clone().multiply(mesh.matrix)
  const expected = normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(relative)).normalize()
  const result = loadingPortSurfacePoint({ object: mesh, point: mesh.localToWorld(new THREE.Vector3(0, 0, .5)), face: { normal } }, root)
  closeVector(result.direction, expected.toArray()); assert.equal(result.direction[1], 0); mesh.geometry.dispose()
})

test('top, floor, sloped or missing normals never manufacture a direction', () => {
  const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry()); root.add(mesh); root.updateMatrixWorld(true)
  for (const normal of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 1, 0).normalize(), new THREE.Vector3(0, 0, 0), new THREE.Vector3(NaN, 0, 1), null]) {
    const result = loadingPortSurfacePoint({ object: mesh, point: new THREE.Vector3(.2, -.3, .4), face: normal ? { normal } : null }, root)
    assert.deepEqual(result, { position: [.2, -.3, .4], nodeName: '' })
  }
  mesh.geometry.dispose()
})

test('surface picking excludes overlay ancestry, foreign meshes and singular owner transforms', () => {
  const root = new THREE.Group(), overlay = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry())
  overlay.userData.loadingPortEditor = true; overlay.add(mesh); root.add(overlay)
  const hit = { object: mesh, point: new THREE.Vector3(), face: { normal: new THREE.Vector3(1, 0, 0) } }
  assert.equal(loadingPortSurfacePoint(hit, root), null)
  const foreign = new THREE.Group(); assert.equal(loadingPortSurfacePoint(hit, foreign), null)
  overlay.userData.loadingPortEditor = false; root.scale.y = 0; assert.equal(loadingPortSurfacePoint(hit, root), null)
  root.scale.y = 1; hit.point.x = NaN; assert.equal(loadingPortSurfacePoint(hit, root), null)
  mesh.geometry.dispose()
})

test('a single normal click or tiny motion picks once, without damping/orbit drag', () => {
  const gesture = new LoadingPortPointerGesture()
  assert.equal(gesture.begin(pointer(), true), true); assert.equal(gesture.pendingClick, true)
  assert.equal(gesture.move(pointer({ clientX: 32, clientY: 43 })), true)
  assert.equal(gesture.end(up({ clientX: 32, clientY: 43 }), true), true)
  assert.equal(gesture.pendingClick, false); assert.equal(gesture.end(up(), true), false)
})

test('a drag that returns to its initial position cannot pick', () => {
  const gesture = new LoadingPortPointerGesture(); gesture.begin(pointer(), true)
  assert.equal(gesture.move(pointer({ clientX: 70 })), false)
  assert.equal(gesture.move(pointer()), false); assert.equal(gesture.end(up(), true), false)
})

test('coalesced excursion beyond the threshold cannot hide in a final close move', () => {
  const gesture = new LoadingPortPointerGesture(); gesture.begin(pointer(), true)
  assert.equal(gesture.move(pointer({ getCoalescedEvents: () => [pointer({ clientX: 65 }), pointer()] })), false)
  assert.equal(gesture.end(up(), true), false)
})

test('movement first observed on pointerup still cancels a drag', () => {
  const gesture = new LoadingPortPointerGesture(); gesture.begin(pointer(), true)
  assert.equal(gesture.end(up({ clientY: 70 }), true), false)
})

test('right, middle, nonprimary or modified clicks are never port gestures', () => {
  for (const invalid of [{ button: 1, buttons: 4 }, { button: 2, buttons: 2 }, { isPrimary: false }, { buttons: 3 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    const gesture = new LoadingPortPointerGesture()
    assert.equal(gesture.begin(pointer(invalid), true), false)
    assert.equal(gesture.end(up(), true), false)
  }
})

test('multi-touch remains invalid until all participating pointers end', () => {
  const gesture = new LoadingPortPointerGesture()
  gesture.begin(pointer({ pointerType: 'touch' }), true)
  assert.equal(gesture.begin(pointer({ pointerId: 2, pointerType: 'touch', isPrimary: false }), true), false)
  assert.equal(gesture.pendingClick, false)
  assert.equal(gesture.end(up({ pointerType: 'touch' }), true), false)
  assert.equal(gesture.end(up({ pointerId: 2, pointerType: 'touch' }), true), false)
  assert.equal(gesture.begin(pointer({ pointerId: 3, pointerType: 'touch' }), true), true)
  assert.equal(gesture.end(up({ pointerId: 3, pointerType: 'touch' }), true), true)
})

test('overlapping or duplicate pointerdown cannot restart a canceled click', () => {
  const gesture = new LoadingPortPointerGesture(); gesture.begin(pointer(), true)
  assert.equal(gesture.begin(pointer({ button: 2, buttons: 3 }), true), false)
  assert.equal(gesture.end(up(), true), false)
  gesture.begin(pointer(), true); gesture.begin(pointer({ pointerId: 2 }), false)
  assert.equal(gesture.end(up(), true), false); assert.equal(gesture.end(up({ pointerId: 2 }), true), false)
})

test('foreign pointerup and external release do not set a port', () => {
  const gesture = new LoadingPortPointerGesture(); gesture.begin(pointer(), true)
  assert.equal(gesture.end(up({ pointerId: 7 }), true), false)
  assert.equal(gesture.end(up(), false), false)
  assert.equal(gesture.begin(pointer(), false), false); assert.equal(gesture.end(up(), true), false)
})

test('pointercancel, lost capture, wheel invalidation and reset prevent stale selection', () => {
  for (const cancel of [g => g.cancel(pointer()), g => g.invalidate(), g => g.reset()]) {
    const gesture = new LoadingPortPointerGesture(); gesture.begin(pointer(), true); cancel(gesture)
    assert.equal(gesture.pendingClick, false); assert.equal(gesture.end(up(), true), false)
    assert.equal(gesture.begin(pointer(), true), true); assert.equal(gesture.end(up(), true), true)
  }
})

test('actual OrbitControls inertia is drained while preserving the visible camera pose', () => {
  const document = { addEventListener() {}, removeEventListener() {} }
  const element = { style: {}, ownerDocument: document, addEventListener() {}, removeEventListener() {}, getRootNode: () => document }
  const camera = new THREE.PerspectiveCamera(); camera.position.set(5, 4, 6)
  const controls = new OrbitControls(camera, element); controls.enableDamping = true
  controls._sphericalDelta.theta = .4; controls._sphericalDelta.phi = .1; controls._panOffset.set(.2, .1, 0)
  const before = { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), target: controls.target.toArray(), zoom: camera.zoom }
  stopLoadingPortOrbitDamping(controls, camera)
  assert.deepEqual({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), target: controls.target.toArray(), zoom: camera.zoom }, before)
  assert.equal(controls.enableDamping, true); assert.equal(controls._sphericalDelta.theta, 0); assert.equal(controls._panOffset.lengthSq(), 0)
  controls.update(); closeVector(camera.position.toArray(), before.position); controls.dispose()
})

test('reset complete view discards previous orbit/pan/zoom inertia and establishes a genuinely stationary default pose', () => {
  const document = { addEventListener() {}, removeEventListener() {} }
  const element = { style: {}, ownerDocument: document, addEventListener() {}, removeEventListener() {}, getRootNode: () => document }
  const camera = new THREE.PerspectiveCamera(42, 1, .01, 10000); camera.position.set(5, 4, 6)
  const controls = new OrbitControls(camera, element); controls.enableDamping = true
  controls._sphericalDelta.theta = .8; controls._sphericalDelta.phi = .15; controls._panOffset.set(.5, .4, .2); controls._scale = .7
  const box = new THREE.Box3(new THREE.Vector3(10, 1, -5), new THREE.Vector3(14, 5, -1)), extent = box.getSize(new THREE.Vector3()).length()
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { root: new THREE.Group(), camera, controls, box, extent })
  preview.resetCamera()
  const center = box.getCenter(new THREE.Vector3()), expected = center.clone().add(new THREE.Vector3(.9, .65, 1.1).normalize().multiplyScalar(loadingPortCameraDistance(extent, camera.aspect)))
  closeVector(camera.position.toArray(), expected.toArray()); closeVector(controls.target.toArray(), center.toArray())
  assert.equal(controls.enableDamping, true); assert.equal(controls.autoRotate, false)
  assert.equal(controls._sphericalDelta.theta, 0); assert.equal(controls._panOffset.lengthSq(), 0); assert.equal(controls._scale, 1)
  for (let frame = 0; frame < 20; frame++) controls.update()
  closeVector(camera.position.toArray(), expected.toArray()); closeVector(controls.target.toArray(), center.toArray()); controls.dispose()
})

test('camera distance preserves the old landscape fit and accounts for narrow horizontal frustums', () => {
  assert.equal(loadingPortCameraDistance(10, 1), 14); assert.equal(loadingPortCameraDistance(10, 2), 14)
  assert.equal(loadingPortCameraDistance(10, .5), 28)
  assert.equal(loadingPortCameraDistance(10, 0), 14); assert.equal(loadingPortCameraDistance(10, NaN), 14)
  assert.ok(Number.isFinite(loadingPortCameraDistance(0, 1)))
})

test('complete view contains every transformed model bounding-box corner at portrait and landscape aspects', () => {
  const document = { addEventListener() {}, removeEventListener() {} }
  const element = { style: {}, ownerDocument: document, addEventListener() {}, removeEventListener() {}, getRootNode: () => document }
  for (const size of [[4, 4, 4], [20, .5, .3], [.4, 18, .5], [.3, .5, 20]]) {
    const root = new THREE.Group(); root.position.set(10, 2, -6); root.scale.setScalar(2); root.rotation.y = .6
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size)); root.add(mesh)
    const before = { position: root.position.toArray(), scale: root.scale.toArray(), rotation: root.rotation.toArray() }
    const box = new THREE.Box3().setFromObject(root), extent = box.getSize(new THREE.Vector3()).length()
    for (const aspect of [.01, .15, .45, .8, 1, 2, 4]) {
      const camera = new THREE.PerspectiveCamera(42, aspect, .01, 10000); camera.position.set(5, 4, 6)
      const controls = new OrbitControls(camera, element); controls.enableDamping = true
      const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { root, camera, controls, box, extent })
      controls._sphericalDelta.theta = .8; controls._panOffset.set(.5, .4, .2); controls._scale = .7
      preview.resetCamera(); camera.updateMatrixWorld(true)
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(camera)
        for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(projected[axis]) <= 1 + 1e-8,
          `size ${size}, aspect ${aspect}: projected corner ${projected.toArray()} outside frustum`)
      }
      assert.ok(camera.position.distanceTo(controls.target) <= controls.maxDistance); controls.dispose()
    }
    assert.deepEqual({ position: root.position.toArray(), scale: root.scale.toArray(), rotation: root.rotation.toArray() }, before)
    mesh.geometry.dispose()
  }
})

test('aspect changes retain observation direction, pan target and relative zoom without old damping drift', () => {
  const document = { addEventListener() {}, removeEventListener() {} }
  const element = { style: {}, ownerDocument: document, addEventListener() {}, removeEventListener() {}, getRootNode: () => document }
  const camera = new THREE.PerspectiveCamera(42, 2, .01, 10000), controls = new OrbitControls(camera, element)
  controls.enableDamping = true; controls.target.set(5, -2, 3)
  const box = new THREE.Box3(new THREE.Vector3(-3, -3, -3), new THREE.Vector3(3, 3, 3)), extent = box.getSize(new THREE.Vector3()).length()
  const direction = new THREE.Vector3(.5, .2, -.7).normalize(), relativeZoom = .65, target = controls.target.clone()
  camera.position.copy(target).addScaledVector(direction, loadingPortCameraDistance(extent, 2) * relativeZoom); controls.update()
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { root: new THREE.Group(), camera, controls, box, extent, gesture: new LoadingPortPointerGesture() })
  for (const aspect of [.45, .2, 1.5, 1]) {
    controls._sphericalDelta.theta = .6; controls._panOffset.set(.3, .2, .1); controls._scale = .8
    preview.gesture.begin(pointer(), true); preview.resizeCamera(aspect)
    assert.equal(preview.gesture.pendingClick, false); preview.gesture.reset()
    const offset = camera.position.clone().sub(controls.target)
    closeVector(offset.clone().normalize().toArray(), direction.toArray()); closeVector(controls.target.toArray(), target.toArray())
    assert.ok(Math.abs(offset.length() / loadingPortCameraDistance(extent, aspect) - relativeZoom) < 1e-8)
    assert.equal(camera.aspect, aspect); assert.equal(controls.enableDamping, true); assert.equal(controls._scale, 1)
    const stationary = camera.position.toArray(); for (let frame = 0; frame < 20; frame++) controls.update(); closeVector(camera.position.toArray(), stationary)
  }
  controls.dispose()
})

test('single-point markers do not require direction and active inlet/outlet highlights switch clearly', () => {
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { markers: new THREE.Group(), localExtent: 10 })
  const ports = { inlet: { position: [1, 1.234567, 3] }, outlet: { position: [-2, 2, -3], direction: [0, 0, -1] } }
  preview.setPorts(ports, null, 'inlet')
  const points = preview.portMarkers.children.filter(child => child.userData.loadingPortRole === 'point')
  assert.equal(points.length, 2); closeVector(points[0].position.toArray(), ports.inlet.position)
  assert.equal(points[0].userData.loadingPortActive, true); assert.equal(points[1].userData.loadingPortActive, false)
  assert.ok(points[0].geometry.parameters.radius > points[1].geometry.parameters.radius)
  assert.match(points[0].userData.loadingPortLabel, /进料口.*高度 1\.2346/)
  const line = preview.portMarkers.children.find(child => child.userData.loadingPortRole === 'height-baseline' && child.userData.loadingPortKind === 'inlet')
  const coords = line.geometry.getAttribute('position')
  assert.ok(Math.abs(coords.getY(0) - ports.inlet.position[1]) < 1e-6); assert.ok(Math.abs(coords.getY(1) - ports.inlet.position[1]) < 1e-6)
  assert.equal(preview.portMarkers.children.filter(child => child.isBox3Helper).length, 0)
  assert.equal(preview.portMarkers.children.filter(child => child.userData.loadingPortRole === 'direction').length, 1, 'no fabricated arrow when direction is absent')
  const old = preview.portMarkers; let disposed = 0; points[0].geometry.addEventListener('dispose', () => disposed++)
  preview.setPorts(ports, null, 'outlet'); assert.equal(disposed, 1); assert.equal(old.parent, null)
  const outlet = preview.portMarkers.children.find(child => child.userData.loadingPortRole === 'point' && child.userData.loadingPortKind === 'outlet')
  assert.equal(outlet.userData.loadingPortActive, true)
  preview.setPorts(null); assert.equal(preview.portMarkers.children.length, 0)
})

test('height labels do not pretend the root coordinates use a specified physical unit', () => {
  assert.equal(loadingPortHeightLabel({ position: [0, -1.00506, 0] }, 'outlet'), '出料口 · 高度 -1.0051')
})

function labelFixture(position = 'absolute') {
  let container
  const document = { defaultView: { getComputedStyle: () => ({ position }) }, createElement: () => ({
    style: {}, attributes: {}, children: [], hidden: false, ownerDocument: document,
    setAttribute(name, value) { this.attributes[name] = value },
    appendChild(element) { element.parentElement = this; this.children.push(element) },
    remove() { this.removed = true; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null },
    get offsetWidth() { return Math.min(160, Math.max(0, container.clientWidth - 12)) }, get offsetHeight() { return 35 }
  }) }
  container = document.createElement('div'); container.clientWidth = container.clientHeight = 470
  const labels = new LoadingPortLabelLayer(container), root = new THREE.Group()
  const camera = new THREE.PerspectiveCamera(42, 1, .01, 10000); camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0)
  return { container, labels, root, camera }
}

test('DOM height labels retain 14px admin-scaled font and full contrast at every model zoom', () => {
  const { labels, root, camera } = labelFixture()
  labels.add({ position: [0, 1.234567, 0] }, 'inlet', false, false)
  const element = labels.entries[0].element
  assert.equal(element.style.fontSize, 'calc(14px * var(--admin-font-scale,1))')
  assert.equal(element.style.fontWeight, '600'); assert.equal(element.style.color, '#fff'); assert.equal(element.style.background, '#146579')
  assert.equal(element.style.opacity, '1'); assert.equal(element.style.pointerEvents, 'none')
  assert.equal(element.textContent, '进料口 · 高度 1.2346')
  for (const distance of [4, 14, 100]) {
    camera.position.z = distance; labels.update(root, camera)
    assert.equal(element.hidden, false); assert.equal(element.style.fontSize, 'calc(14px * var(--admin-font-scale,1))')
    assert.equal(element.style.opacity, '1')
  }
  labels.dispose()
})

test('DOM label projection uses current root and camera transforms, hiding points outside the canvas/behind the camera', () => {
  const { root, camera } = labelFixture(), parent = new THREE.Group(); parent.position.set(100, 40, -70); parent.add(root)
  root.scale.setScalar(3); root.rotation.y = .7
  camera.position.set(100, 40, -60); camera.lookAt(100, 40, -70)
  const center = projectLoadingPortLabel([0, 0, 0], root, camera, 470, 470)
  closeVector([center.x, center.y], [235, 235])
  assert.equal(projectLoadingPortLabel([0, 0, 10], root, camera, 470, 470), null)
  assert.equal(projectLoadingPortLabel([1000, 0, 0], root, camera, 470, 470), null)
  assert.equal(projectLoadingPortLabel([0, 0, 0], root, camera, 0, 470), null)
})

test('height labels stay within resized/clipped canvas bounds and separate coincident active/inactive points', () => {
  const { labels, container, root, camera } = labelFixture()
  labels.add({ position: [0, 0, 0] }, 'inlet', false, false)
  labels.add({ position: [0, 0, 0] }, 'outlet', true, false)
  labels.update(root, camera)
  const [inlet, outlet] = labels.entries.map(entry => entry.element)
  assert.notEqual(inlet.style.transform, outlet.style.transform)
  container.clientWidth = 100; container.clientHeight = 90; labels.update(root, camera)
  for (const element of [inlet, outlet]) {
    const [x, y] = element.style.transform.match(/[\d.]+/g).map(Number)
    assert.ok(x >= 6 && x + element.offsetWidth <= container.clientWidth - 6)
    assert.ok(y >= 6 && y + element.offsetHeight <= container.clientHeight - 6)
    assert.equal(element.style.maxWidth, 'calc(100% - 12px)')
  }
  labels.entries[0].position = [0, 0, 20]; labels.update(root, camera); assert.equal(inlet.hidden, true)
  labels.dispose()
})

test('candidate label is distinguished with a border and text, not unreadable transparency', () => {
  const { labels } = labelFixture()
  labels.add({ position: [0, 0, 0] }, 'inlet', false, true)
  const element = labels.entries[0].element
  assert.match(element.textContent, /^建议 · 进料口/); assert.match(element.style.border, /dashed/)
  assert.equal(element.style.opacity, '1'); assert.equal(element.style.fontSize, 'calc(14px * var(--admin-font-scale,1))')
  labels.dispose()
})

test('setPorts replaces old DOM annotations without stacking label layers, and asset/dispose cleanup is complete', () => {
  const { labels, container } = labelFixture('static')
  assert.equal(container.style.position, 'relative')
  const preview = Object.assign(Object.create(LoadingPortPreview.prototype), { labels, markers: new THREE.Group(), localExtent: 10, scene: new THREE.Scene() })
  preview.setPorts({ inlet: { position: [0, 1, 0] } })
  const old = labels.entries[0].element
  preview.setPorts({ outlet: { position: [0, 2, 0] } }, null, 'outlet')
  assert.equal(old.removed, true); assert.equal(labels.entries.length, 1); assert.equal(container.children.length, 1)
  assert.equal(labels.entries[0].element.attributes['data-loading-port-active'], 'true')
  preview.clearAsset(); assert.equal(labels.entries.length, 0); assert.equal(labels.layer.children.length, 0)
  labels.dispose(); labels.dispose(); assert.equal(container.children.length, 0); assert.equal(container.style.position, '')
  labels.add({ position: [0, 0, 0] }, 'inlet', true, false); assert.equal(labels.entries.length, 0)
})
