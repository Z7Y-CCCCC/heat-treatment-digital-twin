// Designer-only object identity is deliberately kept outside document JSON.
export function createWidgetInstanceRegistry(unwrap = value => value) {
  const keys = new WeakMap()
  let sequence = 0
  const key = widget => {
    const object = unwrap(widget)
    if (!object || typeof object !== 'object') return ''
    if (!keys.has(object)) keys.set(object, `designer-instance:${++sequence}`)
    return keys.get(object)
  }
  return { key, find: (widgets, instanceKey) => instanceKey ? (widgets || []).find(widget => key(widget) === instanceKey) || null : null }
}

export function dashboardWidgetIdentityIssues(document) {
  const widgets = Array.isArray(document?.widgets) ? document.widgets : []
  const occurrences = new Map(), issues = []
  widgets.forEach((widget, index) => {
    const widgetId = typeof widget?.id === 'string' ? widget.id : String(widget?.id ?? '')
    if (typeof widget?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(widgetId)) {
      issues.push({ code: 'invalid-widget-id', widgetId, indexes: [index], message: `第 ${index + 1} 个组件标识不合法；请填写 1–128 位字母、数字、下划线或短横线` })
    }
    if (!occurrences.has(widgetId)) occurrences.set(widgetId, [])
    occurrences.get(widgetId).push(index)
  })
  for (const [widgetId, indexes] of occurrences) {
    if (indexes.length > 1) issues.push({ code: 'duplicate-widget-id', widgetId, indexes,
      message: `组件标识重复：${widgetId || '(空)'}；请在各实例的“组件标识”中填写唯一值后保存` })
  }
  return issues
}

export function widgetIdError(document, widget, newId) {
  if (!document?.widgets?.includes(widget)) return '当前组件已不存在，请重新选择'
  if (typeof newId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(newId)) return '请填写 1–128 位字母、数字、下划线或短横线'
  if (document.widgets.some(other => other !== widget && other.id === newId)) return '组件标识已被其它实例使用，请填写唯一值'
  return ''
}

const copyValue = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

// Only an explicit Inspector edit calls this; loading never repairs IDs.
export function renameDashboardWidget(document, widget, newId) {
  const error = widgetIdError(document, widget, newId)
  if (error) throw new Error(error)
  const oldId = widget.id
  if (oldId === newId) return { changed: false, oldId, newId, oldIdStillUsed: false }
  const oldIdStillUsed = document.widgets.some(other => other !== widget && other.id === oldId)
  for (const view of document.scene?.views || []) {
    const state = view.componentState || view.components
    if (!state) continue
    for (const field of ['show', 'hide']) {
      if (!Array.isArray(state[field])) continue
      const next = []
      for (const target of state[field]) {
        const replacement = target === oldId ? newId : target === `widget:${oldId}` ? `widget:${newId}` : null
        if (replacement === null) next.push(target)
        else if (oldIdStillUsed) next.push(target, replacement)
        else next.push(replacement)
      }
      state[field] = [...new Set(next)]
    }
    if (state.overrides && typeof state.overrides === 'object' && !Array.isArray(state.overrides)) {
      for (const oldKey of [oldId, `widget:${oldId}`]) {
        if (!Object.hasOwn(state.overrides, oldKey)) continue
        const newKey = oldKey === oldId ? newId : `widget:${newId}`
        Object.defineProperty(state.overrides, newKey, { value: copyValue(state.overrides[oldKey]), writable: true, configurable: true, enumerable: true })
        if (!oldIdStillUsed) delete state.overrides[oldKey]
      }
    }
  }
  widget.id = newId
  return { changed: true, oldId, newId, oldIdStillUsed }
}

// Only newly constructed objects are accepted; existing loaded IDs stay intact.
export function allocateNewWidgetIds(existingWidgets, newWidgets) {
  const existing = new Set(existingWidgets || [])
  const used = new Set((existingWidgets || []).map(widget => widget.id))
  const remapped = Object.create(null)
  for (const widget of newWidgets || []) {
    if (existing.has(widget)) throw new Error('Cannot allocate an ID for an existing widget')
    const oldId = String(widget.id || 'widget')
    const base = oldId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'widget'
    let id = base, suffix = 1
    while (used.has(id)) {
      const tail = `_${++suffix}`
      id = base.slice(0, 128 - tail.length) + tail
    }
    widget.id = id
    used.add(id)
    if (oldId !== id) remapped[oldId] = id
  }
  return remapped
}

// Main-canvas IDs are document-wide, not view-local: views only filter the
// same widget array. Historical presets may contain multiple real instances
// under one ID. Allocate their technical identities only for an explicit
// human save/publish, never while reading a document or activating a release.
// Keep the first identity stable and preserve the old broadcast semantics of
// show/hide, overrides and widget visibility events for all its instances.
// Tooltip templates have their own identity scope and are not re-keyed here.
export function prepareDashboardWidgetIdentities(document) {
  const issues = dashboardWidgetIdentityIssues(document)
  const invalid = issues.filter(issue => issue.code === 'invalid-widget-id')
  if (invalid.length) throw new Error(invalid.map(issue => issue.message).join('；'))
  if (!issues.some(issue => issue.code === 'duplicate-widget-id')) {
    return { document, changed: false, changes: [] }
  }

  const repaired = copyValue(document)
  const used = new Set(repaired.widgets.map(widget => widget.id))
  const reserveTarget = target => {
    const id = String(target || '').replace(/^widget:/, '')
    if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) used.add(id)
  }
  // Do not accidentally turn a dangling authored reference into a reference
  // to a newly named widget, or overwrite a separately authored override.
  for (const view of repaired.scene?.views || []) {
    const state = view.componentState || view.components
    for (const target of [...(state?.show || []), ...(state?.hide || []), ...Object.keys(state?.overrides || {})]) reserveTarget(target)
  }
  for (const widget of repaired.widgets) for (const event of widget.events || []) {
    if (event?.targetType === 'widget') reserveTarget(event.targetId)
  }

  const seen = new Set(), changes = [], targets = new Map()
  repaired.widgets.forEach((widget, index) => {
    const oldId = widget.id
    if (!seen.has(oldId)) { seen.add(oldId); return }
    let suffix = 1, newId = oldId
    while (used.has(newId)) {
      const tail = `_${++suffix}`
      newId = oldId.slice(0, 128 - tail.length) + tail
    }
    used.add(newId)
    renameDashboardWidget(repaired, widget, newId)
    changes.push({ index, oldId, newId })
    if (!targets.has(oldId)) targets.set(oldId, [])
    targets.get(oldId).push(newId)
  })

  for (const widget of repaired.widgets) {
    if (!Array.isArray(widget.events)) continue
    const events = widget.events.flatMap(event => {
      const additional = event?.targetType === 'widget' && ['set_visibility', 'toggle_visibility'].includes(event.action)
        ? targets.get(event.targetId) : null
      return additional?.length ? [event, ...additional.map(targetId => ({ ...copyValue(event), targetId }))] : [event]
    })
    // The persisted event schema currently accepts twelve events. Reject an
    // unsafe repair atomically instead of letting normalization silently drop
    // authored actions. Ordinary duplicate HUD presets have no such events.
    if (events.length > 12 && events.length > widget.events.length) {
      throw new Error(`组件“${widget.title || widget.id}”的重复标识关联了过多显隐事件；保留全部动作需要超过 12 个事件，未修改草稿`)
    }
    widget.events = events
  }
  return { document: repaired, changed: true, changes }
}
