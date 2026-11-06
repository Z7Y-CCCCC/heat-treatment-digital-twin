<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { createTooltipTemplate, tooltipBackgroundWidget, restoreTooltipDynamicBinding } from '../../../../../shared/tooltipTemplates.mjs'
import { createTooltipContext, tooltipMetadataPath } from '../../../runtime/tooltipContext.js'
import { createDashboardWidget, deepClone, widgetTypeLabel } from '../../../runtime/dashboardSchema.js'
import { pointKey } from '../../../runtime/pointBinding.js'
import { adminApi } from '../../../config/factoryConfig.js'
import TooltipSurface from '../../../runtime/TooltipSurface.vue'
import ColorField from './ColorField.vue'
import DataSetBindingEditor from './DataSetBindingEditor.vue'
import DataCatalogPicker from './DataCatalogPicker.vue'
import { catalogBinding } from '../../../runtime/dataCatalog.js'
import { addTooltipDataRow } from '../../../runtime/tooltipDataRows.js'
import { effectiveWidgetBackground, updateWidgetBackground } from '../../../runtime/widgetAppearance.js'

const props = defineProps({
  document: Object, views: { type: Array, default: () => [] }, currentViewId: String,
  devices: { type: Array, default: () => [] }, points: { type: Array, default: () => [] },
  workshops: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] },
  metrics: Object, deviceStatusMap: Object, deviceDataMap: Object, pointValues: Object,
  playbackNow: Number, sourceMode: String, readonly: Boolean, factoryId: String, parameters: Object
})
const emit = defineEmits(['change', 'notice'])
const kind = ref('device'), templateId = ref(''), selectedIds = ref([])
const previewDeviceId = ref(''), previewPartId = ref(''), bindingViewId = ref('')
const parts = ref([]), partsBusy = ref(false), partsError = ref('')
const zoom = ref(1.5), snap = ref(true), inspectorTab = ref('content')
const previewSurfaceRef = ref(null)
const addingDataRow = ref(false), dataRowLabel = ref(''), dataRowItem = ref(null)
const previewValues = reactive({})
let partSequence = 0, operation = null, disposed = false, dataPreviewSequence = 0, dataPreviewQueue = 0
const library = [{ type: 'text', label: '文字' }, { type: 'value', label: '数值' }, { type: 'status', label: '状态灯' }, { type: 'container', label: '背景区域' }, { type: 'divider', label: '分隔线' }, { type: 'image', label: '图片' }]
const model = computed(() => props.document?.tooltipTemplates)
const templates = computed(() => (model.value?.templates || []).filter(item => item.kind === kind.value))
const template = computed(() => templates.value.find(item => item.id === templateId.value) || templates.value[0])
const backgroundWidget = computed(() => tooltipBackgroundWidget(template.value))
const selected = computed(() => template.value?.widgets.find(item => item.id === selectedIds.value[0]))
const selectedWidgets = computed(() => template.value?.widgets.filter(item => selectedIds.value.includes(item.id)) || [])
const layers = computed(() => [...(template.value?.widgets || [])].sort((a, b) => b.zIndex - a.zIndex))
const bindingViews = computed(() => props.views.filter(view => kind.value === 'device' ? ['factory', 'workshop', 'line'].includes(view.mode) : view.mode === 'device'))
const bindingView = computed(() => bindingViews.value.find(view => view.id === bindingViewId.value) || bindingViews.value[0])
const viewRef = computed(() => bindingView.value?.metadata?.tooltipTemplates?.[kind.value] || 'inherit')
const previewDevice = computed(() => {
  const device = props.devices.find(item => String(item.id) === previewDeviceId.value)
  if (!device) return null
  const line = props.lines.find(item => String(item.id) === String(device.line_id || device.lineId))
  const workshop = props.workshops.find(item => String(item.id) === String(device.workshop_id || device.workshopId || line?.workshop_id))
  return { ...device, lineId: line?.id || device.line_id || '', lineName: line?.name || '', workshopId: workshop?.id || '', workshopName: workshop?.name || '' }
})
const previewPart = computed(() => parts.value.find(item => item.id === previewPartId.value) || null)
const actualPoints = computed(() => props.points.filter(point => String(point.device_id) === previewDeviceId.value).map(point => {
  const reading = props.pointValues?.[`${previewDeviceId.value}:${point.id}`] || props.pointValues?.[String(point.id)]
  // Definitions may carry saved/imported example values. Only an owned live
  // record is allowed to supply the measurement and its quality in preview.
  const live = reading && String(reading.device_id ?? reading.deviceId ?? '') === previewDeviceId.value ? reading : null
  return { ...point, value: null, quality: 'stale', ...(live || {}), device_id: previewDeviceId.value }
}))
const context = computed(() => createTooltipContext({
  kind: kind.value, device: previewDevice.value, part: previewPart.value,
  status: props.deviceStatusMap?.[previewDeviceId.value] || {},
  frame: props.deviceDataMap?.[previewDeviceId.value] || {}, points: actualPoints.value,
  runtimeContext: { factoryId: props.factoryId || '', viewId: bindingView.value?.id || '', viewMode: kind.value === 'part' ? 'device' : bindingView.value?.mode || 'factory', inspectionStage: bindingView.value?.metadata?.inspectionStage || 'solid' }
}))
// Data previews observe identity/parameters only, not the changing live frame
// embedded in the rendering context; PLC refresh must not erase a DB preview.
const dataPreviewContext = computed(() => ({
  factoryId: props.factoryId || '', tooltipTarget: true, deviceId: previewDeviceId.value,
  partId: kind.value === 'part' ? previewPartId.value : '',
  workshopId: String(previewDevice.value?.workshopId || ''), lineId: String(previewDevice.value?.lineId || ''),
  viewId: bindingView.value?.id || '', viewMode: kind.value === 'part' ? 'device' : bindingView.value?.mode || 'factory',
  parameters: props.parameters || {}
}))
const runtimeFields = computed(() => [
  { path: 'hover.device.name', label: '当前悬停设备 · 名称' },
  { path: 'hover.device.id', label: '当前悬停设备 · 编号' },
  { path: 'hover.device.modelName', label: '当前悬停设备 · 模型名称' },
  { path: 'hover.device.status', label: '当前悬停设备 · 数据状态' },
  { path: 'hover.device.workshopName', label: '当前悬停设备 · 所属车间' },
  { path: 'hover.device.lineName', label: '当前悬停设备 · 所属产线' },
  ...(kind.value === 'part' ? [
    { path: 'hover.part.name', label: '当前悬停部件 · 名称' },
    { path: 'hover.part.id', label: '当前悬停部件 · 编号' },
    { path: 'hover.part.group', label: '当前悬停部件 · 分组' },
    { path: 'hover.part.description', label: '当前悬停部件 · 说明' },
    { path: 'hover.part.hint', label: '当前拆解阶段 · 点击提示' },
    ...Array.from({ length: 8 }, (_, i) => [{ path: `hover.part.points.${i}.name`, label: `部件关联点位 ${i + 1} · 名称` }, { path: `hover.part.points.${i}.value`, label: `部件关联点位 ${i + 1} · 数值` }]).flat()
  ] : [])
])
const canvasStyle = computed(() => ({ width: `${template.value?.canvas.width || 280}px`, height: `${template.value?.canvas.height || 230}px`, transform: `scale(${zoom.value})`, transformOrigin: 'top left' }))
const stageStyle = computed(() => ({ width: `${(template.value?.canvas.width || 280) * zoom.value}px`, height: `${(template.value?.canvas.height || 230) * zoom.value}px` }))
const pointChoices = computed(() => actualPoints.value.filter(point => String(point.access_type || 'READ').toUpperCase() === 'READ'))
const selectedMode = computed(() => selected.value?.data.mode || 'static')
const bindingSources = computed(() => [...(selectedMode.value === 'static' ? [{ id: 'static', label: '固定文案 / 数值' }] : []), { id: 'runtime', label: '悬停设备 / 部件字段' }, { id: 'plc', label: '当前悬停设备点位' }, { id: 'dataset', label: '外部数据表（数据库 / HTTP）' }, ...(!['static', 'runtime', 'plc', 'dataset'].includes(selectedMode.value) ? [{ id: selectedMode.value, label: '原有高级绑定（保留）' }] : [])])
const selectedTextPreview = computed(() => selected.value?.type === 'text' ? previewSurfaceRef.value?.getRenderedText?.(selected.value.id) : undefined)
const selectedTextFormat = computed(() => Array.isArray(selected.value?.content.lines) ? selected.value.content.lines.join('\n') : String(selected.value?.content.text ?? ''))
const selectedLinkedMetadata = computed(() => selectedMode.value === 'runtime' && tooltipMetadataPath(selected.value?.data.path || selected.value?.data.source))
const selectedSystemMetadata = computed(() => selectedLinkedMetadata.value && selected.value?.dynamicField
  === (selected.value?.data.path || selected.value?.data.source))
