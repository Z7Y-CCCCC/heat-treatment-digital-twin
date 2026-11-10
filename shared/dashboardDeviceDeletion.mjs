// Device deletion is an ownership operation, not a data-binding migration.
// A fixed data source on a shared overview is not evidence that its widget is
// private. Never normalize a document here: unrelated authoring must survive.
const clone = value => JSON.parse(JSON.stringify(value))
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const textId = value => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const idSet = values => new Set((Array.isArray(values) ? values : []).map(textId).filter(Boolean))
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const mapViews = new Set(['map_world', 'map_country', 'map_province', 'map_city', 'map_district', 'site_street', 'site_factory'])
const viewTargetType = view => String(view.targetType || view.target_type || '').toLowerCase()
const parentId = view => textId(view.parentViewId ?? view.parent_view_id)
const deviceLikeView = view => {
  const type = viewTargetType(view || {})
  // An authored explicit factory/area target wins over a stale mode selector.
  return type ? ['device', 'device_part'].includes(type) : view?.mode === 'device'
}
const deviceRule = rule => (rule?.source === 'context' || !rule?.source) && rule?.path === 'deviceId'
const positiveDeviceRule = rule => deviceRule(rule) && (!rule.operator || rule.operator === '==') && !!textId(rule.value)

function deviceRulePolicy(deletedDevices, options) {
  const catalog = Array.isArray(options.remainingDeviceIds) ? options.remainingDeviceIds
    : Array.isArray(options.existingDeviceIds) ? options.existingDeviceIds : null
  const remaining = catalog ? [...idSet(catalog)].filter(id => !deletedDevices.has(id)) : []
  const numeric = value => { const number = Number(value); return Number.isFinite(number) ? number : null }
  const equal = (left, right) => String(left ?? '') === String(right ?? '')
    || numeric(left) !== null && numeric(right) !== null && numeric(left) === numeric(right)
  return {
    onlyDeleted(rule) {
      if (!positiveDeviceRule(rule) || ![...deletedDevices].some(id => equal(id, rule.value))) return false
      // dashboardRules equality intentionally accepts numeric aliases: "1"
      // and "01" may be separate registered devices but match one condition.
      // Without a complete catalog, never infer numeric exclusive ownership.
      if (!catalog && numeric(rule.value) !== null) return false
      return !remaining.some(id => equal(id, rule.value))
    }
  }
}

function explicitViewDevice(view) {
  if (!deviceLikeView(view)) return ''
  const type = viewTargetType(view)
  if (type === 'device' || !type && view.mode === 'device') return textId(view.targetId ?? view.target_id)
  // A part targetId may be a model part, not a device ID.
  return textId(view.metadata?.deviceId || view.metadata?.ownerDeviceId)
}

function effectiveViewDevice(view, byId) {
  const seen = new Set()
  let cursor = view
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    if (!deviceLikeView(cursor)) return '' // Explicit global/area children remain shared.
    const explicit = explicitViewDevice(cursor)
    if (explicit) return explicit
    cursor = byId.get(parentId(cursor))
  }
  return ''
}

function widgetViewEligible(widget, view) {
  const visibility = widget.visibility || widget.config?.visibility || {}
  if (visibility.viewIds?.length && !visibility.viewIds.map(String).includes(String(view.id))) return false
  if (visibility.viewModes?.length && !visibility.viewModes.includes(view.mode || 'factory')) return false
  const type = widget.type || widget.widget_type
  const keys = [widget.id, type, `system:${type}`, widget.groupId && `group:${widget.groupId}`].filter(Boolean)
  const state = view.componentState || view.components || {}
  if (keys.some(key => state.hide?.includes(key))) return false
  if ((mapViews.has(view.id) || state.show?.length) && !keys.some(key => state.show?.includes(key))) return false
  return true
}

