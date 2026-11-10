import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref, watch } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { deferred, installBrowser, installSockets, json, settle } from './helpers.mjs'
import { exportDashboardTemplate, importDashboardTemplate, dashboardTemplateReferences, rebindDashboardTemplate } from '../src/runtime/dashboardTemplate.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { widgetBindingChoices, DATASET_WIDGETS, POINT_WIDGETS } from '../src/runtime/widgetBindingChoices.js'
import { bindingReferenceDiagnostics } from '../src/runtime/bindingReferenceDiagnostics.js'
import { applyTemplateFieldBindings, templateFieldBindings } from '../src/runtime/templateFieldMapping.js'
import { cacheFactoryDraft, clearFactoryDraft, readFactoryDraft } from '../src/runtime/factoryDraftCache.js'
import { approvedOverviewFixture } from './fixtures/approved-overview.mjs'
import { legacyWorkflow } from '../../shared/widgetBindingWorkflow.mjs'

// Run the real SFC setup/load path; child renderers are irrelevant to the source
// selection and are stubbed so no canvas, GL context or browser is required.
const sourceUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
const originalFetch = globalThis.fetch
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
const pickerUrl = new URL('../src/views/admin/components/DataCatalogPicker.vue', import.meta.url)
const pickerDescriptor = parse(await readFile(pickerUrl, 'utf8')).descriptor
let pickerCompiled = compileScript(pickerDescriptor, { id: 'designer-catalog-reference-test' }).content
for (const match of [...pickerCompiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const name = match[2], target = name.startsWith('.') ? new URL(name, pickerUrl).href : import.meta.resolve(name)
    pickerCompiled = pickerCompiled.replace(match[0], `from ${JSON.stringify(target)}`)
}
const { default: CatalogPicker } = await import(`data:text/javascript;base64,${Buffer.from(pickerCompiled).toString('base64')}`)
CatalogPicker.render = () => null

function fixture(t, connections, { factoryId = '', storage, designerState, datasetState } = {}) {
    const environment = installBrowser(t)
    const sockets = installSockets(environment.replace)
    const fetchRequests = []
    // Keep explicit per-test fetch mocks, but otherwise seal the real store's
    // polling/preview transport. A late localhost 401 can revoke adminSession
    // even after its originating store was disposed by a previous fixture.
    if (globalThis.fetch === originalFetch) environment.replace('fetch', async input => {
        fetchRequests.push(String(input instanceof Request ? input.url : input))
        return json({ success: true, result: { quality: 'good', value: 0, rows: [] } })
    })
    environment.browser.cancelAnimationFrame = () => {}
    environment.browser.requestAnimationFrame = () => 0
    environment.replace('ResizeObserver', class { observe() {} disconnect() {} })
    const local = storage || { getItem: key => key === 'digital_twin_factory_scope_v1' ? factoryId : null, setItem() {}, removeItem() {} }
    environment.replace('localStorage', local)
    environment.browser.localStorage = local
    t.mock.method(adminApi, 'getDashboardDesigner', async () => designerState || ({ revision: 1, document: {} }))
    for (const method of ['getDevices', 'getDataPoints', 'getWorkshops', 'getLines']) t.mock.method(adminApi, method, async () => [])
    t.mock.method(adminApi, 'getRealtimePointValues', async () => ({ points: [] }))
    t.mock.method(adminApi, 'getDataSources', async () => ({ connections }))
    // Dataset loading is part of the real startup Promise.all too. Never let a
    // unit fixture race an actual localhost request (or the next fixture).
    t.mock.method(adminApi, 'getDataSets', async () => datasetState || ({ datasets: [] }))
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
    const ready = async () => {
        const state = instance.value.$.setupState
        if (state.loading) await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                stop()
                reject(new Error(`Designer fixture startup timed out: ${state.status.text}`))
            }, 10000)
            const stop = watch(() => state.loading, loading => {
                if (loading) return
                clearTimeout(timeout)
                stop()
                resolve()
            }, { flush: 'post' })
        })
        await nextTick()
    }
    return { instance, browser: environment.browser, app, renderer, ready, sockets, fetchRequests, beforeRestore: environment.beforeRestore }
}

function pointerEvent(overrides = {}) {
    return { button: 0, pointerId: 7, detail: 1, clientX: 100, clientY: 100,
        preventDefault() {}, stopPropagation() {}, ...overrides }
}

async function canvasSelectionFixture(t, widgets = [], options = {}) {
    const { instance, browser, ready } = fixture(t, [], options)
    await ready()
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

test('canvas fixtures wait for the completed startup load before replacing the document and selection', async t => {
    const pending = deferred()
    t.after(() => pending.resolve({ datasets: [] }))
    let prepared = false
    const preparing = canvasSelectionFixture(t, [{ id: 'after-startup', type: 'text' }], { datasetState: pending.promise })
        .then(result => { prepared = true; return result })
    await settle()
    assert.equal(prepared, false, 'one event-loop turn is not a completed-load barrier')
    pending.resolve({ datasets: [] })
    const { state, widget } = await preparing
    assert.equal(state.loading, false)
    assert.equal(widget('after-startup').id, 'after-startup')
    state.selectedIds = ['after-startup']
    await nextTick(); await settle()
    assert.deepEqual(state.selectedIds, ['after-startup'])
    assert.deepEqual(state.documentModel.widgets.map(item => item.id), ['after-startup'])
})

test('designer fixture polling uses isolated HTTP and socket transports instead of a live localhost session', async t => {
    const timers = []
    t.mock.method(globalThis, 'setInterval', (callback, delay) => { timers.push({ callback, delay }); return timers.length })
    t.mock.method(globalThis, 'clearInterval', () => {})
    const { ready, sockets, fetchRequests } = fixture(t, [])
    await ready()
    assert.equal(sockets.length, 1)
    assert.equal(sockets[0].readyState, 0, 'the fixture does not open a real socket')
    assert.notEqual(globalThis.fetch, originalFetch)
    for (const timer of timers.filter(timer => timer.delay === 1000)) timer.callback()
    await settle()
    assert.ok(fetchRequests.some(url => new URL(url).pathname.endsWith('/platform/metrics/latest')))
    assert.ok(fetchRequests.some(url => new URL(url).pathname.endsWith('/health')))
})

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
    await settle()
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
    assert.equal(state.diagnosticTarget.id, 'business_b')
    assert.equal(state.diagnosticFocus.isTooltip, false)
    assert.ok(Number.parseFloat(state.diagnosticFrameStyle.borderWidth) * state.zoom >= 2.5)
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
    assert.equal(state.diagnosticTarget, null)
    assert.equal(state.diagnosticFocus.templateId, template.id)
    assert.equal(state.diagnosticFocus.widgetId, template.widgets[0].id)
    assert.equal(state.diagnosticFocus.isTooltip, true)
    const markup = descriptor.template.content
    assert.match(markup, /aria-label="组件配置问题"/)
    assert.match(markup, /@click="locateValidationIssue\(issue\)"/)
})

test('diagnostic overlay locates a hidden locked target without revealing it or changing its authoring', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [{
        id: 'hidden_problem', type: 'text', visible: false, locked: true,
        frame: { x: 900, y: 700, width: 200, height: 80, rotation: 12 },
        visibility: { viewIds: ['workshop_overview'], rules: [{ source: 'context', path: 'deviceId', operator: '==', value: 'not_current' }] }
    }] }).widgets
    state.setValidationIssues(['组件 hidden_problem 绑定的设备不存在：not_current'], 'reference')
    const before = JSON.stringify(state.documentModel)
    const calls = [], ancestorScrolls = []
    const scroll = {
        scrollLeft: 0, scrollTop: 0, clientWidth: 400, clientHeight: 300,
        scrollWidth: 400, scrollHeight: 300,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300 }),
        querySelectorAll: selector => selector === '[data-diagnostic-widget-id]' ? [{
            dataset: { diagnosticWidgetId: 'hidden_problem' },
            scrollIntoView: value => ancestorScrolls.push(value),
            getBoundingClientRect: () => ({ left: 900, top: 700, right: 1100, bottom: 780, width: 200, height: 80 })
        }] : [],
        scrollTo: value => calls.push(value)
    }
    state.viewportRef = { querySelector: () => scroll }
    await state.locateValidationIssue(state.validationIssues[0])
    await settle()
    assert.equal(state.diagnosticTarget.id, 'hidden_problem')
    assert.equal(state.canvasWidgets.some(widget => widget.id === 'hidden_problem'), false)
    assert.equal(state.diagnosticTargetHidden, true)
    assert.equal(state.diagnosticFrameStyle.opacity, 1)
    assert.equal(state.diagnosticFrameStyle.transform, 'rotate(12deg)')
    for (const zoom of [.25, .5, .75, 1, 1.25, 1.5, 1.75, 2.5]) {
        state.zoom = zoom
        const border = Number.parseFloat(state.diagnosticFrameStyle.borderWidth)
        assert.equal(border, Math.ceil(2.5 / zoom))
        assert.ok(Math.floor(border) * zoom >= 2.5)
        assert.ok(border * zoom < 2.5 + zoom)
    }
    assert.deepEqual(calls.at(-1), { left: 800, top: 590, behavior: 'auto' })
    assert.ok(ancestorScrolls.length >= 1)
    for (const options of ancestorScrolls) assert.deepEqual(options, { block: 'nearest', inline: 'nearest', behavior: 'auto' })
    assert.equal(JSON.stringify(state.documentModel), before)
    assert.match(state.status.text, /隐藏.*原显隐设置未改变/)
})

