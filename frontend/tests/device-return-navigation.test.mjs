import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { deviceReturnOrigin, deviceBackRequest } from '../src/runtime/deviceReturnNavigation.js'

const views = [{ id: 'factory_overview', name: '全厂总览', mode: 'factory' },
  { id: 'workshop_overview', name: '车间总览', mode: 'workshop' },
  { id: 'line_overview', name: '产线视角', mode: 'line' }]
const context = mode => ({ factoryId: 'factory-a', sceneId: 'scene-a', viewMode: 'device', viewId: 'device_detail', deviceId: 'one', inspectionStage: 'solid',
  returnOrigin: { factoryId: 'factory-a', sceneId: 'scene-a', viewMode: mode, viewId: `${mode}_overview`, workshopId: 'entry-workshop', lineId: mode === 'line' ? 'entry-line' : '' } })

test('device return label uses the actual factory/workshop/line entry, not the device ancestry', () => {
  for (const mode of ['factory','workshop','line']) {
    const current = context(mode), before = structuredClone(current), origin = deviceReturnOrigin(current, views)
    assert.equal(origin.viewId, `${mode}_overview`)
    assert.equal(origin.name, views.find(view => view.mode === mode).name)
    assert.deepEqual(current, before)
  }
})

test('inspection exits internally first, and missing, stale, deleted or hidden entry views use the existing fallback', () => {
  for (const stage of ['part','exploded','xray']) assert.equal(deviceReturnOrigin({ ...context('workshop'), inspectionStage: stage }, views), null)
  const current = context('workshop')
  for (const patch of [{ factoryId: 'other' }, { sceneId: 'other' }, { returnOrigin: null }, { viewMode: 'line' }]) assert.equal(deviceReturnOrigin({ ...current, ...patch }, views), null)
  assert.equal(deviceReturnOrigin(current, views.filter(view => view.mode !== 'workshop')), null)
  assert.equal(deviceReturnOrigin(current, views.map(view => ({ ...view, metadata: { hierarchyHidden: true } }))), null)
})

test('all device back commands use the one native back path with stale-view/device/stage guards', () => {
  for (const inspectionStage of ['solid','xray','exploded','part']) {
    const value = context('workshop'); value.inspectionStage = inspectionStage
    const request = deviceBackRequest(value)
    assert.equal(request.action, 'inspection_back')
    assert.deepEqual(request.focus, { mode: 'device', deviceId: 'one', inspectionStage })
    assert.equal(request.viewId, 'device_detail')
    assert.equal(Object.hasOwn(request, 'returnOrigin'), false, 'client cannot forge a native entry camera or return target')
  }
})

test('native world clicks capture before changing the camera; solid back restores entry before considering the fixed parent', async () => {
  const controller = await readFile(new URL('../../unity-client/Assets/Scripts/Runtime/FactoryDashboardController.cs', import.meta.url), 'utf8')
  const detail = controller.slice(controller.indexOf('private void ShowDetail('), controller.indexOf('private void ShowOverview('))
  assert.ok(detail.indexOf('DeviceEntryStarting?.Invoke()') < detail.indexOf('_orbit?.FocusBounds('))
  assert.match(detail, /_mode != DashboardMode.Detail/)
  const runtime = await readFile(new URL('../../unity-client/Assets/Scripts/Runtime/FactoryRuntime.cs', import.meta.url), 'utf8')
  const back = runtime.slice(runtime.indexOf('private void NavigateToParentCamera()'), runtime.indexOf('private void OnDeviceHoverUpdated('))
  assert.ok(back.indexOf('TryReturnToDeviceEntry()') < back.indexOf('current?.ReturnViewId'))
  assert.match(runtime, /_orbit\?\.CaptureViewState\(\)/)
  assert.match(runtime, /_orbit\?\.RestoreViewState\(entry.Camera\)/)
  assert.match(runtime, /expectedStage, _dashboard.InspectionStageName/)
  assert.match(runtime, /string.IsNullOrWhiteSpace\(lineId\) && !restoreEntry/)
  assert.match(runtime, /view.Id, restoreEntry: true/)
})
