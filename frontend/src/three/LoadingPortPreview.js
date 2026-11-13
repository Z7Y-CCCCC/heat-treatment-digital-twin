import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { loadConfiguredGltf, disposeSceneObject } from '../runtime/ConfiguredFactoryScene.js'
import { resolveBackendAssetUrl } from './ModelFactory.js'
import { restoreGltfNodeNames } from './gltfNodeIdentity.js'
import { inferLoadingPort } from './lineLoadingAlignment.js'
import { createSimpleRotatingCart } from './simpleRotatingCart.js'

function isEditorNode(node, root) {
  for (let item = node; item; item = item.parent) {
    if (item.userData?.loadingPortEditor) return true
    if (item === root) break
  }
  return false
}

// A hit is measured exactly in the authored root coordinates. A surface normal
// is optional: a floor/top face cannot tell us which way a loading mouth faces.
export function loadingPortSurfacePoint(hit, root) {
  if (!root || !hit?.object || !hit.point?.toArray().every(Number.isFinite) || isEditorNode(hit.object, root)) return null
  let ancestor = hit.object
  while (ancestor && ancestor !== root) ancestor = ancestor.parent
  if (!ancestor) return null
  root.updateMatrixWorld(true)
  if (!Number.isFinite(root.matrixWorld.determinant()) || root.matrixWorld.determinant() === 0) return null
  const point = root.worldToLocal(hit.point.clone())
  const result = { position: point.toArray(), nodeName: hit.object.name || '' }
  const normal = hit.face?.normal
  if (!normal?.toArray().every(Number.isFinite) || normal.lengthSq() < 1e-12) return result
  const relative = root.matrixWorld.clone().invert().multiply(hit.object.matrixWorld)
  if (!Number.isFinite(relative.determinant()) || relative.determinant() === 0) return result
  const localNormal = normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(relative)).normalize()
  // Only a near-vertical side face gives a trustworthy horizontal outward normal.
  // Never manufacture a direction from a node center, bounds, or camera position.
  if (Math.abs(localNormal.y) > .25 || Math.hypot(localNormal.x, localNormal.z) < .9) return result
  localNormal.y = 0; localNormal.normalize()
  result.direction = localNormal.toArray()
  return result
}

// Tracks the entire gesture (including coalesced movements), not just its final
// displacement. A drag that returns to its origin must never set a port.
export class LoadingPortPointerGesture {
  constructor(threshold = 5) { this.threshold = threshold; this.pointers = new Set(); this.candidate = null }
  begin(event, eligible) {
    if (this.candidate) this.candidate.invalid = true
    if (!Number.isFinite(event.pointerId)) return false
    const overlapping = this.pointers.size > 0
    this.pointers.add(event.pointerId)
    if (!eligible || overlapping || this.pointers.size !== 1 || event.isPrimary === false || event.button !== 0
      || (event.buttons !== undefined && event.buttons !== 1) || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false
    this.candidate = { id: event.pointerId, x: event.clientX, y: event.clientY, maxDistance: 0, invalid: false }
    return true
  }
  move(event, checkButtons = true) {
    const current = this.candidate
    if (!current || current.id !== event.pointerId) return false
    const samples = [...(event.getCoalescedEvents?.() || []), event]
    for (const sample of samples) {
      if (!Number.isFinite(sample.clientX) || !Number.isFinite(sample.clientY)) { current.invalid = true; continue }
      current.maxDistance = Math.max(current.maxDistance, Math.hypot(sample.clientX - current.x, sample.clientY - current.y))
    }
    if (current.maxDistance > this.threshold || (checkButtons && event.buttons !== undefined && event.buttons !== 1)) current.invalid = true
    return !current.invalid
  }
  end(event, inside) {
    const current = this.candidate
    this.move(event, false); this.pointers.delete(event.pointerId)
    if (!current || current.id !== event.pointerId) return false
    this.candidate = null
    return !!inside && !current.invalid && this.pointers.size === 0 && event.button === 0 && event.isPrimary !== false
      && (event.buttons === undefined || event.buttons === 0) && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
  }
  cancel(event) { this.pointers.delete(event?.pointerId); this.invalidate(); if (this.candidate?.id === event?.pointerId) this.candidate = null }
  invalidate() { if (this.candidate) this.candidate.invalid = true }
  reset() { this.candidate = null; this.pointers.clear() }
  get pendingClick() { return !!this.candidate && !this.candidate.invalid }
}

// Drain old orbit inertia without changing the visible pose. Otherwise a click
// made just after rotating the model would raycast against a moving camera.
export function stopLoadingPortOrbitDamping(controls, camera) {
  if (!controls || !camera) return
  const position = camera.position.clone(), quaternion = camera.quaternion.clone(), target = controls.target.clone(), zoom = camera.zoom
  const damping = controls.enableDamping, autoRotate = controls.autoRotate
  try {
    controls.enableDamping = false; controls.autoRotate = false; controls.update()
  } finally {
    camera.position.copy(position); camera.quaternion.copy(quaternion); camera.zoom = zoom
    controls.target.copy(target); controls.enableDamping = damping; controls.autoRotate = autoRotate
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true)
  }
}