const selectedTextSource = computed(() => {
  const data = selected.value?.data || {}
  if (data.mode === 'runtime') return runtimeFields.value.find(field => field.path === data.path)?.label || data.path || '悬停对象字段'
  if (data.mode === 'plc') return `当前悬停设备点位 · ${data.pointKey || '尚未选择点位'}`
  if (data.mode === 'dataset') return `外部数据表 · ${data.datasetId || '尚未选择'} / ${data.datasetField || '尚未选择字段'}`
  return bindingSources.value.find(source => source.id === selectedMode.value)?.label || selectedMode.value
})

function change(label = '编辑悬停提示模板') {
  if (props.readonly) return
  emit('change', label)
}
function invalidate() { dataPreviewSequence++; for (const key of Object.keys(previewValues)) delete previewValues[key] }
async function refreshCatalogPreviews() {
  const queue = ++dataPreviewQueue
  await nextTick()
  if (disposed || queue !== dataPreviewQueue || typeof adminApi.previewDataSet !== 'function') return
  const sequence = ++dataPreviewSequence, activeTemplate = template.value
  const currentContext = deepClone(dataPreviewContext.value), contextKey = JSON.stringify(currentContext)
  // Prepared tables are already configured in the data center. Read their
  // preview automatically; novice users must not hunt for a test button.
  // Sequential requests bound load even on an unusually large custom card.
  for (const widget of activeTemplate?.widgets.filter(item => item.data?.mode === 'dataset' && item.data.datasetId && item.data.datasetField) || []) {
    const key = JSON.stringify(widget.data)
    const current = () => !disposed && sequence === dataPreviewSequence && activeTemplate === template.value
      && JSON.stringify(dataPreviewContext.value) === contextKey && activeTemplate.widgets.includes(widget) && JSON.stringify(widget.data) === key
    if (!current()) return
    const scopedContext = widget.data.deviceScope === 'global' ? { ...currentContext, deviceId: '', partId: '', workshopId: '', lineId: '' } : currentContext
    try {
      const response = await adminApi.previewDataSet({ datasetId: widget.data.datasetId, binding: deepClone(widget.data), context: scopedContext })
      if (!current()) return
      if (response.error || !response.result) throw new Error(response.error || '数据表预览读取失败')
      previewValues[widget.id] = { ...response.result, deviceId: scopedContext.deviceId, deviceName: scopedContext.deviceId ? previewDevice.value?.name || '' : '', partId: scopedContext.partId }
    } catch (error) {
      if (!current()) return
      previewValues[widget.id] = { value: null, rows: [], series: [], quality: 'bad', error: error.message, deviceId: scopedContext.deviceId, partId: scopedContext.partId }
    }
  }
}
// Older saved templates can already have lost their live mode. Restore their
// proven binding before classifying the inspector, not just when switching sources.
let repairingBindings = false
function repairDynamicBindings() {
  if (repairingBindings) return
  repairingBindings = true
  try {
    for (const item of model.value?.templates || []) for (const widget of item.widgets || []) {
      const restored = restoreTooltipDynamicBinding(widget, item)
      if (JSON.stringify(restored) !== JSON.stringify(widget)) Object.assign(widget, restored)
    }
  } finally { repairingBindings = false }
}
watch(() => model.value?.templates.map(item => [item.id, item.kind,
  item.widgets?.map(widget => [widget.id, widget.title, widget.data, widget.dynamicBinding, widget.dynamicField,
    widget.content?.text, widget.content?.lines, widget.content?.valueMap])]),
repairDynamicBindings, { deep: true, immediate: true, flush: 'sync' })
// Undo/redo replaces the document object, not the active template identity.
// Compare each source so restoring content does not clear the selected layer.
watch([() => template.value?.id, kind], () => { selectedIds.value = []; addingDataRow.value = false; dataRowItem.value = null; dataRowLabel.value = ''; invalidate() })
watch(dataPreviewContext, invalidate, { deep: true })
watch(() => template.value?.widgets.map(widget => [widget.id, widget.data]), invalidate, { deep: true })
watch([dataPreviewContext, () => template.value?.widgets.filter(widget => widget.data?.mode === 'dataset').map(widget => [widget.id, widget.data])], refreshCatalogPreviews, { deep: true, immediate: true })
watch(() => props.devices.map(device => String(device.id)), ids => {
  if (!ids.includes(previewDeviceId.value)) previewDeviceId.value = ids[0] || ''
}, { immediate: true })
watch(bindingViews, views => {
  if (!views.some(view => view.id === bindingViewId.value)) bindingViewId.value = views.find(view => view.id === props.currentViewId)?.id || views[0]?.id || ''
}, { immediate: true })
watch(() => [templates.value.map(item => item.id), templateId.value], () => {
  if (!templates.value.some(item => item.id === templateId.value)) templateId.value = templates.value.find(item => item.id === model.value?.defaults?.[kind.value])?.id || templates.value[0]?.id || ''
  selectedIds.value = selectedIds.value.filter(id => template.value?.widgets.some(widget => widget.id === id))
}, { immediate: true })
async function loadParts() {
  const id = previewDeviceId.value, sequence = ++partSequence
  parts.value = []; previewPartId.value = ''; partsError.value = ''; partsBusy.value = false
  if (!id || kind.value !== 'part') return
  partsBusy.value = true
  try {
    const result = await adminApi.getDeviceInspection(id)
    if (disposed || sequence !== partSequence || id !== previewDeviceId.value) return
    parts.value = result.inspection?.parts || []
    previewPartId.value = parts.value[0]?.id || ''
  } catch (error) { if (sequence === partSequence) partsError.value = error.message }
  finally { if (sequence === partSequence) partsBusy.value = false }
}
watch(() => [previewDeviceId.value, kind.value], loadParts, { immediate: true })
function chooseTemplate(id) { templateId.value = id }
function newTemplate(copy = false) {
  if (props.readonly || !model.value || model.value.templates.length >= 24) return
  repairDynamicBindings()
  const id = `tooltip_${kind.value}_${Date.now()}`
  const next = copy && template.value ? deepClone(template.value) : createTooltipTemplate(kind.value, id)
  const previousBackgroundId = tooltipBackgroundWidget(next)?.id
  const remappedIds = new Map(), remappedGroups = new Map()
  next.id = id; next.name = copy ? `${template.value.name} · 副本` : kind.value === 'device' ? '新设备提示' : '新部件提示'
  next.widgets.forEach((widget, index) => { const oldId = widget.id; widget.id = `${id}_${index}`; remappedIds.set(oldId, widget.id)
    if (widget.groupId) { if (!remappedGroups.has(widget.groupId)) remappedGroups.set(widget.groupId, `${id}_group_${remappedGroups.size}`); widget.groupId = remappedGroups.get(widget.groupId) }
  })
  next.backgroundWidgetId = remappedIds.get(previousBackgroundId) || ''
  model.value.templates.push(next); templateId.value = id; change(copy ? '复制悬停提示模板' : '新增悬停提示模板')
}
function removeTemplate() {
  if (props.readonly || !template.value) return
  const id = template.value.id
  if (model.value.defaults[kind.value] === id) return emit('notice', '默认模板不能删除，请先指定另一个默认模板')
  model.value.templates = model.value.templates.filter(item => item.id !== id)
  for (const view of props.views) if (view.metadata?.tooltipTemplates?.[kind.value] === id) view.metadata.tooltipTemplates[kind.value] = 'inherit'
  change('删除悬停提示模板')
}
function setDefault() { if (!props.readonly && template.value) { model.value.defaults[kind.value] = template.value.id; change('设置默认悬停提示模板') } }
function setViewRef(value) {
  if (props.readonly || !bindingView.value) return
  const view = bindingView.value
  view.metadata = { ...view.metadata, tooltipTemplates: { ...view.metadata?.tooltipTemplates, [kind.value]: value } }
  if (kind.value === 'device') view.metadata.deviceTooltip = { ...view.metadata.deviceTooltip, enabled: value !== 'disabled' }
  change('修改视角悬停提示模板引用')
}
function selectWidget(id, event = {}) {
  const widget = template.value?.widgets.find(item => item.id === id)
  if (!widget) return
  const members = widget.groupId ? template.value.widgets.filter(item => item.groupId === widget.groupId).map(item => item.id) : [id]
  const ids = [id, ...members.filter(item => item !== id)]
  if (event.ctrlKey || event.metaKey) {
    // Treat groups as one selection unit, even when only part was selected.
    const remove = ids.every(item => selectedIds.value.includes(item))
    selectedIds.value = remove ? selectedIds.value.filter(item => !ids.includes(item)) : [...new Set([...selectedIds.value, ...ids])]
  } else {
    selectedIds.value = event.shiftKey ? [...new Set([...selectedIds.value, ...ids])] : ids
  }
}
function chooseCatalogData(item) {
  if (props.readonly || !selected.value || selectedSystemMetadata.value) return
  const binding = catalogBinding(item, { tooltip: true, kind: kind.value })
  if (!binding) return emit('notice', '此数据项不适用于当前悬停对象')
  selected.value.data = binding
  selected.value.dynamicBinding = deepClone(binding)
  if (selected.value.type === 'text') {
    selected.value.content.text = binding.mode === 'runtime' && tooltipMetadataPath(binding.path) ? '{value}' : '{value}{unit}'
    selected.value.content.datasetTextMode = 'template'
    delete selected.value.content.lines
    delete selected.value.content.valueMap
  }
  invalidate(); change('从数据中心绑定悬停数据')
}
function chooseRowData(item) {
  dataRowItem.value = item
  if (item && !dataRowLabel.value.trim()) dataRowLabel.value = item.label || ''
}
watch(() => [previewDeviceId.value, previewPartId.value, props.factoryId], () => { dataRowItem.value = null })
function confirmDataRow() {
  if (props.readonly || !template.value) return
  pointerEnd()
  try {
    const insertion = addTooltipDataRow(template.value, { item: dataRowItem.value, label: dataRowLabel.value })
    Object.assign(template.value, insertion.template)
    selectedIds.value = insertion.selectedIds
    addingDataRow.value = false; dataRowItem.value = null; dataRowLabel.value = ''
    inspectorTab.value = 'content'; invalidate(); change('添加悬停数据行')
  } catch (error) { emit('notice', error.message) }
}
function addWidget(type) {
  if (props.readonly || !template.value || template.value.widgets.length >= 80) return
  const index = template.value.widgets.length
  const widget = createDashboardWidget(type === 'divider' ? 'container' : type, index)
  widget.id = `${template.value.id}_item_${Date.now()}`
  widget.title = library.find(item => item.type === type)?.label || '组件'
  widget.frame = { x: 20, y: 20, width: Math.min(160, template.value.canvas.width - 20), height: type === 'divider' ? 1 : type === 'container' ? 80 : 24, rotation: 0 }
  widget.style = { ...widget.style, background: 'transparent', backgroundOpacity: 0, borderWidth: 0, borderRadius: 0, padding: 0, fontSize: 12, color: '#e7eaff' }
  widget.content = { ...widget.content, showTitle: false, text: type === 'text' ? '新文字' : '{value}', align: 'left', fallback: '—' }
  widget.data = { mode: 'static', readOnly: true }; widget.events = []; widget.conditions = []
  widget.zIndex = Math.max(0, ...template.value.widgets.map(item => item.zIndex || 0)) + 1
  if (type === 'divider') { widget.style.background = 'rgba(191,202,245,.2)'; widget.style.backgroundOpacity = .2 }
  template.value.widgets.push(widget); selectedIds.value = [widget.id]; change('添加悬停基础组件')
}
function deleteSelected() {
  if (props.readonly || !template.value) return
  template.value.widgets = template.value.widgets.filter(widget => !selectedIds.value.includes(widget.id) || widget.locked)
  if (!template.value.widgets.some(widget => widget.id === template.value.backgroundWidgetId)) template.value.backgroundWidgetId = ''
  selectedIds.value = []; change('删除悬停组件')
}
function copySelected() {
  if (props.readonly || !template.value || !selectedWidgets.value.length) return
  repairDynamicBindings()
  const room = 80 - template.value.widgets.length
  const stamp = Date.now(), groupMap = new Map()
  const copies = selectedWidgets.value.slice(0, room).map((widget, index) => {
    const copy = deepClone(widget); copy.id = `${template.value.id}_copy_${stamp}_${index}`
    copy.frame.x = Math.min(template.value.canvas.width - copy.frame.width, copy.frame.x + 8)
    copy.frame.y = Math.min(template.value.canvas.height - copy.frame.height, copy.frame.y + 8)
    if (copy.groupId) { if (!groupMap.has(copy.groupId)) groupMap.set(copy.groupId, `tooltip_group_${stamp}_${index}`); copy.groupId = groupMap.get(copy.groupId) }
    copy.zIndex = Math.max(0, ...template.value.widgets.map(item => item.zIndex || 0)) + index + 1
    return copy
  })
  template.value.widgets.push(...copies); selectedIds.value = copies.map(widget => widget.id); change('复制悬停组件')
}
function group(ungroup = false) {
  if (props.readonly || !selectedWidgets.value.length || (!ungroup && selectedWidgets.value.length < 2)) return
  const id = ungroup ? '' : `tooltip_group_${Date.now()}`
  selectedWidgets.value.forEach(widget => { widget.groupId = id }); change(ungroup ? '解组悬停组件' : '组合悬停组件')
}
function toggleWidgetLock(widget) {
  if (props.readonly || !template.value?.widgets.includes(widget)) return
  pointerEnd()
  widget.locked = !widget.locked
  change(widget.locked ? '锁定悬停组件' : '解锁悬停组件')
}
function deleteWidget(widget) {
  if (props.readonly || widget.locked || !template.value?.widgets.includes(widget)) return
  pointerEnd()
  template.value.widgets = template.value.widgets.filter(item => item.id !== widget.id)
  if (template.value.backgroundWidgetId === widget.id) template.value.backgroundWidgetId = ''
  selectedIds.value = selectedIds.value.filter(id => id !== widget.id)
  delete previewValues[widget.id]
  change('删除悬停组件')
}
function moveLayer(direction) {
  if (props.readonly || !selected.value) return
  const sorted = [...template.value.widgets].sort((a, b) => a.zIndex - b.zIndex)
  const index = sorted.findIndex(widget => widget.id === selected.value.id), next = Math.max(0, Math.min(sorted.length - 1, index + direction))
  ;[sorted[index], sorted[next]] = [sorted[next], sorted[index]]
  sorted.forEach((widget, i) => { widget.zIndex = i }); change('调整悬停组件层级')
}
function resizeTemplate(width, height) {
  if (props.readonly || !template.value) return
  const canvas = template.value.canvas
  canvas.width = Math.round(Math.max(180, Math.min(960, Number(width) || 280)))
  canvas.height = Math.round(Math.max(80, Math.min(1080, Number(height) || 230)))
  const background = backgroundWidget.value
  if (background) {
    template.value.backgroundWidgetId = background.id
    Object.assign(background.frame, { x: 0, y: 0, width: canvas.width, height: canvas.height, rotation: 0 })
  }
}
function templateGeometryChanged() {
  if (props.readonly || !template.value) return
  resizeTemplate(template.value.canvas.width, template.value.canvas.height)
  change('调整悬停模板尺寸')
}
function geometryChanged() {
  if (props.readonly || !template.value) return
  if (selected.value === backgroundWidget.value && selected.value) {
    resizeTemplate(selected.value.frame.width, selected.value.frame.height)
    change('调整悬停模板尺寸')
    return
  }
  const canvas = template.value.canvas
  resizeTemplate(canvas.width, canvas.height)
  // Ordinary elements are independent; resizing the template never scales or
  // repositions its text/data fields to chase a second background rectangle.
  for (const widget of selectedWidgets.value) {
    widget.frame.width = Math.max(widget.type === 'container' ? 1 : 20, Math.min(canvas.width, Number(widget.frame.width) || 20))
    widget.frame.height = Math.max(widget.type === 'container' ? 1 : 20, Math.min(canvas.height, Number(widget.frame.height) || 20))
    widget.frame.x = Math.max(0, Math.min(canvas.width - widget.frame.width, Number(widget.frame.x) || 0))
    widget.frame.y = Math.max(0, Math.min(canvas.height - widget.frame.height, Number(widget.frame.y) || 0))
  }
  change('修改悬停组件尺寸与位置')
}
function beginPointer(event, widget, resize = false) {
  event.stopPropagation()
  if (event.button !== 0) return
  event.preventDefault()
  pointerEnd()
  const fullySelected = (widget.groupId ? template.value.widgets.filter(item => item.groupId === widget.groupId) : [widget]).every(item => selectedIds.value.includes(item.id))
  // Plain dragging retains the current multi-selection. Resize controls do
  // not toggle selection, while Ctrl/Meta clicks always add/remove once.
  if (resize) {
    if (!fullySelected) selectWidget(widget.id)
  } else if (event.ctrlKey || event.metaKey || event.shiftKey || !fullySelected) {
    selectWidget(widget.id, event)
  }
  if (props.readonly || widget.locked || !selectedIds.value.includes(widget.id)) return
  if (widget === backgroundWidget.value) {
    if (resize) beginCanvasResize(event, 'both')
    return // A full-card background is anchored to the template origin.
  }
  const movable = resize ? [widget] : selectedWidgets.value.filter(item => !item.locked && item !== backgroundWidget.value)
  if (!movable.length) return
  operation = { template: template.value, x: event.clientX, y: event.clientY, resize, frames: movable.map(item => ({ id: item.id, frame: { ...item.frame } })), changed: false }
  window.addEventListener('pointermove', pointerMove); window.addEventListener('pointerup', pointerEnd); window.addEventListener('pointercancel', pointerEnd)
}
function beginCanvasResize(event, axis = 'height') {
  event.stopPropagation(); event.preventDefault()
  if (props.readonly || !template.value || event.button !== 0) return
  pointerEnd()
  operation = { template: template.value, x: event.clientX, y: event.clientY, resizeTemplate: true, axis,
    canvas: { width: template.value.canvas.width, height: template.value.canvas.height }, changed: false }
  window.addEventListener('pointermove', pointerMove); window.addEventListener('pointerup', pointerEnd); window.addEventListener('pointercancel', pointerEnd)
}
function canvasResizeKey(event) {
  if (props.readonly || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.stopPropagation(); event.preventDefault()
  const step = (snap.value ? template.value.canvas.gridSize || 4 : 1) * (event.shiftKey ? 10 : 1)
  resizeTemplate(template.value.canvas.width, template.value.canvas.height + (event.key === 'ArrowDown' ? step : -step))
  change('调整悬停模板尺寸')
}
function pointerMove(event) {
  if (!operation || !template.value) return
  if (props.readonly || operation.template !== template.value) return pointerEnd()
  const grid = snap.value ? template.value.canvas.gridSize || 4 : 1
  let dx = Math.round((event.clientX - operation.x) / zoom.value / grid) * grid, dy = Math.round((event.clientY - operation.y) / zoom.value / grid) * grid
  if (operation.resizeTemplate) {
    resizeTemplate(operation.canvas.width + (operation.axis === 'height' ? 0 : dx), operation.canvas.height + (operation.axis === 'width' ? 0 : dy))
    operation.changed = template.value.canvas.width !== operation.canvas.width || template.value.canvas.height !== operation.canvas.height
    return
  }
  if (!operation.resize && operation.frames.length) {
    // Clamp one common delta so grouped elements retain their relative layout
    // when a member reaches the small canvas boundary.
    const minX = Math.min(...operation.frames.map(item => item.frame.x))
    const minY = Math.min(...operation.frames.map(item => item.frame.y))
    const maxX = Math.max(...operation.frames.map(item => item.frame.x + item.frame.width))
    const maxY = Math.max(...operation.frames.map(item => item.frame.y + item.frame.height))
    dx = Math.max(-minX, Math.min(template.value.canvas.width - maxX, dx))
    dy = Math.max(-minY, Math.min(template.value.canvas.height - maxY, dy))
  }
  for (const item of operation.frames) {
    const widget = template.value.widgets.find(widget => widget.id === item.id)
    if (!widget) continue
    if (operation.resize) {
      widget.frame.width = Math.max(widget.type === 'container' ? 1 : 20, Math.min(template.value.canvas.width - item.frame.x, item.frame.width + dx))
      widget.frame.height = Math.max(widget.type === 'container' ? 1 : 20, Math.min(template.value.canvas.height - item.frame.y, item.frame.height + dy))
    } else {
      widget.frame.x = Math.max(0, Math.min(template.value.canvas.width - item.frame.width, item.frame.x + dx))
      widget.frame.y = Math.max(0, Math.min(template.value.canvas.height - item.frame.height, item.frame.y + dy))
    }
  }
  if (dx || dy) operation.changed = true
}
function pointerEnd() {
  const changed = operation?.changed
  const label = operation?.resizeTemplate ? '调整悬停模板尺寸' : '拖动悬停组件'
  operation = null; window.removeEventListener('pointermove', pointerMove); window.removeEventListener('pointerup', pointerEnd); window.removeEventListener('pointercancel', pointerEnd)
  if (changed) change(label)
}
function selectionStyle(widget) { return { left: `${widget.frame.x}px`, top: `${widget.frame.y}px`, width: `${widget.frame.width}px`, height: `${widget.frame.height}px`, zIndex: widget.zIndex, transform: `rotate(${widget.frame.rotation || 0}deg)` } }
function changeSource(mode) {
  if (props.readonly || !selected.value) return
  repairDynamicBindings()
  const previous = selected.value.data
  // A live/associated field is not an authored caption. Never snapshot its
  // current value into fixed copy (including object descriptions and hints).
  if (mode === 'static' && previous.mode && previous.mode !== 'static') {
    emit('notice', '该元素随数据源或关联对象变化，不能改成固定文案；请编辑对应的标题、标签等固定文字图层。')
    return
  }
  if (selectedSystemMetadata.value && mode !== previous.mode) {
    emit('notice', '这是当前设备／部件的关联动态字段，不能改成其他内容；请修改对应的固定标题，或另加一个数据元素。')
    return
  }
  const data = { ...previous, mode, deviceScope: 'current', deviceId: '', readOnly: true }
  if (mode !== previous.mode) {
    // A pointId is honored by the shared renderer even outside PLC mode.
    // Source-specific fields must not survive a switch and win over the new
    // runtime field/static value; common formatting stays authored.
    for (const key of ['pointId', 'point_id', 'pointKey', 'requireConfiguredPoint', 'source', 'path',
      'datasetId', 'datasetField', 'datasetFields', 'connectionId', 'table', 'valueField', 'timeField',
      'apiPath', 'jsonPath', 'businessSection', 'datasets', 'formula']) delete data[key]
  }
  selected.value.data = data
  if (mode !== 'static' && selected.value.type === 'text') selected.value.content.text = '{value}{unit}'
  if (mode === 'dataset' && selected.value.type === 'text') selected.value.content.datasetTextMode = 'template'
  if (mode === 'runtime' && !selected.value.data.path?.startsWith('hover.')) selected.value.data.path = kind.value === 'part' ? 'hover.part.name' : 'hover.device.name'
  invalidate(); change('修改悬停文字数据来源')
}
function changeBoundText(event) {
  if (props.readonly || !selected.value || selected.value.type !== 'text' || selectedMode.value === 'static') return
  if (selectedLinkedMetadata.value) {
    if (event?.target) event.target.value = selectedTextFormat.value
    emit('notice', '状态、名称、车间／产线等由真实数据和关联对象自动提供，不能自定义显示文字。')
    return
  }
  const format = String(event?.target?.value ?? '')
  if (!format.includes('{value}')) {
    if (event?.target) event.target.value = selectedTextFormat.value
    emit('notice', '数据或关联字段的显示格式必须保留 {value}，不能用固定文字替换当前数据。')
    return
  }
  selected.value.content.text = format
  delete selected.value.content.lines
  change('修改悬停数据展示格式')
}
function choosePoint(id) {
  if (props.readonly || !selected.value) return
  const point = pointChoices.value.find(item => String(item.id) === id)
  Object.assign(selected.value.data, { pointId: '', point_id: '', pointKey: point ? pointKey(point) : '', requireConfiguredPoint: true, path: '', unit: point?.unit || '', decimals: point?.decimals ?? 1, deviceId: '', deviceScope: 'current', readOnly: true })
  invalidate(); change('绑定悬停设备语义点位')
}
function addMap() { if (!props.readonly && selected.value && !selectedLinkedMetadata.value) { (selected.value.content.valueMap ||= []).push({ value: '', text: '' }); change('增加状态文字映射') } }
function keys(event) {
  if (event.target.matches('input,textarea,select') || props.readonly) return
  if ((event.ctrlKey || event.metaKey) && ['z', 'y', 's'].includes(event.key.toLowerCase())) { pointerEnd(); return }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected() }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') { event.preventDefault(); group(event.shiftKey) }
  else if (event.key === 'Delete') { event.preventDefault(); deleteSelected() }
  else if (event.key.startsWith('Arrow')) {
    event.preventDefault(); const step = event.shiftKey ? 10 : 1
    selectedWidgets.value.filter(widget => !widget.locked).forEach(widget => { widget.frame.x += event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0; widget.frame.y += event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0 }); geometryChanged()
  }
}
onBeforeUnmount(() => { disposed = true; partSequence++; pointerEnd() })
</script>

