import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { deferred, installBrowser, settle } from './helpers.mjs'
import { exportDashboardTemplate, importDashboardTemplate, dashboardTemplateReferences, rebindDashboardTemplate } from '../src/runtime/dashboardTemplate.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { widgetBindingChoices, DATASET_WIDGETS, POINT_WIDGETS } from '../src/runtime/widgetBindingChoices.js'
import { applyTemplateFieldBindings, templateFieldBindings } from '../src/runtime/templateFieldMapping.js'

// Run the real SFC setup/load path; child renderers are irrelevant to the source
// selection and are stubbed so no canvas, GL context or browser is required.
const sourceUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
test('source choices are short, unique, supported by the widget and preserve existing direct bindings',()=>{
  for(const type of [...DATASET_WIDGETS,'image','container','navigation'])for(const mode of ['static','dataset','database','http_api','business','plc']){
    const choices=widgetBindingChoices({type,data:{mode}})
    assert.equal(new Set(choices.map(c=>c.id)).size,choices.length)
    assert.ok(choices.some(c=>c.id===mode),`${type}/${mode} remains editable`)
    if(mode==='static')assert.equal(choices.length,1+Number(DATASET_WIDGETS.has(type))+Number(POINT_WIDGETS.has(type))*(1+Number(!['trend','hud_chart_dock'].includes(type)))+Number(type==='map_region_list'))
    for(const id of ['database','http_api','business'])assert.equal(choices.some(c=>c.id===id),mode===id)
  }
})
const { descriptor, errors } = parse(await readFile(sourceUrl, 'utf8'))
assert.deepEqual(errors, [])
let compiled = compileScript(descriptor, { id: 'data-source-designer-test' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const specifier = match[2]
    const target = specifier.endsWith('.vue')
        ? 'data:text/javascript,export default {render:()=>null}'
        : specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier)
    compiled = compiled.replace(match[0], `from ${JSON.stringify(target)}`)
}
const { default: Designer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Designer.render = () => null

function fixture(t, connections) {
    const environment = installBrowser(t)
    environment.browser.cancelAnimationFrame = () => {}
    environment.browser.requestAnimationFrame = () => 0
    environment.replace('ResizeObserver', class { observe() {} disconnect() {} })
    environment.replace('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    t.mock.method(adminApi, 'getDashboardDesigner', async () => ({ revision: 1, document: {} }))
    for (const method of ['getDevices', 'getDataPoints', 'getWorkshops', 'getLines']) t.mock.method(adminApi, method, async () => [])
    t.mock.method(adminApi, 'getRealtimePointValues', async () => ({ points: [] }))
    t.mock.method(adminApi, 'getDataSources', async () => ({ connections }))
    // Dataset loading is part of the real startup Promise.all too. Never let a
    // unit fixture race an actual localhost request (or the next fixture).
    t.mock.method(adminApi, 'getDataSets', async () => ({ datasets: [] }))
    t.mock.method(adminApi, 'getSettings', async () => ({}))
    t.mock.method(adminApi, 'listFactories', async () => ({factories:[]}))
    const renderer = createRenderer({
        createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
        setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
        patchProp() {}, insert() {}, remove() {}
    })
    const instance = ref(null)
    const app = renderer.createApp({ render: () => h(Designer, { ref: instance }) })
    app.mount({})
    environment.beforeRestore(() => app.unmount())
    return { instance, browser: environment.browser }
}

function pointerEvent(overrides = {}) {
    return { button: 0, pointerId: 7, detail: 1, clientX: 100, clientY: 100,
        preventDefault() {}, stopPropagation() {}, ...overrides }
}

async function canvasSelectionFixture(t, widgets = []) {
    const { instance, browser } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const items = widgets.length ? widgets : [
        { id: 'a', type: 'text', frame: { x: 100, y: 50, width: 100, height: 60 } },
        { id: 'b', type: 'text', frame: { x: 300, y: 150, width: 100, height: 60 } }
    ]
    const ids = new Set(items.map(widget => widget.id))
    state.documentModel = normalizeDashboardDocument({ canvas: { width: 800, height: 500, gridSize: 1 }, widgets: items })
    state.documentModel.widgets = state.documentModel.widgets.filter(widget => ids.has(widget.id))
    state.selectedViewId = 'factory_overview'
    state.currentView.componentState = { show: [...ids], hide: [], hideNonTargetDevices: false }
    state.viewportRef = { querySelector: selector => selector === '.designer-canvas-stage'
        ? { getBoundingClientRect: () => ({ left: 0, top: 0 }) } : null }
    state.zoom = 1
    state.selectedIds = []
    state.resetHistory()
    return { state, browser, widget: id => state.documentModel.widgets.find(widget => widget.id === id) }
}

function canvasClick(state, widget, modifiers = {}) {
    const event = pointerEvent(modifiers)
    state.beginMove(event, widget)
    state.endPointerOperation()
    state.selectCanvasWidget(widget, event)
}

test('canvas selection uses a dedicated click handler while layer clicks stay independent and the multi-select hint is visible', () => {
    const canvasArticle = descriptor.template.content.match(/<article\s+[\s\S]*?:data-widget-id="widget.id"[\s\S]*?>/)?.[0]
    assert.match(canvasArticle, /@pointerdown\.stop="beginMove\(\$event, widget\)"/)
    assert.match(canvasArticle, /@click\.stop="selectCanvasWidget\(widget, \$event\)"/)
    assert.match(descriptor.template.content, /@click="selectWidget\(widget, \$event, \{ focusCanvas: true \}\)"/)
    assert.match(descriptor.template.content, /Ctrl \/ Command 点击多选，再点取消/)
})

test('real pointerdown to click Ctrl and Meta gestures add or remove once, without no-op history or fallback movement', async t => {
    const { state, browser, widget } = await canvasSelectionFixture(t)
    for (const modifier of ['ctrlKey', 'metaKey']) {
        state.selectedIds = []
        const before = JSON.stringify(state.documentModel)
        canvasClick(state, widget('a'))
        canvasClick(state, widget('b'), { [modifier]: true })
        assert.deepEqual(state.selectedIds, ['a', 'b'])
        const event = pointerEvent({ [modifier]: true })
        state.beginMove(event, widget('b'))
        state.handlePointerMove(pointerEvent({ clientX: 250, clientY: 220 }))
        assert.equal(browser.listeners.get('pointermove')?.size || 0, 0, 'cancelled primary must not drag remaining selection')
        state.endPointerOperation()
        state.selectCanvasWidget(widget('b'), event)
        assert.deepEqual(state.selectedIds, ['a'])
        canvasClick(state, widget('a'), { [modifier]: true })
        state.handlePointerMove(pointerEvent({ clientX: 250, clientY: 220 }))
        assert.deepEqual(state.selectedIds, [], 'cancelling the last selected item must not fall back to dragging it')
        assert.equal(JSON.stringify(state.documentModel), before)
        assert.equal(state.history.length, 1)
        assert.equal(state.canUndo, false)
    }
})

test('Ctrl group selection adds a partially selected group atomically and removes a fully selected group', async t => {
    const { state, widget } = await canvasSelectionFixture(t, [
        { id: 'a', type: 'text' }, { id: 'g1', type: 'text', groupId: 'group' }, { id: 'g2', type: 'text', groupId: 'group' }
    ])
    state.selectedIds = ['a', 'g1']
    canvasClick(state, widget('g2'), { ctrlKey: true })
    assert.deepEqual(state.selectedIds, ['a', 'g1', 'g2'])
    canvasClick(state, widget('g1'), { ctrlKey: true })
    assert.deepEqual(state.selectedIds, ['a'])
    canvasClick(state, widget('g2'))
    assert.deepEqual(state.selectedIds, ['g1', 'g2'], 'a plain click on an unselected group replaces selection')
    assert.equal(state.history.length, 1)
})

test('Shift adds selection while keyboard clicks and layer clicks are not swallowed by canvas pointer deduplication', async t => {
    const { state, widget } = await canvasSelectionFixture(t)
    canvasClick(state, widget('a'))
    canvasClick(state, widget('b'), { shiftKey: true })
    canvasClick(state, widget('a'), { shiftKey: true })
    assert.deepEqual(state.selectedIds, ['a', 'b'])
    state.beginMove(pointerEvent({ ctrlKey: true }), widget('b'))
    state.endPointerOperation()
    assert.deepEqual(state.selectedIds, ['a'])
    state.selectWidget(widget('b'), { ctrlKey: true }, { focusCanvas: true })
    assert.deepEqual(state.selectedIds, ['a', 'b'], 'the independent layer click must still toggle')
    state.selectCanvasWidget(widget('b'), pointerEvent({ ctrlKey: true, detail: 0 }))
    assert.deepEqual(state.selectedIds, ['a'], 'keyboard click must still toggle even with a previous pointer marker')
    assert.equal(state.history.length, 1)
})

test('plain dragging a selected item retains multi-selection and uses the same displacement for each item', async t => {
    const { state, widget } = await canvasSelectionFixture(t)
    state.selectedIds = ['a', 'b']
    state.beginMove(pointerEvent(), widget('a'))
    state.handlePointerMove(pointerEvent({ clientX: 150, clientY: 130 }))
    assert.deepEqual(state.selectedIds, ['a', 'b'])
    assert.deepEqual([widget('a').frame.x, widget('a').frame.y, widget('b').frame.x, widget('b').frame.y], [150, 80, 350, 180])
    state.endPointerOperation()
    state.selectCanvasWidget(widget('a'), pointerEvent())
    assert.deepEqual(state.selectedIds, ['a', 'b'])
    assert.equal(state.history.length, 2)
    state.undo()
    assert.deepEqual([widget('a').frame.x, widget('a').frame.y, widget('b').frame.x, widget('b').frame.y], [100, 50, 300, 150])
})

test('Ctrl-add dragging moves all selected items once and canvas edges do not distort their relative positions', async t => {
    const { state, widget } = await canvasSelectionFixture(t)
    state.selectedIds = ['a']
    const event = pointerEvent({ ctrlKey: true })
    state.beginMove(event, widget('b'))
    state.handlePointerMove(pointerEvent({ clientX: 150, clientY: 130 }))
    state.endPointerOperation()
    state.selectCanvasWidget(widget('b'), event)
    assert.deepEqual(state.selectedIds, ['a', 'b'])
    assert.deepEqual([widget('a').frame.x, widget('a').frame.y, widget('b').frame.x, widget('b').frame.y], [150, 80, 350, 180])
    state.beginMove(pointerEvent(), widget('a'))
    state.handlePointerMove(pointerEvent({ clientX: 1100, clientY: 1100 }))
    assert.deepEqual([widget('a').frame.x, widget('a').frame.y, widget('b').frame.x, widget('b').frame.y], [500, 340, 700, 440])
    state.endPointerOperation()
    state.beginMove(pointerEvent(), widget('b'))
    state.handlePointerMove(pointerEvent({ clientX: -1000, clientY: -1000 }))
    assert.deepEqual([widget('a').frame.x, widget('a').frame.y, widget('b').frame.x, widget('b').frame.y], [0, 0, 200, 100])
    state.endPointerOperation()
})

test('locked canvas items remain selectable but cannot drag themselves or the other selected items', async t => {
    const { state, browser, widget } = await canvasSelectionFixture(t)
    widget('b').locked = true
    state.resetHistory()
    state.selectedIds = ['a']
    const before = JSON.stringify(state.documentModel)
    const event = pointerEvent({ ctrlKey: true })
    state.beginMove(event, widget('b'))
    assert.deepEqual(state.selectedIds, ['a', 'b'])
    state.handlePointerMove(pointerEvent({ clientX: 150, clientY: 130 }))
    assert.equal(browser.listeners.get('pointermove')?.size || 0, 0)
    state.selectCanvasWidget(widget('b'), event)
    assert.deepEqual(state.selectedIds, ['a', 'b'])
    assert.equal(JSON.stringify(state.documentModel), before)
    canvasClick(state, widget('b'), { ctrlKey: true })
    assert.deepEqual(state.selectedIds, ['a'])
    state.selectedIds = []
    canvasClick(state, widget('b'))
    assert.deepEqual(state.selectedIds, ['b'])
    state.selectedIds = ['a', 'b']
    state.beginMove(pointerEvent(), widget('a'))
    state.handlePointerMove(pointerEvent({ clientX: 150, clientY: 130 }))
    assert.deepEqual([widget('a').frame.x, widget('b').frame.x], [150, 300], 'dragging an unlocked item excludes the locked item')
    state.endPointerOperation()
    assert.equal(state.history.length, 2)
})

test('resize does not toggle selection on a Ctrl gesture or its generated click and pointer cancellation cleans all listeners', async t => {
    const { state, browser, widget } = await canvasSelectionFixture(t)
    state.selectedIds = ['a']
    const event = pointerEvent({ ctrlKey: true })
    state.beginResize(event, widget('a'), 'se')
    state.handlePointerMove(pointerEvent({ clientX: 120, clientY: 115 }))
    for (const handler of [...(browser.listeners.get('pointercancel') || [])]) handler()
    state.selectCanvasWidget(widget('a'), event)
    assert.deepEqual(state.selectedIds, ['a'])
    assert.deepEqual([widget('a').frame.width, widget('a').frame.height], [120, 75])
    assert.equal(state.history.length, 2)
    for (const name of ['pointermove', 'pointerup', 'pointercancel']) assert.equal(browser.listeners.get(name)?.size || 0, 0)
    state.beginMove(pointerEvent(), widget('a'))
    state.beginMove(pointerEvent({ ctrlKey: true }), widget('a'))
    assert.deepEqual(state.selectedIds, [])
    assert.equal(browser.listeners.get('pointermove')?.size || 0, 0, 'a new cancelled pointer closes any preceding operation')
    assert.equal(state.history.length, 2, 'repeated no-op pointers must not create history')
})

test('preview widget interaction and non-left pointers do not edit selection or geometry', async t => {
    const { state, browser, widget } = await canvasSelectionFixture(t)
    state.selectedIds = ['a']
    const before = JSON.stringify(state.documentModel)
    state.previewMode = true
    canvasClick(state, widget('b'), { ctrlKey: true })
    state.beginResize(pointerEvent(), widget('a'), 'se')
    state.handlePointerMove(pointerEvent({ clientX: 150, clientY: 130 }))
    assert.deepEqual(state.selectedIds, ['a'])
    state.previewMode = false
    state.beginMove(pointerEvent({ button: 2, ctrlKey: true }), widget('b'))
    state.beginResize(pointerEvent({ button: 2 }), widget('a'), 'se')
    assert.deepEqual(state.selectedIds, ['a'])
    assert.equal(JSON.stringify(state.documentModel), before)
    assert.equal(state.history.length, 1)
    assert.equal(browser.listeners.get('pointermove')?.size || 0, 0)
})

test('marquee keeps additive selection, selects full groups and clears on plain empty-canvas clicks without document history', async t => {
    const { state, widget } = await canvasSelectionFixture(t, [
        { id: 'a', type: 'text', groupId: 'group', frame: { x: 100, y: 50, width: 100, height: 60 } },
        { id: 'outside-group', type: 'text', groupId: 'group', frame: { x: 400, y: 50, width: 100, height: 60 } },
        { id: 'b', type: 'text', locked: true, frame: { x: 600, y: 200, width: 100, height: 60 } }
    ])
    assert.ok(state.currentViewWidgets.some(item => item.id === widget('a').id))
    state.selectedIds = ['b']
    state.beginMarqueeSelection(pointerEvent({ clientX: 0, clientY: 0, shiftKey: true }))
    state.handlePointerMove(pointerEvent({ clientX: 210, clientY: 120 }))
    assert.deepEqual(state.selectedIds, ['b', 'a', 'outside-group'])
    state.endPointerOperation()
    state.beginMarqueeSelection(pointerEvent({ clientX: 0, clientY: 0, ctrlKey: true }))
    state.endPointerOperation()
    assert.deepEqual(state.selectedIds, ['b', 'a', 'outside-group'], 'additive empty click preserves selection')
    state.beginMarqueeSelection(pointerEvent({ clientX: 0, clientY: 0 }))
    state.endPointerOperation()
    assert.deepEqual(state.selectedIds, [])
    assert.equal(state.history.length, 1)
})

test('layer controls contain only top/bottom and place a widget beyond the actual stack bounds', async t => {
    const controls = descriptor.template.content.match(/class="layer-actions"[^>]*>(.*?)<\/div>/s)?.[1]
    assert.ok(controls)
    assert.deepEqual([...controls.matchAll(/>([^<>]+)<\/button>/g)].map(match => match[1]), ['置顶', '置底'])
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = [{id:'a',zIndex:1030},{id:'b',zIndex:2000},{id:'c',zIndex:-20}]
    const widget = state.documentModel.widgets[0]
    state.moveLayer(widget, 'top'); assert.equal(widget.zIndex, 2001)
    state.moveLayer(widget, 'bottom'); assert.equal(widget.zIndex, -21)
})

test('restoring or reentering the designer skips disabled global and hidden local views, but manual editing remains possible', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const disabled = {enabled:Object.fromEntries(state.views.filter(v=>/^(map_|site_)/.test(v.id)).map(v=>[v.id,false]))}
    state.updateGlobalViewPolicy(disabled)
    state.documentModel.scene.views.find(v=>v.id==='factory_overview').metadata={hierarchyHidden:true}
    state.restoreEditorState({viewId:'map_world',collapsedViewIds:['factory_overview']})
    assert.equal(state.selectedViewId, 'workshop_overview')
    assert.ok(state.collapsedViewIds.has('factory_overview'))
    state.selectView('map_world')
    assert.equal(state.selectedViewId,'map_world', 'closed views remain explicitly editable')
    state.deactivateDesigner(); state.activateDesigner()
    assert.equal(state.selectedViewId,'workshop_overview')
    const deviceView=state.views.find(view=>view.mode==='device').id
    state.selectView(deviceView); state.deactivateDesigner(); state.activateDesigner()
    assert.equal(state.selectedViewId,deviceView, 'available last selection is retained')
})

test('designer reads actual device part catalogs and a late A catalog cannot replace B or invent preview measurements',async t=>{
 const {instance}=fixture(t,[]);await settle();const state=instance.value.$.setupState,a=deferred(),b=deferred()
 t.mock.method(adminApi,'getDeviceInspection',id=>id==='a'?a.promise:b.promise)
 state.editorDeviceId='a';state.previewContext.deviceId='a';const first=state.loadPreviewParts()
 state.editorDeviceId='b';state.previewContext.deviceId='b';const second=state.loadPreviewParts()
 b.resolve({inspection:{parts:[{id:'b_real',name:'真实 B 部件',point_ids:[],point_keys:[]}]}});await second
 a.resolve({inspection:{parts:[{id:'a_old',name:'旧 A 部件'}]}});await first
 assert.equal(state.previewContext.partId,'b_real');assert.equal(state.previewContext.partName,'真实 B 部件');assert.deepEqual(state.previewSelectedPart.points,[])
})

test('saving retains edits and the newer selection made while the server is pending', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const pending = deferred()
    let submitted
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => { submitted = document; return pending.promise })
    state.documentModel.name = '提交版本'
    const saving = state.saveDraft()
    state.documentModel.name = '保存期间的新修改'
    state.selectedIds = ['new-selection']
    pending.resolve({ revision: 2, document: submitted })
    assert.equal(await saving, true)
    assert.equal(submitted.name, '提交版本')
    assert.equal(state.documentModel.name, '保存期间的新修改')
    assert.equal(state.revision, 2)
    assert.equal(state.isDirty, true)
    assert.deepEqual(state.selectedIds, ['new-selection'])
})