test('a diagnostic already visible inside the canvas still reveals outer page ancestors while ordinary selection does not', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [
        { id: 'outer_page_problem', type: 'text', visibility: { viewIds: ['workshop_overview'] } }
    ] }).widgets
    state.setValidationIssues(['组件 outer_page_problem 绑定的设备不存在：missing'], 'reference')
    const calls = [], ancestorScrolls = []
    const element = { dataset: { diagnosticWidgetId: 'outer_page_problem', widgetId: 'outer_page_problem' },
        getBoundingClientRect: () => ({ left: 100, top: 900, right: 300, bottom: 980, width: 200, height: 80 }),
        scrollIntoView: value => ancestorScrolls.push(value) }
    const scroll = { scrollLeft: 0, scrollTop: 0, clientWidth: 400, clientHeight: 300,
        scrollWidth: 400, scrollHeight: 300,
        getBoundingClientRect: () => ({ left: 0, top: 850, right: 400, bottom: 1150 }),
        querySelectorAll: () => [element], scrollTo: value => calls.push(value) }
    state.viewportRef = { querySelector: () => scroll }
    await state.locateValidationIssue(state.validationIssues[0])
    await settle()
    assert.deepEqual(calls, [])
    assert.ok(ancestorScrolls.length >= 1)
    for (const options of ancestorScrolls) assert.deepEqual(options, { block: 'nearest', inline: 'nearest', behavior: 'auto' })
    const diagnosticScrollCount = ancestorScrolls.length
    state.selectWidget(state.documentModel.widgets[0], {}, { focusCanvas: true })
    await settle()
    assert.equal(ancestorScrolls.length, diagnosticScrollCount)
})

test('diagnostic focus clears with other selections, contexts, repaired issues and deletion; repeats target only the last request', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [
        { id: 'problem_a', type: 'text', visibility: { viewIds: ['workshop_overview'] } },
        { id: 'problem_b', type: 'text', visibility: { viewIds: ['workshop_overview'] } }
    ] }).widgets
    state.setValidationIssues(['组件 problem_a 绑定的设备不存在：a', '组件 problem_b 绑定的设备不存在：b'], 'reference')
    const [a, b] = state.validationIssues
    await state.locateValidationIssue(a)
    const firstSequence = state.diagnosticFocus.sequence
    state.selectedIds = ['problem_b']
    assert.equal(state.diagnosticFocus, null)
    await state.locateValidationIssue(a)
    assert.ok(state.diagnosticFocus.sequence > firstSequence)
    await Promise.all([state.locateValidationIssue(a), state.locateValidationIssue(b)])
    assert.equal(state.diagnosticTarget.id, 'problem_b')
    state.setValidationIssues(['组件 problem_a 绑定的设备不存在：a'], 'reference')
    assert.equal(state.diagnosticFocus, null)
    await state.locateValidationIssue(a)
    state.editorDeviceId = 'another_device'
    assert.equal(state.diagnosticFocus, null)
    await state.locateValidationIssue(a)
    state.documentModel.widgets = state.documentModel.widgets.filter(widget => widget.id !== 'problem_a')
    assert.equal(state.diagnosticFocus, null)
})

test('late center and fitted-mode callbacks retain the diagnostic location until normal selection clears it', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [
        { id: 'late_fit_problem', type: 'text', visibility: { viewIds: ['workshop_overview'] } },
        { id: 'ordinary_after_fit', type: 'text', visibility: { viewIds: ['workshop_overview'] } }
    ] }).widgets
    state.setValidationIssues(['组件 late_fit_problem 绑定的设备不存在：missing'], 'reference')
    const ancestorScrolls = []
    const scroll = { scrollLeft: 0, scrollTop: 0, clientWidth: 400, clientHeight: 300,
        scrollWidth: 2000, scrollHeight: 4000,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300 }),
        scrollTo({ left, top }) { this.scrollLeft = left; this.scrollTop = top },
        querySelectorAll: () => [{ dataset: { diagnosticWidgetId: 'late_fit_problem' },
            getBoundingClientRect: () => ({ left: 900 - scroll.scrollLeft, top: 1400 - scroll.scrollTop,
                right: 1100 - scroll.scrollLeft, bottom: 1480 - scroll.scrollTop, width: 200, height: 80 }),
            scrollIntoView: value => ancestorScrolls.push(value) }] }
    state.viewportRef = { querySelector: () => scroll }
    state.designerMode = 'tooltips'
    await state.locateValidationIssue(state.validationIssues[0])
    await settle()
    assert.equal(scroll.scrollLeft, 800)
    assert.equal(scroll.scrollTop, 1290)
    state.centerCanvas()
    await settle()
    assert.equal(scroll.scrollTop, 1290)
    state.fitCanvas('comfortable')
    await settle()
    assert.equal(scroll.scrollTop, 1290)
    assert.ok(ancestorScrolls.length >= 3)
    state.selectedIds = ['ordinary_after_fit']
    state.centerCanvas()
    await settle()
    assert.equal(scroll.scrollTop, 1850)
    assert.equal(state.diagnosticFocus, null)
})

test('manual device or editor-mode changes cancel a pending diagnostic request before it restores a stale red frame', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = normalizeDashboardDocument({ widgets: [
        { id: 'pending_problem', type: 'text', visibility: { viewIds: ['workshop_overview'] } }
    ] }).widgets
    state.setValidationIssues(['组件 pending_problem 绑定的设备不存在：missing'], 'reference')
    const issue = state.validationIssues[0]
    const deviceRequest = state.locateValidationIssue(issue)
    state.editorDeviceId = 'manually_chosen_device'
    await deviceRequest
    assert.equal(state.diagnosticFocus, null)
    assert.equal(state.diagnosticTarget, null)

    const modeRequest = state.locateValidationIssue(issue)
    state.designerMode = 'tooltips'
    await modeRequest
    assert.equal(state.diagnosticFocus, null)

    const owner = state.documentModel.tooltipTemplates.templates[0]
    state.setValidationIssues([`悬停模板“${owner.name}”：第 1 个组件 尺寸不合法`])
    const tooltipRequest = state.locateValidationIssue(state.validationIssues[0])
    state.designerMode = 'layout'
    await tooltipRequest
    assert.equal(state.diagnosticFocus, null)
    assert.equal(state.diagnosticTarget, null)
})

