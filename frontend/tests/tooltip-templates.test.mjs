import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createTooltipTemplate, normalizeTooltipTemplates, resolveTooltipTemplate, tooltipDocumentWidgets, tooltipBackgroundWidget, tooltipDynamicBinding, restoreTooltipDynamicBinding, isTooltipMetadataPath, cleanLegacyPartTooltip, MAX_TOOLTIP_TEMPLATES, MAX_TOOLTIP_WIDGETS } from '../../shared/tooltipTemplates.mjs'
import { playbackSelection } from '../../shared/widgetPlayback.mjs'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { exportDashboardTemplate, importDashboardTemplate, dashboardTemplateReferences, rebindDashboardTemplate } from '../src/runtime/dashboardTemplate.js'
import { templateFieldBindings, applyTemplateFieldBindings } from '../src/runtime/templateFieldMapping.js'
const require = createRequire(import.meta.url)
const { normalizeDocument, validateDocument, documentToLegacyWidgets } = require('../../backend/utils/dashboardDocument.js')

test('explicit inspector source choices survive preset restoration, frontend/backend reopening and template export/import', () => {
  for (const data of [{mode:'static'}, {mode:'runtime',path:'hover.device.workshopName'}, {mode:'dataset',datasetId:'authored-table',datasetField:'caption'}]) {
    const preset = createTooltipTemplate('device'), field = preset.widgets.find(widget => widget.id.endsWith('_status_value'))
    field.content = { ...field.content, dataSourceConfigured:true, text:data.mode==='static'?'用户固定状态':'{value}' }
    field.data = { ...data, deviceId:'',deviceScope:'current',readOnly:true }
    // Leave the old provenance deliberately present: explicit choices must
    // win over an original preset ID and its previously saved source.
    assert.equal(field.dynamicBinding.path,'hover.device.status')
    const doc = normalizeDashboardDocument({tooltipTemplates:{templates:[preset],defaults:{device:preset.id}}})
    for (const version of [doc,normalizeDashboardDocument(normalizeDocument(doc)),importDashboardTemplate(exportDashboardTemplate(doc),doc)]) {
      const actual = version.tooltipTemplates.templates.find(template=>template.id===preset.id).widgets.find(widget=>widget.id===field.id)
      assert.equal(actual.content.dataSourceConfigured,true)
      assert.equal(actual.data.mode,data.mode)
      if(data.path)assert.equal(actual.data.path,data.path)
      if(data.datasetId)assert.equal(actual.data.datasetId,data.datasetId)
      assert.equal(actual.dynamicField,undefined)
      assert.equal(actual.content.text,data.mode==='static'?'用户固定状态':'{value}')
      assert.equal(actual.data.deviceId,'')
      if(data.mode==='static')assert.equal(actual.dynamicBinding,undefined)
    }
  }
})

test('tooltips are two local basic-widget templates, never main canvas/Unity widgets', () => {
  const doc = normalizeDashboardDocument()
  assert.equal(doc.tooltipTemplates.templates.length, 2)
  assert.equal(doc.widgets.length, 2)
  assert.equal(documentToLegacyWidgets(normalizeDocument(doc)).length, 2)
  const template = resolveTooltipTemplate(doc, doc.scene.views[0], 'device')
  assert.equal(template.canvas.width, 280)
  assert.ok(template.widgets.every(widget => ['text','value','status','container','image'].includes(widget.type)))
  assert.equal(template.widgets.find(widget => widget.title === '设备名称').data.path, 'hover.device.name')
  assert.ok(template.widgets.some(widget => widget.type === 'container' && widget.frame.height === 1))
  assert.notEqual(template.widgets.find(widget => widget.title === '所属车间标签').id, template.widgets.find(widget => widget.title === '所属车间数据').id)
  assert.ok(tooltipDocumentWidgets(doc).length > doc.widgets.length)
})

test('legacy per-view device tooltip customization and disabling migrate reversibly', () => {
  const doc = normalizeDashboardDocument({ scene: { views: [
    {id:'custom_factory',name:'全厂',mode:'factory',metadata:{deviceTooltip:{title:'自定标题',fields:['name','id'],pointKeys:['analog.temperature'],description:'说明',showHint:false}}},
    {id:'custom_workshop',name:'车间',mode:'workshop',metadata:{deviceTooltip:{enabled:false}}}
  ] } })
  const view = doc.scene.views[0]
  const template = resolveTooltipTemplate(doc,view,'device')
  assert.match(template.id,/tooltip_legacy_/)
  assert.equal(template.widgets.find(widget => widget.title === '提示标题').content.text,'自定标题')
  assert.equal(template.widgets.find(widget => widget.title === '补充说明').content.text,'说明')
  assert.ok(template.widgets.some(widget => widget.data.path === 'hover.device.pointMap.analog.temperature.text'))
  assert.ok(!template.widgets.some(widget => widget.title === '点击提示'))
  assert.equal(resolveTooltipTemplate(doc,doc.scene.views[1],'device'),null)
  assert.deepEqual(normalizeDashboardDocument(doc).tooltipTemplates,doc.tooltipTemplates)
})

