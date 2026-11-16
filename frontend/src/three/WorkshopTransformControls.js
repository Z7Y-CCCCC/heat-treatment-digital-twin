import * as T from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { resolveLoadingPort } from '../../../shared/loadingPorts.mjs'
import { workshopFrame, workshopWorldToLocal, constrainWorkshopTransform, transformValues, workshopYawFromQuaternion } from '../views/admin/utils/workshopTransform.js'

// An editor-only adapter. It does not own device models, persist configuration,
// or install any interaction in the real-time display.
export class WorkshopTransformControls {
  constructor(runtime, { getContext, onSelect, onStart, onChange, onEnd, onUndo }) {
    Object.assign(this, { runtime, manager: runtime.sceneManager, getContext, onSelect, onStart, onChange, onEnd, onUndo })
    const m = this.manager; this.element = m.renderer.domElement; this.element.tabIndex = 0
    this.control = new TransformControls(m.camera); this.control.domElement = this.element
    this.control.setSize(.95); this.proxy = new T.Group(); this.proxy.name = '__workshop_transform__'
    this.helper = this.control.getHelper(); m.scene.add(this.proxy, this.helper)
    this.outline = new T.BoxHelper(undefined, 0x468af3); this.outline.visible = false; m.scene.add(this.outline)
    this.indicators = new T.Group(); m.scene.add(this.indicators)
    this.ndc = new T.Vector2(); this.offset = new T.Vector3(); this.listeners = []
    const listen = (target, name, fn, capture = false) => { const bound = fn.bind(this); target.addEventListener(name, bound, capture); this.listeners.push(() => target.removeEventListener(name, bound, capture)) }
    listen(this.element, 'pointerdown', this.down, true); listen(this.element, 'pointermove', this.move, true)
    listen(this.element, 'pointerup', this.up, true); listen(this.element, 'pointercancel', this.cancelEvent, true)
    listen(this.element, 'lostpointercapture', this.cancelEvent, true); listen(this.element, 'click', this.click, true)
    listen(this.element, 'keydown', this.key); listen(window, 'blur', this.cancelEvent)
    this.change = () => this.changed(); this.control.addEventListener('objectChange', this.change)
    this.orbitChange = () => this.updateLabels(); m.controls.addEventListener('change', this.orbitChange)
  }
  pointer(event) { const r = this.element.getBoundingClientRect(); return { x: (event.clientX-r.left)/r.width*2-1, y: -(event.clientY-r.top)/r.height*2+1, button: event.type === 'pointermove' ? -1 : 0 } }
  sync() {
    if (this.drag) { this.outline.update(); this.updatePorts(); this.updateLabels(); return }
    const c = this.getContext(), model = c?.device && this.runtime.furnaces.get(c.device.id)
    this.context = c; this.model = model; this.control.detach(); this.outline.visible = !!model
    this.clearIndicators()
    if (!model || !c.active) { this.outline.visible = false; this.element.dataset.workshopSelection = ''; this.element.dataset.workshopHandles = '[]'; return }
    model.updateWorldMatrix(true, true); const box = new T.Box3().setFromObject(model)
    this.offset.copy(box.getCenter(new T.Vector3())).sub(model.position)
    this.proxy.position.copy(model.position).add(this.offset)
    this.frame = workshopFrame(c.device, c.workshop, c.line)
    this.proxy.rotation.set(0, c.mode === 'rotate' ? model.rotation.y : -this.frame.yaw, 0)
    this.control.setMode(c.mode); this.control.setSpace(c.mode === 'rotate' ? 'world' : 'local')
    this.control.showX = c.mode !== 'rotate'; this.control.showY = c.mode === 'rotate' || !c.cart && c.spatial
    this.control.showZ = c.mode !== 'rotate' && !c.cart && (c.spatial || !c.binding)
    this.control.enabled = c.editable; if (c.editable) this.control.attach(this.proxy)
    this.outline.setFromObject(model); this.outline.visible = true
    this.makeIndicators(c); this.updateLabels(); this.manager.scene.updateMatrixWorld(true)
  }
  down(event) {
    if (event.button !== 0 || this.drag || !this.control.enabled || !this.control.object) return
    this.control.pointerHover(this.pointer(event)); if (!this.control.axis) return
    this.element.dataset.workshopGesture = 'start:' + this.control.axis
    this.element.focus({preventScroll:true}); event.preventDefault(); event.stopImmediatePropagation()
    this.manager.stopCameraTransition(); const c = this.getContext(); if (!c?.editable || !c.active) return
    this.drag = { id: event.pointerId, context: c, before: { id: c.device.id, coordinate_space: c.device.coordinate_space, ...transformValues(c.device) }, orbit: this.manager.controls.enabled }
    this.onStart(c.device.id); this.manager.controls.enabled = false
    this.control.pointerDown(this.pointer(event))
    if (!this.control.dragging) { this.finish(true); return }
    this.element.setPointerCapture(event.pointerId)
  }
  move(event) {
    if (!this.drag) return
    if (event.pointerId !== this.drag.id) return
    event.preventDefault(); event.stopImmediatePropagation(); this.control.pointerMove(this.pointer(event))
  }
  changed() {
    if (!this.drag) return
    const { before, context: c } = this.drag
    const current = this.getContext()
    if (!current?.editable || !current.active || current.device?.id !== before.id) { this.finish(true); return }
    const local = workshopWorldToLocal(this.proxy.position.clone().sub(this.offset), before, c.workshop, c.line)
    const next = constrainWorkshopTransform(before, { pos_x: local.x, pos_y: local.y, pos_z: local.z, rotation_y: workshopYawFromQuaternion(this.proxy.quaternion, before.rotation_y, this.frame.yaw) }, c)
    this.onChange(before.id, next, { axis: this.control.axis, mode: c.mode })
    this.element.dataset.workshopGesture = 'moving:' + this.control.axis
    this.outline.update(); this.updateLabels()
  }
  up(event) { if (!this.drag || event.pointerId !== this.drag.id) return; event.preventDefault(); event.stopImmediatePropagation(); this.finish(false) }
  cancelEvent(event) { if (this.drag && (event.pointerId === undefined || event.pointerId === this.drag.id)) this.finish(true) }
  finish(cancelled) {
    const drag = this.drag; if (!drag) return
    this.drag = null; this.control.pointerUp({button:0}); this.manager.controls.enabled = drag.orbit
    this.skipClick = true; this.manager.suppressNextClick = true
    if (this.element.hasPointerCapture?.(drag.id)) this.element.releasePointerCapture(drag.id)
    this.onEnd(drag.before.id, cancelled); this.sync()
    this.element.dataset.workshopGesture = cancelled ? 'cancelled' : 'committed'
  }
  click(event) {
    if (this.skipClick || this.manager.suppressNextClick) { this.skipClick = false; this.manager.suppressNextClick = false; event.stopImmediatePropagation(); return }
    if (this.manager.canvasGesture?.dragged) return
    const device = this.manager.findDeviceFromPointerEvent(event)
    if (device) { event.stopImmediatePropagation(); this.element.focus({preventScroll:true}); this.onSelect(device.userData.id) }
  }
  key(event) {
    if (event.key === 'Escape' && this.drag) { event.preventDefault(); this.finish(true) }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (this.drag) this.finish(true); else this.onUndo(event.shiftKey) }
  }
  clearIndicators() {
    this.labels = []; this.portIndicators = []
    this.indicators.traverse(n => { n.geometry?.dispose(); if (n.material) { n.material.map?.dispose(); n.material.dispose() } })
    this.indicators.clear()
  }
  makeIndicators(c) {
    const colors = [0xe15a59, 0x3f9972, 0x4789dc], names = ['沿产线 X', '高度 Y', '对接距离 Z']
    for (const [i, axis] of ['X','Y','Z'].entries()) if (c.mode !== 'rotate' && this.control['show'+axis] && c.editable) {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 64
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fffffff5'; ctx.fillRect(0,0,320,64); ctx.fillStyle = '#'+colors[i].toString(16); ctx.fillRect(0,0,9,64); ctx.fillStyle = '#24364d'; ctx.font = 'bold 34px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(names[i],164,44)
      const texture = new T.CanvasTexture(canvas), sprite = new T.Sprite(new T.SpriteMaterial({map:texture,depthTest:false,depthWrite:false,toneMapped:false,fog:false})); sprite.renderOrder = 30
      this.indicators.add(sprite); this.labels.push({i,sprite})
    }
    const seen = new Set(); modelPorts: for (const kind of ['inlet','outlet']) {
      let port; try { port = resolveLoadingPort(c.model, c.device, kind) } catch { continue }
      if (!port) continue
      const key = JSON.stringify([port.position,port.direction]); if (seen.has(key)) continue modelPorts; seen.add(key)
      const position = new T.Vector3(...port.position).applyMatrix4(this.model.matrixWorld), direction = new T.Vector3(...port.direction).transformDirection(this.model.matrixWorld)
      const size = new T.Box3().setFromObject(this.model).getSize(new T.Vector3()).length(), length = Math.max(.3,size*.17)
      const arrow = new T.ArrowHelper(direction, position, length, c.cart ? 0xe29124 : 0x1677c8)
      arrow.line.material.depthTest = false; arrow.cone.material.depthTest = false; arrow.line.renderOrder = arrow.cone.renderOrder = 25
      this.indicators.add(arrow)
      this.portIndicators.push({ arrow, port })
    }
  }
  updatePorts() {
    if (!this.model) return
    this.model.updateWorldMatrix(true, true)
    for (const {arrow,port} of this.portIndicators || []) {
      arrow.position.copy(new T.Vector3(...port.position).applyMatrix4(this.model.matrixWorld))
      arrow.setDirection(new T.Vector3(...port.direction).transformDirection(this.model.matrixWorld))
    }
  }
  updateLabels() {
    const distance = this.manager.camera.position.distanceTo(this.proxy.position), length = Math.max(.3, distance * .16)
    for (const {i,sprite} of this.labels || []) {
      const axis = new T.Vector3(i===0?1:0,i===1?1:0,i===2?1:0).applyQuaternion(this.proxy.quaternion)
      sprite.position.copy(this.proxy.position).addScaledVector(axis,length); sprite.scale.set(length*.72,length*.144,1)
    }
    // Read-only screen locations make canvas controls inspectable by assistive
    // tooling and UI regression tests; they cannot move or save any object.
    this.helper.updateMatrixWorld(true); this.manager.camera.updateMatrixWorld(true)
    const rect = this.element.getBoundingClientRect(), mode = this.control.mode
    const handles = this.control.enabled ? this.control._gizmo.picker[mode].children.filter(node => ['X','Y','Z'].includes(node.name) && this.control['show'+node.name]).map(node => {
      const point = new T.Box3().setFromObject(node).getCenter(new T.Vector3()).project(this.manager.camera)
      return { axis: node.name, x: rect.left+(point.x+1)*rect.width/2, y: rect.top+(1-point.y)*rect.height/2 }
    }) : []
    this.element.dataset.workshopSelection = this.context?.device?.id || ''
    this.element.dataset.workshopHandles = JSON.stringify(handles)
  }
  dispose() {
    this.finish(true); this.control.removeEventListener('objectChange', this.change)
    this.manager.controls.removeEventListener('change', this.orbitChange); this.listeners.forEach(fn=>fn())
    this.control.detach(); this.control.dispose(); this.clearIndicators()
    this.outline.geometry.dispose(); this.outline.material.dispose()
    this.proxy.removeFromParent(); this.helper.removeFromParent(); this.outline.removeFromParent(); this.indicators.removeFromParent()
    delete this.element.dataset.workshopSelection; delete this.element.dataset.workshopHandles
    delete this.element.dataset.workshopGesture
  }
}