test('revision conflicts preserve the local draft and never publish', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    t.mock.method(adminApi, 'saveDashboardDraft', async () => ({ error: '修订冲突，请刷新' }))
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => { throw new Error('must not publish') })
    state.documentModel.name = '必须保留的草稿'
    await state.publishVersion()
    assert.equal(state.documentModel.name, '必须保留的草稿')
    assert.equal(state.isDirty, true)
    assert.equal(publish.mock.callCount(), 0)
    assert.equal(state.status.tone, 'danger')
    assert.equal(state.publishNotice.tone, 'error')
    assert.match(state.publishNotice.text, /保存失败.*修订冲突/)
})

test('incomplete draft bindings save without data loss and explain why publishing is deferred', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [
        { id: 'pending_filter', type: 'filter', title: '产线筛选', content: { parameterKey: '' } },
        { id: 'pending_business', type: 'business_summary', title: '业务统计', data: { mode: 'business', connectionId: '' } }
    ] }).widgets
    state.documentModel.tooltipTemplates.templates[0].widgets[1].content.text = '我编辑的悬停提示'
    const beforeBindings = state.documentModel.widgets.filter(widget => widget.id.startsWith('pending_')).map(widget => ({ id: widget.id, title: widget.title, data: { ...widget.data }, content: { ...widget.content } }))
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => ({ revision: 2, document, warnings: [
        '第 1 个组件“产线筛选”（pending_filter）请选择已定义的大屏参数',
        '第 2 个组件 的业务只读组件必须选择外部数据库连接'
    ] }))
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => { throw new Error('must not publish an incomplete saved draft') })
    await state.publishVersion()
    assert.deepEqual(state.documentModel.widgets.filter(widget => widget.id.startsWith('pending_')).map(widget => ({ id: widget.id, title: widget.title, data: { ...widget.data }, content: { ...widget.content } })), beforeBindings)
    assert.equal(state.documentModel.tooltipTemplates.templates[0].widgets[1].content.text, '我编辑的悬停提示')
    assert.equal(state.revision, 2)
    assert.equal(state.isDirty, false)
    assert.equal(state.status.tone, 'warning')
    assert.equal(state.publishNotice.tone, 'warning')
    assert.match(state.publishNotice.text, /草稿已保存，尚未发布/)
    assert.equal(publish.mock.callCount(), 0)
    assert.deepEqual(state.validationIssues.map(issue => issue.widgetId), ['pending_filter', 'pending_business'])
    assert.match(state.validationIssues[0].label, /产线筛选.*pending_filter/)
})