test('diagnostic framing is a separate pointer-transparent red dashed presentation layer, not widget styling', () => {
    const markup = descriptor.template.content, css = descriptor.styles.map(style => style.content).join('\n')
    assert.match(markup, /class="designer-diagnostic-frame"/)
    assert.match(markup, /:data-diagnostic-widget-id="diagnosticTarget.id"/)
    assert.match(markup, /:diagnostic-focus="diagnosticFocus\?\.isTooltip \? diagnosticFocus : null"/)
    assert.match(css, /\.designer-diagnostic-frame\{[^}]*border-style:dashed[^}]*border-color:#ff4d4f[^}]*pointer-events:none/)
    assert.match(css, /\.designer-widget\.selected::after\{border:2px solid #43b9ff/)
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
    // This success fixture has no catalog; do not leave default PLC demo
    // references pointing at devices that this fixture says do not exist.
    state.documentModel.widgets = []
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

test('actual new widget, copy and HUD preset paths avoid existing ID collisions without repairing any loaded duplicate', async t => {
    const { state } = await canvasSelectionFixture(t, [
        { id: 'hud_factory_kpi', type: 'value', content: { value: 1 } },
        { id: 'hud_factory_kpi', type: 'value', content: { value: 2 } },
        { id: 'hud_factory_devices', type: 'value' },
        { id: 'hud_factory_alarms', type: 'value' },
        { id: 'hud_factory_trend', type: 'value' }
    ])
    t.mock.method(Date, 'now', () => 123456789)
    const original = JSON.parse(JSON.stringify(state.documentModel.widgets))
    const originalCount = original.length
    state.addWidget('value')
    state.addWidget('value')
    state.selectedIds = [state.documentModel.widgets[originalCount].id]
    state.copySelected()
    state.selectedIds = [state.documentModel.widgets[originalCount].id]
    state.copySelected()
    state.addWidgetPreset({ id: 'factory_hud_modules', label: '工厂 HUD' })
    assert.deepEqual(JSON.parse(JSON.stringify(state.documentModel.widgets.slice(0, originalCount))), original)
    const additions = state.documentModel.widgets.slice(originalCount)
    assert.equal(additions.length, 8)
    assert.equal(new Set(additions.map(widget => widget.id)).size, 8)
    assert.ok(additions.every(widget => !original.some(existing => existing.id === widget.id)))
    assert.deepEqual(state.documentModel.scene.views.at(-1).componentState.show, additions.slice(-4).map(widget => widget.id))
    assert.equal(state.documentModel.widgets.filter(widget => widget.id === 'hud_factory_kpi').length, 2)
    assert.equal(state.selectedWidget, state.documentModel.widgets.at(-4), 'new preset focuses its first actual instance')
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

function staleReferenceDocument() {
    return normalizeDashboardDocument({ widgets: [{ id: 'cfg_device_trend_Furnace_03', type: 'trend',
        title: '炉温趋势', frame: { x: 83, y: 47, width: 520, height: 260 },
        data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'Furnace_03', pointId: '638', pointKey: 'analog.actual_temp', readOnly: true },
        visibility: { viewIds: ['factory_overview'], matchBoundDevice: true }, content: { text: '保留标题' }
    }] })
}

test('reference diagnostics are read-only and distinguish nested template components with the same ID', () => {
    const document = staleReferenceDocument()
    document.tooltipTemplates.templates = [{ id: 'tip', name: '设备提示', widgets: [JSON.parse(JSON.stringify(document.widgets[0]))] }]
    const before = JSON.stringify(document)
    const issues = bindingReferenceDiagnostics(document, [], [])
    assert.equal(issues.length, 4)
    assert.match(issues[0], /组件 cfg_device_trend_Furnace_03 绑定的设备不存在：Furnace_03（炉温趋势）/)
    assert.match(issues[1], /绑定的点位不存在：638/)
    assert.match(issues[2], /^悬停模板“设备提示”：组件 cfg_device_trend_Furnace_03/)
    assert.equal(JSON.stringify(document), before)
    assert.deepEqual(bindingReferenceDiagnostics(document, [{ id: 'Furnace_03' }], [{ id: 638 }]), [])
    const untitled = { widgets: [{ id: 'raw-id', type: 'trend', data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'gone' } }] }
    assert.match(bindingReferenceDiagnostics(untitled, [], [])[0], /（趋势图）/)
})

test('deleted-device refresh reports and locates the stale component without mutating layout or rebinding', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel = staleReferenceDocument()
    const before = JSON.stringify(state.documentModel), revision = state.revision
    state.pointValues = { 638: { id: 638, device_id: 'Furnace_03', value: 999, quality: 'good' } }
    t.mock.method(adminApi, 'getDevices', async () => [{ id: 'other', name: '其它设备' }])
    t.mock.method(adminApi, 'getDataPoints', async () => [{ id: 'new', device_id: 'other', category: 'analog', value_role: 'actual_temp', access_type: 'READ' }])
    assert.equal(await state.refreshBindingCatalog({ force: true }), true)
    await nextTick()
    assert.equal(JSON.stringify(state.documentModel), before)
    assert.equal(state.revision, revision)
    assert.equal(state.validationIssuePhase, 'reference')
    assert.equal(state.validationIssues.length, 2)
    assert.ok(state.validationIssues.every(issue => issue.widgetId === 'cfg_device_trend_Furnace_03'))
    assert.equal(state.pointValues[638], undefined)
    await state.locateValidationIssue(state.validationIssues[0])
    assert.deepEqual(state.selectedIds, ['cfg_device_trend_Furnace_03'])
    assert.equal(state.selectedBindingDeviceId, 'Furnace_03')
    assert.equal(state.editorDeviceId, 'Furnace_03')
    assert.equal(state.editorDevice, null)
    assert.equal(state.safeCatalogPreviewDeviceId, '')
    assert.equal(state.previewValueForWidget(state.selectedWidget), undefined)
    assert.equal(JSON.stringify(state.documentModel), before)
})

test('stale dynamic IDs save as warnings, survive normalization, and clear only after explicit repair or removal', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel = staleReferenceDocument()
    state.selectedIds = ['cfg_device_trend_Furnace_03']
    state.documentModel.name = '修改布局后的草稿'
    let submitted
    t.mock.method(adminApi, 'saveDashboardDraft', async (_id, document) => {
        submitted = JSON.parse(JSON.stringify(document))
        return { revision: 136, document, warnings: bindingReferenceDiagnostics(document, [], []) }
    })
    assert.equal(await state.saveDraft(), true)
    const saved = state.documentModel.widgets[0]
    assert.equal(submitted.widgets[0].data.deviceId, 'Furnace_03')
    assert.equal(saved.data.mode, 'plc')
    assert.equal(saved.data.deviceId, 'Furnace_03')
    assert.equal(saved.data.pointId, '638')
    assert.equal(saved.frame.x, 83)
    assert.equal(saved.content.text, '保留标题')
    assert.equal(state.revision, 136)
    assert.equal(state.validationIssuePhase, 'draft')
    assert.equal(state.validationIssues.length, 2)
    assert.match(state.status.text, /草稿已保存.*暂不能发布/)
    state.documentModel.widgets = []
    await nextTick()
    assert.equal(state.validationIssues.length, 0)
})

test('late catalog requests cannot replace newer metadata or update a deactivated or unmounted designer', async t => {
    const { instance, app } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel = staleReferenceDocument()
    const before = JSON.stringify(state.documentModel)
    const firstDevices = deferred(), firstPoints = deferred(), secondDevices = deferred(), secondPoints = deferred()
    let deviceCalls = 0, pointCalls = 0
    t.mock.method(adminApi, 'getDevices', () => ++deviceCalls === 1 ? firstDevices.promise : secondDevices.promise)
    t.mock.method(adminApi, 'getDataPoints', () => ++pointCalls === 1 ? firstPoints.promise : secondPoints.promise)
    const first = state.refreshBindingCatalog({ force: true }), second = state.refreshBindingCatalog({ force: true })
    secondDevices.resolve([{ id: 'current' }]); secondPoints.resolve([{ id: 'current-point', device_id: 'current', access_type: 'READ' }])
    assert.equal(await second, true)
    firstDevices.resolve([{ id: 'old' }]); firstPoints.resolve([{ id: 'old-point', device_id: 'old' }])
    assert.equal(await first, false)
    assert.equal(state.devices[0].id, 'current')
    assert.equal(state.points[0].id, 'current-point')
    assert.equal(JSON.stringify(state.documentModel), before)
    const inactiveDevices = deferred(), inactivePoints = deferred()
    t.mock.method(adminApi, 'getDevices', () => inactiveDevices.promise)
    t.mock.method(adminApi, 'getDataPoints', () => inactivePoints.promise)
    const inactive = state.refreshBindingCatalog({ force: true })
    state.deactivateDesigner()
    inactiveDevices.resolve([{ id: 'inactive' }]); inactivePoints.resolve([])
    assert.equal(await inactive, false)
    assert.equal(state.devices[0].id, 'current')
    const unmountedDevices = deferred(), unmountedPoints = deferred()
    t.mock.method(adminApi, 'getDevices', () => unmountedDevices.promise)
    t.mock.method(adminApi, 'getDataPoints', () => unmountedPoints.promise)
    state.activateDesigner()
    const unmounted = state.refreshBindingCatalog()
    app.unmount()
    unmountedDevices.resolve([{ id: 'unmounted' }]); unmountedPoints.resolve([])
    assert.equal(await unmounted, false)
    assert.equal(state.devices[0].id, 'current')
})

test('catalog failures retain the last complete directory and retry only after five seconds', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    const device = { id: 'Furnace_03' }, point = { id: 638, device_id: 'Furnace_03', access_type: 'READ' }
    state.documentModel = staleReferenceDocument()
    state.selectedIds = ['cfg_device_trend_Furnace_03']
    state.devices = [device]; state.points = [point]; state.bindingCatalogPoints = [point]
    let now = 100000
    t.mock.method(Date, 'now', () => now)
    const devicesRead = t.mock.method(adminApi, 'getDevices', async () => [{ id: 'not-a-complete-catalog' }])
    const pointsRead = t.mock.method(adminApi, 'getDataPoints', async () => { throw Error('暂时断开') })
    assert.equal(await state.refreshBindingCatalog({ force: true }), false)
    for (now = 101000; now <= 104000; now += 1000) { await state.refreshRealtimePoints(); await settle() }
    assert.equal(pointsRead.mock.callCount(), 1)
    assert.equal(devicesRead.mock.callCount(), 1)
    await state.refreshRealtimePoints(); await settle()
    assert.equal(pointsRead.mock.callCount(), 2)
    assert.equal(state.devices[0].id, 'Furnace_03')
    assert.equal(state.points[0].id, 638)
    assert.equal(state.safeCatalogPreviewDeviceId, 'Furnace_03', 'a failed directory cannot mark an existing reference as deleted')
    assert.equal(state.validationIssues.length, 0, 'empty realtime frames and failed metadata reads are not proof of deletion')
    assert.equal(state.documentModel.widgets[0].data.pointId, '638')
})

test('publishing locks before pending metadata preflight and releases on success and reference rejection', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel.widgets = []
    state.lastSavedSnapshot = state.snapshot()
    const devices = deferred(), points = deferred()
    const directory = t.mock.method(adminApi, 'getDevices', () => devices.promise)
    t.mock.method(adminApi, 'getDataPoints', () => points.promise)
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => ({ release: { id: 'one-release', version: '1.2.3' } }))
    const first = state.publishVersion(), second = state.publishVersion()
    assert.equal(state.publishing, true)
    assert.equal(directory.mock.callCount(), 1)
    assert.equal(publish.mock.callCount(), 0)
    devices.resolve([]); points.resolve([])
    await Promise.all([first, second])
    assert.equal(publish.mock.callCount(), 1)
    assert.equal(state.publishing, false)
    state.documentModel = staleReferenceDocument()
    state.lastSavedSnapshot = state.snapshot()
    state.validationIssuePhase = 'reference'
    await state.publishVersion()
    assert.equal(publish.mock.callCount(), 1)
    assert.equal(state.publishing, false)
    assert.equal(state.publishNotice.tone, 'warning')
    assert.match(state.publishNotice.text, /尚未发布/)
    assert.doesNotMatch(state.publishNotice.text, /草稿已保存/)
})