function privateWidget(widget, views, removedViews, deletedDevices, rulePolicy, canvasMembership = true) {
  const visibility = widget.visibility || widget.config?.visibility || {}
  const binding = widget.data || widget.binding || {}
  const scope = binding.deviceScope || binding.device_scope || (binding.deviceId || binding.device_id ? 'fixed' : 'current')
  if (visibility.matchBoundDevice && scope === 'fixed' && deletedDevices.has(textId(binding.deviceId || binding.device_id))) return true
  const rules = Array.isArray(visibility.rules) ? visibility.rules : []
  if (rules.length) {
    if (visibility.ruleMode === 'any') {
      if (rules.every(rule => rulePolicy.onlyDeleted(rule))) return true
    } else if (rules.some(rule => rulePolicy.onlyDeleted(rule))) return true
  }
  const viewIds = Array.isArray(visibility.viewIds) ? visibility.viewIds : []
  // Hidden private widgets are still owned, including an old unbound caption.
  if (viewIds.length && viewIds.every(id => removedViews.has(textId(id)))) return true
  if (!canvasMembership) return false // TooltipSurface never reads main-canvas show/hide lists.
  const eligible = views.filter(view => widgetViewEligible(widget, view))
  return eligible.length > 0 && eligible.every(view => removedViews.has(textId(view.id)))
}

function removeMapKeys(owner, field, removed) {
  if (!record(owner?.[field])) return
  for (const key of Object.keys(owner[field])) if (removed.has(key)) delete owner[field][key]
}

function pruneSelectionLists(owner, deletedDevices, deletedPoints) {
  if (!record(owner)) return false
  let emptyDeviceSelection = false
  for (const [key, value] of Object.entries(owner)) {
    if(key==='deviceBindings' && Array.isArray(value)){
      const next=value.filter(row=>!deletedDevices.has(textId(row?.deviceId)))
      if(next.length!==value.length){owner[key]=next;if(value.length && !next.length)emptyDeviceSelection=true}
      continue
    }
    if (Array.isArray(value) && ['deviceIds', 'device_ids', 'rotationDeviceIds'].includes(key)) {
      const next = value.filter(id => !deletedDevices.has(textId(id)))
      if (next.length !== value.length) {
        owner[key] = next
        if (value.length && !next.length) emptyDeviceSelection = true
      }
    } else if (Array.isArray(value) && ['pointIds', 'point_ids'].includes(key)) {
      owner[key] = value.filter(id => !deletedPoints.has(textId(id)))
    } else if (record(value)) {
      if (pruneSelectionLists(value, deletedDevices, deletedPoints)) emptyDeviceSelection = true
    } else if (Array.isArray(value) && ['datasets', 'series','items'].includes(key)) {
      for (const item of value) if (pruneSelectionLists(item, deletedDevices, deletedPoints)) emptyDeviceSelection = true
    }
  }
  return emptyDeviceSelection
}

function pruneWidget(widget, { removedWidgets, removedGroups, removedViews, deletedDevices, deletedPoints, rulePolicy, emptyScopeWidgetIds }) {
  const visibility = widget.visibility || widget.config?.visibility
  if (record(visibility)) {
    if (Array.isArray(visibility.viewIds)) visibility.viewIds = visibility.viewIds.filter(id => !removedViews.has(textId(id)))
    if (visibility.ruleMode === 'any' && Array.isArray(visibility.rules)) {
      visibility.rules = visibility.rules.filter(rule => !rulePolicy.onlyDeleted(rule))
    }
  }
  for (const holder of [widget, widget.style, widget.config?.style]) removeMapKeys(holder, 'viewOverrides', removedViews)
  // Factory HUD clicks index this authored map by exact device.id. Only this
  // formal content/legacy-config field is a device-keyed map; arbitrary object
  // keys or nested API payloads are not ownership/reference evidence.
  for (const content of [widget.content, widget.config]) removeMapKeys(content, 'deviceActions', deletedDevices)
  let emptySelection = false
  for (const binding of [widget.data, widget.binding, widget.dynamicBinding, widget.content, widget.config]) {
    if (pruneSelectionLists(binding, deletedDevices, deletedPoints)) emptySelection = true
  }
  // Empty explicit device lists otherwise mean "all devices" in playback and
  // HUD filters. Retain the shared frame, but never broaden that empty scope.
  if (emptySelection) {
    widget.visible = false
    emptyScopeWidgetIds.push(widget.id)
  }
  const eventOwner = Array.isArray(widget.events) ? widget : widget.config
  if (Array.isArray(eventOwner?.events)) eventOwner.events = eventOwner.events.filter(event => {
    if (!record(event)) return true
    if (deletedDevices.has(textId(event.deviceId || event.device_id))) return false
    if (deletedPoints.has(textId(event.pointId || event.point_id))) return false
    if (removedViews.has(textId(event.viewId)) && event.action === 'switch_view') return false
    if (['set_visibility', 'toggle_visibility'].includes(event.action)) {
      if (event.targetType === 'widget' && removedWidgets.has(textId(event.targetId))) return false
      if (event.targetType === 'group' && removedGroups.has(textId(event.targetId))) return false
    }
    return true
  })
}