test('configuration issue location selects exactly the failing main widget without editing its content', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [
        { id: 'filter_a', type: 'filter', title: '设备筛选', groupId: 'same_group', visibility: { viewIds: ['workshop_overview'] } },
        { id: 'business_b', type: 'business_summary', title: '报表', groupId: 'same_group', data: { mode: 'business', connectionId: '' }, visibility: { viewIds: ['workshop_overview'] } }
    ] }).widgets
    state.setValidationIssues(['第 2 个组件 的业务只读组件必须选择外部数据库连接'], 'draft')
    const before = JSON.stringify(state.documentModel)
    state.designerMode = 'tooltips'
    state.panelLayout.leftCollapsed = true
    state.panelLayout.rightCollapsed = true
    state.layersCollapsed = true
    await state.locateValidationIssue(state.validationIssues[0])
    assert.equal(state.designerMode, 'layout')
    assert.equal(state.selectedViewId, 'workshop_overview')
    assert.deepEqual(state.selectedIds, ['business_b'])
    assert.equal(state.inspectorTab, 'data')
    assert.equal(state.layerVisibilityFilter, 'all')
    assert.equal(state.layersCollapsed, false)
    assert.equal(state.panelLayout.leftCollapsed, false)
    assert.equal(state.panelLayout.rightCollapsed, false)
    assert.equal(JSON.stringify(state.documentModel), before)
})