test('frontend/backend normalization and export/import preserve nested authored bindings/styles', () => {
  const doc = normalizeDashboardDocument()
  const device = doc.tooltipTemplates.templates.find(template => template.kind === 'device')
  device.name = '我的提示'
  const widget = device.widgets.find(widget => widget.title === '设备名称')
  widget.style.color = '#ffcc88'
  widget.data = {...widget.data,mode:'dataset',datasetId:'source_set',datasetField:'value'}
  doc.scene.views[0].metadata.tooltipTemplates = {device:device.id,part:'disabled'}
  const backend = normalizeDocument(doc)
  assert.deepEqual(validateDocument(backend,{throwOnError:false}),[])
  assert.equal(backend.tooltipTemplates.templates[0].widgets.find(row => row.id === widget.id).data.datasetId,'source_set')
  const imported = importDashboardTemplate(exportDashboardTemplate(backend),doc)
  assert.equal(imported.tooltipTemplates.templates[0].name,'我的提示')
  assert.equal(imported.tooltipTemplates.templates[0].widgets.find(row => row.id === widget.id).style.color,'#ffcc88')
  assert.equal(imported.scene.views[0].metadata.tooltipTemplates.part,'disabled')
})

test('nested source/field remapping does not collide with reused widget IDs across templates', () => {
  const doc = normalizeDashboardDocument()
  const device=doc.tooltipTemplates.templates[0], part=doc.tooltipTemplates.templates[1]
  for (const template of [device,part]) template.widgets = [{...template.widgets[1],id:'same_id',data:{mode:'dataset',datasetId:'old_set',datasetField:'old_column'}}]
  const references = dashboardTemplateReferences(doc)
  assert.equal(references.find(ref => ref.id === 'old_set').uses.length,2)
  const rebound = rebindDashboardTemplate(doc,{'datasets:old_set':'new_set'},{datasets:[{id:'new_set'}]})
  const fields = templateFieldBindings(rebound)
  assert.equal(fields.length,2)
  assert.notEqual(fields[0].key,fields[1].key)
  const updated = applyTemplateFieldBindings(rebound,[{...fields[0],target:{datasetId:'new_set',datasetField:'new_column'}}])
  assert.equal(updated.tooltipTemplates.templates[0].widgets[0].data.datasetField,'new_column')
  assert.equal(updated.tooltipTemplates.templates[1].widgets[0].data.datasetField,'old_column')
})

test('template limits, unsupported widgets, stale references and disabled legacy bridge are repaired', () => {
  const source = {templates:Array.from({length:40},(_,index)=>({...createTooltipTemplate('device',`id_${index}`),canvas:{width:99999,height:-3},widgets:[{id:'bad',type:'trend'}]}))}
  const views=[{metadata:{tooltipTemplates:{device:'missing',part:'disabled'},deviceTooltip:{enabled:true}}}]
  const normalized=normalizeTooltipTemplates(source,views)
  assert.ok(normalized.templates.length<=MAX_TOOLTIP_TEMPLATES)
  assert.equal(normalized.templates[0].canvas.width,960)
  assert.equal(normalized.templates[0].canvas.height,80)
  assert.equal(normalized.templates[0].widgets.length,0)
  assert.ok(normalized.templates.some(template=>template.kind==='part'))
  assert.equal(views[0].metadata.tooltipTemplates.device,'inherit')
  const doc=normalizeDashboardDocument()
  doc.scene.views[0].metadata.tooltipTemplates={device:'disabled',part:'inherit'}
  doc.scene.views[0].metadata.deviceTooltip={enabled:true}
  assert.equal(normalizeDashboardDocument(doc).scene.views[0].metadata.deviceTooltip.enabled,false)
})