function templateReferences(views) {
  const result = new Map()
  for (const view of views) for (const id of Object.values(view.metadata?.tooltipTemplates || {})) {
    if (!textId(id) || ['inherit', 'disabled'].includes(id)) continue
    if (!result.has(String(id))) result.set(String(id), [])
    result.get(String(id)).push(view.id)
  }
  return result
}

/** Read explicit selection/ownership references only, never captions/ID names. */
export function dashboardReferencedDeviceIds(document = {}) {
  const result = new Set()
  const add = value => { const id = textId(value); if (id) result.add(id) }
  const walkSelections = owner => {
    if (!record(owner)) return
    for (const [key, value] of Object.entries(owner)) {
      if (['deviceId', 'device_id'].includes(key)) add(value)
      else if (['path', 'source'].includes(key) && typeof value === 'string') {
        // These formal runtime-map paths name an object, unlike a caption or
        // an arbitrary serialized API response. They are references only.
        const match = /^(?:deviceDataMap|deviceStatusMap)\.([^.]+)(?:\.|$)/.exec(value)
        if (match) add(match[1])
      }
      else if (Array.isArray(value) && ['deviceIds', 'device_ids', 'rotationDeviceIds'].includes(key)) value.forEach(add)
      else if (record(value)) walkSelections(value)
      else if (Array.isArray(value) && ['datasets', 'series','items','deviceBindings'].includes(key)) value.forEach(walkSelections)
    }
  }
  for (const view of document.scene?.views || []) { add(explicitViewDevice(view)); add(view.metadata?.ownerDeviceId) }
  for (const widget of [...(document.widgets || []), ...(document.tooltipTemplates?.templates || []).flatMap(template => template.widgets || [])]) {
    for (const rule of widget.visibility?.rules || widget.config?.visibility?.rules || []) if (deviceRule(rule)) add(rule.value)
    for (const content of [widget.content, widget.config]) if (record(content?.deviceActions)) Object.keys(content.deviceActions).forEach(add)
    for (const source of [widget.data, widget.binding, widget.dynamicBinding, widget.content, widget.config]) walkSelections(source)
    for (const event of widget.events || widget.config?.events || []) add(event?.deviceId || event?.device_id)
  }
  return [...result]
}

export const collectDashboardDeviceIds = dashboardReferencedDeviceIds

/**
 * Pure deletion projection used by the server transaction and editor history.
 * confirmedRemovals is a factory-validated server acknowledgement; it prevents
 * unsaved edits from resurrecting an already deleted original widget ID.
 */