export function loadingPortHeightLabel(port, kind) {
  const height = Number(port.position[1].toFixed(4))
  return `${kind === 'outlet' ? '出料口' : '进料口'} · 高度 ${height}`
}

const validLoadingPortAspect = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 1

// The 42-degree preview camera already fits a bounding sphere at 1.4 * the
// diagonal in square/landscape viewports. Portrait viewports have a smaller
// horizontal frustum, so back away proportionally without resizing the model.
export function loadingPortCameraDistance(extent, aspect) {
  const size = Number.isFinite(Number(extent)) && Number(extent) > 0 ? Number(extent) : .001
  return size * 1.4 * Math.max(1, 1 / validLoadingPortAspect(aspect))
}

function updateCameraWithoutLoadingPortInertia(controls) {
  const damping = controls.enableDamping, autoRotate = controls.autoRotate
  try {
    controls.enableDamping = false; controls.autoRotate = false; controls.update()
  } finally { controls.enableDamping = damping; controls.autoRotate = autoRotate }
}

// Height is an annotation, not a world-sized mesh. Keep its text readable at
// every zoom level, including a short/narrow model-preview canvas.
export function projectLoadingPortLabel(position, root, camera, width, height) {
  if (!root || !camera || width <= 0 || height <= 0 || !position?.every(Number.isFinite)) return null
  root.updateWorldMatrix(true, false); camera.updateWorldMatrix(true, false)
  const point = new THREE.Vector3(...position).applyMatrix4(root.matrixWorld).project(camera)
  if (![point.x, point.y, point.z].every(Number.isFinite) || Math.abs(point.x) > 1 || Math.abs(point.y) > 1 || Math.abs(point.z) > 1) return null
  return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 }
}