test('nested widgets are subject to data completeness, duplicate ID and read-only validation', () => {
  const doc=normalizeDashboardDocument()
  const template=doc.tooltipTemplates.templates[0]
  template.widgets[1].data={mode:'dataset',datasetId:'',datasetField:'',readOnly:false}
  template.widgets.push({...template.widgets[1]})
  const errors=validateDocument(doc,{throwOnError:false})
  assert.ok(errors.some(error=>error.includes('数据集与字段')))
  assert.ok(errors.some(error=>error.includes('禁止启用 PLC 写入')))
  assert.ok(errors.some(error=>error.includes('组件 ID 重复')))
})

test('hover scope never rotates and respects explicit fixed/global choices, including device views', () => {
  const devices=[{id:'a'},{id:'b'}]
  const context={tooltipTarget:true,deviceId:'b',viewId:'device_detail',viewMode:'device'}
  assert.equal(playbackSelection({deviceScope:'current'},context,devices,0).device.id,'b')
  assert.equal(playbackSelection({deviceScope:'rotation'},context,devices,0).device.id,'b')
  assert.equal(playbackSelection({deviceScope:'fixed',deviceId:'a'},context,devices,0).device.id,'a')
  assert.equal(playbackSelection({deviceScope:'global'},context,devices,0).device,null)
  assert.equal(playbackSelection({deviceScope:'current'},{...context,deviceId:'missing'},devices,0).device,null)
})

test('preset backgrounds follow canvas dimensions through frontend/backend normalization and export', () => {
  const doc = normalizeDashboardDocument()
  for (const template of doc.tooltipTemplates.templates) {
    assert.equal(template.backgroundWidgetId, `${template.id}_background`)
    const originalForeground = template.widgets.filter(widget => widget.id !== template.backgroundWidgetId).map(widget => ({ id: widget.id, frame: { ...widget.frame }, data: { ...widget.data } }))
    template.canvas.width = 360
    template.canvas.height = 420
    const frontend = normalizeDashboardDocument(doc).tooltipTemplates.templates.find(item => item.id === template.id)
    const background = tooltipBackgroundWidget(frontend)
    assert.deepEqual(background.frame, { x: 0, y: 0, width: 360, height: 420, rotation: 0 })
    for (const saved of originalForeground) {
      const widget = frontend.widgets.find(item => item.id === saved.id)
      assert.deepEqual(widget.frame, saved.frame, 'resizing the card does not move or stretch foreground widgets')
      assert.deepEqual(widget.data, saved.data, 'resizing does not change a data binding')
    }
  }
  const backend = normalizeDocument(doc)
  const imported = importDashboardTemplate(exportDashboardTemplate(backend), doc)
  for (const template of imported.tooltipTemplates.templates) {
    assert.equal(tooltipBackgroundWidget(template)?.id, template.backgroundWidgetId)
    assert.equal(tooltipBackgroundWidget(template).frame.width, template.canvas.width)
    assert.equal(tooltipBackgroundWidget(template).frame.height, template.canvas.height)
  }
  assert.deepEqual(validateDocument(backend, { throwOnError: false }), [])
})

test('legacy default backgrounds migrate even when only their old canvas height was enlarged', () => {
  for (const copied of [false, true]) {
    const template = createTooltipTemplate('device')
    delete template.backgroundWidgetId
    if (copied) {
      template.id = 'legacy_copy'
      template.widgets[0].id = 'legacy_copy_0'
    }
    template.canvas.height += 100
    assert.equal(tooltipBackgroundWidget(template), template.widgets[0])
    const normalized = normalizeTooltipTemplates({ templates: [template] }).templates[0]
    assert.equal(normalized.backgroundWidgetId, template.widgets[0].id)
    assert.equal(tooltipBackgroundWidget(normalized).frame.height, normalized.canvas.height)
  }
})

test('explicit absent or invalid background references never guess another ordinary area', () => {
  assert.equal(tooltipBackgroundWidget(null), null)
  assert.equal(tooltipBackgroundWidget({ backgroundWidgetId: 'placeholder', widgets: null }), null)
  const template = createTooltipTemplate('device')
  template.canvas.height = 400
  const originalHeight = template.widgets[0].frame.height
  for (const reference of ['', 'deleted_background', template.widgets[1].id]) {
    template.backgroundWidgetId = reference
    assert.equal(tooltipBackgroundWidget(template), null)
    const normalized = normalizeTooltipTemplates({ templates: [template] }).templates[0]
    assert.equal(normalized.backgroundWidgetId, '')
    assert.equal(normalized.widgets[0].frame.height, originalHeight)
    assert.equal(tooltipBackgroundWidget(normalized), null)
  }
  delete template.backgroundWidgetId
  template.widgets[0].frame.rotation = 30
  assert.equal(tooltipBackgroundWidget(template), null, 'rotated legacy areas are not silently converted to card backgrounds')
})

