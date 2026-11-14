import * as T from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { loadConfiguredGltf, disposeSceneObject } from '../runtime/ConfiguredFactoryScene.js'
import { nativeDeviceTransform } from '../runtime/factorySceneConfig.js'
import { resolveBackendAssetUrl } from './ModelFactory.js'
import { dockingPreview } from '../views/admin/utils/dockingCalibration.js'
import { createSimpleRotatingCart } from './simpleRotatingCart.js'

export class DockingCalibrationPreview {
  constructor(container) {
    this.container = container; this.scene = new T.Scene(); this.scene.background = new T.Color('#eef3f8')
    this.renderer = new T.WebGLRenderer({ antialias: true }); this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.5)); this.renderer.outputColorSpace = T.SRGBColorSpace
    this.camera = new T.OrthographicCamera(-10, 10, 10, -10, .01, 10000)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableRotate = false; this.controls.enableDamping = true
    this.scene.add(new T.HemisphereLight(0xffffff, 0x60778d, 2.4)); const light = new T.DirectionalLight(0xffffff, 3); light.position.set(12, 20, 10); this.scene.add(light)
    container.append(this.renderer.domElement); this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container)
    this.draw = () => { if (this.disposed || this.paused) return; this.controls.update(); this.renderer.render(this.scene, this.camera); this.frame = requestAnimationFrame(this.draw) }; this.draw()
  }
  async load(plan, { signal } = {}) {
    this.plan = plan; this.groups = []
    for (const [index, result] of [plan.deviceResult, plan.cartResult].entries()) {
      const loaded = await loadConfiguredGltf(resolveBackendAssetUrl(result.device.model_file || result.model.file_path), { signal })
      if (this.disposed || signal?.aborted) { disposeSceneObject(loaded.scene); return }
      const group = new T.Group(), transform = nativeDeviceTransform(result.device, result.model)
      group.add(loaded.scene); this.scene.add(group); this.groups.push(group)
      if (index === 1 && plan.cartTurn) {
        let anchor
        if (plan.cartTurn.presentation === 'simple') {
          const simple = createSimpleRotatingCart(new T.Box3().setFromObject(loaded.scene), plan.cartTurn.rootPort)
          if (!simple) throw Error('旋转小车简模无法显示')
          loaded.scene.visible = false; group.add(simple.root); anchor = simple.upper
        } else anchor = loaded.scene.getObjectByName(plan.cartTurn.nodeName)
        if (!anchor) throw Error('旋转小车上转台无法显示')
        anchor.quaternion.premultiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0), plan.cartTurn.angle))
      }
      group.position.set(transform.position.x, transform.position.y, transform.position.z); group.rotation.y = transform.yaw; group.scale.set(...transform.scale)
      if (index === 1) group.position.x = -plan.cartPreviewX
    }
    const box = new T.Box3().setFromObject(this.scene); this.bounds = box.clone(); this.center = box.getCenter(new T.Vector3()); this.span = Math.max(box.getSize(new T.Vector3()).length() * .6, 1)
    const grid = new T.GridHelper(Math.max(10, Math.ceil(this.span * 2)), 20, 0x9db1c5, 0xd3dee9); grid.position.set(this.center.x, Math.min(0, box.min.y), this.center.z); this.scene.add(grid)
    this.markers = [0x1677c8, 0xe29124].map(color => {
      const marker = new T.Mesh(new T.SphereGeometry(this.span * .016, 14, 10), new T.MeshBasicMaterial({ color, depthTest: false })); marker.renderOrder = 20; this.scene.add(marker); return marker
    })
    this.line = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0x374d66, depthTest: false })); this.line.renderOrder = 19; this.scene.add(this.line)
    this.setPosition(plan.position); this.setView('front')
  }
  setPosition(position) {
    if (!this.plan || !this.groups?.length || this.disposed) return
    this.groups[0].position.x = -position.x; this.groups[0].position.y = position.y
    const current = dockingPreview(this.plan, position)
    if (!this.markers) return
    this.markers[0].position.fromArray(current.devicePort); this.markers[1].position.fromArray(current.cartPort)
    this.line.geometry.dispose(); this.line.geometry = new T.BufferGeometry().setFromPoints([new T.Vector3(...current.devicePort), new T.Vector3(...current.cartPort)])
  }
  setView(view) {
    if (!this.center || this.disposed) return
    this.view = view; this.camera.zoom = 1
    this.camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0)
    this.camera.position.copy(this.center).add(view === 'top' ? new T.Vector3(0, this.span * 4, 0) : new T.Vector3(0, 0, this.span * 4))
    this.controls.target.copy(this.center); this.camera.lookAt(this.center); this.controls.update(); this.resize()
  }
  resize() {
    if (this.disposed) return
    const width = Math.max(this.container.clientWidth, 1), height = Math.max(this.container.clientHeight, 1), span = this.span || 10
    this.renderer.setSize(width, height); const ratio = width / height
    // Fit only the currently projected axes. The front view must not shrink
    // two models just because their unprojected front/back separation is large.
    // Keep the user's camera target/zoom untouched during nudges and resizing.
    const size = this.bounds?.getSize(new T.Vector3())
    const halfHeight = size ? Math.max((this.view === 'top' ? size.z : size.y) / 2, size.x / (2 * ratio), .3) * 1.18 : span
    this.camera.left = -halfHeight * ratio; this.camera.right = -this.camera.left
    this.camera.top = halfHeight; this.camera.bottom = -halfHeight; this.camera.updateProjectionMatrix()
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; cancelAnimationFrame(this.frame); this.observer.disconnect(); this.controls.dispose(); disposeSceneObject(this.scene); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove()
  }
  pause() { this.paused = true; cancelAnimationFrame(this.frame) }
  resume() { if (this.disposed || !this.paused) return; this.paused = false; this.resize(); this.draw() }
}
