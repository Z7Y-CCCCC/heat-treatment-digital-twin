<script setup>
import { computed, ref, watch, onUnmounted, onMounted } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import { cacheFactoryDraft, readFactoryDraft, clearFactoryDraft } from '../../../runtime/factoryDraftCache.js'
import { createDashboardDataStore } from '../../../runtime/DataStore.js'
import { receiveMotionSignal, stepMotionSignal } from '../../../three/PortableMotionPlayer.js'
import { isRetiredMotionAction } from '../../../../../shared/motionActionAvailability.mjs'
import DeviceHierarchyPicker from './DeviceHierarchyPicker.vue'
import MotionDataPicker from './MotionDataPicker.vue'
import MotionEndpointPicker from './MotionEndpointPicker.vue'
const props = defineProps({ devices: { type: Array, default: () => [] }, models: { type: Array, default: () => [] }, factories: { type: Array, default: () => [] }, workshops: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] }, factoryId: String, requestFactorySwitch: Function, devicePickerTarget: { type: String, default: '' }, confirm: { type: Function, required: true } })
const selectedId = ref(''), query = ref(''), loaded = ref(null), draft = ref(null), busy = ref(false), error = ref(''), message = ref(''), activeId = ref(''), section = ref('bindings'), configChanged = ref(false)
const deviceRange = ref({ workshopId: '', lineId: '' })
const factory = String(props.factoryId || getFactoryScope()), states = ref({}), points = ref([]), saved = ref(''), catalog = ref({ categories: [], tables: [], items: [] }), catalogBusy = ref(false), catalogError = ref(''), store = createDashboardDataStore({ staleMs: 5000 })
let generation = 0, catalogGeneration = 0, disposed = false, discardOnExit = false, tick
const clone = value => JSON.parse(JSON.stringify(value))
const scopeValid = computed(() => !props.factoryId || String(props.factoryId) === factory)
const editable = computed(() => canAdminPage('model-animations', 'edit') && scopeValid.value)
const device = computed(() => props.devices.find(d => String(d.id) === selectedId.value)), model = computed(() => props.models.find(m => m.id === loaded.value?.modelId))
function hierarchyLocation(device) {
  let instance = {}
  try { instance = (typeof device.instance_config === 'string' ? JSON.parse(device.instance_config || '{}') : device.instance_config) || {} } catch { /* An invalid instance belongs to its explicit hierarchy only. */ }
  const lineId = String(device.line_id || device.lineId || ''), line = props.lines.find(item => String(item.id) === lineId)
  const workshopId = String(device.workshop_id || device.workshopId || instance.workshop_id || instance.workshopId || line?.workshop_id || line?.workshopId || '')
  return { workshopId: props.workshops.some(item => String(item.id) === workshopId) ? workshopId : '__unassigned', lineId: line ? lineId : '__unassigned' }
}
const options = computed(() => props.devices.filter(d => {
  const location = hierarchyLocation(d), range = deviceRange.value
  return (!range.workshopId || range.workshopId === location.workshopId) && (!range.lineId || range.lineId === location.lineId)
    && `${d.name} ${d.id}`.toLowerCase().includes(query.value.toLowerCase())
}))
function filterDeviceRange(range = {}) {
  if (busy.value || !scopeValid.value || disposed) return false
  const workshopId = String(range.workshopId || ''), lineId = String(range.lineId || '')
  if (!workshopId && lineId) return false
  if (workshopId && workshopId !== '__unassigned' && !props.workshops.some(item => String(item.id) === workshopId)) return false
  if (lineId && lineId !== '__unassigned' && !props.lines.some(item => String(item.id) === lineId && String(item.workshop_id || item.workshopId || '') === workshopId)) return false
  // This changes only the list range. Selecting another device still goes
  // through choose(), including the existing unsaved-work confirmation.
  deviceRange.value = { workshopId, lineId }
  return true
}
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== saved.value)
const action = computed(() => loaded.value?.actions.find(a => a.id === activeId.value))
function isRetiredBinding(binding, data = loaded.value) { return isRetiredMotionAction(data?.actions?.find(action => action.id === binding.actionId) || { kind: binding.kind ?? 'clip', id: binding.actionId }) }
const selectableActions = computed(() => (loaded.value?.actions || []).filter(action => !isRetiredMotionAction(action)))
const retirementPending = computed(() => !!draft.value?.bindings.some(binding => binding.enabled && isRetiredBinding(binding)))
const retirementLabel = computed(() => [...new Set((draft.value?.bindings || []).filter(binding => binding.enabled && isRetiredBinding(binding)).map(binding => binding.actionId === 'clip:process_cycle' ? '完整工艺循环' : '旧自定义动画'))].join('、'))
const row = computed(() => draft.value?.bindings.find(b => b.actionId === activeId.value))
const readPoints = computed(() => points.value.filter(p => String(p.access_type || 'READ').toUpperCase() === 'READ'))
const availableDataItems = computed(() => catalog.value.items.filter(item => item.motionReady === true && item.enabled !== false && item.sourceReady !== false && item.objectScope !== 'part' && ['number', 'boolean', 'string'].includes(item.type) && ['runtime', 'plc', 'dataset'].includes(item.binding?.mode)))
const endpointDataItems = computed(() => availableDataItems.value.filter(item => item.type === 'boolean' && (item.endpointReady === true || item.endpointReady == null && item.binding?.mode === 'plc' && readPoints.value.some(point => String(point.id) === String(item.binding.pointId) && point.data_type === 'BOOL'))))
const endpointCatalog = computed(() => ({ ...catalog.value, items: catalog.value.items.map(item => ({ ...item, motionReady: endpointDataItems.value.some(source => source.id === item.id) })) }))
const endpointMode = computed(() => row.value?.trigger?.mode === 'endpoints')
function motionCatalog(directory, capabilities) {
  const byId = new Map((Array.isArray(capabilities) ? capabilities : []).map(item => [item.id, item]))
  return { categories: directory.categories || [], tables: directory.tables || [], items: (directory.items || []).map(item => {
    const source = byId.get(item.id)
    return { ...item, ...source, motionReady: source?.motionReady === true, motionError: source?.motionReady === true ? '' : source?.motionError || (source ? '此数据项暂不支持设备动作，请在数据中心检查来源与对象映射' : '动作数据能力未读取，请刷新目录后重新选择') }
  }) }
}
function sourceFor(binding) { return availableDataItems.value.find(item => item.id === binding?.dataItemId) || (!binding?.dataItemId && binding?.pointId ? availableDataItems.value.find(item => item.binding.mode === 'plc' && String(item.binding.pointId) === String(binding.pointId)) : null) }
function typeFor(binding) { return binding?.trigger?.mode === 'endpoints' ? 'boolean' : sourceFor(binding)?.type || (!binding?.dataItemId && readPoints.value.find(p => String(p.id) === String(binding?.pointId))?.data_type === 'BOOL' ? 'boolean' : binding?.trigger?.mode === 'condition' ? typeof binding.trigger.value === 'boolean' ? 'boolean' : typeof binding.trigger.value === 'string' ? 'string' : 'number' : 'number') }
const selectedSource = computed(() => sourceFor(row.value)), sourceType = computed(() => typeFor(row.value))
const operators = computed(() => sourceType.value === 'number' ? [{ id: 'gt', label: '大于 ＞' }, { id: 'gte', label: '大于或等于 ≥' }, { id: 'lt', label: '小于 ＜' }, { id: 'lte', label: '小于或等于 ≤' }, { id: 'eq', label: '等于 ＝' }, { id: 'ne', label: '不等于 ≠' }] : [{ id: 'eq', label: '等于' }, { id: 'ne', label: '不等于' }])
const resolvedBindings = computed(() => draft.value?.bindings.filter(binding => selectableActions.value.some(action => action.id === binding.actionId)).map(b => { const a = loaded.value?.actions.find(a => a.id === b.actionId), p = points.value.find(p => String(p.id) === String(b.pointId)); return { ...b, kind: a?.kind, mode: a?.mode, clipId: a?.kind === 'clip' ? a.id.slice(5) : '', sourceGroup: p?.category || 'analog', sourceKey: p?.value_role || p?.name || '' } }) || [])
function triggerFor(type, mode = 'range') { return type === 'number' && mode === 'range' ? { mode: 'range', operator: 'gt', value: 0, hysteresis: 0 } : { mode: 'condition', operator: type === 'number' ? 'gt' : 'eq', value: type === 'boolean' ? true : type === 'string' ? '' : 0, hysteresis: 0 } }
function prepareConfig(data) {
  const existingRows = data.config?.bindings || []
  const bindings = (data.actions || []).flatMap(a => {
    const existing = existingRows.find(binding => binding.actionId === a.id)
    if (isRetiredMotionAction(a)) return existing ? [clone(existing)] : []
    const binding = clone(existing || { actionId: a.id, enabled: false, pointId: '', inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: a.mode === 'position' ? 1 : 0 })
    binding.dataItemId ||= ''; binding.trigger ||= triggerFor(typeFor(binding))
    return [binding]
  })
  // Preserve retired saved rows even when their old action package is missing.
  for (const existing of existingRows) if (isRetiredBinding(existing, data) && !bindings.some(binding => binding.actionId === existing.actionId)) bindings.push(clone(existing))
  return { version: 1, staleMs: data.config?.staleMs || 5000, bindings }
}
function stateFor(id) {
  const b = draft.value?.bindings.find(binding => binding.actionId === id), prior = saved.value ? JSON.parse(saved.value).bindings.find(binding => binding.actionId === id) : null
  if (b?.dataItemId && b.dataItemId !== prior?.dataItemId) return { reason: '新绑定待保存', usable: false }
  if (b?.trigger?.mode === 'endpoints' && JSON.stringify(b.trigger) !== JSON.stringify(prior?.trigger)) return { reason: '新绑定待保存', usable: false }
  return states.value[id] || { reason: '等待数据', usable: false }
}
function persist() { if (!discardOnExit && dirty.value && loaded.value) cacheFactoryDraft(factory, `animation:${selectedId.value}`, 'device-animations', { deviceId: selectedId.value, revision: loaded.value.revision, config: draft.value }) }
async function canLeave() { return !dirty.value || await props.confirm('动画联动尚未保存，保留草稿并离开？') }
async function choose(id) { const current = selectedId.value, version = generation; if (id === current) return true; if (busy.value || !scopeValid.value || !props.devices.some(d => String(d.id) === id) || !await canLeave() || disposed || version !== generation || current !== selectedId.value) return false; persist(); selectedId.value = String(id); return true }
async function load() {
  const version = ++generation, id = selectedId.value; catalogGeneration++; loaded.value = null; draft.value = null; points.value = []; catalog.value = { categories: [], tables: [], items: [] }; states.value = {}; error.value = ''; message.value = ''; catalogError.value = ''; discardOnExit = false; configChanged.value = false
  if (!id || !scopeValid.value) { busy.value = false; return }
  busy.value = true; catalogBusy.value = true
  try {
    const [data, rows, directory] = await Promise.all([adminApi.getDeviceAnimations(id), adminApi.getDataPoints(id), adminApi.getDataCenterCatalog({ deviceId: id, factoryId: factory }).catch(cause => ({ error: cause.message }))])
    if (disposed || version !== generation || id !== selectedId.value || !scopeValid.value) return
    if (data.error || rows.error) throw Error(data.error || rows.error)
    if (!Array.isArray(rows) || !Array.isArray(data.actions)) throw Error('动作或采集点位列表无效')
    loaded.value = data; points.value = rows
    if (directory.error || directory.success === false) catalogError.value = directory.error || '数据中心目录读取失败'
    else catalog.value = motionCatalog(directory, data.dataItems)
    const config = prepareConfig(data); saved.value = JSON.stringify(config)
    const cached = readFactoryDraft(factory, `animation:${id}`)
    draft.value = cached?.revision === data.revision ? prepareConfig({ ...data, config: cached.config }) : config
    if (cached && cached.revision !== data.revision) message.value = '配置已变更，旧草稿未覆盖；请重新绑定'
    activeId.value = selectableActions.value[0]?.id || ''
  } catch (cause) { if (version === generation && !disposed) error.value = cause.message }
  finally { if (version === generation && !disposed) { busy.value = false; catalogBusy.value = false } }
}
async function refreshCatalog() {
  const request = ++catalogGeneration, id = selectedId.value, version = generation
  if (!id || !scopeValid.value) return
  catalogBusy.value = true; catalogError.value = ''
  try {
    const [directory, animation] = await Promise.all([adminApi.getDataCenterCatalog({ deviceId: id, factoryId: factory }), adminApi.getDeviceAnimations(id)])
    if (disposed || request !== catalogGeneration || version !== generation || id !== selectedId.value || !scopeValid.value) return
    if (directory.error || directory.success === false || animation.error) throw Error(directory.error || animation.error || '数据目录读取失败')
    catalog.value = motionCatalog(directory, animation.dataItems)
    configChanged.value = animation.revision !== loaded.value?.revision
    if (configChanged.value) message.value = '动作或设备配置已更新；当前修改仍保留，请重新读取后再保存。'
  }
  catch (cause) { if (!disposed && request === catalogGeneration) { catalogError.value = cause.message; catalog.value = { categories: [], tables: [], items: [] } } }
  finally { if (!disposed && request === catalogGeneration) catalogBusy.value = false }
}
async function reloadConfig() {
  const id = selectedId.value, version = generation
  if (busy.value || !scopeValid.value || !id) return false
  if (dirty.value && !await props.confirm('重新读取将放弃当前设备未保存的修改，继续？')) return false
  if (disposed || busy.value || !scopeValid.value || version !== generation || id !== selectedId.value) return false
  clearFactoryDraft(factory, `animation:${id}`)
  await load()
  return !!loaded.value && id === selectedId.value && scopeValid.value
}
function numericMetadataProblem(binding) {
  if (!Number.isFinite(binding.inputMin) || !Number.isFinite(binding.inputMax)) return '输入下限和上限必须填写有效数值'
  if (binding.inputMin >= binding.inputMax) return '输入下限必须小于上限；条件触发也需保留有效的范围设置'
  if (Math.max(Math.abs(binding.inputMin), Math.abs(binding.inputMax)) > 1e12) return '输入范围不能超过 ±1,000,000,000,000'
  if (!Number.isFinite(binding.speed) || binding.speed < .05 || binding.speed > 10) return '动画速度必须是 0.05～10 的有效数值'
  if (!Number.isFinite(binding.transitionSeconds) || binding.transitionSeconds < 0 || binding.transitionSeconds > 60) return '过渡时间必须是 0～60 秒的有效数值'
  return ''
}
function bindingProblem(binding) {
  if (!binding) return ''
  if (isRetiredBinding(binding)) return ''
  const source = sourceFor(binding), point = readPoints.value.find(p => String(p.id) === String(binding.pointId)), type = typeFor(binding), trigger = binding.trigger
  if (binding.dataItemId && !source) return catalog.value.items.find(item => item.id === binding.dataItemId)?.motionError || '原驱动数据已移除或不可用，请重新选择或解除绑定'
  const numericProblem = numericMetadataProblem(binding)
  if (numericProblem) return numericProblem
  if (trigger?.mode === 'endpoints') {
    const definition = loaded.value?.actions.find(a => a.id === binding.actionId)
    if (definition?.mode !== 'position') return '两个到位反馈只适用于行程动作，运行动作请使用条件触发'
    const ids = [trigger.extended?.dataItemId, trigger.retracted?.dataItemId]
    if (!binding.enabled && ids.every(id => !id)) return ''
    if (ids.some(id => !id)) return '请选择“推料到位”和“退回到位”两个数据项'
    const sources = ids.map(id => endpointDataItems.value.find(item => item.id === id))
    if (sources.some(item => !item)) return ids.map(id => catalog.value.items.find(item => item.id === id)?.endpointError).find(Boolean) || '原到位反馈不可用，请从数据中心重新选择开关量或解除绑定'
    if (endpointIdentity(sources[0]) === endpointIdentity(sources[1])) return '两个到位反馈不能使用同一个点位或同一数据字段'
    if (binding.dataItemId || binding.pointId) return '到位反馈不能混用普通驱动数据，请重新选择驱动方式'
    return ''
  }
  if (!binding.enabled && !binding.dataItemId) return ''
  if (!binding.dataItemId && !point) return '请从数据中心选择本设备可用的驱动数据'
  if (!trigger || !['range', 'condition'].includes(trigger.mode)) return '请选择驱动方式'
  if (trigger.mode === 'range') { if (type !== 'number') return '开关量和文字状态只能使用条件触发，不能映射数值范围' }
  else { if (!operatorsFor(type).includes(trigger.operator)) return '此数据类型不支持该比较方式'; if (typeof trigger.value !== (type === 'boolean' ? 'boolean' : type === 'string' ? 'string' : 'number') || type === 'number' && !Number.isFinite(trigger.value)) return '比较值必须与数据项类型一致'; if (!Number.isFinite(trigger.hysteresis) || trigger.hysteresis < 0) return '迟滞宽度必须是非负数值' }
  return ''
}
const operatorsFor = type => type === 'number' ? ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'ne']
const currentProblem = computed(() => bindingProblem(row.value)), saveProblem = computed(() => configChanged.value ? '动作或数据来源配置已更新，请重新读取后再保存' : draft.value?.bindings.map(bindingProblem).find(Boolean) || '')
async function save() {
  if (!loaded.value || busy.value || !editable.value || !scopeValid.value) return false
  if (saveProblem.value) { error.value = saveProblem.value; return false }
  const confirmationGeneration = generation, confirmationDevice = selectedId.value
  if (retirementPending.value && !await props.confirm(`${retirementLabel.value}已从可绑定动作中移除。保存将停用旧动画绑定，但保留动作定义和历史数据配置，继续？`)) return false
  if (disposed || confirmationGeneration !== generation || confirmationDevice !== selectedId.value || !loaded.value || busy.value || !editable.value || !scopeValid.value) return false
  if (saveProblem.value) { error.value = saveProblem.value; return false }
  busy.value = true; error.value = ''; message.value = ''
  const version = generation, id = selectedId.value, body = { revision: loaded.value.revision, config: clone(draft.value) }, snapshot = JSON.stringify(draft.value)
  body.config.bindings = body.config.bindings.flatMap(binding => {
    if (!isRetiredBinding(binding)) return [binding]
    const stored = loaded.value.config.bindings.find(row => row.actionId === binding.actionId)
    return stored ? [{ ...clone(stored), enabled: false }] : []
  })
  try {
    const result = await adminApi.saveDeviceAnimations(id, body)
    if (disposed || version !== generation || id !== selectedId.value || !scopeValid.value) return false
    if (result.error || !result.success) throw Error(result.error || '保存未确认')
    loaded.value = { ...loaded.value, ...result }
    const canonical = prepareConfig(loaded.value)
    saved.value = JSON.stringify(canonical)
    if (JSON.stringify(draft.value) === snapshot) draft.value = canonical
    else draft.value.bindings = draft.value.bindings.map(binding => isRetiredBinding(binding) ? clone(canonical.bindings.find(saved => saved.actionId === binding.actionId) || { ...binding, enabled: false }) : binding)
    clearFactoryDraft(factory, `animation:${id}`)
    if (dirty.value) persist()
    message.value = '已保存，Unity 自动同步'
    return true
  }
  catch (cause) { if (version === generation && !disposed) error.value = cause.message; return false }
  finally { if (version === generation && !disposed) busy.value = false }
}
function chooseDataItem(item) { if (!editable.value || busy.value || !row.value || !availableDataItems.value.some(source => source.id === item?.id)) return; row.value.dataItemId = item.id; row.value.pointId = ''; row.value.trigger = triggerFor(item.type, action.value?.mode === 'running' ? 'condition' : 'range'); states.value = {}; message.value = '更换数据后保存并同步，即可在 Unity 大屏跟随现场数据。' }
function clearDataItem() { if (!editable.value || busy.value || catalogBusy.value || !row.value) return; row.value.dataItemId = ''; row.value.pointId = ''; row.value.enabled = false; row.value.trigger = triggerFor('number'); states.value = {}; message.value = '已解除数据绑定并停用此动作，保存并同步后生效。' }
function endpointIdentity(item) { const source = item?.binding || {}; return source.mode === 'plc' ? `plc:${source.pointId}` : source.mode === 'dataset' ? `dataset:${source.datasetId}:${source.datasetField || source.field || source.path || ''}` : `runtime:${source.path || item?.id}` }
function chooseEndpointData(side, item) { if (!editable.value || busy.value || !row.value || row.value.trigger?.mode !== 'endpoints' || !['extended', 'retracted'].includes(side) || !endpointDataItems.value.some(source => source.id === item?.id)) return; row.value.trigger[side] = { dataItemId: item.id }; row.value.dataItemId = ''; row.value.pointId = ''; states.value = {}; message.value = '到位反馈保持实时绑定；保存后 Unity 大屏按这两个开关量显示端点。' }
function feedbackLabel(binding) { if (binding?.trigger?.mode !== 'endpoints') return sourceFor(binding)?.label || points.value.find(p => String(p.id) === binding?.pointId)?.label || points.value.find(p => String(p.id) === binding?.pointId)?.name || '数据项已移除或不可用'; return ['extended', 'retracted'].map(side => availableDataItems.value.find(item => item.id === binding.trigger[side]?.dataItemId)?.label || '反馈未配置').join(' / ') }
function changeTriggerMode(mode) { if (!editable.value || busy.value || !row.value) return; if (mode === 'endpoints') { if (action.value?.mode !== 'position') return; if (!endpointMode.value) { row.value.dataItemId = ''; row.value.pointId = ''; row.value.trigger = { mode: 'endpoints', extended: { dataItemId: '' }, retracted: { dataItemId: '' } }; states.value = {} }; return }; if (mode === 'range' && sourceType.value !== 'number') { message.value = '开关量、文字状态请使用条件触发，不需要填写数值上下限。'; return } row.value.trigger = triggerFor(sourceType.value, mode) }
function changeOperator(value) { if (!editable.value || busy.value || !row.value || !operatorsFor(sourceType.value).includes(value)) return; row.value.trigger.operator = value; if (['eq', 'ne'].includes(value)) row.value.trigger.hysteresis = 0 }
function changeThreshold(value) { if (!editable.value || busy.value || !row.value) return; row.value.trigger.value = sourceType.value === 'boolean' ? value === 'true' : sourceType.value === 'number' ? value.trim() === '' ? '' : Number(value) : String(value) }
function discardPending() { discardOnExit = true; clearFactoryDraft(factory, `animation:${selectedId.value}`); if (saved.value) draft.value = JSON.parse(saved.value); states.value = {} }
watch(() => props.devices.map(d => String(d.id)), ids => { if (!ids.includes(selectedId.value)) { persist(); selectedId.value = scopeValid.value ? ids[0] || '' : '' } }, { immediate: true })
watch(selectedId, load, { immediate: true })
watch(() => props.factoryId, () => { if (!scopeValid.value) { persist(); generation++; catalogGeneration++; loaded.value = null; draft.value = null; selectedId.value = ''; points.value = []; catalog.value = { categories: [], tables: [], items: [] }; error.value = '工厂已改变，请刷新页面后继续'; busy.value = false; catalogBusy.value = false } })
watch(draft, () => { states.value = {}; if (dirty.value) discardOnExit = false; persist() }, { deep: true })
function receiveFrame(data) { const incomingFactory = data.factoryId || data.factory_id; if (!scopeValid.value || String(data.furnace_id) !== selectedId.value || incomingFactory && String(incomingFactory) !== factory) return; const now = performance.now() / 1000; for (const b of resolvedBindings.value) { if (!b.enabled || data.motionInputOnly && !b.dataItemId && b.trigger?.mode !== 'endpoints') continue; const state = states.value[b.actionId] || { seconds: 0 }; receiveMotionSignal(state, b, data, now); states.value[b.actionId] = state } }
store.setDeviceDataHandler(receiveFrame)
store.setMotionInputHandler(receiveFrame)
onMounted(() => { store.connect(); tick = setInterval(() => { const now = performance.now() / 1000; for (const b of resolvedBindings.value) { const state = states.value[b.actionId]; if (state) stepMotionSignal(state, b, .2, now, draft.value?.staleMs || 5000) } }, 200) })
onUnmounted(() => { persist(); disposed = true; generation++; catalogGeneration++; clearInterval(tick); store.dispose() })
defineExpose({ canLeave, savePending: () => dirty.value ? save() : true, discardPending, reloadConfig })
</script>
<template>
<section class="animation-link" aria-label="设备实时动画联动">
 <aside class="link-devices">
  <Teleport defer :to="devicePickerTarget || 'body'" :disabled="!devicePickerTarget">
   <div class="link-device-picker" :class="{ 'is-header-picker': !!devicePickerTarget }">
    <DeviceHierarchyPicker :factories="factories" :workshops="workshops" :lines="lines" :devices="devices" :factory-id="factory" :device-id="selectedId" :disabled="busy || !scopeValid" :request-factory-switch="requestFactorySwitch" scope-only :scope-workshop-id="deviceRange.workshopId" :scope-line-id="deviceRange.lineId" @scope-change="filterDeviceRange" />
   </div>
  </Teleport>
  <input v-model="query" class="input" placeholder="搜索设备" aria-label="搜索联动设备">
  <div class="link-device-list"><button v-for="d in options" :key="d.id" type="button" :class="{active:String(d.id)===selectedId}" :disabled="busy" @click="choose(String(d.id))"><strong>{{ d.name||d.id }}</strong><small>{{ models.find(m=>m.id===d.model_type)?.name||d.model_type }}</small></button><p v-if="!options.length" class="link-device-empty">{{ query ? '当前范围没有匹配的设备' : '当前范围暂无设备' }}</p></div>
 </aside>
 <main class="link-main"><header class="link-heading"><div><h3>{{ device?.name||'选择设备' }}</h3><small>{{ model?.name||loaded?.modelId }}</small></div><span v-if="dirty" class="unsaved">未保存</span><button class="btn" :disabled="busy" @click="reloadConfig">重新读取</button><button class="btn btn-primary" :disabled="busy || (!dirty && !retirementPending) || !editable || !!saveProblem" v-permission="{page:'model-animations',action:'edit'}" @click="save">{{busy?'处理中…':'保存并同步'}}</button></header>
 <p v-if="error" class="link-error" role="alert">{{error}}</p><p v-if="message" class="link-message" role="status">{{message}}</p>
 <p v-if="retirementPending" class="link-message" role="status">存在已移除的{{ retirementLabel }}绑定；保存时会确认停用，历史配置保留。</p>
 <div v-if="loaded&&draft" class="link-content"><section class="link-config" role="region" aria-label="部件动作联动配置" tabindex="0"><nav class="link-tabs" aria-label="动画联动设置"><button type="button" :aria-selected="section==='bindings'" @click="section='bindings'">动作绑定</button><button type="button" :aria-selected="section==='health'" @click="section='health'">运行状况</button></nav>
 <template v-if="section==='bindings'"><div class="action-list" aria-label="可绑定动作"><button v-for="a in selectableActions" :key="a.id" type="button" :class="{active:activeId===a.id}" @click="activeId=a.id"><span>{{a.label}}</span><small>{{draft.bindings.find(b=>b.actionId===a.id)?.enabled?'已启用':'未启用'}}</small></button><p v-if="!selectableActions.length" class="hint">该型号尚无动作。在“部件动作”中配置模型节点即可。</p></div>
 <fieldset v-if="row" class="binding-fields" :disabled="busy || !editable"><label class="enable-line"><span>{{ action.label }}</span><input v-model="row.enabled" type="checkbox" role="switch" aria-label="启用动作联动" v-permission="{page:'model-animations',action:'edit'}"></label>
 <MotionDataPicker v-if="!endpointMode" :catalog="catalog" :data-item-id="row.dataItemId" :point-id="row.pointId" :disabled="!editable || busy" :busy="catalogBusy" :error="catalogError" @select="chooseDataItem" @refresh="refreshCatalog" @clear="clearDataItem" />
 <section class="trigger-config"><header><strong>如何驱动动作</strong><small>{{ sourceType === 'boolean' ? '开关量' : sourceType === 'string' ? '文字状态' : '数值数据' }}</small></header><div class="trigger-mode-tabs" aria-label="动作数据触发方式"><button type="button" :class="{ active: row.trigger.mode === 'range' }" :disabled="sourceType !== 'number'" @click="changeTriggerMode('range')"><strong>范围映射</strong><small>输入范围 → 动作行程</small></button><button type="button" :class="{ active: row.trigger.mode === 'condition' }" @click="changeTriggerMode('condition')"><strong>条件触发</strong><small>满足条件 → 动作状态</small></button><button v-if="action.mode === 'position'" type="button" class="endpoint-mode-choice" :class="{ active: endpointMode }" @click="changeTriggerMode('endpoints')"><strong>到位反馈 · 两个开关量</strong><small>推料到位 / 退回到位，不猜中间位置</small></button></div>
 <MotionEndpointPicker v-if="endpointMode" :catalog="endpointCatalog" :extended="row.trigger.extended" :retracted="row.trigger.retracted" :disabled="!editable || busy" :busy="catalogBusy" :error="catalogError" @select="chooseEndpointData" @refresh="refreshCatalog" @clear="clearDataItem" />
 <template v-if="row.trigger.mode === 'range' && sourceType === 'number'"><div class="range-fields"><label>输入下限<input v-model.number="row.inputMin" class="input" type="number" aria-label="动作输入下限" v-permission="{page:'model-animations',action:'edit'}"></label><label>输入上限<input v-model.number="row.inputMax" class="input" type="number" aria-label="动作输入上限" v-permission="{page:'model-animations',action:'edit'}"></label></div><p class="hint">{{ action.mode === 'position' ? '数值从下限变化到上限时，动作行程从 0% 变化到 100%。' : '兼容原有范围配置：高于范围中点时运行。需要明确阈值时，请切换条件触发。' }}</p></template>
 <template v-else-if="row.trigger.mode === 'condition'"><label>比较方式<select :value="row.trigger.operator" class="input" aria-label="动作比较方式" @change="changeOperator($event.target.value)"><option v-for="operator in operators" :key="operator.id" :value="operator.id">{{ operator.label }}</option></select></label><label>比较值<select v-if="sourceType === 'boolean'" :value="String(row.trigger.value)" class="input" aria-label="动作开关比较值" @change="changeThreshold($event.target.value)"><option value="true">开启 / true</option><option value="false">关闭 / false</option></select><input v-else :value="row.trigger.value" :type="sourceType === 'number' ? 'number' : 'text'" class="input" aria-label="动作条件比较值" :maxlength="sourceType === 'string' ? 160 : undefined" :placeholder="sourceType === 'string' ? '例如：运行中（必须与真实文字一致）' : '请输入比较阈值'" @input="changeThreshold($event.target.value)"></label><p class="hint">条件满足时{{ action.mode === 'running' ? '运行动作；不满足时停止' : '到达 100% 状态；不满足时回到 0%' }}。{{ sourceType === 'string' ? '文字按原值比较，不能把数值或开关量当成文字。' : sourceType === 'boolean' ? '开关量按 true / false 比较，不需要输入数值范围。' : '数值使用所选比较方式；单位沿用数据项。' }}</p><details v-if="sourceType === 'number' && !['eq','ne'].includes(row.trigger.operator)" class="trigger-advanced"><summary>高级 · 防抖迟滞</summary><label>迟滞宽度<input v-model.number="row.trigger.hysteresis" class="input" type="number" min="0" step="any" aria-label="动作条件迟滞宽度"></label><small class="hint">0 表示关闭。设置宽度后，已满足的条件要越过反向边界才解除，避免数值在阈值附近波动时反复启停。</small></details></template>
 </section>
 <div class="range-fields"><label v-if="action.mode === 'position'">{{ endpointMode ? '显示过渡（秒）' : '过渡（秒）' }}<input v-model.number="row.transitionSeconds" class="input" type="number" min="0" max="60" step=".1" aria-label="动作过渡秒数" v-permission="{page:'model-animations',action:'edit'}"></label><label v-else>动画速度<input v-model.number="row.speed" class="input" type="number" min=".05" max="10" step=".1" aria-label="动作运行速度" v-permission="{page:'model-animations',action:'edit'}"></label><label>方向<select v-model="row.invert" class="input" aria-label="动作联动方向" v-permission="{page:'model-animations',action:'edit'}"><option :value="false">正常</option><option :value="true">反向</option></select></label></div>
 <p v-if="endpointMode" class="hint">显示过渡仅让模型平滑切换到已确认端点，不表示实际行程位置。两端均未到位、数据失效或超时时保持画面；重连后按当前反馈重新对齐。</p>
 <p v-if="currentProblem" class="binding-warning" role="alert">{{ currentProblem }}</p><small class="hint">仅驱动 Unity 大屏画面，不写入 PLC。更换数据后请保存并同步。</small>

 </fieldset></template>
 <template v-else><p class="health-connection" role="status"><span :class="{good:store.wsConnected.value}">{{store.wsConnected.value?'数据已连接':'等待数据连接'}}</span><small>保存后在 Unity 大屏生效</small></p><label class="timeout">无新数据暂停（毫秒）<input v-model.number="draft.staleMs" class="input" type="number" min="1000" max="60000" v-permission="{page:'model-animations',action:'edit'}"></label><div class="health-list"><article v-for="b in draft.bindings.filter(b=>b.enabled && selectableActions.some(action=>action.id===b.actionId))" :key="b.actionId"><strong>{{loaded.actions.find(a=>a.id===b.actionId)?.label}}</strong><span :class="{good:stateFor(b.actionId).usable}">{{stateFor(b.actionId).reason}}</span><small>{{ feedbackLabel(b) }}</small></article><p v-if="!draft.bindings.some(b=>b.enabled)" class="hint">尚未启用动作</p></div></template>
 </section></div>
 <p v-else-if="busy" class="hint">正在读取动作与数据中心目录…</p>
 </main>