export function cleanupDeletedDeviceContent(input, options = {}) {
  const document = clone(input)
  const deletedDevices = idSet(options.deviceIds), deletedPoints = idSet(options.pointIds)
  const rulePolicy = deviceRulePolicy(deletedDevices, options)
  const confirmed = options.confirmedRemovals || {}
  const views = Array.isArray(document.scene?.views) ? document.scene.views : []
  const byView = new Map(views.map(view => [textId(view.id), view]))
  const removedViews = idSet(confirmed.removedViewIds)
  for (const view of views) if (deletedDevices.has(effectiveViewDevice(view, byView))) removedViews.add(textId(view.id))
  const widgets = Array.isArray(document.widgets) ? document.widgets : []
  const removedWidgets = idSet(confirmed.removedWidgetIds)
  for (const widget of widgets) if (privateWidget(widget, views, removedViews, deletedDevices, rulePolicy)) removedWidgets.add(textId(widget.id))
  const removedWidgetIds = widgets.filter(widget => removedWidgets.has(textId(widget.id))).map(widget => widget.id)
  const keptWidgets = widgets.filter(widget => !removedWidgets.has(textId(widget.id)))
  const originalGroups = idSet(widgets.map(widget => widget.groupId))
  const survivingGroups = idSet(keptWidgets.map(widget => widget.groupId))
  const removedGroups = new Set([...originalGroups].filter(id => !survivingGroups.has(id)))
  const removedTargets = new Set([...removedWidgets, ...[...removedGroups].map(id => `group:${id}`)])
  const emptyScopeWidgetIds = [], updatedWidgetIds = []
  for (const widget of keptWidgets) {
    const previous = JSON.stringify(widget)
    pruneWidget(widget, { removedWidgets, removedGroups, removedViews, deletedDevices, deletedPoints, rulePolicy, emptyScopeWidgetIds })
    if (JSON.stringify(widget) !== previous) updatedWidgetIds.push(widget.id)
  }
  if (Array.isArray(document.widgets)) document.widgets = keptWidgets

  const keptViews = views.filter(view => !removedViews.has(textId(view.id)))
  const fallback = keptViews.find(view => view.id === 'factory_overview')?.id || keptViews.find(view => !mapViews.has(view.id))?.id || keptViews[0]?.id || ''
  const survivingAncestor = (id, returnEdge = false) => {
    const seen = new Set()
    let cursor = textId(id)
    while (cursor && removedViews.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      const removed = byView.get(cursor)
      cursor = returnEdge ? textId(removed?.returnViewId || removed?.return_view_id) || parentId(removed || {}) : parentId(removed || {})
    }
    return cursor && !removedViews.has(cursor) && byView.has(cursor) ? cursor : ''
  }
  const updatedViewIds = [], emptyScopeViewIds = []
  for (const view of keptViews) {
    const previous = JSON.stringify(view)
    for (const field of ['parentViewId', 'parent_view_id', 'returnViewId', 'return_view_id']) if (own(view, field) && removedViews.has(textId(view[field]))) view[field] = survivingAncestor(view[field], field.startsWith('return'))
    const state = view.componentState || view.components
    if (record(state)) {
      const hadAllowList = Array.isArray(state.show) && state.show.length > 0
      for (const key of ['show', 'hide']) if (Array.isArray(state[key])) state[key] = state[key].filter(id => !removedTargets.has(textId(id)))
      if (hadAllowList && !state.show.length) {
        state.hide = [...new Set([...(state.hide || []), ...keptWidgets.map(widget => widget.id)])]
        emptyScopeViewIds.push(view.id)
      }
      removeMapKeys(state, 'widgetOverrides', removedTargets)
      removeMapKeys(state, 'widgetVisibility', removedTargets)
    }
    removeMapKeys(view, 'widgetOverrides', removedTargets)
    removeMapKeys(view, 'viewOverrides', removedViews)
    if (JSON.stringify(view) !== previous) updatedViewIds.push(view.id)
  }
  if (Array.isArray(document.scene?.views)) document.scene.views = keptViews
  if (record(document.scene) && removedViews.has(textId(document.scene.defaultViewId))) document.scene.defaultViewId = survivingAncestor(document.scene.defaultViewId) || fallback
  for (const holder of [document, document.scene, document.metadata, document.scene?.layout]) {
    removeMapKeys(holder, 'viewOverrides', removedViews)
    removeMapKeys(holder, 'viewState', removedViews)
    removeMapKeys(holder, 'widgetOverrides', removedTargets)
    for (const state of Object.values(holder?.viewState || {})) {
      removeMapKeys(state, 'widgetOverrides', removedTargets)
      removeMapKeys(state, 'widgetVisibility', removedTargets)
      const hadAllowList = Array.isArray(state?.show) && state.show.length > 0
      for (const key of ['show', 'hide', 'selectedWidgetIds']) if (Array.isArray(state?.[key])) state[key] = state[key].filter(id => !removedTargets.has(textId(id)))
      if (hadAllowList && !state.show.length) state.hide = [...new Set([...(state.hide || []), ...keptWidgets.map(widget => widget.id)])]
    }
  }

  const templates = Array.isArray(document.tooltipTemplates?.templates) ? document.tooltipTemplates.templates : []
  const uses = templateReferences(views), defaults = idSet(Object.values(document.tooltipTemplates?.defaults || {}))
  const removedTemplates = idSet(confirmed.removedTooltipTemplateIds)
  for (const template of templates) {
    const references = uses.get(textId(template.id)) || []
    if (!defaults.has(textId(template.id)) && references.length && references.every(id => removedViews.has(textId(id)))) removedTemplates.add(textId(template.id))
  }
  const removedTooltipWidgetIds = [], updatedTooltipWidgetIds = [], updatedTooltipTemplateIds = []
  const confirmedTooltipWidgets = new Map((Array.isArray(confirmed.removedTooltipWidgetIds) ? confirmed.removedTooltipWidgetIds : []).map(row => [textId(row.templateId), idSet(row.widgetIds)]))
  for (const template of templates) {
    const originalWidgets = Array.isArray(template.widgets) ? template.widgets : []
    const removed = confirmedTooltipWidgets.get(textId(template.id)) || new Set()
    if (removedTemplates.has(textId(template.id))) originalWidgets.forEach(widget => removed.add(textId(widget.id)))
    else originalWidgets.forEach(widget => { if (privateWidget(widget, views, removedViews, deletedDevices, rulePolicy, false)) removed.add(textId(widget.id)) })
    const removedIds = originalWidgets.filter(widget => removed.has(textId(widget.id))).map(widget => widget.id)
    if (removedIds.length) removedTooltipWidgetIds.push({ templateId: template.id, widgetIds: removedIds })
    if (removedTemplates.has(textId(template.id))) continue
    const previous = JSON.stringify(template)
    template.widgets = originalWidgets.filter(widget => !removed.has(textId(widget.id)))
    const oldGroups = idSet(originalWidgets.map(widget => widget.groupId)), liveGroups = idSet(template.widgets.map(widget => widget.groupId))
    const templateRemovedGroups = new Set([...oldGroups].filter(id => !liveGroups.has(id)))
    const changedIds = []
    for (const widget of template.widgets) {
      const old = JSON.stringify(widget)
      pruneWidget(widget, { removedWidgets: removed, removedGroups: templateRemovedGroups, removedViews, deletedDevices, deletedPoints, rulePolicy, emptyScopeWidgetIds })
      if (JSON.stringify(widget) !== old) changedIds.push(widget.id)
    }
    if (removed.has(textId(template.backgroundWidgetId))) delete template.backgroundWidgetId
    if (changedIds.length) updatedTooltipWidgetIds.push({ templateId: template.id, widgetIds: changedIds })
    if (JSON.stringify(template) !== previous) updatedTooltipTemplateIds.push(template.id)
  }
  if (Array.isArray(document.tooltipTemplates?.templates)) document.tooltipTemplates.templates = templates.filter(template => !removedTemplates.has(textId(template.id)))
  // Confirmed deletion can arrive after a local template reference was added.
  for (const view of keptViews) for (const [kind, id] of Object.entries(view.metadata?.tooltipTemplates || {})) if (removedTemplates.has(textId(id))) {
    view.metadata.tooltipTemplates[kind] = 'inherit'
    if (!updatedViewIds.includes(view.id)) updatedViewIds.push(view.id)
  }
  for (const [kind, id] of Object.entries(document.tooltipTemplates?.defaults || {})) if (removedTemplates.has(textId(id))) {
    const replacement = document.tooltipTemplates.templates.find(template => template.kind === kind)
    if (replacement) document.tooltipTemplates.defaults[kind] = replacement.id
    else delete document.tooltipTemplates.defaults[kind]
  }
  return {
    document, changed: JSON.stringify(document) !== JSON.stringify(input),
    removedWidgetIds, removedViewIds: views.filter(view => removedViews.has(textId(view.id))).map(view => view.id),
    removedTooltipTemplateIds: templates.filter(template => removedTemplates.has(textId(template.id))).map(template => template.id),
    removedTooltipWidgetIds, updatedWidgetIds, updatedViewIds, updatedTooltipTemplateIds, updatedTooltipWidgetIds,
    emptyScopeWidgetIds: [...new Set(emptyScopeWidgetIds)], emptyScopeViewIds
  }
}
