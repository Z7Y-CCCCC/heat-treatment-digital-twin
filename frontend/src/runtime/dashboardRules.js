function getByPath(source, path) {
  if (!path) return source
  return String(path).split('.').reduce((current, key) => current?.[key], source)
}

function numericValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function matchesRule(rule = {}, runtime = {}) {
  const source = rule.source === 'data' ? { value: runtime.dataValue, record: runtime.dataRecord } : runtime.context
  const value = getByPath(source, rule.path || (rule.source === 'data' ? 'value' : 'viewMode'))
  const target = rule.value
  const operator = rule.operator || '=='
  if (operator === 'truthy') return !!value
  if (operator === 'falsy') return !value
  if (operator === 'contains') {
    if (Array.isArray(value)) return value.map(String).includes(String(target))
    return String(value ?? '').includes(String(target ?? ''))
  }
  const leftNumber = numericValue(value)
  const rightNumber = numericValue(target)
  if (operator === '==') return String(value ?? '') === String(target ?? '') || (leftNumber !== null && rightNumber !== null && leftNumber === rightNumber)
  if (operator === '!=') return !matchesRule({ ...rule, operator: '==' }, runtime)
  if (leftNumber === null || rightNumber === null) return false
  if (operator === '>') return leftNumber > rightNumber
  if (operator === '>=') return leftNumber >= rightNumber
  if (operator === '<') return leftNumber < rightNumber
  if (operator === '<=') return leftNumber <= rightNumber
  return false
}

const shown = () => ({ visible: true, reason: '', code: 'visible' })
const hidden = (code, reason) => ({ visible: false, code, reason })

export function widgetRuntimeVisibility(widget = {}, runtime = {}) {
  if (widget.visible === false || widget.visible === 0) return hidden('manual', '组件已手动隐藏')
  const groupId = String(widget.groupId || '')
  if (groupId && runtime.groupVisibility?.[groupId] === false) return hidden('group-event', '组件组被事件隐藏')
  if (runtime.widgetVisibility?.[widget.id] === false) return hidden('widget-event', '组件被事件隐藏')

  const visibility = widget.visibility || {}
  const context = runtime.context || {}
  const viewId = String(context.viewId || '')
  if (Array.isArray(visibility.viewIds) && visibility.viewIds.length && !visibility.viewIds.includes(viewId)) return hidden('view-filter', '不在指定视角中')
  if (Array.isArray(visibility.viewModes) && visibility.viewModes.length
    && !visibility.viewModes.includes(context.viewMode || 'factory')) return hidden('mode-filter', '不在指定视角类型中')
  if (visibility.matchBoundDevice) {
    const deviceScope = widget.data?.deviceScope === 'current' ? 'current' : 'fixed'
    if (deviceScope === 'current') {
      // “当前设备” is a runtime context, not a duplicated widget per device.
      if (!String(context.deviceId || '')) return hidden('device-context', '当前视角未选择设备')
    } else {
      const boundDeviceId = String(widget.data?.deviceId || '')
      if (!boundDeviceId || String(context.deviceId || '') !== boundDeviceId) return hidden('device-filter', '与绑定设备不匹配')
    }
  }
  const rules = Array.isArray(visibility.rules) ? visibility.rules : []
  if (!rules.length) return shown()
  const matches = rules.map(rule => matchesRule(rule, runtime))
  return (visibility.ruleMode === 'any' ? matches.some(Boolean) : matches.every(Boolean))
    ? shown() : hidden('rule', '显隐条件未满足')
}

export function widgetRuntimeVisible(widget = {}, runtime = {}) {
  return widgetRuntimeVisibility(widget, runtime).visible
}

export function applyVisibilityAction(event = {}, state = {}) {
  const targetId = String(event.targetId || '')
  if (!targetId) return false
  const store = event.targetType === 'widget' ? state.widgetVisibility : state.groupVisibility
  if (!store) return false
  if (event.action === 'toggle_visibility') store[targetId] = store[targetId] === false
  else store[targetId] = event.visibility !== 'hide'
  return true
}