test('changing playback controls does not clear stale IDs or auto-select the first registered device', async t => {
    const { instance } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel = staleReferenceDocument()
    state.selectedIds = ['cfg_device_trend_Furnace_03']
    state.devices = [{ id: 'other' }]
    state.points = [{ id: 'new', device_id: 'other', category: 'analog', value_role: 'actual_temp' }]
    state.editorDeviceId = 'other'
    state.pointPlaybackChanged()
    assert.equal(state.selectedWidget.data.pointId, '638')
    assert.equal(state.selectedWidget.data.deviceId, 'Furnace_03')
    state.selectedWidget.data.deviceId = ''
    state.pointPlaybackChanged()
    assert.equal(state.selectedWidget.data.deviceId, '')
    assert.equal(state.selectedWidget.data.pointId, '638')
    // The compatibility selector has already applied its v-model value before
    // notifying the parent; its explicit device-change event may rebind.
    state.selectedWidget.data.deviceId = 'other'
    state.pointPlaybackChanged({ deviceChanged: true })
    assert.equal(state.selectedWidget.data.pointId, 'new')
})

test('a confirmed deleted binding loads the factory replacement catalog without sending its deleted preview ID or changing the binding', async t => {
    const { instance, renderer, beforeRestore } = fixture(t, [])
    await settle()
    const state = instance.value.$.setupState
    state.documentModel = staleReferenceDocument()
    state.selectedIds = ['cfg_device_trend_Furnace_03']
    state.bindingCatalogReady = false
    assert.equal(state.safeCatalogPreviewDeviceId, 'Furnace_03', 'without a complete directory the ID is not presumed deleted')
    t.mock.method(adminApi, 'getDevices', async () => [{ id: 'other', name: '其它设备' }])
    t.mock.method(adminApi, 'getDataPoints', async () => [{ id: 'new', device_id: 'other', category: 'analog', value_role: 'actual_temp', access_type: 'READ' }])
    t.mock.method(adminApi, 'getDeviceInspection', async () => ({ inspection: { parts: [] } }))
    await state.refreshBindingCatalog({ force: true })
    await state.locateValidationIssue(state.validationIssues[0])
    assert.equal(state.safeCatalogPreviewDeviceId, '')
    assert.equal(state.selectedBindingDeviceId, 'Furnace_03')
    const before = JSON.stringify(state.documentModel), requests = [], selections = [], picker = ref(null)
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        const url = new URL(input)
        assert.equal(url.pathname, '/api/data-center/catalog')
        assert.equal(url.searchParams.has('preview_device_id'), false)
        assert.equal(url.searchParams.has('device_id'), false)
        assert.equal(new Headers(options.headers).get('X-Factory-ID'), 'factory-test')
        requests.push(url.href)
        return json({ success: true, categories: [{ id: 'realtime', name: '实时采集' }], tables: [{ id: 'plc-other', name: '其它设备采集' }],
            items: [{ id: 'new-temp', categoryId: 'realtime', tableId: 'plc-other', label: '炉内温度', type: 'number', sourceType: 'plc',
                deviceName: '其它设备', previewValue: 888, quality: 'good', binding: { mode: 'plc', deviceScope: 'fixed', deviceId: 'other', pointId: 'new', pointKey: 'analog.actual_temp' } }] })
    })
    const pickerApp = renderer.createApp({ render: () => h(CatalogPicker, { ref: picker, binding: state.selectedWidget.data,
        factoryId: 'factory-test', deviceId: state.safeCatalogPreviewDeviceId, widgetType: state.selectedWidget.type,
        onSelect: item => selections.push(item) }) })
    pickerApp.mount({})
    beforeRestore(() => pickerApp.unmount())
    await settle(); await nextTick()
    const pickerState = picker.value.$.setupState
    assert.equal(requests.length, 1)
    assert.equal(pickerState.error, '')
    assert.deepEqual(pickerState.items.map(item => item.id), ['new-temp'])
    assert.equal(pickerState.current, undefined, 'replacement samples are not labelled as the original binding')
    assert.equal(selections.length, 0)
    assert.equal(state.previewValueForWidget(state.selectedWidget), undefined, 'catalog samples never become the deleted binding reading')
    assert.equal(state.selectedWidget.data.pointId, '638')
    assert.equal(state.selectedWidget.data.deviceId, 'Furnace_03')
    assert.equal(JSON.stringify(state.documentModel), before)
    assert.match(descriptor.template.content, /<DataCatalogPicker[^>]*:device-id="safeCatalogPreviewDeviceId"/)
})

function deletionSyncDocument() {
    return normalizeDashboardDocument({ sceneId: 'deletion-scene', metadata: { revision: 5 }, scene: { defaultViewId: 'overview', views: [
        { id: 'overview', mode: 'factory' }, { id: 'device', mode: 'device', targetId: '' }
    ] }, widgets: [
        { id: 'device-private', type: 'text', data: { mode: 'static', value: '设备说明' }, content: { text: '专属说明' },
            visibility: { viewIds: ['device'], rules: [{ source: 'context', path: 'deviceId', operator: '==', value: 'deleted-owner' }] } },
        { id: 'general-title', type: 'text', data: { mode: 'static', value: '原标题' }, content: { text: '原公共标题' }, visibility: { viewIds: ['overview'] } },
        { id: 'general-fixed', type: 'trend', data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'deleted-owner', pointId: '638' }, visibility: { viewIds: ['overview'] } }
    ] })
}

function deletionSyncPlan(factoryId, beforeRevision = 5, nextRevision = 6) {
    return { id: `${factoryId}-delete-${beforeRevision}`, factoryId, deletedDeviceIds: ['deleted-owner'], remainingDeviceIds: ['remaining-owner'],
        scenes: [{ sceneId: 'deletion-scene', beforeRevision, revision: nextRevision, removedWidgetIds: ['device-private'], removedViewIds: [],
            removedTooltipTemplateIds: [], removedTooltipWidgetIds: [], updatedWidgetIds: [] }] }
}

function deletionStorage(factoryId) {
    const values = new Map([['digital_twin_factory_scope_v1', factoryId]])
    return { get length() { return values.size }, key: index => [...values.keys()][index],
        getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}

test('backend-confirmed device deletion updates the real designer, baseline and undo stack while preserving unrelated edits', async t => {
    const factoryId = 'deletion-live-sfc', { instance } = fixture(t, [], { factoryId })
    await settle()
    const state = instance.value.$.setupState, baseline = deletionSyncDocument(), edited = structuredClone(baseline)
    edited.widgets.find(w => w.id === 'general-title').content.text = '未保存的新标题'
    state.documentModel = edited; state.revision = 5; state.lastSavedSnapshot = state.snapshot(baseline)
    state.history = [{ document: baseline, label: '原稿' }, { document: edited, label: '修改标题' }]; state.historyIndex = 1
    state.selectedIds = ['device-private', 'general-title']; state.editorDeviceId = 'deleted-owner'
    state.devices = [{ id: 'deleted-owner' }, { id: 'remaining-owner' }]
    state.onDashboardDeviceDeleted(deletionSyncPlan(factoryId))
    assert.equal(state.revision, 6); assert.equal(state.isDirty, true)
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'))
    assert.equal(state.documentModel.widgets.find(w => w.id === 'general-title').content.text, '未保存的新标题')
    assert.equal(state.documentModel.widgets.find(w => w.id === 'general-fixed').data.pointId, '638', 'shared fixed sources are not silently rebound')
    for (const entry of state.history) assert.ok(!entry.document.widgets.some(w => w.id === 'device-private'))
    assert.ok(!state.selectedIds.includes('device-private')); assert.notEqual(state.editorDeviceId, 'deleted-owner')
    state.undo()
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'), 'Ctrl+Z must not restore a deleted device component')
    assert.equal(state.documentModel.widgets.find(w => w.id === 'general-title').content.text, '原公共标题')
    await settle()
})

test('a deletion from another factory never changes the active designer', async t => {
    const { instance } = fixture(t, [], { factoryId: 'deletion-isolated-sfc' }); await settle()
    const state = instance.value.$.setupState; state.documentModel = deletionSyncDocument(); state.revision = 5
    const before = state.snapshot()
    state.onDashboardDeviceDeleted(deletionSyncPlan('different-factory'))
    assert.equal(state.snapshot(), before); assert.equal(state.revision, 5)
})

test('real designer revision conflicts keep edited content and block save/publish rather than overwriting another revision', async t => {
    const factoryId = 'deletion-conflict-sfc', { instance } = fixture(t, [], { factoryId }); await settle()
    const state = instance.value.$.setupState; state.documentModel = deletionSyncDocument(); state.revision = 2
    state.documentModel.widgets.find(w => w.id === 'general-title').content.text = '不能丢的修改'
    state.lastSavedSnapshot = state.snapshot()
    const save = t.mock.method(adminApi, 'saveDashboardDraft', async () => { throw Error('must not save a conflicting draft') })
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => { throw Error('must not publish a conflicting draft') })
    state.onDashboardDeviceDeleted(deletionSyncPlan(factoryId))
    assert.equal(state.revision, 2); assert.ok(state.deletionSyncConflict)
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'))
    assert.equal(state.documentModel.widgets.find(w => w.id === 'general-title').content.text, '不能丢的修改')
    assert.equal(await state.saveDraft(), false); await state.publishVersion()
    assert.equal(save.mock.callCount(), 0); assert.equal(publish.mock.callCount(), 0)
    assert.match(state.status.text, /本机未保存编辑仍已保留/)
    await settle()
})