test('only a unique lowest upright full-canvas area is eligible for conservative geometric migration', () => {
  const template = createTooltipTemplate('device')
  delete template.backgroundWidgetId
  template.widgets[0].id = 'renamed_area'
  template.widgets[0].title = '原有底板'
  assert.equal(tooltipBackgroundWidget(template), template.widgets[0])
  const extra = { ...template.widgets[0], id: 'another_area', title: '另一个区域', frame: { ...template.widgets[0].frame } }
  template.widgets.push(extra)
  assert.equal(tooltipBackgroundWidget(template), null, 'two competing full-canvas areas must remain independent')
  template.widgets[0].zIndex = -1
  assert.equal(tooltipBackgroundWidget(template), template.widgets[0])
  const normalized = normalizeTooltipTemplates({ templates: [template] }).templates[0]
  const background = tooltipBackgroundWidget(normalized)
  const dividerBefore = template.widgets.find(widget => widget.type === 'container' && widget.frame.height === 1)
  assert.deepEqual(normalized.widgets.find(widget => widget.id === dividerBefore.id).frame, dividerBefore.frame)
  assert.deepEqual(normalized.widgets.find(widget => widget.id === extra.id).frame, extra.frame)
  assert.equal(background.id, 'renamed_area')
})

test('background references follow the precise container when widget IDs normalize or collide with a text ID', () => {
  const template = createTooltipTemplate('device')
  const background = template.widgets[0]
  background.id = 'same id'
  template.backgroundWidgetId = 'same id'
  const text = { ...template.widgets[1], id: 'same id' }
  template.widgets = [text, background]
  const normalized = normalizeTooltipTemplates({ templates: [template] }, [], (widget) => ({ ...widget, id: widget.id.replaceAll(' ', '_') })).templates[0]
  assert.equal(normalized.widgets[0].id, 'same_id')
  assert.notEqual(normalized.backgroundWidgetId, normalized.widgets[0].id)
  assert.equal(tooltipBackgroundWidget(normalized)?.type, 'container')
  assert.equal(tooltipBackgroundWidget(normalized)?.id, normalized.widgets[1].id)
  template.widgets.push({ ...background, frame: { ...background.frame } })
  assert.equal(tooltipBackgroundWidget(template), null, 'ambiguous duplicate containers cannot be guessed')
  assert.equal(normalizeTooltipTemplates({ templates: [template] }).templates[0].backgroundWidgetId, '')
})

test('a trimmed background does not bind to a different area when template widget limits apply', () => {
  const template = createTooltipTemplate('device')
  const background = template.widgets[0]
  template.widgets = Array.from({ length: MAX_TOOLTIP_WIDGETS }, (_, index) => ({ ...template.widgets[1], id: `text_${index}` }))
  template.widgets.push(background)
  const normalized = normalizeTooltipTemplates({ templates: [template] }).templates[0]
  assert.equal(normalized.widgets.length, MAX_TOOLTIP_WIDGETS)
  assert.equal(normalized.backgroundWidgetId, '')
  assert.equal(tooltipBackgroundWidget(normalized), null)
})

test('old frozen device metadata values regain their original dynamic binding without changing static labels or layout', () => {
  const template = createTooltipTemplate('device', 'tooltip_device', { fields: ['name', 'id', 'model', 'status', 'workshop', 'line'] })
  for (const widget of template.widgets) { delete widget.dynamicBinding; delete widget.dynamicField }
  const targets = ['name', 'id_value', 'model_value', 'status_value', 'workshop_value', 'line_value']
  const before = {}
  for (const key of targets) {
    const widget = template.widgets.find(row => row.id === `${template.id}_${key}`)
    before[widget.id] = { frame: structuredClone(widget.frame), style: structuredClone(widget.style), title: widget.title }
    widget.data = { mode: 'static', readOnly: true }
    widget.content = { ...widget.content, text: '数据正常', lines: ['永远正常'], value: '旧设备', valueMap: [{ value: '数据异常 / 未连接', text: '数据正常' }] }
    widget.title += ' · 已改图层名'
    before[widget.id].title = widget.title
  }
  const left = template.widgets.find(row => row.id === `${template.id}_status_label`)
  left.content.text = '我自定义的状态标题'
  const custom = { ...structuredClone(left), id: `${template.id}_item_1793980000000`, title: '自定义文字', content: { text: '数据正常' } }
  template.widgets.push(custom)
  const normalized = normalizeTooltipTemplates({ templates: [template] }).templates[0]
  for (const key of targets) {
    const widget = normalized.widgets.find(row => row.id === `${template.id}_${key}`)
    assert.equal(widget.data.mode, 'runtime')
    assert.match(widget.data.path, /^hover\.device\./)
    assert.equal(widget.dynamicBinding.path, widget.data.path)
    assert.equal(widget.content.text, '{value}')
    assert.equal(widget.content.lines, undefined)
    assert.equal(widget.content.value, undefined)
    assert.equal(widget.content.valueMap, undefined)
    assert.deepEqual(widget.frame, before[widget.id].frame)
    assert.deepEqual(widget.style, before[widget.id].style)
    assert.equal(widget.title, before[widget.id].title)
  }
  assert.equal(normalized.widgets.find(row => row.id === left.id).content.text, '我自定义的状态标题')
  assert.equal(normalized.widgets.find(row => row.id === left.id).data.mode, 'static')
  assert.equal(normalized.widgets.find(row => row.id === custom.id).data.mode, 'static')
  assert.equal(normalized.widgets.find(row => row.id === custom.id).content.text, '数据正常')
  assert.deepEqual(normalizeTooltipTemplates({ templates: [normalized] }).templates[0], normalized)
})