test('validation diagnostics prefer stable component IDs and never mistake nested tooltip indices for main widgets', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [
        { id: 'main_a', type: 'filter', title: '主筛选 A' },
        { id: 'main_b', type: 'filter', title: '主筛选 B' }
    ] }).widgets
    const template = state.documentModel.tooltipTemplates.templates[0]
    state.setValidationIssues([
        '第 1 个组件“主筛选 B”（main_b）请选择已定义的大屏参数',
        `悬停模板“${template.name}”：第 1 个组件 尺寸不合法`
    ])
    assert.equal(state.validationIssues[0].widgetId, 'main_b')
    assert.equal(state.validationIssues[1].templateId, template.id)
    assert.equal(state.validationIssues[1].widgetId, template.widgets[0].id)
    state.selectedIds = ['main_a']
    await state.locateValidationIssue(state.validationIssues[1])
    assert.deepEqual(state.selectedIds, ['main_a'])
    const markup = descriptor.template.content
    assert.match(markup, /aria-label="组件配置问题"/)
    assert.match(markup, /@click="locateValidationIssue\(issue\)"/)
})

test('structured save errors retain local edits and a later successful save clears issue warnings', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.name = '必须保留的提示模板修改'
    const warning = '第 1 个组件“导航状态”（widget_navigation）请选择已定义的大屏参数'
    t.mock.method(adminApi, 'saveDashboardDraft', async () => ({ error: warning, errors: [warning] }))
    assert.equal(await state.saveDraft(), false)
    assert.equal(state.documentModel.name, '必须保留的提示模板修改')
    assert.equal(state.isDirty, true)
    assert.equal(state.validationIssues.length, 1)
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => ({ revision: 2, document, warnings: [] }))
    assert.equal(await state.saveDraft(), true)
    assert.equal(state.validationIssues.length, 0)
    assert.equal(state.status.tone, 'success')
    assert.equal(state.isDirty, false)
})

test('template import stays in the target scene and can be undone without publishing', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const before = JSON.stringify(state.documentModel)
    const source = normalizeDashboardDocument({ name: '复用方案', sceneId: 'another_scene', projectId: 'another_project' })
    const text = exportDashboardTemplate(source)
    const input = { files: [{ size: text.length, text: async () => text }], value: 'template.json' }
    await state.loadTemplateFile({ target: input })
    assert.equal(state.documentModel.name, '复用方案')
    assert.equal(state.documentModel.sceneId, JSON.parse(before).sceneId)
    assert.equal(state.documentModel.projectId, JSON.parse(before).projectId)
    assert.equal(state.isDirty, true)
    assert.equal(input.value, '')
    state.undo()
    assert.equal(JSON.stringify(state.documentModel), before)
})