test('a deletion acknowledgement during an in-flight successful save is applied after its response and cannot resurrect a component', async t => {
    const factoryId = 'deletion-save-race-sfc', { instance } = fixture(t, [], { factoryId }); await settle()
    const state = instance.value.$.setupState; state.documentModel = deletionSyncDocument(); state.revision = 5; state.lastSavedSnapshot = state.snapshot()
    const pending = deferred(); let submitted
    t.mock.method(adminApi, 'saveDashboardDraft', async (_scene, document) => { submitted = structuredClone(document); return pending.promise })
    const saving = state.saveDraft(); await settle(); assert.ok(submitted)
    state.onDashboardDeviceDeleted(deletionSyncPlan(factoryId, 6, 7))
    assert.ok(state.documentModel.widgets.some(w => w.id === 'device-private'), 'do not race the pending save response')
    submitted.metadata.revision = 6; pending.resolve({ document: submitted, revision: 6, warnings: [] })
    assert.equal(await saving, true)
    assert.equal(state.revision, 7); assert.equal(state.deletionSyncConflict, null)
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'))
    assert.ok(!JSON.parse(state.lastSavedSnapshot).widgets.some(w => w.id === 'device-private'))
    await settle()
})

test('reopening the designer replays trusted backend deletion history into an unmounted dirty cache', async t => {
    const factoryId = 'deletion-reopen-sfc', original = deletionSyncDocument(), edited = structuredClone(original)
    edited.widgets.find(w => w.id === 'general-title').content.text = '跨页面保留的编辑'
    cacheFactoryDraft(factoryId, 'dashboard:deletion-scene', 'dashboard', { sceneId: 'deletion-scene', revision: 5, document: edited })
    t.after(() => clearFactoryDraft(factoryId, 'dashboard:deletion-scene'))
    const server = structuredClone(original); server.widgets = server.widgets.filter(w => w.id !== 'device-private'); server.metadata.revision = 6
    const { instance } = fixture(t, [], { factoryId, storage: deletionStorage(factoryId),
        designerState: { revision: 6, document: server, dashboardCleanupHistory: [deletionSyncPlan(factoryId)] } })
    await settle(); await nextTick()
    const state = instance.value.$.setupState
    assert.equal(state.revision, 6); assert.equal(state.deletionSyncConflict, null)
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'))
    assert.equal(state.documentModel.widgets.find(w => w.id === 'general-title').content.text, '跨页面保留的编辑')
    assert.equal(readFactoryDraft(factoryId, 'dashboard:deletion-scene').revision, 6)
})

test('reopening a conflicting deleted-device cache displays preserved editing instead of silently replacing it with the server', async t => {
    const factoryId = 'deletion-reopen-conflict-sfc', original = deletionSyncDocument(), edited = structuredClone(original)
    edited.widgets.find(w => w.id === 'general-title').content.text = '旧修订上的重要编辑'; edited.metadata.revision = 2
    cacheFactoryDraft(factoryId, 'dashboard:deletion-scene', 'dashboard', { sceneId: 'deletion-scene', revision: 2, document: edited })
    t.after(() => clearFactoryDraft(factoryId, 'dashboard:deletion-scene'))
    const server = structuredClone(original); server.widgets = server.widgets.filter(w => w.id !== 'device-private'); server.metadata.revision = 6
    const { instance } = fixture(t, [], { factoryId, storage: deletionStorage(factoryId),
        designerState: { revision: 6, document: server, dashboardCleanupHistory: [deletionSyncPlan(factoryId)] } })
    await settle(); await nextTick()
    const state = instance.value.$.setupState
    assert.equal(state.revision, 2); assert.ok(state.deletionSyncConflict)
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'))
    assert.equal(state.documentModel.widgets.find(w => w.id === 'general-title').content.text, '旧修订上的重要编辑')
    assert.match(state.status.text, /本机未保存编辑仍已保留/)
})

test('a late designer load response replays queued cleanup instead of putting removed device components back', async t => {
    const factoryId = 'deletion-load-race-sfc', pending = deferred()
    const { instance } = fixture(t, [], { factoryId, designerState: pending.promise })
    const state = instance.value.$.setupState
    assert.equal(state.loading, true)
    state.onDashboardDeviceDeleted(deletionSyncPlan(factoryId))
    pending.resolve({ revision: 5, document: deletionSyncDocument() })
    await settle(); await nextTick()
    assert.equal(state.loading, false); assert.equal(state.revision, 6)
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'))
    assert.ok(!JSON.parse(state.lastSavedSnapshot).widgets.some(w => w.id === 'device-private'))
})

test('cleanup ends and records an unrelated active drag before sanitizing history', async t => {
    const factoryId = 'deletion-drag-sfc', { instance, browser } = fixture(t, [], { factoryId }); await settle()
    const state = instance.value.$.setupState, baseline = deletionSyncDocument()
    state.documentModel = baseline; state.revision = 5; state.lastSavedSnapshot = state.snapshot(); state.resetHistory()
    state.selectedIds = ['general-title']
    const widget = state.documentModel.widgets.find(w => w.id === 'general-title')
    state.beginMove(pointerEvent(), widget)
    state.handlePointerMove(pointerEvent({ clientX: 170, clientY: 120 }))
    const moved = JSON.parse(JSON.stringify(widget.frame))
    assert.ok(browser.listeners.get('pointermove')?.size)
    state.onDashboardDeviceDeleted(deletionSyncPlan(factoryId))
    assert.deepEqual(state.documentModel.widgets.find(w => w.id === 'general-title').frame, moved)
    assert.equal(browser.listeners.get('pointermove')?.size, 0)
    assert.ok(state.history.some(entry => entry.label === '移动组件'))
    for (const entry of state.history) assert.ok(!entry.document.widgets.some(w => w.id === 'device-private'))
    state.handlePointerMove(pointerEvent({ clientX: 600, clientY: 700 }))
    assert.deepEqual(state.documentModel.widgets.find(w => w.id === 'general-title').frame, moved, 'the old pointer cannot write after cleanup')
    await settle()
})

test('focus deletion-history reconciliation ignores the returned canvas and preserves local edits', async t => {
    const factoryId = 'deletion-history-focus-sfc', { instance } = fixture(t, [], { factoryId }); await settle()
    const state = instance.value.$.setupState; state.documentModel = deletionSyncDocument(); state.revision = 5; state.lastSavedSnapshot = state.snapshot()
    state.documentModel.widgets.find(w => w.id === 'general-title').content.text = '仍在编辑的标题'
    t.mock.method(adminApi, 'getDashboardDesigner', async () => ({ revision: 6, document: { widgets: [{ id: 'do-not-load' }] }, dashboardCleanupHistory: [deletionSyncPlan(factoryId)] }))
    assert.equal(await state.refreshDashboardDeletionHistory({ force: true }), true)
    assert.equal(state.documentModel.widgets.find(w => w.id === 'general-title').content.text, '仍在编辑的标题')
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'do-not-load'))
    assert.ok(!state.documentModel.widgets.some(w => w.id === 'device-private'))
    assert.equal(state.revision, 6); assert.equal(state.isDirty, true)
    await settle()
})

test('default factory identity comes only from the trusted project and queued cleanup verifies that identity', async t => {
    const pending = deferred(), { instance } = fixture(t, [], { designerState: pending.promise })
    const state = instance.value.$.setupState
    state.onDashboardDeviceDeleted(deletionSyncPlan('other-owner'))
    state.onDashboardDeviceDeleted(deletionSyncPlan('factory_default'))
    pending.resolve({ project: { factory_id: 'factory_default' }, revision: 5, document: deletionSyncDocument() })
    await settle(); await nextTick()
    assert.equal(state.documentFactoryId, 'factory_default'); assert.equal(state.previewContext.factoryId, 'factory_default')
    assert.equal(state.revision, 6); assert.ok(!state.deletionSyncConflict)
    assert.ok(!state.documentModel.widgets.some(widget => widget.id === 'device-private'))
    const before = state.snapshot()
    state.onDashboardDeviceDeleted(deletionSyncPlan('other-owner', 6, 7))
    assert.equal(state.snapshot(), before); assert.equal(state.revision, 6)
    await settle()
})

test('an old default-factory cache cleaned by the trusted tombstone snapshot preserves edits and the old CAS base', async t => {
    const factoryId = 'factory_default', edited = deletionSyncDocument(), storage = deletionStorage('')
    edited.metadata.revision = 2; edited.widgets.find(widget => widget.id === 'general-title').content.text = '很久以前尚未保存的编辑'
    cacheFactoryDraft('', 'dashboard:deletion-scene', 'dashboard', { sceneId: 'deletion-scene', revision: 2, document: edited })
    t.after(() => clearFactoryDraft('', 'dashboard:deletion-scene'))
    const server = deletionSyncDocument(); server.widgets = server.widgets.filter(widget => widget.id !== 'device-private')
    const snapshot = { id: 'history_snapshot_old', factoryId, deletedDeviceIds: ['deleted-owner'], remainingDeviceIds: ['remaining-owner'], scenes: [] }
    const events = Array.from({ length: 100 }, (_, index) => ({ id: `recent-${index}`, factoryId, deletedDeviceIds: [`unrelated-${index}`], scenes: [] }))
    const { instance } = fixture(t, [], { storage, designerState: { project: { factory_id: factoryId }, revision: 200, document: server, dashboardCleanupHistory: [...events, snapshot] } })
    await settle(); await nextTick()
    const state = instance.value.$.setupState
    assert.equal(state.revision, 2); assert.equal(state.deletionSyncConflict.reason, 'missed-deletion-history')
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'general-title').content.text, '很久以前尚未保存的编辑')
    assert.ok(!state.documentModel.widgets.some(widget => widget.id === 'device-private'))
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'general-fixed').data.pointId, '638')
    assert.equal(await state.saveDraft(), false)
    assert.match(state.status.text, /本机未保存编辑仍已保留/)
})

