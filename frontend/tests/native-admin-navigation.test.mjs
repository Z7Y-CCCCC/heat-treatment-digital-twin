import test from 'node:test'
import assert from 'node:assert/strict'
import { adminUiStateForFocus, canResumeDashboardAfterLogin, openAdminSurface } from '../src/runtime/nativeAdminNavigation.js'
import { isNativeOverlaySurface, isNativeUnitySurface } from '../src/runtime/nativeSurfaceBridge.js'

test('embedded map asks the native host to reveal its existing admin window', () => {
  const messages = []
  const routes = []
  const result = openAdminSurface({
    embedded: 'unity',
    webview: { postMessage: message => messages.push(message) },
    router: { push: route => routes.push(route) }
  })

  assert.equal(result, 'native')
  assert.deepEqual(messages, [{ type: 'host_action', action: 'show_admin' }])
  assert.deepEqual(routes, [])
})

test('factory location shortcut sends a constrained focus target through the host bridge', () => {
  const messages = []
  openAdminSurface({
    embedded: 'unity',
    focus: 'factory-location',
    webview: { postMessage: message => messages.push(message) },
    router: { push() { assert.fail('embedded navigation must stay in the native host') } }
  })

  assert.deepEqual(messages, [{ type: 'host_action', action: 'show_admin', focus: 'factory-location' }])
})

test('admin-host group map returns to the existing admin page instead of revealing a second surface', () => {
  const messages = []
  const routes = []
  const result = openAdminSurface({
    embedded: 'unity',
    surface: 'admin',
    webview: { postMessage: message => messages.push(message) },
    router: { push: route => routes.push(route) }
  })

  assert.equal(result, 'route')
  assert.deepEqual(routes, [{ path: '/admin', query: { embedded: 'unity' } }])
  assert.deepEqual(messages, [])
})

test('admin-host group map keeps the requested admin focus on same-surface navigation', () => {
  const routes = []
  openAdminSurface({
    embedded: 'unity',
    surface: 'admin',
    focus: 'factory-location',
    webview: { postMessage() { assert.fail('must not reveal another native surface') } },
    router: { push: route => routes.push(route) }
  })

  assert.deepEqual(routes, [{ path: '/admin', query: { embedded: 'unity', focus: 'factory-location' } }])
})

test('factory location focus overrides only the destination and preserves other saved admin state', () => {
  const stored = { activeTab: 'models', platformSubpage: 'designer', selectedDeviceForPoints: 'device-a' }
  const focused = adminUiStateForFocus(stored, 'factory-location')

  assert.deepEqual(focused, { activeTab: 'platform', platformSubpage: 'scene', selectedDeviceForPoints: 'device-a' })
  assert.deepEqual(stored, { activeTab: 'models', platformSubpage: 'designer', selectedDeviceForPoints: 'device-a' })
  assert.equal(adminUiStateForFocus(stored, 'unknown'), stored)
})

test('standalone map still routes to the protected admin page', () => {
  const routes = []
  const result = openAdminSurface({ embedded: undefined, webview: undefined, router: { push: route => routes.push(route) } })

  assert.equal(result, 'route')
  assert.deepEqual(routes, [{ path: '/admin', query: {} }])
})

test('standalone factory location shortcut remains inside the protected admin route', () => {
  const routes = []
  openAdminSurface({ embedded: undefined, focus: 'factory-location', webview: undefined, router: { push: route => routes.push(route) } })

  assert.deepEqual(routes, [{ path: '/admin', query: { focus: 'factory-location' } }])
})

test('embedded route falls back safely when the native bridge is absent', () => {
  const routes = []
  const result = openAdminSurface({ embedded: 'unity', webview: undefined, router: { push: route => routes.push(route) } })

  assert.equal(result, 'route')
  assert.deepEqual(routes, [{ path: '/admin', query: {} }])
})

test('a Unity query flag without the WebView2 bridge is not treated as native chrome', () => {
  assert.equal(isNativeUnitySurface('unity', undefined), false)
  assert.equal(isNativeUnitySurface('unity', { postMessage: null }), false)
  assert.equal(isNativeUnitySurface('unity', { postMessage() {} }), true)
  assert.equal(isNativeUnitySurface(undefined, { postMessage() {} }), false)
})

test('only the marked native overlay surface may stay transparent while awaiting shared sign-in', () => {
  const bridge = { postMessage() {} }
  assert.equal(isNativeOverlaySurface('unity', 'overlay', bridge), true)
  assert.equal(isNativeOverlaySurface('unity', 'admin', bridge), false)
  assert.equal(isNativeOverlaySurface('unity', 'overlay', undefined), false)
})

test('dashboard returns after login only when the pending request and both dashboard permissions are present', () => {
  assert.equal(canResumeDashboardAfterLogin({
    pending: true,
    authenticated: true,
    permissions: { launch: true, view: true }
  }), true)
  assert.equal(canResumeDashboardAfterLogin({
    pending: true,
    authenticated: true,
    permissions: { launch: false, view: true }
  }), false)
  assert.equal(canResumeDashboardAfterLogin({
    pending: false,
    authenticated: true,
    permissions: { launch: true, view: true }
  }), false)
})