<template>
  <section class="tooltip-template-editor" aria-label="悬停提示模板编辑器" @keydown="keys">
    <aside class="tooltip-template-library">
      <nav class="tooltip-kind-tabs" aria-label="悬停提示类型"><button v-for="item in [{ id: 'device', label: '设备提示' }, { id: 'part', label: '部件提示' }]" :key="item.id" type="button" :class="{ active: kind === item.id }" @click="kind = item.id">{{ item.label }}</button></nav>
      <div class="tooltip-panel-heading"><strong>共享模板</strong><small>各视角引用，不重复制作</small></div>
      <button v-for="item in templates" :key="item.id" type="button" class="tooltip-template-row" :class="{ active: template?.id === item.id }" :data-tooltip-template-id="item.id" @click="chooseTemplate(item.id)"><span>{{ item.name }}</span><small v-if="model.defaults[kind] === item.id">默认</small></button>
      <div class="tooltip-button-row"><button type="button" :disabled="readonly || model?.templates.length >= 24" @click="newTemplate()">＋ 新模板</button><button type="button" :disabled="readonly || !template || model?.templates.length >= 24" @click="newTemplate(true)">复制模板</button></div>
      <fieldset class="tooltip-view-binding" :disabled="readonly">
        <legend>视角引用</legend>
        <label>配置视角<select v-model="bindingViewId" aria-label="提示模板应用视角"><option v-for="view in bindingViews" :key="view.id" :value="view.id">{{ view.name }}</option></select></label>
        <label>使用模板<select :value="viewRef" aria-label="视角提示模板" :disabled="!bindingView" @change="setViewRef($event.target.value)"><option value="inherit">继承默认模板</option><option value="disabled">关闭提示</option><option v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      </fieldset>
      <div class="tooltip-panel-heading"><strong>基础组件</strong><small>每个元素均可单独绑定</small></div>
      <div class="tooltip-component-library"><button v-for="item in library" :key="item.type" type="button" :disabled="readonly || !template || template.widgets.length >= 80" @click="addWidget(item.type)">＋ {{ item.label }}</button></div>
      <div class="tooltip-panel-heading"><strong>内部图层</strong><small>Ctrl 点击多选 / 再点取消</small></div>
      <button v-for="widget in layers" :key="widget.id" type="button" class="tooltip-layer-row" :class="{ active: selectedIds.includes(widget.id) }" :data-tooltip-layer-id="widget.id" @click="selectWidget(widget.id, $event)"><span>{{ widget.title || widgetTypeLabel(widget.type) }}</span><small>{{ widget.locked ? '锁定' : widget.groupId ? '组合' : widgetTypeLabel(widget.type) }}</small></button>
    </aside>
    <main class="tooltip-template-workspace">
      <header class="tooltip-preview-controls"><label>预览设备<select v-model="previewDeviceId" aria-label="悬停预览设备"><option v-if="!devices.length" value="">暂无设备</option><option v-for="device in devices" :key="device.id" :value="String(device.id)">{{ device.name || device.id }}</option></select></label><label v-if="kind === 'part'">预览部件<select v-model="previewPartId" aria-label="悬停预览部件" :disabled="partsBusy || !parts.length"><option v-if="!parts.length" value="">{{ partsBusy ? '读取中…' : '暂无配置部件' }}</option><option v-for="part in parts" :key="part.id" :value="part.id">{{ part.name || part.id }}</option></select></label><button v-if="kind === 'part'" type="button" :disabled="partsBusy || !previewDeviceId" @click="loadParts">刷新部件</button></header>
      <p class="tooltip-preview-note">预览对象只用于检查数据；模板运行时自动显示鼠标当前悬停的设备或部件。</p>
      <p v-if="partsError" class="tooltip-error" role="alert">{{ partsError }}</p>
      <div class="tooltip-local-toolbar"><button type="button" @click="zoom = Math.max(.5, zoom - .25)">−</button><span>{{ Math.round(zoom * 100) }}%</span><button type="button" @click="zoom = Math.min(2.5, zoom + .25)">＋</button><label><input v-model="snap" type="checkbox" /> 网格吸附</label><span class="tooltip-toolbar-spacer"></span><button type="button" class="tooltip-add-data-row" :disabled="readonly || !template || template.widgets.length > 77" :aria-expanded="addingDataRow" @click="addingDataRow = !addingDataRow">＋ 添加数据行</button><button type="button" :disabled="readonly || !selectedIds.length" @click="copySelected">复制元素</button><button type="button" :disabled="readonly || selectedIds.length < 2" @click="group()">组合</button><button type="button" :disabled="readonly || !selectedWidgets.some(widget => widget.groupId)" @click="group(true)">解组</button></div>
      <section v-if="addingDataRow" class="tooltip-data-row-form" aria-label="添加悬停数据行">
        <header><strong>添加数据行</strong><button type="button" aria-label="关闭添加数据行" @click="addingDataRow = false">×</button></header>
        <p>标题可自定义；右侧保留动态绑定。字体、对齐和分隔线沿用当前卡片，提示高度自动增加。</p>
        <label>左侧数据标题<input v-model="dataRowLabel" aria-label="新数据行标题" maxlength="128" placeholder="例如：炉内温度" :disabled="readonly" /></label>
        <DataCatalogPicker :key="`row-${template?.id}`" :factory-id="factoryId" :device-id="previewDeviceId" tooltip :kind="kind" widget-type="text" :disabled="readonly" immediate @select="chooseRowData" />
        <footer><span>{{ dataRowItem ? `右侧：${dataRowItem.label}` : '请选择右侧的实际数据' }}</span><button type="button" :disabled="readonly || !dataRowItem || !dataRowLabel.trim()" @click="confirmDataRow">添加这一行</button></footer>
      </section>
      <div class="tooltip-canvas-viewport" @pointerdown.self="selectedIds = []">
        <div v-if="template" class="tooltip-canvas-stage" :style="stageStyle"><div class="tooltip-small-canvas" :style="canvasStyle" :data-tooltip-canvas="template.id">
          <TooltipSurface ref="previewSurfaceRef" :template="template" :context="context" preview :database-values="previewValues" :metrics="metrics" :device-status-map="deviceStatusMap" :device-data-map="deviceDataMap" :point-values="pointValues" :device-catalog="previewDevice ? [previewDevice] : []" :parameters="parameters || {}" :parameter-definitions="document.parameters || []" :playback-now="playbackNow" :data-ready="true" />
          <button v-if="!readonly" type="button" class="tooltip-canvas-resize-handle s" aria-label="调整悬停模板高度" title="拖动调整提示高度，背景自动贴合；方向键微调" @pointerdown="beginCanvasResize($event, 'height')" @keydown="canvasResizeKey"></button>
          <div class="tooltip-interaction-layer">
            <div v-for="widget in template.widgets" :key="widget.id" class="tooltip-element-hitbox" :class="{ selected: selectedIds.includes(widget.id), locked: widget.locked }" :style="selectionStyle(widget)" :data-tooltip-widget-id="widget.id" :aria-label="widget.title || widgetTypeLabel(widget.type)" @pointerdown="beginPointer($event, widget)"></div>
          </div>
          <div class="tooltip-selection-layer">
            <div v-for="widget in selectedWidgets" :key="widget.id" class="tooltip-selection-frame" :class="{ locked: widget.locked }" :style="selectionStyle(widget)" :data-tooltip-selection-id="widget.id">
              <div class="tooltip-element-actions" @pointerdown.stop @click.stop>
                <button type="button" class="tooltip-element-lock" :class="{ locked: widget.locked }" :disabled="readonly" :aria-label="`${widget.locked ? '解锁' : '锁定'}悬停元素 ${widget.title || widgetTypeLabel(widget.type)}`" :title="widget.locked ? '解锁此元素' : '锁定此元素'" @click="toggleWidgetLock(widget)">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path v-if="widget.locked" d="M8 10V7a4 4 0 0 1 8 0v3"/><path v-else d="M8 10V7a4 4 0 0 1 7.2-2.4"/><path d="M12 14v3"/></svg>
                </button>
                <button type="button" class="tooltip-element-delete" :disabled="readonly || widget.locked" :aria-label="`删除悬停元素 ${widget.title || widgetTypeLabel(widget.type)}`" :title="widget.locked ? '锁定元素不能删除' : '删除此元素'" @click="deleteWidget(widget)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg></button>
              </div>
              <span v-if="!readonly && !widget.locked" class="tooltip-resize-handle" @pointerdown="beginPointer($event, widget, true)"></span>
            </div>
          </div>
        </div></div>
      </div>
      <footer class="tooltip-canvas-footer"><span>{{ template?.canvas.width }} × {{ template?.canvas.height }} · {{ template?.widgets.length || 0 }} 个基础组件 · {{ selectedIds.length }} 个已选</span><span>{{ sourceMode === 'simulation' ? '内置模拟器数据' : '当前工厂数据源' }}</span></footer>
    </main>
    <aside class="tooltip-template-inspector">
      <fieldset v-if="template" class="tooltip-template-properties" :disabled="readonly"><legend>模板设置</legend><label>模板名称<input v-model="template.name" maxlength="80" aria-label="悬停模板名称" @change="change('修改悬停模板名称')" /></label><div class="tooltip-property-grid"><label>宽度<input v-model.number="template.canvas.width" aria-label="悬停模板宽度" type="number" min="180" max="960" @change="templateGeometryChanged" /></label><label>高度<input v-model.number="template.canvas.height" aria-label="悬停模板高度" type="number" min="80" max="1080" @change="templateGeometryChanged" /></label></div><div class="tooltip-button-row"><button type="button" :disabled="model.defaults[kind] === template.id" @click="setDefault">设为默认</button><button type="button" :disabled="model.defaults[kind] === template.id" @click="removeTemplate">删除模板</button></div></fieldset>
      <template v-if="selected">
        <div class="tooltip-panel-heading"><strong>{{ selected.title || widgetTypeLabel(selected.type) }}</strong><small>{{ selected === backgroundWidget ? '提示背景 · 随模板尺寸' : selectedIds.length > 1 ? '已多选，属性编辑首个元素' : '独立基础组件' }}</small></div>
        <nav class="tooltip-inspector-tabs"><button v-for="tab in [{ id: 'content', label: '内容' }, { id: 'style', label: '样式' }, { id: 'data', label: '数据来源' }]" :key="tab.id" type="button" :class="{ active: inspectorTab === tab.id }" @click="inspectorTab = tab.id">{{ tab.label }}</button></nav>
        <fieldset class="tooltip-element-properties" :disabled="readonly">
          <template v-if="inspectorTab === 'content'"><label>图层名称<input v-model="selected.title" aria-label="悬停元素名称" @change="change('修改悬停图层名称')" /></label><template v-if="selected.type === 'text'">
              <div v-if="selectedMode !== 'static'" class="tooltip-text-binding-info">
                <strong>{{ selectedLinkedMetadata ? '关联动态文字 · 不可自定义' : '数据绑定文字' }}</strong>
                <span>{{ selectedTextSource }}</span>
                <label>当前显示<textarea :value="selectedTextPreview ?? ''" aria-label="悬停文字当前显示" rows="3" readonly placeholder="当前没有可预览的文字"></textarea></label>
                <p>内容由数据源或当前设备／部件自动提供，会随关联对象变化，不能改成固定文案。标题、标签等写死文字，请选对应的固定文字图层修改。</p>
                <p v-if="selected.data.path === 'hover.part.description'">部件说明来自部件资料；要修改这段说明，请编辑该部件的源说明，不要把所有部件改成同一段文字。</p>
              </div>
              <label v-if="selectedMode === 'static'">固定文案<textarea v-model="selected.content.text" aria-label="悬停元素文字" rows="3" placeholder="直接输入要显示的标题、标签或固定说明" @change="change('修改悬停固定文案')"></textarea></label>
              <label v-else-if="!selectedLinkedMetadata">显示格式（保留 {value}）<textarea :value="selectedTextFormat" aria-label="悬停元素文字" rows="3" placeholder="必须保留 {value}；可设置单位或前后缀" @change="changeBoundText($event)"></textarea></label>
              <p v-if="!selectedLinkedMetadata" class="tooltip-text-edit-hint">{{ selectedMode === 'static' ? '这里编辑的是写死的文案，不是连接状态、关联信息或实时数据。' : '{value} 代表真实数据或关联信息，不能删除或替换成常量。只修改展示格式，不改动数据本身。' }}</p>
            </template><label v-if="['value', 'status'].includes(selected.type)">数值 / 状态标签<input v-model="selected.content.label" aria-label="悬停数值标签" @change="change('修改悬停数值标签')" /></label><label v-if="selected.type === 'image'">图片地址<input v-model="selected.content.url" @change="change('修改提示图片')" /></label><label>对齐<select v-model="selected.content.align" @change="change('修改悬停文字对齐')"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label><label v-if="!selectedLinkedMetadata">空值 / 异常时显示<input v-model="selected.content.fallback" aria-label="悬停空值文字" @change="change('修改悬停空值文字')" /></label><details v-if="['text', 'value'].includes(selected.type) && !selectedLinkedMetadata"><summary>状态文字映射</summary><div v-for="(entry, index) in selected.content.valueMap || []" :key="index" class="tooltip-mapping-row"><input v-model="entry.value" aria-label="映射原值" placeholder="原值" @change="change()" /><input v-model="entry.text" aria-label="映射文字" placeholder="显示文字" @change="change()" /><button type="button" @click="selected.content.valueMap.splice(index, 1); change()">×</button></div><button type="button" @click="addMap">＋ 映射规则</button></details></template>
          <template v-else-if="inspectorTab === 'style'"><div class="tooltip-property-grid"><label>X<input v-model.number="selected.frame.x" type="number" @change="geometryChanged" /></label><label>Y<input v-model.number="selected.frame.y" type="number" @change="geometryChanged" /></label><label>宽度<input v-model.number="selected.frame.width" type="number" min="1" @change="geometryChanged" /></label><label>高度<input v-model.number="selected.frame.height" type="number" min="1" @change="geometryChanged" /></label><label>字号<input v-model.number="selected.style.fontSize" type="number" min="8" max="120" @change="change('修改悬停字号')" /></label><label>字重<select v-model.number="selected.style.fontWeight" @change="change()"><option :value="400">常规</option><option :value="500">中等</option><option :value="600">半粗</option><option :value="700">粗体</option></select></label><label>圆角<input v-model.number="selected.style.borderRadius" type="number" min="0" max="80" @change="change()" /></label><label>内边距<input v-model.number="selected.style.padding" type="number" min="0" max="100" @change="change()" /></label></div><ColorField v-model="selected.style.color" label="文字颜色" @commit="change('修改提示文字颜色')" /><ColorField v-if="selected.type === 'value'" v-model="selected.style.valueColor" label="数值颜色" @commit="change('修改提示数值颜色')" /><ColorField :model-value="effectiveWidgetBackground(selected.style)" label="背景颜色" @update:model-value="updateWidgetBackground(selected.style, $event)" @commit="change('修改提示背景颜色')" /><ColorField v-model="selected.style.borderColor" label="边框颜色" @commit="change()" /><label>边框宽度<input v-model.number="selected.style.borderWidth" type="number" min="0" max="10" @change="change()" /></label><div class="tooltip-button-row"><button type="button" @click="moveLayer(-1)">下移一层</button><button type="button" @click="moveLayer(1)">上移一层</button></div></template>
          <template v-else-if="selectedSystemMetadata"><div class="tooltip-text-binding-info"><strong>关联动态字段 · 保留绑定</strong><span>{{ selectedTextSource }}</span><label>绑定字段<input :value="selected.data.path || selected.data.source" aria-label="悬停关联字段" readonly /></label><p>状态、名称、车间／产线等来自当前悬停对象，不能改成固定文字或换成其他内容。字体、颜色、位置仍可在样式中调整。</p></div></template>
          <template v-else><DataCatalogPicker :key="selected.id" :binding="selected.data" :factory-id="factoryId" :device-id="previewDeviceId" tooltip :kind="kind" :widget-type="selected.type" :disabled="readonly" @select="chooseCatalogData" /><details class="tooltip-binding-advanced"><summary>高级绑定设置（保留原有配置）</summary><label>数据来源<select :value="selectedMode" aria-label="悬停元素数据来源" @change="changeSource($event.target.value)"><option v-for="source in bindingSources" :key="source.id" :value="source.id">{{ source.label }}</option></select></label><p class="tooltip-binding-hint">绑定范围：当前悬停{{ kind === 'part' ? '部件及所属设备' : '设备' }}。预览选择不会写入固定设备 ID。</p>
            <template v-if="selectedMode === 'static'"><label v-if="selected.type === 'value'">固定数值<input v-model="selected.content.value" @change="change()" /></label></template>
            <template v-else-if="selectedMode === 'runtime'"><label>字段<select v-model="selected.data.path" aria-label="悬停字段" @change="change('修改悬停字段')"><option v-if="selected.data.path && !runtimeFields.some(field => field.path === selected.data.path)" :value="selected.data.path">{{ selected.data.path }}</option><option v-for="field in runtimeFields" :key="field.path" :value="field.path">{{ field.label }}</option></select></label><label>自定义字段路径<input v-model="selected.data.path" placeholder="hover.device.name" @change="change('修改悬停自定义字段')" /></label></template>
            <template v-else-if="selectedMode === 'plc'"><label>预览设备的采集点位<select :value="pointChoices.find(point => pointKey(point) === selected.data.pointKey)?.id || ''" aria-label="悬停采集点位" @change="choosePoint($event.target.value)"><option value="">请选择只读点位</option><option v-for="point in pointChoices" :key="point.id" :value="String(point.id)">{{ point.label || point.display_name || point.name }} · {{ pointKey(point) }}</option></select></label><p v-if="!pointChoices.length" class="tooltip-binding-hint">该设备暂无采集点位，请先配置点位映射。</p><label>通用点位键<input v-model="selected.data.pointKey" placeholder="analog.temperature" @change="change('修改提示语义点位')" /></label></template>
            <DataSetBindingEditor v-else-if="selectedMode === 'dataset'" :key="`${selected.id}:${previewDeviceId}:${previewPartId}`" :binding="selected.data" :context="dataPreviewContext" :devices="previewDevice ? [previewDevice] : []" :playback-now="playbackNow" :disabled="readonly" @change="change('修改提示数据表')" @invalidate="invalidate" @preview="previewValues[selected.id] = $event" />
            <p v-else class="tooltip-binding-hint">原有高级绑定已保留，可改用已配置的数据库或 HTTP 数据表。</p>
            <div v-if="!selectedLinkedMetadata" class="tooltip-property-grid"><label>单位<input v-model="selected.data.unit" @change="change('修改悬停单位')" /></label><label>小数位<input v-model.number="selected.data.decimals" type="number" min="0" max="8" @change="change('修改悬停小数位')" /></label></div><label v-if="selectedMode === 'dataset'">刷新间隔（毫秒）<input v-model.number="selected.data.refreshMs" type="number" min="250" max="3600000" @change="change('修改提示刷新频率')" /></label>
          </details></template>
        </fieldset>
      </template>
      <p v-else class="tooltip-empty-inspector">从提示卡或内部图层列表选择元素，分别编辑内容、样式和数据来源。</p>
    </aside>
  </section>