test('template parser rejects malformed, oversized, duplicate and future templates', () => {
    const document = normalizeDashboardDocument()
    const template = JSON.parse(exportDashboardTemplate(document))
    assert.throws(() => importDashboardTemplate('{}', document), /版本/)
    assert.throws(() => importDashboardTemplate(' '.repeat(5 * 1024 * 1024 + 1), document), /5 MB/)
    template.document.widgets.push(template.document.widgets[0])
    assert.throws(() => importDashboardTemplate(JSON.stringify(template), document), /重复/)
    template.document.widgets.pop()
    template.document.schemaVersion = 999
    assert.throws(() => importDashboardTemplate(JSON.stringify(template), document), /升级/)
})

test('template rebind dialog blocks missing targets, maps shared references and supports undo', async t => {
    const { instance } = fixture(t, [{ id: 'new-db', type: 'sqlite' }])
    await settle()
    const state = instance.value.$.setupState
    state.devices = [{ id: 'new-device', name: '新设备' }]
    state.points = [{ id: 'new-point', device_id: 'new-device', name: '新点位', category: 'analog', value_role: 'pressure', unit: 'bar' }]
    assert.equal(state.templateTargetLabel('points', { id: 1, device_id: 'new-device', label: '实际温度', name: 'actual_temp' }), '新设备（new-device） / 实际温度（actual_temp） · 点位 1')
    assert.equal(state.templateTargetLabel('points', { id: 2, device_id: 'unknown-device', name: 'running' }), 'unknown-device（unknown-device） / running · 点位 2')
    const source = normalizeDashboardDocument({ widgets: [
        { id: 'plc', type: 'value', data: { mode: 'plc', deviceId: 'old-device', pointId: 'old-point' }, events: [{ action: 'focus_device', deviceId: 'old-device' }] },
        { id: 'db', type: 'value', data: { mode: 'database', connectionId: 'old-db', datasets: [{ connectionId: 'old-db', table: 'samples', field: 'value' }] } }
    ] })
    const original = JSON.stringify(state.documentModel)
    const text = exportDashboardTemplate(source)
    await state.loadTemplateFile({ target: { files: [{ size: text.length, text: async () => text }], value: '' } })
    assert.ok(state.templateImport)
    assert.equal(JSON.stringify(state.documentModel), original, 'no old IDs are installed before mapping')
    state.confirmTemplateImport()
    assert.match(state.templateImport.error, /选择/)
    Object.assign(state.templateMapping, { 'devices:old-device': 'new-device', 'points:old-point': 'new-point', 'connections:old-db': 'new-db' })
    state.confirmTemplateImport()
    assert.equal(state.templateImport, null)
    assert.ok(state.templateFieldImport, 'database references require a separate field confirmation')
    assert.equal(JSON.stringify(state.documentModel), original, 'field confirmation has not replaced the draft yet')
    state.confirmTemplateFieldImport(state.templateFieldImport.document)
    const plc = state.documentModel.widgets.find(widget => widget.id === 'plc')
    const db = state.documentModel.widgets.find(widget => widget.id === 'db')
    assert.equal(plc.data.deviceId, 'new-device')
    assert.equal(plc.data.pointId, 'new-point')
    assert.equal(plc.data.pointKey, 'analog.pressure')
    assert.equal(plc.data.path, 'analog.pressure')
    assert.equal(plc.data.unit, 'bar')
    assert.equal(plc.events[0].deviceId, 'new-device')
    assert.equal(db.data.connectionId, 'new-db')
    assert.equal(db.data.datasets[0].connectionId, 'new-db')
    assert.equal(dashboardTemplateReferences(state.documentModel).some(ref => ref.id.startsWith('old-')), false)
    state.undo()
    assert.equal(JSON.stringify(state.documentModel), original)
})

test('mapping rejects wrong point ownership, missing IDs and incompatible source types', () => {
    const document = normalizeDashboardDocument({ widgets: [{ id: 'plc', type: 'value', data: { mode: 'plc', deviceId: 'a', pointId: 'b' } }] })
    const mapping = { 'devices:a': 'x', 'points:b': 'y' }
    const catalog = { devices: [{ id: 'x' }], points: [{ id: 'y', device_id: 'z' }] }
    assert.throws(() => rebindDashboardTemplate(document, mapping, catalog), /不属于/)
    assert.throws(() => rebindDashboardTemplate(document, { ...mapping, 'devices:a': 'missing' }, catalog), /有效目标/)
    const http = normalizeDashboardDocument({ widgets: [{ id: 'api', type: 'value', data: { mode: 'http_api', connectionId: 'old' } }] })
    assert.throws(() => rebindDashboardTemplate(http, { 'connections:old': 'db' }, { connections: [{ id: 'db', type: 'mysql' }] }), /类型不匹配/)
})

test('confirmed template field mapping is saved before publishing and rejects draft races', async t => {
    const { instance } = fixture(t, [{ id: 'db', type: 'sqlite' }])
    await settle()
    const state = instance.value.$.setupState
    const source = normalizeDashboardDocument({ widgets: [{ id: 'mapped', type: 'value', data: { mode: 'database', connectionId: 'old', datasets: [{ connectionId: 'old', table: 'old_table', field: 'old_field' }] } }] })
    const text = exportDashboardTemplate(source)
    const load = () => state.loadTemplateFile({ target: { files: [{ size: text.length, text: async () => text }], value: '' } })
    await load()
    state.templateMapping['connections:old'] = 'db'
    state.confirmTemplateImport()
    const pending = state.templateFieldImport.document
    const beforeKey = JSON.stringify(state.documentModel)
    state.handleKeydown({ key: 'Delete', target: {}, preventDefault() {} })
    assert.equal(JSON.stringify(state.documentModel), beforeKey, 'modal keyboard input must not alter the background draft')
    state.documentModel.name = 'newer edit'
    state.confirmTemplateFieldImport(pending)
    assert.equal(state.documentModel.name, 'newer edit')
    assert.equal(state.templateFieldImport, null)
    assert.match(state.status.text, /草稿已改变/)
    await load()
    state.templateMapping['connections:old'] = 'db'
    state.confirmTemplateImport()
    const rows = templateFieldBindings(state.templateFieldImport.document)
    rows[0].target = { ...rows[0].source, table: 'target_table', field: 'target_field' }
    state.confirmTemplateFieldImport(applyTemplateFieldBindings(state.templateFieldImport.document, rows))
    let saved
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => { saved = JSON.parse(JSON.stringify(document)); return { revision: 2, document: saved } })
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => {
      assert.equal(saved.widgets.find(widget => widget.id === 'mapped').data.datasets[0].field, 'target_field')
      assert.equal(saved.widgets.find(widget => widget.id === 'mapped').data.datasets[0].connectionId, 'db')
      return { release: { id: 'mapped-release', version: '1.0.2' } }
    })
    await state.publishVersion()
    assert.equal(publish.mock.callCount(), 1)
})

