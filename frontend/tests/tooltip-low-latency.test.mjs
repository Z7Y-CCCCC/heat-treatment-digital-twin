import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, watchEffect, nextTick } from 'vue'
import { createTooltipContentContext } from '../src/runtime/tooltipContext.js'
import { tooltipHoverContentTarget, tooltipHoverPointer, tooltipPlacement } from '../src/runtime/tooltipRuntime.js'
import { reconcileOverlayHitTargets } from '../src/runtime/overlayHitRegions.js'

test('content/placement separation leaves configured lazy pointer paths readable without point-map rebuilding', async () => {
  const parent = reactive({ factoryId:'f', viewId:'overview', viewMode:'factory', sceneReady:true,
    hoveredDeviceId:'a', deviceHoverPointer:{ visible:true, x:.2, y:.3 }, inspectionHoverPointer:{ visible:false } })
  const devices = [{ id:'a', name:'炉 A' }, { id:'b', name:'炉 B' }]
  const points = reactive({ a:{ id:'pa', device_id:'a', value:0, quality:'good', category:'analog', name:'temp' },
    foreign:{ id:'pb', device_id:'b', value:999, quality:'good', category:'analog', name:'temp' } })
  let targetBuilds = 0, contextBuilds = 0, configuredPointer
  const target = computed(() => { targetBuilds++; return tooltipHoverContentTarget(parent, devices, points) })
  const content = computed(() => { contextBuilds++; return createTooltipContentContext({ ...target.value, runtimeContext:parent }) })
  const initial = content.value
  const stop = watchEffect(() => { configuredPointer = content.value.deviceHoverPointer.x })
  try {
    for (let index = 0; index < 120; index++) {
      parent.deviceHoverPointer = { visible:true, x:.2 + index / 500, y:.3 }
      await nextTick()
      assert.equal(content.value, initial)
      assert.equal(configuredPointer, parent.deviceHoverPointer.x, 'deliberate runtime paths still see fresh coordinates')
      const p = tooltipPlacement({ width:200, height:80 }, tooltipHoverPointer(parent, target.value), { width:1000, height:500 })
      assert.equal(p.left, parent.deviceHoverPointer.x * 1000 + 16)
    }
    assert.equal(targetBuilds, 1)
    assert.equal(contextBuilds, 1)
    assert.equal(initial.hover.device.pointMap.analog.temp.value, 0)
    points.a.value = 321
    assert.notEqual(content.value, initial, 'real readings still rebuild the owned map immediately')
    assert.equal(content.value.hover.device.pointMap.analog.temp.value, 321)
    parent.hoveredDeviceId = 'b'
    assert.equal(content.value.deviceId, 'b')
    assert.equal(content.value.hover.device.pointMap.analog.temp.value, 999)
  } finally { stop() }
})

test('invalid live pointers hide placement while configured part-anchor fallback and scene readiness are preserved', () => {
  const devices = [{ id:'a' }]
  const context = { viewMode:'device', deviceId:'a', inspectionEnabled:true, inspectionHoveredPartId:'part',
    inspectionParts:[{ id:'part', anchor:{ visible:true, x:.2, y:.4 } }], inspectionHoverPointer:{ visible:false } }
  const target = tooltipHoverContentTarget(context, devices)
  assert.deepEqual(tooltipHoverPointer(context, target), { visible:true, x:.225, y:.34500000000000003 })
  assert.equal(tooltipHoverPointer({ ...context, sceneReady:false }, target), null)
  target.part.anchor.visible = false
  assert.equal(tooltipHoverPointer(context, target), null)
})

function element({ hit = false, insideHit = false, descendants = [] } = {}) {
  const node = { nodeType:1,
    matches: selector => { assert.equal(selector, '[data-overlay-hit="true"]'); return hit },
    querySelectorAll: selector => { assert.equal(selector, '[data-overlay-hit="true"]'); return descendants },
    closest: selector => { assert.equal(selector, '[data-overlay-hit="true"]'); return hit || insideHit ? node : null } }
  return node
}
const mutation = (target, addedNodes = [], removedNodes = []) => ({ target, addedNodes, removedNodes })

test('noninteractive tooltip mounts, content swaps and leave do not schedule native hit-region scans', () => {
  const observed = [], released = [], observer = { observe: target => observed.push(target), unobserve: target => released.push(target) }
  const root = element(), tooltip = element(), text = { nodeType:3 }
  assert.equal(reconcileOverlayHitTargets([mutation(root, [tooltip])], observer), false)
  assert.equal(reconcileOverlayHitTargets([mutation(tooltip, [element()], [element()])], observer), false)
  assert.equal(reconcileOverlayHitTargets([mutation(root, [], [tooltip]), mutation(root, [text], [text])], observer), false)
  assert.deepEqual(observed, [])
  assert.deepEqual(released, [])
})

test('new/removed native hit targets and shell changes within an existing target still reconcile geometry', () => {
  const observed = [], released = [], observer = { observe: target => observed.push(target), unobserve: target => released.push(target) }
  const root = element(), hit = element({ hit:true }), child = element({ hit:true })
  const subtree = element({ descendants:[child] })
  assert.equal(reconcileOverlayHitTargets([mutation(root, [hit, subtree])], observer), true)
  assert.deepEqual(observed, [hit, child])
  assert.equal(reconcileOverlayHitTargets([mutation(element({ insideHit:true }), [element()], [element()])], observer), true)
  assert.equal(reconcileOverlayHitTargets([mutation(root, [], [hit, subtree])], observer), true)
  assert.deepEqual(released, [hit, child])
})