test('old numerically remapped template copies repair only unique original data layer roles', () => {
  const template = createTooltipTemplate('device', 'tooltip_device_1793980000000')
  const oldBackground = template.backgroundWidgetId
  template.widgets.forEach((widget, index) => {
    const previous = widget.id; widget.id = `${template.id}_${index}`
    if (oldBackground === previous) template.backgroundWidgetId = widget.id
    delete widget.dynamicBinding
    delete widget.dynamicField
    if (widget.title === '数据状态数据' || widget.title === '所属车间数据' || widget.title === '所属产线数据') {
      widget.data = { mode: 'static' }; widget.content.text = '旧常量'
    }
  })
  const normalized = normalizeTooltipTemplates({ templates: [template] }).templates[0]
  for (const [title, path] of [['数据状态数据', 'hover.device.status'], ['所属车间数据', 'hover.device.workshopName'], ['所属产线数据', 'hover.device.lineName']]) {
    assert.equal(normalized.widgets.find(row => row.title === title).data.path, path)
  }
  assert.equal(normalized.widgets.find(row => row.title === '数据状态标签').data.mode, 'static')
  const duplicated = structuredClone(template)
  const state = duplicated.widgets.find(row => row.title === '数据状态数据')
  duplicated.widgets.push({ ...structuredClone(state), id: `${template.id}_copy_1793990000000_0` })
  const ambiguous = normalizeTooltipTemplates({ templates: [duplicated] }).templates[0]
  assert.ok(ambiguous.widgets.filter(row => row.title === '数据状态数据').every(row => row.data.mode === 'static'), 'do not infer an erased source from ambiguous copy titles')
})

test('dynamic provenance survives ID/title changes, copies, frontend/backend normalization and attempts to freeze the data', () => {
  const doc = normalizeDashboardDocument()
  const template = doc.tooltipTemplates.templates[0]
  const widget = template.widgets.find(row => row.data.path === 'hover.device.status')
  widget.id = 'copied_and_renamed'; widget.title = '连接字段副本'
  widget.data = { mode: 'static', readOnly: true }
  widget.content.text = '假正常'
  for (const normalize of [normalizeDashboardDocument, normalizeDocument]) {
    const repaired = normalize(doc)
    const target = repaired.tooltipTemplates.templates[0].widgets.find(row => row.id === widget.id)
    assert.equal(target.data.mode, 'runtime')
    assert.equal(target.data.path, 'hover.device.status')
    assert.equal(target.content.text, '{value}')
    assert.equal(target.dynamicBinding.path, 'hover.device.status')
    assert.deepEqual(normalize(repaired).tooltipTemplates, repaired.tooltipTemplates)
  }
  const restored = restoreTooltipDynamicBinding(widget)
  assert.equal(restored.data.path, 'hover.device.status')
  assert.equal(tooltipDynamicBinding(restored).mode, 'runtime')
  const residual = { id: 'imported', type: 'text', data: { mode: 'static', path: 'hover.device.workshopName' }, content: { text: '旧车间' } }
  assert.equal(restoreTooltipDynamicBinding(residual).data.path, 'hover.device.workshopName')
  assert.equal(restoreTooltipDynamicBinding(residual).data.mode, 'runtime')
})