test('project bundle drafts enter data rebinding directly while current factory IDs are preselected', async t => {
    const { instance } = fixture(t, [{ id: 'configured-db', type: 'sqlite' }])
    await settle()
    const state = instance.value.$.setupState
    state.devices = [{ id: 'imported-device', name: '迁入设备' }]
    state.points = [{ id: 'imported-point', device_id: 'imported-device', name: 'temperature', category: 'analog' }]
    state.documentModel = normalizeDashboardDocument({ widgets: [
        { id: 'plc', type: 'value', data: { mode: 'plc', deviceId: 'imported-device', pointId: 'imported-point' } },
        { id: 'metric', type: 'value', data: { mode: 'database', connectionId: 'unconfigured_migration_a', datasets: [{ connectionId: 'unconfigured_migration_a', table: 'source_table', field: 'temp' }] } }
    ] })
    const before = JSON.stringify(state.documentModel)
    state.rebindCurrentTemplate()
    assert.equal(state.templateMapping['devices:imported-device'], 'imported-device')
    assert.equal(state.templateMapping['points:imported-point'], 'imported-point')
    assert.equal(state.templateMapping['connections:unconfigured_migration_a'], undefined)
    state.confirmTemplateImport()
    assert.match(state.templateImport.error, /选择/)
    assert.equal(JSON.stringify(state.documentModel), before)
    state.templateMapping['connections:unconfigured_migration_a'] = 'configured-db'
    state.confirmTemplateImport()
    assert.ok(state.templateFieldImport)
    const bindings = templateFieldBindings(state.templateFieldImport.document)
    assert.equal(bindings[0].source.connectionId, 'configured-db')
    bindings[0].target = { ...bindings[0].source, table: 'target_table', field: 'temperature' }
    state.confirmTemplateFieldImport(applyTemplateFieldBindings(state.templateFieldImport.document, bindings))
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'plc').data.pointId, 'imported-point')
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'metric').data.datasets[0].field, 'temperature')
    state.undo()
    assert.equal(JSON.stringify(state.documentModel), before)
})

test('view targets and focus actions map to the new hierarchy without changing internal view IDs', () => {
    const document = normalizeDashboardDocument({ scene: { views: [{ id: 'custom', targetType: 'line', targetId: 'old-line' }] }, widgets: [
        { id: 'label', type: 'text', content: { deviceIds: ['old-device'] }, visibility: { rules: [{ source: 'context', path: 'deviceId', operator: '==', value: 'old-device' }] }, events: [{ action: 'focus_workshop', workshopId: 'old-workshop' }, { action: 'switch_view', viewId: 'custom' }] }
    ] })
    const mapped = rebindDashboardTemplate(document, { 'lines:old-line': 'new-line', 'workshops:old-workshop': 'new-workshop', 'devices:old-device': 'new-device' }, { lines: [{ id: 'new-line' }], workshops: [{ id: 'new-workshop' }], devices: [{ id: 'new-device' }] })
    assert.equal(mapped.scene.views.find(view => view.id === 'custom').targetId, 'new-line')
    assert.equal(mapped.widgets.find(widget => widget.id === 'label').events[0].workshopId, 'new-workshop')
    assert.equal(mapped.widgets.find(widget => widget.id === 'label').events[1].viewId, 'custom')
    assert.deepEqual(mapped.widgets.find(widget => widget.id === 'label').content.deviceIds, ['new-device'])
    assert.equal(mapped.widgets.find(widget => widget.id === 'label').visibility.rules[0].value, 'new-device')
})

test('publish success reports the saved release without claiming an unacknowledged runtime update', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => ({ revision: 2, document }))
    t.mock.method(adminApi, 'publishDashboard', async () => ({ release: { id: 'release-test', version: '1.0.1' } }))
    await state.publishVersion()
    assert.match(state.status.text, /1\.0\.1 已发布/)
    assert.doesNotMatch(state.status.text, /已收到更新/)
    assert.match(state.status.text, /连接后将加载/)
    assert.equal(state.publishNotice.tone, 'success')
    assert.match(state.publishNotice.text, /保存并发布成功.*1\.0\.1/)
})

test('publish errors produce a dismissible failure notice and a later retry replaces it with success', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    let attempts = 0
    t.mock.method(adminApi, 'publishDashboard', async () => {
        if (++attempts === 1) throw Error('服务器暂不可用')
        return { release:{id:'retry-release',version:'1.0.3'} }
    })
    await state.publishVersion()
    assert.equal(state.publishing,false)
    assert.equal(state.publishNotice.tone,'error')
    assert.match(state.publishNotice.text,/发布失败.*服务器暂不可用/)
    state.clearPublishNotice();assert.equal(state.publishNotice,null)
    await state.publishVersion()
    assert.equal(state.publishNotice.tone,'success')
    assert.match(state.publishNotice.text,/1\.0\.3/)
    state.deactivateDesigner();assert.equal(state.publishNotice,null)
})

test('edits during the save stage show not-published feedback and never a false success', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState, pending=deferred()
    let submitted
    t.mock.method(adminApi,'saveDashboardDraft',async(_id,document)=>{submitted=JSON.parse(JSON.stringify(document));return pending.promise})
    const publish=t.mock.method(adminApi,'publishDashboard',async()=>{throw Error('must not publish')})
    state.documentModel.name='保存前'
    const saving=state.publishVersion();await settle()
    state.documentModel.name='保存期间的新修改'
    pending.resolve({revision:2,document:submitted});await saving
    assert.equal(publish.mock.callCount(),0)
    assert.equal(state.isDirty,true)
    assert.equal(state.publishNotice.tone,'warning')
    assert.match(state.publishNotice.text,/尚未发布/)
})

