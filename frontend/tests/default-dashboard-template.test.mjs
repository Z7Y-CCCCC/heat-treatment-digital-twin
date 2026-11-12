import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'
import { DEFAULT_DASHBOARD_TEMPLATE } from '../../shared/defaultDashboardTemplate.mjs'
import { createRequire } from 'node:module'
import { widgetPresentationState } from '../src/runtime/widgetPresentation.js'
import { playbackSelection, devicePoint } from '../../shared/widgetPlayback.mjs'
import { cleanupDeletedDeviceContent } from '../../shared/dashboardDeviceDeletion.mjs'
const { createDefaultDashboardDocument, FILE } = createRequire(import.meta.url)('../../backend/services/defaultDashboardTemplate.js')

test('designer replaces rebind toolbar with an accessible fixed-baseline notice', async () => {
  const filename = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
  const source = await readFile(filename,'utf8'), {descriptor} = parse(source)
  assert.doesNotMatch(descriptor.template.content, /重绑定数据|@click="rebindCurrentTemplate"/)
  assert.match(descriptor.template.content,/class="builtin-template-badge" role="note" aria-label="固定的内置默认模板"/)
  assert.match(descriptor.template.content,/现场编辑不会改写它/)
  assert.match(descriptor.template.content,/新增设备自动沿用共享设备视角布局/)
  assert.match(descriptor.template.content,/DEFAULT_DASHBOARD_TEMPLATE\.factoryViewCount/)
  assert.equal(DEFAULT_DASHBOARD_TEMPLATE.factoryViewCount,7)
  assert.ok(Object.isFrozen(DEFAULT_DASHBOARD_TEMPLATE))
  compileScript(descriptor,{id:'fixed-baseline'})
  assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:filename.pathname,id:'fixed-baseline'}).errors,[])
  assert.deepEqual(compileStyle({source:descriptor.styles.map(s=>s.content).join('\n'),id:'fixed-baseline'}).errors,[])
  assert.match(descriptor.template.content,/@click="confirmTemplateImport"/)
  assert.match(source,/rebindDashboardTemplate\(pending.document/)
})

test('every new device automatically uses the four shared device views with its own data context', async () => {
  const before = await readFile(FILE)
  const document = createDefaultDashboardDocument({ projectId:'shared-device-project', sceneId:'shared-device-scene', name:'共享设备视角测试' })
  const devices = ['existing-device', 'new-device-a', 'new-device-b'].map(id => ({ id, name:id }))
  const views = document.scene.views.filter(view => view.mode === 'device')
  assert.deepEqual(views.map(view => view.id), ['device_detail','device_xray','device_exploded','device_part'])
  const expectedCounts = { device_detail:13, device_xray:13, device_exploded:11, device_part:6 }
  const visibleLayout = (input, view, deviceId, catalog) => {
    const context = { viewId:view.id, viewMode:'device', deviceId, inspectionStage:view.metadata.inspectionStage, sceneReady:true }
    const visible = input.widgets.filter(widget => widgetPresentationState(widget, { view, context }).visible)
    for (const widget of visible) {
      assert.equal(widget.data.deviceScope, 'current')
      assert.equal(widget.data.deviceId, '')
      assert.equal(playbackSelection(widget.data, context, catalog).device?.id, deviceId, `${view.id}/${widget.id} must not read another device`)
      if (widget.data.mode === 'plc') assert.equal(devicePoint(widget.data, deviceId, {
        foreign:{id:'foreign-point',device_id:'other-device',name:'temperature',value:999}
      }), null, 'unconfigured shared slots must not borrow another device\'s point')
    }
    return visible.map(widget => ({ id:widget.id, frame:widget.frame, style:widget.style }))
  }
  for (const view of views) {
    assert.equal(view.targetId, '')
    const expected = visibleLayout(document, view, devices[0].id, devices)
    assert.equal(expected.length, expectedCounts[view.id])
    for (const device of devices.slice(1)) assert.deepEqual(visibleLayout(document, view, device.id, devices), expected)
  }
  let remaining = devices
  let current = document
  for (const device of devices) {
    remaining = remaining.filter(row => row.id !== device.id)
    const deletion = cleanupDeletedDeviceContent(current, { deviceIds:[device.id], existingDeviceIds:remaining.map(row => row.id) })
    assert.deepEqual(deletion.removedWidgetIds, [])
    assert.deepEqual(deletion.removedViewIds, [])
    assert.deepEqual(deletion.document, document)
    current = deletion.document
  }
  const recreated = [{id:'device-after-empty', name:'清空后新设备'}]
  for (const view of views) assert.equal(visibleLayout(current, view, recreated[0].id, recreated).length, expectedCounts[view.id])
  assert.deepEqual(await readFile(FILE), before)
})