test('part identity and point metadata stay dynamic without a default description, while device copy remains editable', () => {
  const part = createTooltipTemplate('part')
  assert.equal(part.widgets.some(widget=>widget.data.path==='hover.part.description'),false)
  for (const key of ['name', 'group', 'hint', 'point_0_label', 'point_0_value']) {
    const widget = part.widgets.find(row => row.id === `${part.id}_${key}`)
    delete widget.dynamicBinding; delete widget.dynamicField; widget.data = { mode: 'static' }; widget.content.text = '旧部件'
  }
  const normalized = normalizeTooltipTemplates({ templates: [part] }).templates.find(row => row.kind === 'part')
  for (const key of ['name', 'group', 'hint', 'point_0_label', 'point_0_value']) assert.equal(normalized.widgets.find(row => row.id === `${part.id}_${key}`).data.mode, 'runtime')
  assert.equal(normalized.widgets.find(row => row.id === `${part.id}_title`).data.mode, 'static')
  const device = createTooltipTemplate('device', 'tooltip_custom', { description: '固定补充说明' })
  const result = normalizeTooltipTemplates({ templates: [device] }).templates[0]
  assert.equal(result.widgets.find(row => row.id === `${device.id}_description`).data.mode, 'static')
  assert.equal(result.widgets.find(row => row.id === `${device.id}_description`).content.text, '固定补充说明')
})

function legacyPartTooltip(id='tooltip_part') {
  const template=createTooltipTemplate('part',id)
  delete template.partDescriptionCleanupVersion
  template.canvas.height+=50
  for(const widget of template.widgets)if(widget.frame.y>=84)widget.frame.y+=50
  tooltipBackgroundWidget(template).frame.height=template.canvas.height
  const description=JSON.parse(JSON.stringify(template.widgets.find(widget=>widget.id===`${id}_name`)))
  Object.assign(description,{id:`${id}_description`,title:'部件说明',frame:{x:20,y:84,width:240,height:42,rotation:0},dynamicField:'hover.part.description'})
  description.data.path='hover.part.description';description.dynamicBinding.path='hover.part.description'
  template.widgets.push(description)
  return template
}

test('all saved part tooltip templates lose the generated description once, compact the gap and keep real data bindings',()=>{
 const templates=[legacyPartTooltip(),legacyPartTooltip('copied_part')]
 const frozen=templates[1].widgets.find(widget=>widget.title==='部件说明')
 frozen.id='copied_part_99';frozen.data={mode:'static'};frozen.content.text='原 GLB 总成拆解展示；保留节点内部相对位置，不代表实际检修顺序。'
 const original=JSON.stringify(templates)
 const raw={tooltipTemplates:{templates,defaults:{part:'tooltip_part'}}}
 for(const normalize of [normalizeDashboardDocument,normalizeDocument]){
  const document=normalize(raw)
  for(const template of document.tooltipTemplates.templates.filter(template=>template.kind==='part')){
   assert.equal(template.widgets.some(widget=>widget.title==='部件说明'),false)
   assert.equal(template.widgets.some(widget=>widget.data.path==='hover.part.description'),false)
   assert.equal(template.widgets.find(widget=>widget.id===`${template.id}_point_0_value`).frame.y,88)
   assert.equal(template.canvas.height,224)
   assert.equal(tooltipBackgroundWidget(template).frame.height,224)
   assert.equal(template.widgets.find(widget=>widget.id===`${template.id}_name`).data.path,'hover.part.name')
   assert.equal(template.widgets.find(widget=>widget.id===`${template.id}_point_0_value`).data.path,'hover.part.points.0.text')
  }
  assert.deepEqual(normalize(document).tooltipTemplates,document.tooltipTemplates)
 }
 assert.equal(JSON.stringify(templates),original,'cleanup must not mutate stored model/template inputs')
 const resolved=resolveTooltipTemplate(raw,{metadata:{}},'part')
 assert.equal(resolved.widgets.some(widget=>widget.title==='部件说明'),false,'old published snapshots are clean before being edited or saved')
})