test('a legacy localStorage draft cleaned by a scene-free tombstone is retained without advancing its old revision', async t => {
    const factoryId = 'old-storage-owner', storage = deletionStorage(factoryId), edited = deletionSyncDocument()
    edited.metadata.revision = 2; edited.widgets.find(widget => widget.id === 'general-title').content.text = '本地存储里的重要修改'
    storage.setItem('dashboard-designer-draft:deletion-scene', JSON.stringify({ serverRevision: 2, document: edited }))
    const server = deletionSyncDocument(); server.widgets = server.widgets.filter(widget => widget.id !== 'device-private')
    const cleanup = { id: 'snapshot-storage', factoryId, deletedDeviceIds: ['deleted-owner'], remainingDeviceIds: ['remaining-owner'], scenes: [] }
    const { instance } = fixture(t, [], { factoryId, storage, designerState: { project: { factory_id: factoryId }, revision: 200, document: server, dashboardCleanupHistory: [cleanup] } })
    await settle(); await nextTick()
    const state = instance.value.$.setupState
    assert.equal(state.revision, 2); assert.equal(state.deletionSyncConflict.reason, 'missed-deletion-history')
    assert.ok(!state.documentModel.widgets.some(widget => widget.id === 'device-private'))
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'general-title').content.text, '本地存储里的重要修改')
})

async function resolvableConflictFixture(t, conflicting = false) {
    const factoryId = 'resolvable-conflict', storage = deletionStorage(factoryId), original = deletionSyncDocument()
    original.widgets = original.widgets.filter(widget => widget.id !== 'general-fixed')
    const { instance } = fixture(t, [], { factoryId, storage, designerState: { revision: 2, document: original } })
    await settle()
    const state = instance.value.$.setupState, server = structuredClone(JSON.parse(state.snapshot()))
    state.documentModel.widgets.find(widget => widget.id === 'general-title').content.text = '保留本机标题'
    server.widgets = server.widgets.filter(widget => widget.id !== 'device-private')
    server.widgets.find(widget => widget.id === 'general-title').frame.x = 325
    if (conflicting) server.widgets.find(widget => widget.id === 'general-title').content.text = '服务端不同标题'
    t.mock.method(adminApi, 'getDashboardDesigner', async () => ({ project: { factory_id: factoryId }, revision: 6, document: server, dashboardCleanupHistory: [deletionSyncPlan(factoryId)] }))
    const save = t.mock.method(adminApi, 'saveDashboardDraft', async (_scene, document, expectedRevision) => {
        assert.equal(expectedRevision, 6)
        return { revision: 7, document: structuredClone(document), warnings: [] }
    })
    state.onDashboardDeviceDeleted(deletionSyncPlan(factoryId), { refreshCatalog: false })
    assert.ok(state.deletionSyncConflict)
    return { state, storage, server, save }
}

test('saving a deletion revision gap automatically merges disjoint edits and retains the latest CAS guard', async t => {
    const { state, save } = await resolvableConflictFixture(t)
    assert.equal(await state.saveDraft(), true)
    assert.equal(save.mock.callCount(), 1)
    const title = state.documentModel.widgets.find(widget => widget.id === 'general-title')
    assert.equal(title.content.text, '保留本机标题'); assert.equal(title.frame.x, 325)
    assert.equal(state.deletionSyncConflict, null); assert.equal(state.revision, 7)
    assert.ok(!state.documentModel.widgets.some(widget => widget.id === 'device-private'))
})

test('a real conflict has an actionable local choice, backs up both drafts and preserves nonconflicting server edits', async t => {
    const { state, storage, save } = await resolvableConflictFixture(t, true)
    assert.equal(await state.saveDraft(), false); assert.equal(save.mock.callCount(), 0)
    assert.ok(state.draftConflictDetails.includes('widgets[general-title].content.text'))
    assert.match(descriptor.template.content, /保留本机并保存/)
    assert.equal(await state.saveDraft({ conflictChoice: 'local' }), true)
    assert.equal(state.deletionSyncConflict, null)
    const title = state.documentModel.widgets.find(widget => widget.id === 'general-title')
    assert.equal(title.content.text, '保留本机标题'); assert.equal(title.frame.x, 325)
    const [backup] = JSON.parse(storage.getItem(state.conflictBackupKey()))
    assert.equal(backup.localDocument.widgets.find(widget => widget.id === 'general-title').content.text, '保留本机标题')
    assert.equal(backup.serverDocument.widgets.find(widget => widget.id === 'general-title').content.text, '服务端不同标题')
})

test('using the server draft backs up local edits, clears the conflict and never saves or publishes implicitly', async t => {
    const { state, save } = await resolvableConflictFixture(t, true)
    const publish = t.mock.method(adminApi, 'publishDashboard', async () => { throw Error('must not publish') })
    await state.useServerDraft()
    assert.equal(state.deletionSyncConflict, null); assert.equal(state.revision, 6)
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'general-title').content.text, '服务端不同标题')
    assert.equal(state.isDirty, false); assert.ok(state.conflictBackup)
    assert.equal(save.mock.callCount(), 0); assert.equal(publish.mock.callCount(), 0)
})

test('failed recovery-backup storage never replaces the canvas or advances its revision', async t => {
    const { state, storage, save } = await resolvableConflictFixture(t, true)
    const before = state.snapshot(), revision = state.revision
    t.mock.method(storage, 'setItem', () => { throw Error('quota exceeded') })
    assert.equal(await state.saveDraft({ conflictChoice: 'local' }), false)
    assert.equal(state.snapshot(), before); assert.equal(state.revision, revision)
    assert.ok(state.deletionSyncConflict); assert.equal(save.mock.callCount(), 0)
    assert.match(state.status.text, /恢复副本保存失败/)
})

test('the display checkbox assigns the requested boolean once, syncs layers/preview and supports undo without changing data or style', async t => {
    const { instance } = fixture(t, []); await settle()
    const state = instance.value.$.setupState
    const widget = state.documentModel.widgets.find(widget => widget.type === 'return_button')
    assert.ok(widget)
    state.selectedViewId = 'factory_overview'
    const before = JSON.parse(JSON.stringify(widget))
    state.lastSavedSnapshot = state.snapshot(); state.resetHistory()
    assert.equal(state.componentDisplayStates[widget.id].visible, true, 'root return button must not be secretly auto-hidden')
    state.setWidgetVisibility(widget, false)
    assert.equal(widget.visible, false); assert.equal(state.componentDisplayStates[widget.id].visible, false)
    assert.equal(state.isDirty, true)
    const count = state.history.length
    state.setWidgetVisibility(widget, false)
    assert.equal(state.history.length, count, 'repeated checkbox change cannot invert the requested state or add undo steps')
    assert.deepEqual(JSON.parse(JSON.stringify(widget)), { ...before, visible: false })
    state.previewMode = true
    assert.ok(!state.canvasWidgets.some(item => item.id === widget.id))
    state.toggleLayerVisibility(widget)
    assert.equal(widget.visible, true); assert.ok(state.canvasWidgets.some(item => item.id === widget.id))
    state.undo()
    assert.equal(state.documentModel.widgets.find(item => item.id === widget.id).visible, false)
    state.redo()
    assert.deepEqual(JSON.parse(JSON.stringify(state.documentModel.widgets.find(item => item.id === widget.id))), before)
})

test('normal HUD panels use the same display assignment without changing bindings, content or layout', async t => {
    const { instance } = fixture(t, []); await settle()
    const state = instance.value.$.setupState
    state.documentModel = normalizeDashboardDocument({ widgets: [{ id: 'parameters', type: 'hud_kpi_panel', content: { title: '生产运行参数' }, data: { mode: 'runtime', path: 'metrics.current_output' } }] })
    const widget = state.documentModel.widgets.find(widget => widget.id === 'parameters')
    const before = JSON.parse(JSON.stringify(widget)); state.resetHistory()
    state.setWidgetVisibility(widget, false)
    assert.deepEqual(JSON.parse(JSON.stringify(widget)), { ...before, visible: false })
    state.setWidgetVisibility(widget, true)
    assert.deepEqual(JSON.parse(JSON.stringify(widget)), before)
})

test('designer restores pending edits from an old blue cache using the approved source appearance, not the stale copied colors', async t => {
    const factoryId = 'approved-style-reopen', authority = approvedOverviewFixture(), local = structuredClone(authority)
    const runningSnapshot = structuredClone(authority)
    delete authority.metadata.approvedOverviewStyle
    delete local.metadata.approvedOverviewStyle
    local.widgets.find(widget => widget.id === 'cfg_param_a_value').content.text = '还没保存的真实内容 {value}'
    cacheFactoryDraft(factoryId, 'dashboard:approved-scene', 'dashboard', { revision: 137, document: local })
    t.after(() => clearFactoryDraft(factoryId, 'dashboard:approved-scene'))
    const { instance } = fixture(t, [], { factoryId, designerState: { revision: 137, document: authority, currentRelease: { id: 'approved-running', version: '1.0.75', snapshot: runningSnapshot } } })
    await settle()
    const state = instance.value.$.setupState
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'detail_trend').style.background, '#241f2e')
    assert.equal(state.documentModel.widgets.find(widget => widget.id === 'cfg_param_a_value').content.text, '还没保存的真实内容 {value}')
    assert.equal(state.isDirty, true)
    assert.equal(state.documentModel.metadata.approvedOverviewStyle.version, 2)
    assert.deepEqual(state.documentModel.widgets.find(widget => widget.id === 'cfg_device_trend_Furnace_01').data,
        authority.widgets.find(widget => widget.id === 'cfg_device_trend_Furnace_01').data)
})