</section>
</template>
<style scoped>
.binding-fields{margin:0;border-left:0;border-right:0;border-bottom:0;padding-bottom:0;min-width:0}.trigger-config{display:grid;gap:10px}.trigger-config>header{display:flex;align-items:center;justify-content:space-between;gap:8px}.trigger-config>header strong{font-weight:600;font-size:12px;color:#426286}.trigger-config>header small{font-size:10px;color:#90a0b5}.trigger-mode-tabs{display:grid;grid-template-columns:1fr 1fr;gap:7px}.trigger-mode-tabs button{display:grid;gap:5px;min-width:0;padding:10px 8px;border:1px solid #e1e7f0;border-radius:7px;text-align:left;background:#fff;color:#7b8ba1;cursor:pointer}.trigger-mode-tabs button strong{font-size:12px;font-weight:500}.trigger-mode-tabs button small{font-size:10px;color:#98a5b8;line-height:1.5}.trigger-mode-tabs button.active{border-color:#afc9f0;background:#f0f6ff;color:#326bc0}.trigger-mode-tabs .endpoint-mode-choice{grid-column:1/-1;background:#f6f9ff}.trigger-mode-tabs button:disabled{opacity:.45;cursor:default}.trigger-advanced{display:grid;gap:8px;border-top:1px solid #e5ebf3;padding-top:10px}.trigger-advanced>summary{font-size:11px;color:#8e9bb0;cursor:pointer;margin-bottom:10px}.binding-warning{padding:8px 10px;border-radius:6px;background:#fff6ed;color:#b57c3c;font-size:11px;line-height:1.6;margin:0}.binding-fields:disabled{opacity:.75}

.animation-link{display:grid;grid-template-columns:220px minmax(0,1fr);gap:16px;min-height:620px;color:#26374d}.link-devices,.link-main{border:1px solid #e0e6ef;border-radius:12px;background:#fff;min-width:0}.link-devices{padding:14px;display:flex;flex-direction:column;gap:12px}.link-devices header,.link-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.link-devices small,.link-heading small{font-size:calc(11px * var(--admin-font-scale, 1));color:#7d899b}.link-device-list{display:grid;align-content:start;gap:6px;max-height:640px;overflow:auto}.link-device-list button{display:grid;gap:6px;padding:11px 9px;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.link-device-list button.active{border-color:#bdd1fa;background:#eef4ff}.link-device-list small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.link-main{overflow:hidden}.link-heading{padding:16px;border-bottom:1px solid #e5eaf1}.link-heading>div{flex:1;min-width:0}.link-heading h3{font-size:calc(17px * var(--admin-font-scale, 1));margin:0 0 4px}.unsaved{color:#b77910;font-size:calc(11px * var(--admin-font-scale, 1))}.link-content{display:grid;grid-template-columns:minmax(0,1fr);min-height:560px}.link-config{padding:20px;min-width:0}.link-tabs{display:flex;gap:4px;background:#f2f5fa;border:1px solid #e2e8f2;border-radius:9px;padding:4px}.link-tabs button{flex:1;border:0;border-radius:6px;padding:8px 12px;white-space:nowrap;background:transparent;color:#6d7f96;cursor:pointer;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1))}.link-tabs button[aria-selected=true]{background:white;color:#2261cc;box-shadow:0 2px 8px #304f7520}.action-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:8px;max-height:210px;overflow:auto;margin:12px 0}.action-list button{display:flex;justify-content:space-between;gap:8px;padding:10px;border:1px solid #e3e8ef;border-radius:7px;background:white;cursor:pointer;color:#32455b;font-size:calc(12px * var(--admin-font-scale, 1));text-align:left}.action-list button.active{border-color:#adc8fb;background:#f0f6ff}.action-list small{color:#8190a4;white-space:nowrap;font-size:calc(10px * var(--admin-font-scale, 1))}.binding-fields{display:grid;gap:12px;border-top:1px solid #e5eaf1;padding-top:13px;font-size:calc(12px * var(--admin-font-scale, 1))}.binding-fields label,.timeout{display:grid;gap:7px;min-width:0}.enable-line{display:flex!important;align-items:center;justify-content:space-between;font-weight:600}.enable-line input{appearance:none;width:36px;height:21px;border-radius:20px;background:#c2cad6;position:relative;cursor:pointer;transition:background .15s}.enable-line input:before{content:'';position:absolute;width:15px;height:15px;left:3px;top:3px;border-radius:50%;background:white;transition:transform .15s}.enable-line input:checked{background:#428de0}.enable-line input:checked:before{transform:translateX(15px)}.range-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.hint{color:#8591a3;font-size:calc(11px * var(--admin-font-scale, 1));line-height:1.6}.input{box-sizing:border-box;width:100%;padding:9px 10px;font:inherit;font-size:calc(12px * var(--admin-font-scale, 1));border:1px solid #d4dce8;border-radius:7px;background:#fafbfe;color:#32455b}.input:focus-visible{outline:2px solid #a6c7ff}.timeout{font-size:calc(12px * var(--admin-font-scale, 1));margin-top:16px}.health-connection{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-size:calc(12px * var(--admin-font-scale, 1));color:#53657e}.health-connection small{font-size:calc(11px * var(--admin-font-scale, 1));color:#7a889b}.health-list{display:grid;gap:9px;margin-top:15px;max-height:440px;overflow:auto}.health-list article{display:grid;grid-template-columns:1fr auto;gap:7px;padding:10px;border:1px solid #e4e9f0;border-radius:7px;font-size:calc(11px * var(--admin-font-scale, 1))}.health-list small{grid-column:1/-1;color:#8893a3}.good{color:#218a69}.link-error,.link-message{margin:8px 16px;padding:10px;font-size:calc(12px * var(--admin-font-scale, 1));border-radius:7px;background:#fff3f0;color:#b34740}.link-message{background:#f0f8f5;color:#337e65}.btn{padding:8px 12px;border:1px solid #d0dcec;border-radius:8px;background:white;color:#34619b;font-size:calc(12px * var(--admin-font-scale, 1));cursor:pointer}.btn-primary{background:#2868eb;border-color:#2868eb;color:white}.btn:disabled{opacity:.5;cursor:default}@media(max-width:1100px){.animation-link{grid-template-columns:175px minmax(0,1fr)}}@media(max-width:850px){.animation-link{grid-template-columns:1fr}.link-device-list{display:flex;max-height:100px}.link-device-list button{flex:0 0 170px}.link-content{grid-template-columns:1fr}.link-config{border-right:0}}
</style>
<style scoped>
/* Device navigation and the full-width configuration each own their scrolling. */
.link-device-picker.is-header-picker { min-width:260px; max-width:560px; }
.link-device-picker.is-header-picker :deep(.hierarchy-trigger) { padding:9px 12px; border:1px solid #d5dfea; border-radius:8px; background:#fff; }
.link-device-picker.is-header-picker :deep(.hierarchy-trigger strong) { font-size:calc(12px * var(--admin-font-scale,1)); }
.link-device-picker.is-header-picker :deep(.hierarchy-trigger small) { font-size:calc(11px * var(--admin-font-scale,1)); }
.animation-link { flex:1; min-height:0; min-width:0; overflow:hidden; align-items:stretch; }
.link-devices { min-height:0; overflow:hidden; }
.link-devices> :not(.link-device-list) { flex-shrink:0; }
.link-device-list { flex:1; min-height:0; max-height:none; overflow-y:auto; overscroll-behavior:contain; }
.link-device-empty { margin:8px 0; color:#687a92; font-size:calc(12px * var(--admin-font-scale, 1)); line-height:1.6; }
.link-main { display:flex; flex-direction:column; min-height:0; }
.link-heading { flex:0 0 auto; flex-wrap:wrap; }
.link-error,.link-message { flex-shrink:0; }
.link-content { flex:1; min-height:0; overflow:hidden; }
.link-config { min-height:0; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; scrollbar-gutter:stable; }
.link-config:focus-visible { outline:2px solid #3d83d8; outline-offset:-2px; }
@media(max-width:850px) {
  .link-device-picker.is-header-picker { min-width:0; width:100%; }
  .animation-link { flex:0 0 auto; overflow:visible; }
  .link-devices { overflow:visible; }
  .link-device-list { flex:none; max-height:100px; overflow:auto; }
  .link-main { overflow:visible; }
  .link-content { overflow:visible; }
  .link-config { overflow:visible; }
}
</style>