test('part description cleanup preserves overlapping authored layouts, other captions and deliberately reconfigured fields',()=>{
 const source=legacyPartTooltip(),caption=JSON.parse(JSON.stringify(source.widgets.find(widget=>widget.title==='部件分组')))
 caption.id='authored-caption';caption.title='自定标题';caption.frame.y=100;caption.data={mode:'static'};delete caption.dynamicField;delete caption.dynamicBinding
 caption.content={text:'用户自定说明'};source.widgets.push(caption)
 const cleaned=cleanLegacyPartTooltip(source)
 assert.equal(cleaned.widgets.find(widget=>widget.id===caption.id).content.text,'用户自定说明')
 assert.equal(cleaned.widgets.find(widget=>widget.id==='tooltip_part_point_0_value').frame.y,138)
 const edited=legacyPartTooltip(),description=edited.widgets.find(widget=>widget.title==='部件说明')
 description.data={mode:'plc',pointId:'real-reading'};description.content.dataSourceConfigured=true
 assert.equal(cleanLegacyPartTooltip(edited).widgets.find(widget=>widget.id===description.id).data.pointId,'real-reading')
 assert.deepEqual(cleanLegacyPartTooltip(cleaned),cleaned)
 const duplicate=legacyPartTooltip(),name=duplicate.widgets.find(widget=>widget.title==='部件名称')
 name.id='tooltip_part_description'
 assert.ok(cleanLegacyPartTooltip(duplicate).widgets.some(widget=>widget.title==='部件名称'),'duplicate IDs cannot delete an unrelated name/data field')
 assert.doesNotThrow(()=>normalizeTooltipTemplates({templates:[{kind:'part',widgets:{}}]}))
})

test('external and numeric bindings keep authored data source/format, and their remembered source cannot be frozen by a mode toggle', () => {
  const template = createTooltipTemplate('device')
  const widget = { id: 'custom_point', title: '采集温度', type: 'text', data: { mode: 'dataset', datasetId: 'temperatures', datasetField: 'value', unit: '°C' }, content: { text: '温度 {value}{unit}' }, frame: { x: 5, y: 5, width: 200, height: 24 }, style: {} }
  template.widgets.push(widget)
  const normalized = normalizeTooltipTemplates({ templates: [template] }).templates[0]
  const point = normalized.widgets.find(row => row.id === widget.id)
  assert.equal(point.data.datasetId, 'temperatures')
  assert.equal(point.content.text, '温度 {value}{unit}')
  point.data = { mode: 'static' }; point.content.text = '999°C'
  const repaired = normalizeTooltipTemplates({ templates: [normalized] }).templates[0].widgets.find(row => row.id === widget.id)
  assert.equal(repaired.data.datasetId, 'temperatures')
  assert.equal(repaired.data.mode, 'dataset')
  assert.match(repaired.content.text, /\{value\}/)
})

test('existing live multiline metadata/numeric formats are preserved while a constant lines override is repaired', () => {
  const widget = { id: 'formatted', type: 'text', data: { mode: 'runtime', path: 'hover.part.description' },
    content: { text: '旧text', lines: ['{value}', '批次 {parameters.batch}'], valueMap: [{ value: '故障', text: '正常' }] } }
  const restored = restoreTooltipDynamicBinding(widget)
  assert.deepEqual(restored.content.lines, widget.content.lines)
  assert.equal(restored.content.text, '旧text')
  assert.equal(restored.content.valueMap, undefined)
  const shadow = { ...widget, content: { text: '说明 {value}', lines: ['冻结文案'] } }
  assert.equal(restoreTooltipDynamicBinding(shadow).content.text, '说明 {value}')
  assert.equal(restoreTooltipDynamicBinding(shadow).content.lines, undefined)
  const point = { ...widget, data: { mode: 'dataset', datasetId: 'source', datasetField: 'value' },
    content: { lines: ['测量 {value}{unit}', '批次 {parameters.batch}'] } }
  assert.deepEqual(restoreTooltipDynamicBinding(point).content.lines, point.content.lines)
})

test('nested point identity and unit metadata share the protected path classifier, unlike measured value/text', () => {
  for (const prefix of ['hover.part.points.0', 'hover.part.points.12', 'hover.device.pointMap.analog.actual_temp']) {
    for (const field of ['name', 'label', 'id', 'unit']) {
      const path = `${prefix}.${field}`
      assert.equal(isTooltipMetadataPath(path), true, path)
      const widget = restoreTooltipDynamicBinding({ id: 'raw_nested', type: 'text', data: { mode: 'static', path },
        content: { text: '旧常量', valueMap: [{ value: '实际点位', text: '伪造点位' }] } })
      assert.equal(widget.data.mode, 'runtime')
      assert.equal(widget.data.path, path)
      assert.equal(widget.content.text, '{value}')
      assert.equal(widget.content.valueMap, undefined)
      assert.equal(widget.dynamicField, undefined, 'ordinary added fields are not system-owned roles')
    }
    for (const field of ['value', 'text']) assert.equal(isTooltipMetadataPath(`${prefix}.${field}`), false)
  }
  for (const path of ['hover.device.pointMap.analog.actual_temp.value', 'hover.part.points.0.text', 'hover.part.points.bad.name', 'hover.device.pointMap.analog.name', 'hover.device.name.extra']) assert.equal(isTooltipMetadataPath(path), false, path)
})