test('the new binding workflow preserves HUD secondary metrics through undo, save and reopening', async t => {
    const old = { authenticated:adminSession.authenticated, pagePermissions:adminSession.pagePermissions }
    t.after(() => Object.assign(adminSession, old))
    adminSession.authenticated = true
    adminSession.pagePermissions = { 'platform.designer':{view:true,edit:true} }
    const devices = [{id:'a',name:'A炉'},{id:'b',name:'B炉'}]
    const points = devices.flatMap(device => [
        {id:`${device.id}-temp`,device_id:device.id,category:'analog',value_role:'temp',access_type:'READ',unit:'℃'},
        {id:`${device.id}-hours`,device_id:device.id,category:'analog',value_role:'hours',access_type:'READ',unit:'h'}
    ])
    const {state,widget} = await canvasSelectionFixture(t,[{
        id:'workflow-kpi',type:'hud_kpi_panel',content:{items:[{label:'运行时长',path:'device.analog.hours',unit:'h'}]},
        data:{mode:'plc',bindingVersion:2,deviceScope:'rotation',pointId:'a-temp',pointKey:'analog.temp',rotationIntervalMs:17000,
            deviceBindings:devices.map(device=>({deviceId:device.id,binding:{mode:'plc',deviceId:device.id,pointId:`${device.id}-temp`,pointKey:'analog.temp',unit:'℃'}}))}
    }])
    state.devices = devices; state.points = points; state.selectedIds = ['workflow-kpi']; state.resetHistory()
    const originalData = JSON.parse(JSON.stringify(widget('workflow-kpi').data))
    const originalItems = JSON.parse(JSON.stringify(widget('workflow-kpi').content.items))
    const changed = structuredClone(originalData)
    changed.deviceBindings[1].binding.pointId = 'b-distinct-temperature'
    changed.deviceBindings[1].binding.pointKey = 'analog.alternateTemperature'
    state.applyDataWorkflow(changed)
    assert.deepEqual(JSON.parse(JSON.stringify(widget('workflow-kpi').content.items)),originalItems)
    assert.equal(widget('workflow-kpi').content.useBoundRing,true)
    state.undo(); assert.deepEqual(JSON.parse(JSON.stringify(widget('workflow-kpi').data)),originalData)
    state.redo(); assert.equal(widget('workflow-kpi').data.deviceBindings[1].binding.pointId,'b-distinct-temperature')
    state.applyMetricSource({index:0,deviceId:'a',item:{id:'a-hour-item',tableId:'a-plc-table',unit:'h',binding:{mode:'plc',deviceId:'a',pointId:'a-hours-replacement',pointKey:'analog.hoursReplacement'}}})
    const metric = widget('workflow-kpi').content.items[0]
    assert.equal(metric.binding.deviceBindings.find(row=>row.deviceId==='a').binding.pointId,'a-hours-replacement')
    assert.equal(metric.binding.deviceBindings.find(row=>row.deviceId==='b').binding.pointId,'b-hours')
    state.applyMetricSource({index:0,deviceId:'a',item:null})
    assert.equal(metric.binding.deviceBindings.find(row=>row.deviceId==='a').binding,null)
    assert.equal(metric.binding.deviceBindings.find(row=>row.deviceId==='b').binding.pointId,'b-hours')
    state.undo()
    assert.equal(widget('workflow-kpi').content.items[0].binding.deviceBindings.find(row=>row.deviceId==='a').binding.pointId,'a-hours-replacement')
    t.mock.method(adminApi,'getDevices',async()=>devices)
    t.mock.method(adminApi,'getDataPoints',async()=>points)
    let saved
    t.mock.method(adminApi,'saveDashboardDraft',async(_scene,document)=>{
        saved=JSON.parse(JSON.stringify(document));return {revision:2,document:saved,warnings:[]}
    })
    assert.equal(await state.saveDraft(),true)
    const expected = JSON.parse(JSON.stringify(widget('workflow-kpi')))
    t.mock.method(adminApi,'getDashboardDesigner',async()=>({revision:2,document:saved}))
    await state.loadDesigner({allowLocal:false})
    assert.deepEqual(JSON.parse(JSON.stringify(widget('workflow-kpi').data)),expected.data)
    assert.deepEqual(JSON.parse(JSON.stringify(widget('workflow-kpi').content.items)),expected.content.items)
    assert.equal(widget('workflow-kpi').data.rotationIntervalMs,17000)
})

test('global HUD secondary metrics keep actual global scope or a deliberately chosen fixed device without changing the main source',async t=>{
    const old={authenticated:adminSession.authenticated,pagePermissions:adminSession.pagePermissions};t.after(()=>Object.assign(adminSession,old))
    adminSession.authenticated=true;adminSession.pagePermissions={'platform.designer':{view:true,edit:true}}
    const {state,widget}=await canvasSelectionFixture(t,[{id:'global-kpi',type:'hud_kpi_panel',content:{items:[{label:'指定炉运行时长',binding:{mode:'runtime',deviceScope:'global',path:''}},{label:'工厂能耗',binding:{mode:'dataset',deviceScope:'global',datasetId:'old-energy',datasetField:'value'}}]},data:{mode:'dataset',bindingVersion:2,deviceScope:'global',datasetId:'factory-main',datasetField:'value',deviceBindings:[]}}])
    state.devices=[{id:'a',name:'A炉'},{id:'b',name:'B炉'}];state.selectedIds=['global-kpi'];state.resetHistory()
    const original=JSON.parse(JSON.stringify(widget('global-kpi').data))
    state.applyMetricScope({index:0,scope:'fixed'})
    assert.equal(widget('global-kpi').content.items[0].binding.deviceId,'','no first-device default')
    const item={id:'a-hours',tableId:'a-plc',unit:'h',binding:{mode:'plc',deviceId:'a',pointId:'pa',pointKey:'analog.hours',deviceScope:'fixed'}}
    state.applyMetricSource({index:0,deviceId:'',item})
    assert.equal(widget('global-kpi').content.items[0].binding.deviceId,'');assert.match(state.status.text,/先明确指定/)
    state.applyMetricScope({index:0,scope:'fixed',deviceId:'a'})
    state.applyMetricSource({index:0,deviceId:'a',item})
    const fixed=widget('global-kpi').content.items[0].binding
    assert.equal(fixed.bindingVersion,2);assert.equal(fixed.deviceScope,'fixed');assert.equal(fixed.deviceId,'a');assert.equal(fixed.deviceBindings.find(row=>row.deviceId==='a').binding.pointId,'pa')
    state.applyMetricSource({index:1,deviceId:'',item:{id:'global-energy',tableId:'energy-table',unit:'kWh',binding:{mode:'dataset',datasetId:'actual-energy',datasetField:'usage',deviceScope:'global'}}})
    const global=widget('global-kpi').content.items[1].binding
    assert.equal(global.deviceScope,'global');assert.equal(global.datasetId,'actual-energy');assert.ok(!global.deviceBindings.some(row=>!row.deviceId))
    assert.deepEqual(JSON.parse(JSON.stringify(widget('global-kpi').data)),original)
    state.applyMetricSource({index:0,deviceId:'a',item:null})
    assert.equal(widget('global-kpi').content.items[0].binding.deviceId,'a');assert.equal(widget('global-kpi').content.items[0].binding.deviceBindings.find(row=>row.deviceId==='a').binding,null)
    state.undo();assert.equal(widget('global-kpi').content.items[0].binding.deviceBindings.find(row=>row.deviceId==='a').binding.pointId,'pa')
})

test('an existing explicit device workflow stays editable on map views while genuine map region fields retain their dedicated editor',async t=>{
    const {state,widget}=await canvasSelectionFixture(t,[{id:'mapped-device-kpi',type:'hud_kpi_panel',data:{mode:'plc',bindingVersion:2,deviceScope:'rotation',pointId:'pa',pointKey:'analog.temp',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'pa',pointKey:'analog.temp'}}]}}])
    state.selectedIds=['mapped-device-kpi'];state.selectedViewId='map_world';await nextTick()
    assert.equal(state.currentViewIsMapSurface,true);assert.equal(state.selectedUsesBindingWorkflow,true)
    assert.equal(widget('mapped-device-kpi').data.deviceBindings[0].binding.pointId,'pa')
    widget('mapped-device-kpi').data={mode:'runtime',path:'metrics.overall_oee',deviceScope:'global'};await nextTick()
    assert.equal(state.selectedUsesBindingWorkflow,true,'legacy factory HUD metrics stay editable through the new workflow on a map/custom preview')
    assert.equal(widget('mapped-device-kpi').data.path,'metrics.overall_oee','opening its editor cannot rewrite the existing running source')
    widget('mapped-device-kpi').data.mode='runtime';widget('mapped-device-kpi').data.path='map.factsFactoryCount';await nextTick()
    assert.equal(state.selectedUsesMapData,true);assert.equal(state.selectedUsesBindingWorkflow,false)
})

