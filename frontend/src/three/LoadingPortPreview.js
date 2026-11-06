import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { loadConfiguredGltf, disposeSceneObject } from '../runtime/ConfiguredFactoryScene.js'
import { resolveBackendAssetUrl } from './ModelFactory.js'
import { restoreGltfNodeNames } from './gltfNodeIdentity.js'
import { inferLoadingPort } from './lineLoadingAlignment.js'

// All editor coordinates are relative to the authored glTF scene root. Never
// normalize/recenter/resize the asset to make the preview fit the viewport.
export function nodeBoundsInLoadingRoot(node, root) {
  root.updateMatrixWorld(true)
  const inverse = root.matrixWorld.clone().invert(), box = new THREE.Box3()
  node.traverse(child => {
    if (!child.geometry || child.userData.loadingPortEditor) return
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
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x879db2, 2.5))
    const light = new THREE.DirectionalLight(0xffffff, 2)
    light.position.set(8, 14, 9); this.scene.add(light)
    this.raycaster = new THREE.Raycaster()
    this.down = event => { this.pointerStart = [event.clientX, event.clientY] }
    this.up = event => {
      if (!this.picking || !this.root || !this.pointerStart || event.button !== 0 || Math.hypot(event.clientX - this.pointerStart[0], event.clientY - this.pointerStart[1]) > 5) return
      const rect = this.renderer.domElement.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera)
      // Intersect authored geometry only; editor markers must not pick themselves.
      const meshes = []
      this.root.traverseVisible(node => { if (node.isMesh && !node.userData.loadingPortEditor) meshes.push(node) })
      const hit = this.raycaster.intersectObjects(meshes, false)[0]
      if (!hit) return
      this.onSurface({ position: this.root.worldToLocal(hit.point.clone()).toArray(), nodeName: hit.object.name || '' })
    }
    this.renderer.domElement.addEventListener('pointerdown', this.down)
    this.renderer.domElement.addEventListener('pointerup', this.up)
    this.resize = () => {
      if (this.disposed) return
      const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight)
      this.renderer.setSize(width, height); this.camera.aspect = width / height; this.camera.updateProjectionMatrix()
    }
    if (globalThis.ResizeObserver) { this.observer = new ResizeObserver(this.resize); this.observer.observe(container) }
    else globalThis.window?.addEventListener('resize', this.resize)
    this.resize()
    this.renderer.setAnimationLoop(() => { if (!this.disposed) { this.controls.update(); this.renderer.render(this.scene, this.camera) } })
  }

  async load(model, { signal } = {}) {
    const generation = this.generation = (this.generation || 0) + 1
    this.clearAsset()
    if (!model?.file_path) throw new Error('该模型尚未上传 glTF / GLB 文件，可先使用坐标表单配置。')
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
    this.axes = new THREE.AxesHelper(this.localExtent * .16)
    this.axes.userData.loadingPortEditor = true; this.markers.add(this.axes)
    this.resetCamera()
    return this.nodes.map(({ node, ...entry }) => entry)
  }

  resetCamera() {
    if (!this.root || this.box?.isEmpty()) return
    const center = this.box.getCenter(new THREE.Vector3()), extent = this.extent
    this.camera.near = Math.max(extent / 10000, .00001); this.camera.far = Math.max(extent * 100, 10)
    this.camera.position.copy(center).add(new THREE.Vector3(.9, .65, 1.1).normalize().multiplyScalar(extent * 1.4))
    this.controls.target.copy(center); this.controls.minDistance = extent * .025; this.controls.maxDistance = extent * 30
    this.camera.updateProjectionMatrix(); this.controls.update()
  }

  setPicking(value) { this.picking = !!value; this.renderer.domElement.style.cursor = value ? 'crosshair' : 'grab' }

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
    if (!this.markers) return
    if (this.portMarkers) { this.markers.remove(this.portMarkers); disposeSceneObject(this.portMarkers) }
    this.portMarkers = new THREE.Group(); this.portMarkers.userData.loadingPortEditor = true
    this.markers.add(this.portMarkers)
    const marker = (port, kind, candidate) => {
      if (!port?.position?.every(Number.isFinite) || !port?.direction?.every(Number.isFinite)) return
      const color = kind === 'inlet' ? 0x168aa7 : 0xe78b22, extent = this.localExtent
      const point = new THREE.Mesh(new THREE.SphereGeometry(extent * (candidate ? .01 : .013), 16, 10), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: candidate ? .45 : 1, wireframe: candidate }))
      point.position.fromArray(port.position); point.renderOrder = 10; point.userData.loadingPortEditor = true
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(...port.direction).normalize(), point.position, extent * .15, color, extent * .04, extent * .025)
      arrow.traverse(node => { node.userData.loadingPortEditor = true; if (node.material) { node.material.depthTest = false; node.material.transparent = true; node.material.opacity = candidate ? .45 : 1 }; node.renderOrder = 11 })
      this.portMarkers.add(point, arrow)
    }
    for (const kind of ['inlet', 'outlet']) marker(ports?.[kind], kind, false)
    if (suggestion) marker(suggestion, activeKind, true)
  }

  clearAsset() {
    if (this.root) this.scene.remove(this.root)
    if (this.markers) this.scene.remove(this.markers)
    disposeSceneObject([this.root, this.markers])
    this.root = null; this.nodes = []; this.markers = null; this.portMarkers = null; this.selection = null
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true; this.generation = (this.generation || 0) + 1
    this.renderer.setAnimationLoop(null); this.observer?.disconnect(); globalThis.window?.removeEventListener('resize', this.resize)
    this.renderer.domElement.removeEventListener('pointerdown', this.down); this.renderer.domElement.removeEventListener('pointerup', this.up)
    this.controls.dispose(); this.clearAsset(); this.renderer.dispose(); this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}