test('preset semantic field markers survive copies, ID changes and backend/frontend normalization without forcing a legal source replacement', () => {
  const template = createTooltipTemplate('device')
  const field = template.widgets.find(row => row.id === `${template.id}_status_value`)
  assert.equal(field.dynamicField, 'hover.device.status')
  const duplicate = structuredClone(field)
  duplicate.id = 'new_id_for_copied_status'; duplicate.title = '任意图层名'
  template.widgets.push(duplicate)
  const doc = normalizeDashboardDocument({ tooltipTemplates: { templates: [template] } })
  for (const normalize of [normalizeDashboardDocument, normalizeDocument]) {
    const normalized = normalize(doc)
    const copy = normalized.tooltipTemplates.templates[0].widgets.find(row => row.id === duplicate.id)
    assert.equal(copy.dynamicField, 'hover.device.status')
    copy.data = { mode: 'static' }; copy.content.text = '常量正常'; delete copy.dynamicBinding
    const repaired = normalize(normalized).tooltipTemplates.templates[0].widgets.find(row => row.id === duplicate.id)
    assert.equal(repaired.data.path, 'hover.device.status')
    assert.equal(repaired.dynamicField, 'hover.device.status')
    assert.equal(repaired.content.text, '{value}')
  }
  const custom = { ...structuredClone(field), data: { mode: 'dataset', datasetId: 'legal_source', datasetField: 'value' } }
  assert.equal(restoreTooltipDynamicBinding(custom, template).data.mode, 'dataset')
  assert.equal(restoreTooltipDynamicBinding(custom, template).data.datasetId, 'legal_source')
  assert.equal(restoreTooltipDynamicBinding(custom, template).dynamicField, 'hover.device.status')
})

test('old numeric preset roles regain dynamicField while newly added metadata bindings remain freely selectable', () => {
  const template = createTooltipTemplate('device', 'tooltip_device_1793991111111')
  template.widgets.forEach((widget, index) => { widget.id = `${template.id}_${index}`; delete widget.dynamicField; delete widget.dynamicBinding })
  const old = normalizeTooltipTemplates({ templates: [template] }).templates[0]
  assert.equal(old.widgets.find(row => row.title === '数据状态数据').dynamicField, 'hover.device.status')
  assert.equal(old.widgets.find(row => row.title === '所属产线数据').dynamicField, 'hover.device.lineName')
  const added = { id: `${template.id}_item_1793991112222`, title: '文字', type: 'text',
    data: { mode: 'runtime', path: 'hover.device.name' }, content: { text: '{value}' } }
  let result = restoreTooltipDynamicBinding(added, template)
  assert.equal(result.dynamicField, undefined)
  result = restoreTooltipDynamicBinding({ ...result, data: { ...result.data, path: 'hover.device.lineName' } }, template)
  assert.equal(result.data.path, 'hover.device.lineName')
  assert.equal(result.dynamicField, undefined)
  result = restoreTooltipDynamicBinding({ ...result, data: { ...result.data, path: 'hover.part.points.0.name' } }, template)
  assert.equal(result.data.path, 'hover.part.points.0.name')
  assert.equal(result.dynamicField, undefined)
  const rejectedMarker = restoreTooltipDynamicBinding({ ...added, dynamicField: 'hover.device.frame.temperature' }, template)
  assert.equal(rejectedMarker.dynamicField, undefined)
  assert.equal(restoreTooltipDynamicBinding({ ...added, dynamicField: ['hover.device.name'] }, template).dynamicField, undefined)
})

test('preset point-name labels have semantic roles, measured point values retain configurable mappings', () => {
  const part = createTooltipTemplate('part')
  const label = part.widgets.find(row => row.id === `${part.id}_point_0_label`)
  const value = part.widgets.find(row => row.id === `${part.id}_point_0_value`)
  assert.equal(label.dynamicField, 'hover.part.points.0.name')
  assert.equal(value.dynamicField, undefined)
  const device = createTooltipTemplate('device', 'device_points', { pointKeys: ['analog.actual_temp'] })
  const name = device.widgets.find(row => row.id === `${device.id}_point_0_label`)
  assert.equal(name.dynamicField, 'hover.device.pointMap.analog.actual_temp.name')
  const mapped = restoreTooltipDynamicBinding({ ...value, content: { text: '{value}', valueMap: [{ value: 1, text: '运行' }] } }, part)
  assert.deepEqual(mapped.content.valueMap, [{ value: 1, text: '运行' }])
})