test('save and reopening restore independent global HUD metric catalogs without changing the main source', async t => {
    const old = { authenticated: adminSession.authenticated, pagePermissions: adminSession.pagePermissions }
    t.after(() => Object.assign(adminSession, old))
    adminSession.authenticated = true
    adminSession.pagePermissions = { 'platform.designer': { view: true, edit: true } }
    t.mock.method(globalThis, 'fetch', async () => json({ success: true, result: { quality: 'good', value: 0, rows: [] } }))
    const devices = [{ id: 'a', name: 'A炉' }, { id: 'b', name: 'B炉' }]
    const points = [{ id: 'a-hours', device_id: 'a', category: 'analog', value_role: 'actual_hours', access_type: 'READ', unit: 'h' }]
    const fixedItem = { id: 'actual-a-hours', categoryId: 'realtime', tableId: 'a-plc-table', deviceId: 'a', label: 'A炉实际运行时长', type: 'number', unit: 'h',
        binding: { mode: 'plc', deviceId: 'a', pointId: 'a-hours', pointKey: 'analog.actual_hours', deviceScope: 'fixed' } }
    const globalItem = { id: 'actual-global-energy', categoryId: 'energy', tableId: 'factory-energy-table', label: '全厂实际耗电量', type: 'number', unit: 'kWh',
        binding: { mode: 'dataset', datasetId: 'actual-energy', datasetField: 'usage', deviceScope: 'global' } }
    const { state, widget } = await canvasSelectionFixture(t, [{ id: 'global-save-kpi', type: 'hud_kpi_panel',
        data: { mode: 'dataset', bindingVersion: 2, deviceScope: 'global', datasetId: 'factory-main', datasetField: 'overallProgress', deviceBindings: [] },
        content: { items: [{ label: '指定炉运行时长', binding: { mode: 'runtime', deviceScope: 'global', path: '' } },
            { label: '全厂耗电量', binding: { mode: 'dataset', deviceScope: 'global', datasetId: 'old-energy', datasetField: 'value' } }] } }])
    state.devices = devices
    state.points = points
    state.selectedIds = ['global-save-kpi']
    state.resetHistory()
    const originalMain = JSON.parse(JSON.stringify(widget('global-save-kpi').data))
    state.applyMetricScope({ index: 0, scope: 'fixed' })
    assert.equal(widget('global-save-kpi').content.items[0].binding.deviceId, '', 'switching scope does not guess the first device')
    state.applyMetricScope({ index: 0, scope: 'fixed', deviceId: 'a' })
    state.applyMetricSource({ index: 0, deviceId: 'a', item: fixedItem })
    state.applyMetricSource({ index: 1, deviceId: '', item: globalItem })
    assert.deepEqual(JSON.parse(JSON.stringify(widget('global-save-kpi').data)), originalMain)
    t.mock.method(adminApi, 'getDevices', async () => devices)
    t.mock.method(adminApi, 'getDataPoints', async () => points)
    t.mock.method(adminApi, 'getDataSets', async () => ({ datasets: [
        { id: 'factory-main', name: '全厂工艺', columns: [{ name: 'overallProgress', type: 'number' }] },
        { id: 'actual-energy', name: '全厂能耗', columns: [{ name: 'usage', type: 'number' }] }
    ] }))
    let saved
    t.mock.method(adminApi, 'saveDashboardDraft', async (_scene, document) => {
        saved = JSON.parse(JSON.stringify(document))
        return { revision: 2, document: saved, warnings: [] }
    })
    assert.equal(await state.saveDraft(), true)
    const expected = JSON.parse(JSON.stringify(widget('global-save-kpi').content.items))
    assert.deepEqual(saved.widgets.find(item => item.id === 'global-save-kpi').data, originalMain)
    t.mock.method(adminApi, 'getDashboardDesigner', async () => ({ revision: 2, document: saved }))
    await state.loadDesigner({ allowLocal: false })
    const restored = widget('global-save-kpi')
    assert.deepEqual(JSON.parse(JSON.stringify(restored.data)), originalMain)
    assert.deepEqual(JSON.parse(JSON.stringify(restored.content.items)), expected)
    const fixed = restored.content.items[0].binding, global = restored.content.items[1].binding
    assert.equal(fixed.bindingVersion, 2)
    assert.equal(fixed.deviceScope, 'fixed')
    assert.equal(fixed.deviceId, 'a')
    const fixedRow = fixed.deviceBindings.find(row => row.deviceId === 'a').binding
    assert.equal(fixedRow.pointId, 'a-hours')
    assert.equal(fixedRow.pointKey, 'analog.actual_hours')
    assert.equal(fixedRow.catalogItemId, fixedItem.id)
    assert.equal(fixedRow.catalogTableId, fixedItem.tableId)
    assert.equal(global.deviceScope, 'global')
    assert.equal(global.datasetId, 'actual-energy')
    assert.equal(global.datasetField, 'usage')
    assert.equal(global.catalogItemId, globalItem.id)
    assert.equal(global.catalogTableId, globalItem.tableId)

    // Reopened picker setup resolves the saved binding identities back to the
    // original category/table/field without emitting a new authoring change.
    t.mock.method(adminApi, 'getDataCenterCatalog', async () => ({
        categories: [{ id: 'realtime', name: '实时采集' }, { id: 'energy', name: '能源信息' }],
        tables: [{ id: fixedItem.tableId, name: 'A炉采集点位' }, { id: globalItem.tableId, name: '全厂能耗数据表' }],
        items: [fixedItem, globalItem]
    }))
    const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
        setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    for (const [item, binding, scope] of [[fixedItem, { ...fixedRow, deviceId: 'a', deviceScope: 'fixed' }, { deviceId: 'a', deviceOnly: true }],
        [globalItem, global, { globalOnly: true }]]) {
        const picker = ref(null), changes = []
        const app = renderer.createApp({ render: () => h(CatalogPicker, { ref: picker, binding, ...scope,
            factoryId: 'factory_default', widgetType: 'hud_kpi_panel', immediate: true, onSelect: choice => changes.push(choice) }) })
        app.mount({})
        try {
            await settle(); await settle(); await nextTick()
            const setup = picker.value.$.setupState
            assert.equal(setup.categoryId, item.categoryId)
            assert.equal(setup.tableId, item.tableId)
            assert.equal(setup.chosenId, item.id)
            assert.deepEqual(changes, [], 'reopening must not author a new selection')
        } finally { app.unmount() }
    }
})

test('authored alarm filters survive two designer save and reopening round trips', async t => {
    const old = { authenticated: adminSession.authenticated, pagePermissions: adminSession.pagePermissions }
    t.after(() => Object.assign(adminSession, old))
    adminSession.authenticated = true
    adminSession.pagePermissions = { 'platform.designer': { view: true, edit: true } }
    t.mock.method(globalThis, 'fetch', async () => json({ success: true, result: { quality: 'good', value: 0, rows: [] } }))
    const { EVENT_BINDING } = await import('../../shared/widgetBindingWorkflow.mjs')
    const { state, widget } = await canvasSelectionFixture(t, [{ id: 'saved-real-events', type: 'hud_alarm_panel',
        data: { ...EVENT_BINDING }, content: { limit: 7, emptyText: '暂无真实事件' } }])
    state.selectedIds = ['saved-real-events']
    state.resetHistory()
    const originalSource = JSON.parse(JSON.stringify(widget('saved-real-events').data))
    let saved, savedRevision = 1, saves = 0
    t.mock.method(adminApi, 'saveDashboardDraft', async (_scene, document, expectedRevision) => {
        assert.equal(expectedRevision, savedRevision)
        saved = JSON.parse(JSON.stringify(document))
        saves++
        return { revision: ++savedRevision, document: saved, warnings: [] }
    })
    t.mock.method(adminApi, 'getDashboardDesigner', async () => ({ revision: savedRevision, document: saved }))
    for (const filters of [{ scope: 'current', level: 'warning' }, { scope: 'factory', level: 'critical' }]) {
        state.selectedIds = ['saved-real-events']
        assert.equal(state.selectedWidget.id, 'saved-real-events')
        state.setEventFilter(filters)
        assert.deepEqual(widget('saved-real-events').content.eventFilters, filters)
        assert.deepEqual(JSON.parse(JSON.stringify(widget('saved-real-events').data)), originalSource)
        assert.equal(await state.saveDraft(), true)
        const stored = saved.widgets.find(item => item.id === 'saved-real-events')
        assert.deepEqual(stored.content.eventFilters, filters)
        assert.deepEqual(stored.data, originalSource)
        await state.loadDesigner({ allowLocal: false })
        const reopened = widget('saved-real-events')
        assert.deepEqual(JSON.parse(JSON.stringify(reopened.content.eventFilters)), filters)
        assert.deepEqual(JSON.parse(JSON.stringify(reopened.data)), originalSource)
        assert.equal(reopened.data.mode, EVENT_BINDING.mode)
        assert.equal(reopened.data.path, EVENT_BINDING.path)
        assert.equal(reopened.data.deviceScope, 'global')
        assert.equal(reopened.data.readOnly, true)
        assert.equal(reopened.content.limit, 7)
        assert.equal(reopened.content.emptyText, '暂无真实事件')
    }
    assert.equal(saves, 2)
})