test('canvas resolution follows template import and undo instead of retaining the last preset', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const text = exportDashboardTemplate(state.documentModel)
    state.canvasPreset = '2560x1440'
    state.applyCanvasPreset()
    assert.equal(state.canvasPreset, '2560x1440')
    await state.loadTemplateFile({ target: { files: [{ size: text.length, text: async () => text }], value: '' } })
    assert.equal(state.canvasPreset, '1920x1080')
    state.undo()
    assert.equal(state.canvasPreset, '2560x1440')
})

test('designer keeps all database types but excludes both HTTP API discriminators from all database selectors', async t => {
    const sources = [
        { id: 'primary', type: 'mysql', sourceType: 'database', primary: true },
        ...['mysql', 'postgres', 'sqlserver', 'sqlite'].map(type => ({ id: `legacy_${type}`, type })),
        { id: 'api', sourceType: 'http_api', type: 'http_api' },
        { id: 'api_type_only', type: 'http_api' },
        { id: 'api_source_type_only', sourceType: 'http_api' }
    ]
    const { instance } = fixture(t, sources)
    await settle()
    await nextTick()
    const state = instance.value.$.setupState
    assert.equal(state.loading, false)
    assert.notEqual(state.status.tone, 'danger')
    assert.deepEqual(state.dataSources.map(source => source.id), ['primary', 'legacy_mysql', 'legacy_postgres', 'legacy_sqlserver', 'legacy_sqlite'])
    assert.deepEqual(state.httpApiSources.map(source => source.id), ['api', 'api_type_only', 'api_source_type_only'])
    assert.equal(sources.length, 8, 'filtering must not mutate the API result')

    // Both ordinary datasets and business components share this filtered list.
    const selectors = descriptor.template.content.match(/<select\b[^>]*v-model="(?:dataset|selectedWidget\.data)\.connectionId"[^>]*>[\s\S]*?<\/select>/g)
    assert.equal(selectors?.length, 3)
    assert.equal(selectors.filter(selector => selector.includes('v-for="source in dataSources"')).length, 2)
    assert.equal(selectors.filter(selector => selector.includes('v-for="source in httpApiSources"')).length, 1)
})

test('an empty or malformed data-source response does not break designer loading', async t => {
    const { instance } = fixture(t, null)
    await settle()
    await nextTick()
    const state = instance.value.$.setupState
    assert.deepEqual(state.dataSources, [])
    assert.notEqual(state.status.tone, 'danger')
})

test('HUD preset adds an isolated view without changing the existing view or default', async t => {
    const { instance } = fixture(t, [])
    await settle()
    await nextTick()
    const state = instance.value.$.setupState
    const beforeWidgets = JSON.stringify(state.documentModel.widgets)
    const beforeViews = JSON.stringify(state.documentModel.scene.views)
    const defaultView = state.documentModel.scene.defaultViewId
    state.addWidgetPreset({ id: 'factory_hud_modules', label: '工厂总览 HUD 模块' })
    assert.equal(state.documentModel.scene.defaultViewId, defaultView)
    assert.equal(JSON.stringify(state.documentModel.widgets.slice(0,-4)), beforeWidgets)
    assert.equal(JSON.stringify(state.documentModel.scene.views.slice(0,-1)), beforeViews)
    const view = state.documentModel.scene.views.at(-1)
    assert.equal(view.id, 'factory_hud_modules')
    assert.deepEqual(view.componentState.show, state.documentModel.widgets.slice(-4).map(widget => widget.id))
    const count = state.documentModel.widgets.length
    state.addWidgetPreset({ id: 'factory_hud_modules', label: '工厂总览 HUD 模块' })
    assert.equal(state.documentModel.widgets.length, count, 'repeated click should focus, not duplicate')
})


test('designer previews real backend point records and clears cached healthy values after a failed read',async t=>{
 const {instance}=fixture(t,[]);await settle();const state=instance.value.$.setupState
 state.designerActive=true
 t.mock.method(adminApi,'getRealtimePointValues',async()=>({sourceMode:'simulation',points:[{id:'p',device_id:'d',value:857.3,quality:'good',lastReadAt:12345}]}))
 await state.refreshRealtimePoints();assert.equal(state.pointValues['d:p'].value,857.3);assert.equal(state.pointSourceMode,'simulation');assert.equal(state.pointValues.p.lastReadAt,12345)
 t.mock.method(adminApi,'getRealtimePointValues',async()=>{throw Error('engine disconnected')})
 await state.refreshRealtimePoints();assert.equal(state.pointValues.p.value,null);assert.equal(state.pointValues.p.quality,'bad');assert.equal(state.pointReadError,'engine disconnected')
 const source=await readFile(sourceUrl,'utf8');assert.doesNotMatch(source,/const mock(?:Metrics|Trend|DeviceStatus|BusinessData|Events)/)
})


test('changing a fixed source device resolves that device point and clearing a binding really stays empty',async t=>{
 const {instance}=fixture(t,[]);await settle();const state=instance.value.$.setupState
 state.devices=[{id:'a'},{id:'b'},{id:'empty'}];state.points=[{id:'pa',device_id:'a',category:'analog',value_role:'temp',unit:'°C'},{id:'pb',device_id:'b',category:'analog',value_role:'temp',unit:'°C'}]
 state.documentModel.widgets=[{id:'chart',type:'trend',data:{mode:'plc',deviceScope:'fixed',deviceId:'a',pointId:'pa',pointKey:'analog.temp'},visibility:{}}];state.selectedIds=['chart']
 state.previewBindingDevice('b');assert.equal(state.selectedWidget.data.pointId,'pb');assert.equal(state.selectedWidget.data.deviceId,'b');assert.equal(state.selectedWidget.visibility.matchBoundDevice,false)
 state.bindSelectedPoint('');assert.equal(state.selectedWidget.data.pointId,'');assert.equal(state.selectedWidget.data.pointKey,'');assert.equal(state.selectedWidget.data.path,'')
 state.previewBindingDevice('empty');assert.equal(state.selectedWidget.data.pointId,'')
})


test('global map HTTP preview reads without any device catalog and passes the selected region context',async t=>{
 const {instance}=fixture(t,[]);await settle();const state=instance.value.$.setupState
 state.devices=[];state.previewContext.regionCode='120000';state.previewContext.regionLevel='province'
 const widget={id:'global_map',type:'value',data:{mode:'http_api',deviceScope:'global',connectionId:'owned',apiPath:'/counts/{regionCode}',jsonPath:'count'}}
 state.documentModel.widgets.push(widget)
 let context
 await state.previewExternalBinding(widget,async c=>{context=c;return {result:{value:42,quality:'good'}}})
 assert.equal(context.deviceId,'');assert.equal(context.regionCode,'120000');assert.equal(context.regionLevel,'province');assert.equal(state.databasePreviewValues.global_map.value,42)
})

