import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, ref, shallowRef } from 'vue'
import { installBrowser } from './helpers.mjs'
import { useOutsideDismiss } from '../src/runtime/useOutsideDismiss.js'

function fixture(t) {
  const environment = installBrowser(t), listeners = new Set()
  const webview = {
    addEventListener(name, fn) { assert.equal(name, 'message'); listeners.add(fn) },
    removeEventListener(name, fn) { assert.equal(name, 'message'); listeners.delete(fn) }
  }
  environment.browser.chrome = { webview }
  const child = {}, root = { contains: target => target === child }, open = ref(true)
  let dismissed = 0, state
  const renderer = createRenderer({ createComment: () => ({}), parentNode: () => null, nextSibling: () => null, insert() {}, remove() {} })
  const app = renderer.createApp({ setup() {
    state = useOutsideDismiss({ element:shallowRef(root), isOpen:() => open.value, dismiss:() => { dismissed++; open.value = false } })
    return () => null
  } })
  app.mount({}); environment.beforeRestore(() => app.unmount())
  const dispatch = (name, event) => { for (const fn of document.listeners.get(name) || []) fn(event) }
  return { state, root, child, open, listeners, webview, environment, app, dispatch,
    scene: data => { for (const fn of listeners) fn({ data }) }, count: () => dismissed }
}

test('inside pointer/focus and composed descendants never dismiss; external pointer/focus do', t => {
  const f = fixture(t)
  f.dispatch('pointerdown', { target:f.child }); f.dispatch('focusin', { target:f.child })
  f.dispatch('pointerdown', { target:{}, composedPath:() => [f.root] })
  assert.equal(f.count(), 0)
  f.dispatch('pointerdown', { target:{} }); assert.equal(f.count(), 1)
  f.dispatch('pointerdown', { target:{} }); assert.equal(f.count(), 1, 'closed panels are ignored')
  f.open.value = true; f.dispatch('focusin', { target:{} }); assert.equal(f.count(), 2)
})

test('only a native scene pointer message dismisses; unrelated/invalid messages leave panel open', t => {
  const f = fixture(t)
  for (const data of [null, {}, '', { type:'overlay_host_state' }, { type:'native_quality_state' }]) f.scene(data)
  assert.equal(f.count(), 0)
  f.scene({ type:'overlay_scene_pointerdown' }); assert.equal(f.count(), 1)
  f.scene({ type:'overlay_scene_pointerdown' }); assert.equal(f.count(), 1)
})

test('unmount removes DOM and exact original WebView listeners, including after bridge replacement', t => {
  const f = fixture(t)
  f.environment.browser.chrome = {}; f.app.unmount()
  assert.equal(f.listeners.size, 0)
  for (const name of ['pointerdown', 'focusin']) assert.equal(document.listeners.get(name).size, 0)
  f.dispatch('pointerdown', { target:{} }); f.scene({ type:'overlay_scene_pointerdown' }); assert.equal(f.count(), 0)
})

test('native scene dismissal leaves click/drag forwarding intact and clears stale WebView hover', async () => {
  const source = await readFile(new URL('../../native-admin-host/DashboardOverlayForm.cs', import.meta.url), 'utf8')
  const down = source.slice(source.indexOf('protected override void OnMouseDown'), source.indexOf('protected override void OnMouseUp'))
  assert.match(down, /if \(!IsInteractivePoint\(e.Location\)\)[\s\S]*LeaveWebPointer\(\);\s*NotifyScenePointerDown\(\);[\s\S]*_forwardingMouse = true;[\s\S]*Capture = true;[\s\S]*ForwardMouseMessage\(MouseDownMessage/)
  assert.match(source, /PostWebMessageAsJson\("\{\\"type\\":\\"overlay_scene_pointerdown\\"\}"\)/)
  assert.match(source, /private void LeaveWebPointer\(\)[\s\S]*CoreWebView2MouseEventKind.Leave/)
  assert.match(source, /catch \(Exception error\) when \(error is InvalidOperationException or COMException\)/)
})