</template>

<style scoped>
.tooltip-template-editor .tooltip-add-data-row{color:#3166ad;border-color:#bed2ed;background:#f0f6ff;font-weight:600}.tooltip-data-row-form{display:grid;gap:10px;padding:15px;margin:0 16px 12px;border:1px solid #cbdcf3;border-radius:10px;background:#f9fbff;color:#445879}.tooltip-data-row-form header,.tooltip-data-row-form footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.tooltip-data-row-form header strong{font-size:13px}.tooltip-data-row-form header button{border:0;background:none;padding:2px 6px;font-size:18px;color:#8192ab}.tooltip-data-row-form>p{margin:0;font-size:11px;color:#8693a6;line-height:1.6}.tooltip-data-row-form>label{display:grid;gap:6px;font-size:12px}.tooltip-data-row-form>label input{padding:8px 10px;border:1px solid #d9e2f0;border-radius:6px;font:inherit}.tooltip-data-row-form footer span{font-size:11px;color:#7a8da9}.tooltip-data-row-form footer button{padding:8px 14px;border:1px solid #3b73c6;border-radius:6px;background:#3b73c6;color:#fff}.tooltip-data-row-form button:disabled{opacity:.4}.tooltip-binding-advanced{margin-top:14px;border-top:1px solid #e4eaf2;padding-top:10px}.tooltip-binding-advanced>summary{margin-bottom:12px;color:#8994a5;font-size:11px;cursor:pointer}

.tooltip-template-editor{display:grid;grid-template-columns:220px minmax(340px,1fr) 300px;flex:1;min-height:0;overflow:auto;background:#f5f6f8;color:#344054;font-size:calc(12px * var(--admin-font-scale,1));font-family:inherit}
.tooltip-template-library,.tooltip-template-inspector{overflow:auto;min-height:0;background:#fff;padding:12px;box-sizing:border-box}.tooltip-template-library{border-right:1px solid #dfe3e8}.tooltip-template-inspector{border-left:1px solid #dfe3e8}.tooltip-panel-heading{display:grid;gap:4px;padding:12px 0 8px}.tooltip-panel-heading small,.tooltip-template-row small,.tooltip-layer-row small{color:#7c8798;font-size:calc(10px * var(--admin-font-scale,1))}.tooltip-kind-tabs,.tooltip-inspector-tabs{display:flex;gap:4px}.tooltip-kind-tabs button,.tooltip-inspector-tabs button{flex:1}.tooltip-template-editor button,.tooltip-template-editor input,.tooltip-template-editor select,.tooltip-template-editor textarea{box-sizing:border-box;min-width:0;border:1px solid #d4dbe4;border-radius:5px;background:#fff;color:#344054;font:inherit;padding:7px}.tooltip-template-editor button{cursor:pointer}.tooltip-template-editor button:disabled{cursor:default;opacity:.5}.tooltip-template-editor button:hover:not(:disabled){background:#edf3fb}.tooltip-template-editor button.active{background:#eaf1ff;border-color:#9db8e1;color:#245cb3}.tooltip-template-editor button:focus-visible,.tooltip-template-editor input:focus-visible,.tooltip-template-editor select:focus-visible,.tooltip-template-editor textarea:focus-visible{outline:2px solid #4285db;outline-offset:1px}.tooltip-template-row,.tooltip-layer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;margin-bottom:5px;text-align:left}.tooltip-template-row span,.tooltip-layer-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tooltip-button-row{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap}.tooltip-button-row button{flex:1}.tooltip-component-library{display:grid;grid-template-columns:1fr 1fr;gap:5px}.tooltip-view-binding,.tooltip-template-properties,.tooltip-element-properties{min-width:0;border:0;margin:12px 0 0;padding:0;display:grid;gap:10px}.tooltip-template-editor legend{font-weight:600;padding:0 0 8px}.tooltip-template-editor label{display:grid;gap:5px;min-width:0}.tooltip-template-editor label input,.tooltip-template-editor label select,.tooltip-template-editor textarea{width:100%}.tooltip-preview-controls{display:flex;align-items:end;gap:10px;flex-wrap:wrap;padding:14px 16px 0}.tooltip-preview-controls label{flex:1;min-width:140px;max-width:240px}.tooltip-preview-note,.tooltip-binding-hint,.tooltip-empty-inspector{margin:10px 0;color:#7a8596;font-size:calc(11px * var(--admin-font-scale,1));line-height:1.6}.tooltip-preview-note{padding:0 16px}.tooltip-template-workspace{min-width:0;display:flex;flex-direction:column;min-height:0}.tooltip-local-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid #dfe3e8}.tooltip-local-toolbar label{display:flex;align-items:center;gap:5px}.tooltip-local-toolbar input{width:auto}.tooltip-toolbar-spacer{flex:1}.tooltip-canvas-viewport{flex:1;min-height:320px;overflow:auto;padding:28px;display:grid;place-items:start center;background-color:#111b2b;background-image:linear-gradient(rgba(146,166,210,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(146,166,210,.06) 1px,transparent 1px);background-size:20px 20px}.tooltip-canvas-stage{position:relative;flex-shrink:0;margin:15px}.tooltip-small-canvas{position:relative;outline:1px dashed rgba(177,193,230,.38)}.tooltip-element-hitbox{position:absolute;box-sizing:border-box;cursor:move;border:1px solid transparent;touch-action:none;user-select:none;transform-origin:center}.tooltip-element-hitbox:hover{border-color:rgba(69,190,252,.6)}.tooltip-element-hitbox.selected{border-color:#51bfff;outline:1px solid #51bfff}.tooltip-element-hitbox.locked{cursor:default}.tooltip-resize-handle{position:absolute;right:-4px;bottom:-4px;width:8px;height:8px;border:1px solid #dff4ff;background:#168dca;cursor:nwse-resize;box-sizing:border-box}.tooltip-canvas-footer{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 16px;font-size:calc(10px * var(--admin-font-scale,1));color:#7a8596}.tooltip-property-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.tooltip-template-inspector .tooltip-inspector-tabs{margin-top:8px}.tooltip-mapping-row{display:grid;grid-template-columns:1fr 1fr 30px;gap:4px;margin:6px 0}.tooltip-error{color:#b24c4c;padding:0 16px}.tooltip-template-editor fieldset:disabled{opacity:.7}.tooltip-element-properties details summary{cursor:pointer}.tooltip-empty-inspector{padding:20px 0}
.tooltip-interaction-layer,.tooltip-selection-layer{position:absolute;inset:0;pointer-events:none;overflow:visible}.tooltip-interaction-layer{z-index:2000}.tooltip-selection-layer{z-index:3000}.tooltip-interaction-layer .tooltip-element-hitbox{pointer-events:auto}.tooltip-interaction-layer .tooltip-element-hitbox.selected{border-color:transparent;outline:none}.tooltip-selection-frame{position:absolute;box-sizing:border-box;pointer-events:none;border:1.5px solid #51bfff;background:rgba(81,191,255,.08);box-shadow:0 0 0 1px rgba(5,17,32,.4),0 0 9px rgba(81,191,255,.16);transform-origin:center}.tooltip-selection-frame.locked{border-style:dashed}.tooltip-selection-frame .tooltip-resize-handle{pointer-events:auto}.tooltip-element-actions{position:absolute;top:-25px;right:-2px;display:flex;gap:3px;align-items:center;pointer-events:auto}.tooltip-template-editor .tooltip-element-actions button{display:grid;place-items:center;width:21px;height:21px;padding:0;border:1px solid rgba(195,216,242,.55);border-radius:5px;color:#e6f1ff;background:rgba(15,28,42,.95);box-shadow:0 2px 7px rgba(0,0,0,.25);pointer-events:auto}.tooltip-element-actions button svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.tooltip-template-editor .tooltip-element-actions button:hover:not(:disabled){border-color:#fff;background:#263b57}.tooltip-template-editor .tooltip-element-actions .tooltip-element-lock.locked{color:#ffe0a3;border-color:#d9a24f;background:#5c3d18}.tooltip-template-editor .tooltip-element-actions .tooltip-element-delete{color:#ffaaa4;border-color:rgba(255,127,120,.6)}.tooltip-template-editor .tooltip-element-actions .tooltip-element-delete:hover:not(:disabled){color:#fff;border-color:#ff8f88;background:#762d2a}.tooltip-template-editor .tooltip-element-actions button:disabled{opacity:.42}
.tooltip-template-editor .tooltip-canvas-resize-handle{position:absolute;z-index:4000;width:34px;height:10px;min-width:0;padding:0;border:1px solid #dff6ff;border-radius:3px;background:#168dca;box-shadow:0 1px 4px rgba(0,0,0,.5);pointer-events:auto}.tooltip-canvas-resize-handle.s{left:50%;bottom:-5px;transform:translateX(-50%);cursor:ns-resize;touch-action:none}.tooltip-canvas-resize-handle:focus-visible{outline:2px solid #83d4ff;outline-offset:3px}
.tooltip-text-binding-info{display:grid;gap:7px;padding:11px;border:1px solid #cbdaf3;border-radius:8px;background:#f3f7ff;color:#354a6d}.tooltip-text-binding-info>strong{font-size:12px}.tooltip-text-binding-info>span{font-size:11px;overflow-wrap:anywhere}.tooltip-text-binding-info label{margin:0}.tooltip-text-binding-info textarea[readonly]{background:#edf2fa;color:#586b86;cursor:text}.tooltip-text-binding-info p,.tooltip-text-edit-hint{margin:0;color:#7b899e;font-size:11px;line-height:1.6}.tooltip-text-edit-hint{margin-bottom:11px}
@media(max-width:1150px){.tooltip-template-editor{grid-template-columns:190px minmax(300px,1fr) 270px}}
@media(max-width:800px){.tooltip-template-editor{grid-template-columns:180px minmax(300px,1fr);min-width:600px}.tooltip-template-inspector{grid-column:1/-1;overflow:visible;border-top:1px solid #dfe3e8;display:grid;grid-template-columns:220px 1fr;gap:15px}.tooltip-template-inspector .tooltip-panel-heading{grid-column:2}.tooltip-element-properties,.tooltip-inspector-tabs{grid-column:2}}
</style>