test('fullscreen preview holds a hovered device while its readings and neighboring devices keep refreshing', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0)
  const calls = []
  t.mock.method(adminApi, 'previewDataSet', async payload => {
    calls.push(payload.context.deviceId)
    return { result: { value: calls.length, rows: [], quality: 'good' } }
  })
  const data = { mode: 'dataset', datasetId: 'owned', datasetField: 'temperature', deviceScope: 'rotation', rotationDeviceIds: ['a', 'b'], rotationIntervalMs: 2000, refreshMs: 1000 }
  const { state, widget } = await canvasSelectionFixture(t, [
    { id: 'held', type: 'trend', data }, { id: 'peer', type: 'value', data }
  ])
  state.devices = [{ id: 'a', name: '设备 A' }, { id: 'b', name: '设备 B' }]
  state.playbackNow = 1000
  await state.enterPreviewMode()
  assert.equal(state.databasePreviewValues.held.deviceId, 'a')
  state.playbackController.setHovered(widget('held'), true, 1000)
  state.playbackNow = 3000
  await nextTick(); await settle()
  assert.equal(state.previewDevice(widget('held')).id, 'a')
  assert.equal(state.databasePreviewValues.held.deviceId, 'a')
  assert.equal(state.databasePreviewValues.peer.deviceId, 'b')
  const heldValue = state.databasePreviewValues.held.value
  state.playbackNow = 5000
  await nextTick(); await settle()
  assert.equal(state.databasePreviewValues.held.deviceId, 'a')
  assert.ok(state.databasePreviewValues.held.value > heldValue)
  assert.equal(state.databasePreviewValues.held.deviceName, '设备 A')
  state.playbackController.setHovered(widget('held'), false, 5000)
  assert.equal(state.previewDevice(widget('held')).id, 'a')
  state.playbackNow = 5999
  assert.equal(state.previewDevice(widget('held')).id, 'a')
  state.playbackNow = 6000
  assert.equal(state.previewDevice(widget('held')).id, 'b')
})

test('leaving fullscreen or changing preview scope clears the previous hover pause', async t => {
  t.mock.method(globalThis, 'setInterval', () => 0)
  const { state, widget } = await canvasSelectionFixture(t, [{ id: 'held', type: 'trend', data: { mode: 'plc', deviceScope: 'rotation', rotationDeviceIds: ['a', 'b'], rotationIntervalMs: 2000 } }])
  state.devices = [{ id: 'a' }, { id: 'b' }]
  state.previewMode = true
  state.playbackNow = 1000
  state.playbackController.setHovered(widget('held'), true, 1000)
  state.playbackNow = 3000
  assert.equal(state.previewDevice(widget('held')).id, 'a')
  state.previewMode = false
  state.previewMode = true
  assert.equal(state.previewDevice(widget('held')).id, 'b')
  state.playbackController.setHovered(widget('held'), true, 3000)
  state.playbackNow = 4000
  assert.equal(state.previewDevice(widget('held')).id, 'b')
  state.previewContext.viewId = 'workshop_overview'
  assert.equal(state.previewDevice(widget('held')).id, 'a')
  state.playbackController.setHovered(widget('held'), true, 4000)
  state.deactivateDesigner()
  assert.equal(state.playbackController.timeFor(widget('held'), 120000), 120000)
})

test('ordinary catalog binding cleans source-specific fields, keeps a fixed actual device and is one undoable operation', async t => {
    const authenticated = adminSession.authenticated, permissions = adminSession.pagePermissions
    t.after(() => { adminSession.authenticated = authenticated; adminSession.pagePermissions = permissions })
    adminSession.authenticated = true
    adminSession.pagePermissions = { 'platform.designer': { view: true, edit: true } }
    const { state, widget } = await canvasSelectionFixture(t, [{ id: 'a', type: 'text', content: { text: '原有固定标题' }, data: { mode: 'static', connectionId: 'old-http', jsonPath: 'old.path' } }])
    const originalMode = widget('a').data.mode
    state.selectedIds = ['a']
    state.chooseCatalogData({ id: 'real-temperature', label: '炉温', unit: '℃', type: 'number', objectScope: 'device', sourceType: 'plc',
        binding: { mode: 'plc', deviceScope: 'fixed', deviceId: 'actual-device', pointId: 'real-point', pointKey: 'analog.temp', path: 'analog.temp', requireConfiguredPoint: true } })
    assert.equal(widget('a').data.mode, 'plc')
    assert.equal(widget('a').data.deviceId, 'actual-device')
    assert.equal(widget('a').data.pointId, 'real-point')
    assert.equal(widget('a').data.unit, '℃')
    assert.equal(widget('a').data.connectionId, undefined)
    assert.equal(widget('a').data.jsonPath, undefined)
    assert.equal(widget('a').content.text, '{value}{unit}')
    assert.equal(state.history.length, 2)
    state.undo()
    assert.equal(widget('a').data.mode, originalMode, 'undo restores the original normalized binding, including legacy migration')
    assert.equal(widget('a').content.text, '原有固定标题')
    state.redo()
    assert.equal(widget('a').data.pointKey, 'analog.temp')
})

test('catalog choices obey edit permissions and do not allow metadata to replace a numerical trend', async t => {
    const authenticated = adminSession.authenticated, permissions = adminSession.pagePermissions
    t.after(() => { adminSession.authenticated = authenticated; adminSession.pagePermissions = permissions })
    adminSession.authenticated = true
    adminSession.pagePermissions = { 'platform.designer': { view: true, edit: false } }
    const { state, widget } = await canvasSelectionFixture(t, [{ id: 'a', type: 'trend' }])
    state.selectedIds = ['a']
    const before = JSON.stringify(widget('a'))
    const point = { type: 'number', binding: { mode: 'plc', pointKey: 'analog.temp', deviceScope: 'fixed', deviceId: 'actual', pointId: 'p' } }
    state.chooseCatalogData(point)
    assert.equal(JSON.stringify(widget('a')), before)
    adminSession.pagePermissions['platform.designer'].edit = true
    state.chooseCatalogData({ type: 'string', binding: { mode: 'runtime', path: 'deviceInfo.name' } })
    assert.equal(JSON.stringify(widget('a')), before)
    assert.equal(state.history.length, 1)
    state.chooseCatalogData(point)
    assert.equal(widget('a').data.mode, 'plc')
    assert.equal(state.history.length, 2)
})