export class LoadingPortLabelLayer {
  constructor(container) {
    this.container = container; this.entries = []; this.disposed = false
    const document = container.ownerDocument
    this.layer = document.createElement('div'); this.layer.className = 'loading-port-label-layer'
    this.layer.setAttribute('role', 'group'); this.layer.setAttribute('aria-label', '进出料口高度')
    Object.assign(this.layer.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '1' })
    const position = document.defaultView?.getComputedStyle(container).position || container.style.position || 'static'
    if (position === 'static') { this.previousPosition = container.style.position || ''; container.style.position = 'relative' }
    container.appendChild(this.layer)
  }
  add(port, kind, active, candidate) {
    if (this.disposed) return
    const element = this.container.ownerDocument.createElement('div'); element.className = 'loading-port-height-label'
    const text = `${candidate ? '建议 · ' : ''}${loadingPortHeightLabel(port, kind)}`
    element.textContent = text; element.title = text
    element.setAttribute('data-loading-port-kind', kind)
    element.setAttribute('data-loading-port-active', String(active))
    element.setAttribute('data-loading-port-candidate', String(candidate))
    Object.assign(element.style, {
      position: 'absolute', left: '0', top: '0', margin: '0', boxSizing: 'border-box', padding: '6px 10px',
      maxWidth: 'calc(100% - 12px)', borderRadius: '6px', border: candidate ? '2px dashed #c8d8ef' : '1px solid #ffffff',
      fontFamily: 'inherit', fontWeight: '600', fontSize: 'calc(14px * var(--admin-font-scale,1))', lineHeight: '1.5',
      color: '#fff', background: active ? '#1757a6' : kind === 'inlet' ? '#146579' : '#925113', opacity: '1',
      whiteSpace: 'normal', overflowWrap: 'anywhere', pointerEvents: 'none', userSelect: 'none'
    })
    element.hidden = true; this.layer.appendChild(element)
    this.entries.push({ element, position: [...port.position], active, candidate })
  }
  update(root, camera) {
    if (this.disposed) return
    const width = this.container.clientWidth, height = this.container.clientHeight, occupied = []
    const clamp = (value, limit) => Math.max(6, Math.min(value, Math.max(6, limit)))
    // Prefer the currently edited point when nearby labels need separate slots.
    for (const entry of [...this.entries].sort((a, b) => Number(b.active) - Number(a.active))) {
      const point = projectLoadingPortLabel(entry.position, root, camera, width, height), element = entry.element
      if (!point) { element.hidden = true; continue }
      element.hidden = false
      const labelWidth = element.offsetWidth, labelHeight = element.offsetHeight
      const slots = [
        [point.x + 12, point.y - labelHeight - 12], [point.x + 12, point.y + 12],
        [point.x - labelWidth - 12, point.y - labelHeight - 12], [point.x - labelWidth - 12, point.y + 12]
      ].map(([x, y]) => ({ x: clamp(x, width - labelWidth - 6), y: clamp(y, height - labelHeight - 6) }))
      const slot = slots.find(({ x, y }) => !occupied.some(box => x < box.x + box.width + 4 && x + labelWidth + 4 > box.x && y < box.y + box.height + 4 && y + labelHeight + 4 > box.y)) || slots[0]
      element.style.transform = `translate(${slot.x.toFixed(2)}px, ${slot.y.toFixed(2)}px)`
      occupied.push({ ...slot, width: labelWidth, height: labelHeight })
    }
  }
  clear() { for (const { element } of this.entries) element.remove(); this.entries = [] }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.clear(); this.layer.remove()
    if (this.previousPosition !== undefined && this.container.style.position === 'relative') this.container.style.position = this.previousPosition
  }
}

// All editor coordinates are relative to the authored glTF scene root. Never
// normalize/recenter/resize the asset to make the preview fit the viewport.
export function nodeBoundsInLoadingRoot(node, root) {
  root.updateMatrixWorld(true)
  const inverse = root.matrixWorld.clone().invert(), box = new THREE.Box3()
  node.traverse(child => {
    if (!child.geometry || isEditorNode(child, root)) return
    const positions = child.geometry.getAttribute('position')
    const local = child.geometry.boundingBox?.clone() || (positions ? new THREE.Box3().setFromBufferAttribute(positions) : null)
    if (local) box.union(local.applyMatrix4(inverse.clone().multiply(child.matrixWorld)))
  })
  return box
}

export function collectLoadingPortNodes(root) {
  const counts = new Map(), entries = []
  const visit = node => {
    let meshCount = node.geometry ? 1 : 0
    for (const child of node.children) meshCount += visit(child)
    counts.set(node, meshCount)
    return meshCount
  }
  visit(root)
  root.traverse(node => {
    if (!counts.get(node)) return
    const parts = []
    for (let item = node; item && item !== root; item = item.parent) parts.unshift(item.name || item.type)
    entries.push({ id: node.uuid, name: node.name || '未命名节点', path: parts.join(' / ') || '模型根节点', meshCount: counts.get(node), node })
  })
  return entries
}

export class LoadingPortPreview {
  constructor(container, { onSurface = () => {} } = {}) {
    this.container = container
    this.onSurface = onSurface
    this.disposed = false
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0xf1f5f9)
    this.camera = new THREE.PerspectiveCamera(42, 1, .01, 10000)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.domElement.setAttribute('aria-label', '模型进出料口三维预览，拖动旋转，滚轮缩放')
    this.renderer.domElement.setAttribute('role', 'img')
    container.appendChild(this.renderer.domElement)
    this.labels = new LoadingPortLabelLayer(container)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x879db2, 2.5))
    const light = new THREE.DirectionalLight(0xffffff, 2)
    light.position.set(8, 14, 9); this.scene.add(light)
    this.raycaster = new THREE.Raycaster()
    this.gesture = new LoadingPortPointerGesture()
    this.pointerDocument = this.renderer.domElement.ownerDocument
    const inside = event => {
      const rect = this.renderer.domElement.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
    }
    this.down = event => {
      const eligible = this.picking && this.root && event.target === this.renderer.domElement && inside(event)
      if (this.gesture.begin(event, eligible)) stopLoadingPortOrbitDamping(this.controls, this.camera)
    }
    this.move = event => {
      // OrbitControls listens on ownerDocument. Suppress only sub-threshold
      // movement while a click is still possible; real drags remain normal orbit.
      if (this.gesture.move(event)) event.stopImmediatePropagation()
    }
    this.up = event => {
      const click = this.gesture.end(event, event.target === this.renderer.domElement && inside(event))
      if (!click || !this.picking || !this.root || this.disposed) return
      const rect = this.renderer.domElement.getBoundingClientRect()
      this.camera.updateMatrixWorld(true); this.root.updateMatrixWorld(true)
      this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera)
      // Intersect authored geometry only; editor markers must not pick themselves.
      const meshes = []
      this.root.traverseVisible(node => { if (node.isMesh && !isEditorNode(node, this.root)) meshes.push(node) })
      const hit = this.raycaster.intersectObjects(meshes, false)[0]
      const point = loadingPortSurfacePoint(hit, this.root)
      if (point) this.onSurface(point)
    }
    this.cancel = event => this.gesture.cancel(event)
    this.wheel = () => this.gesture.invalidate()
    this.blur = () => this.gesture.reset()
    for (const [name, handler] of [['pointerdown', this.down], ['pointermove', this.move], ['pointerup', this.up], ['pointercancel', this.cancel]]) this.pointerDocument.addEventListener(name, handler, true)
    this.renderer.domElement.addEventListener('lostpointercapture', this.cancel)
    this.renderer.domElement.addEventListener('wheel', this.wheel, { capture: true, passive: true })
    globalThis.window?.addEventListener('blur', this.blur)
    this.resize = () => {
      if (this.disposed) return
      const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight)
      this.renderer.setSize(width, height); this.resizeCamera(width / height)
    }
    if (globalThis.ResizeObserver) { this.observer = new ResizeObserver(this.resize); this.observer.observe(container) }
    else globalThis.window?.addEventListener('resize', this.resize)
    this.resize()
    this.renderer.setAnimationLoop(() => { if (!this.disposed) { if (!this.gesture.pendingClick) this.controls.update(); this.renderer.render(this.scene, this.camera); this.labels.update(this.root, this.camera) } })
  }

  async load(model, { signal } = {}) {
    const generation = this.generation = (this.generation || 0) + 1
    this.clearAsset()
    if (!model?.file_path) throw new Error('该模型尚未上传 glTF / GLB 文件，请先上传模型，再点击口的下沿设置。')
    const gltf = await loadConfiguredGltf(resolveBackendAssetUrl(model.file_path), { signal })
    if (this.disposed || generation !== this.generation || signal?.aborted) { disposeSceneObject(gltf.scene || gltf.scenes?.[0]); return null }
    restoreGltfNodeNames(gltf)
    this.root = gltf.scene || gltf.scenes?.[0]
    if (!this.root) throw new Error('模型文件中没有可用场景')
    this.scene.add(this.root)
    this.nodes = collectLoadingPortNodes(this.root)
    this.box = new THREE.Box3().setFromObject(this.root)
    this.extent = Math.max(this.box.getSize(new THREE.Vector3()).length(), .001)
    this.localExtent = Math.max(nodeBoundsInLoadingRoot(this.root, this.root).getSize(new THREE.Vector3()).length(), .001)
    // Keep overlays outside the authored hierarchy. Geometry inference must not
    // mistake editor dots/arrows for part of the furnace's body bounds.
    this.markers = new THREE.Group(); this.markers.userData.loadingPortEditor = true
    this.markers.matrixAutoUpdate = false; this.markers.matrix.copy(this.root.matrixWorld); this.scene.add(this.markers)
    this.resetCamera()
    return this.nodes.map(({ node, ...entry }) => entry)
  }

  resetCamera() {
    if (!this.root || this.box?.isEmpty()) return
    stopLoadingPortOrbitDamping(this.controls, this.camera)
    const center = this.box.getCenter(new THREE.Vector3()), extent = this.extent
    this.camera.position.copy(center).add(new THREE.Vector3(.9, .65, 1.1).normalize().multiplyScalar(loadingPortCameraDistance(extent, this.camera.aspect)))
    this.controls.target.copy(center); this.updateCameraLimits()
    this.camera.updateProjectionMatrix()
    updateCameraWithoutLoadingPortInertia(this.controls)
  }

  updateCameraLimits() {
    const extent = this.extent, fitScale = loadingPortCameraDistance(extent, this.camera.aspect) / (extent * 1.4)
    this.camera.near = Math.max(extent / 10000, .00001); this.camera.far = Math.max(extent * 100 * fitScale, 10)
    this.controls.minDistance = extent * .025 * fitScale; this.controls.maxDistance = extent * 30 * fitScale
  }

  resizeCamera(aspect) {
    const previous = validLoadingPortAspect(this.camera.aspect), next = validLoadingPortAspect(aspect)
    if (previous === next || !this.root || !this.extent || this.box?.isEmpty()) {
      this.camera.aspect = next; this.camera.updateProjectionMatrix(); return
    }
    stopLoadingPortOrbitDamping(this.controls, this.camera); this.gesture?.invalidate()
    // Preserve the user's target, observation direction and relative zoom. A
    // breakpoint must not silently reset their chosen view to the default angle.
    const ratio = loadingPortCameraDistance(this.extent, next) / loadingPortCameraDistance(this.extent, previous)
    this.camera.position.sub(this.controls.target).multiplyScalar(ratio).add(this.controls.target)
    this.camera.aspect = next; this.updateCameraLimits(); this.camera.updateProjectionMatrix()
    updateCameraWithoutLoadingPortInertia(this.controls)
  }

  setPicking(value) { this.picking = !!value; if (!value) this.gesture?.reset(); this.renderer.domElement.style.cursor = value ? 'crosshair' : 'grab' }

  nodePoint(id, bottom = false) {
    const entry = this.nodes?.find(item => item.id === id)
    if (!entry || !this.root) return null
    const box = nodeBoundsInLoadingRoot(entry.node, this.root)
    if (box.isEmpty()) return null
    const position = box.getCenter(new THREE.Vector3()); if (bottom) position.y = box.min.y
    return { position: position.toArray(), nodeName: entry.node.name || '' }
  }

  selectNode(id) {
    if (this.selection) { this.markers?.remove(this.selection); disposeSceneObject(this.selection); this.selection = null }
    const entry = this.nodes?.find(item => item.id === id)
    if (!entry || !this.root) return
    const box = nodeBoundsInLoadingRoot(entry.node, this.root)
    if (box.isEmpty()) return
    this.selection = new THREE.Box3Helper(box, 0x7c5bc7)
    this.selection.userData.loadingPortEditor = true; this.selection.material.depthTest = false
    this.markers.add(this.selection)
  }

  infer(device, model, kind) { return this.root ? inferLoadingPort(this.root, device || {}, model || {}, kind) : null }

  setPorts(ports, suggestion = null, activeKind = 'inlet') {
    this.labels?.clear()
    if (!this.markers) return
    if (this.portMarkers) { this.markers.remove(this.portMarkers); disposeSceneObject(this.portMarkers) }
    this.portMarkers = new THREE.Group(); this.portMarkers.userData.loadingPortEditor = true
    this.markers.add(this.portMarkers)
    const marker = (port, kind, candidate) => {
      if (!Array.isArray(port?.position) || port.position.length !== 3 || !port.position.every(Number.isFinite)) return
      const active = kind === activeKind && !candidate
      const color = active ? 0x1766cc : kind === 'inlet' ? 0x168aa7 : 0xd67a16, extent = this.localExtent
      const opacity = candidate ? .5 : active ? 1 : .75
      const point = new THREE.Mesh(new THREE.SphereGeometry(extent * (active ? .019 : candidate ? .009 : .012), 20, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity, wireframe: candidate }))
      point.position.fromArray(port.position); point.renderOrder = 10; point.userData.loadingPortEditor = true
      point.userData.loadingPortKind = kind; point.userData.loadingPortActive = active; point.userData.loadingPortRole = 'point'
      const direction = Array.isArray(port.direction) && port.direction.length === 3 && port.direction.every(Number.isFinite)
        ? new THREE.Vector3(...port.direction) : null
      const horizontal = direction && Math.hypot(direction.x, direction.z) > 1e-9 ? new THREE.Vector3(direction.x, 0, direction.z).normalize() : null
      const cross = horizontal ? new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), horizontal) : new THREE.Vector3(1, 0, 0)
      const halfLine = extent * (active ? .105 : .08)
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        point.position.clone().addScaledVector(cross, -halfLine), point.position.clone().addScaledVector(cross, halfLine)
      ]), new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity }))
      line.renderOrder = 12; line.userData.loadingPortEditor = true; line.userData.loadingPortRole = 'height-baseline'
      line.userData.loadingPortKind = kind; line.userData.loadingPortActive = active
      const labelText = loadingPortHeightLabel(port, kind)
      point.userData.loadingPortLabel = labelText
      this.labels?.add(port, kind, active, candidate)
      this.portMarkers.add(point, line)
      if (active) {
        const halo = new THREE.Mesh(new THREE.SphereGeometry(extent * .029, 20, 12), new THREE.MeshBasicMaterial({ color: 0x1766cc, depthTest: false, depthWrite: false, transparent: true, opacity: .28, wireframe: true }))
        halo.position.copy(point.position); halo.renderOrder = 11; halo.userData.loadingPortEditor = true; halo.userData.loadingPortRole = 'point-highlight'
        this.portMarkers.add(halo)
      }
      if (horizontal) {
        const arrow = new THREE.ArrowHelper(horizontal, point.position, extent * .065, color, extent * .018, extent * .011)
        arrow.traverse(node => { node.userData.loadingPortEditor = true; if (node.material) { node.material.depthTest = false; node.material.depthWrite = false; node.material.transparent = true; node.material.opacity = opacity * .8 }; node.renderOrder = 11 })
        arrow.userData.loadingPortRole = 'direction'; this.portMarkers.add(arrow)
      }
    }
    for (const kind of ['inlet', 'outlet']) marker(ports?.[kind], kind, false)
    if (suggestion) marker(suggestion, activeKind, true)
  }

  setCartTransfer(config, ports) {
    if (!this.root) return
    const signature = JSON.stringify([config, ports])
    if (signature === this.cartSignature) return
    this.cartSignature = signature
    this.clearCartTransfer()
    if (config?.kind !== 'rotating' || config.presentation !== 'simple') return
    const bounds = nodeBoundsInLoadingRoot(this.root, this.root)
    const visual = createSimpleRotatingCart(bounds, ports?.outlet || ports?.inlet)
    if (!visual) return
    this.hiddenCartMeshes = []
    this.root.traverse(node => { if (node.isMesh) { this.hiddenCartMeshes.push([node, node.visible]); node.visible = false } })
    this.simpleCart = visual.root; this.root.add(visual.root)
  }
  clearCartTransfer() {
    for (const [mesh, visible] of this.hiddenCartMeshes || []) mesh.visible = visible
    if (this.simpleCart) { this.root?.remove(this.simpleCart); disposeSceneObject(this.simpleCart) }
    this.hiddenCartMeshes = []; this.simpleCart = null
  }
  clearAsset() {
    this.clearCartTransfer(); this.cartSignature = null
    this.gesture?.reset()
    this.labels?.clear()
    if (this.root) this.scene.remove(this.root)
    if (this.markers) this.scene.remove(this.markers)
    disposeSceneObject([this.root, this.markers])
    this.root = null; this.nodes = []; this.markers = null; this.portMarkers = null; this.selection = null
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true; this.generation = (this.generation || 0) + 1
    this.renderer.setAnimationLoop(null); this.observer?.disconnect(); globalThis.window?.removeEventListener('resize', this.resize)
    for (const [name, handler] of [['pointerdown', this.down], ['pointermove', this.move], ['pointerup', this.up], ['pointercancel', this.cancel]]) this.pointerDocument?.removeEventListener(name, handler, true)
    this.renderer.domElement.removeEventListener('lostpointercapture', this.cancel)
    this.renderer.domElement.removeEventListener('wheel', this.wheel, true)
    globalThis.window?.removeEventListener('blur', this.blur); this.gesture?.reset()
    this.controls.dispose(); this.clearAsset(); this.labels?.dispose(); this.renderer.dispose(); this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
