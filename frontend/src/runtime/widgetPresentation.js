import { SYSTEM_WIDGET_TYPES, MAP_SURFACE_VIEW_IDS } from './dashboardSchema.js'
import { globalViewEnabled, runtimeViewHidden } from '../../../shared/viewNavigation.mjs'
import { widgetRuntimeVisibility } from './dashboardRules.js'

// Navigation controls are WebView widgets even in older documents tagged unity.
// Keep the same eligibility and view membership in authoring, maps and Unity HUD.
export function isCanvasWidget(widget) {
  const type = widget.type || widget.widget_type
  return ['navigation', 'return_button'].includes(type)
    || (!SYSTEM_WIDGET_TYPES.has(type) && widget.runtimeTarget !== 'unity')
}

export function widgetViewVisibility(widget, view) {
  if (!view) return { visible: false, code: 'no-view', reason: '未选择视角' }
  const type = widget.type || widget.widget_type
  const keys = [widget.id, type, `system:${type}`, widget.groupId && `group:${widget.groupId}`].filter(Boolean)
  const state = view.componentState || {}
  if (keys.some(key => state.hide?.includes(key))) return { visible: false, code: 'view-hidden', reason: '当前视角已隐藏此组件' }
  const included = keys.some(key => state.show?.includes(key))
  if ((MAP_SURFACE_VIEW_IDS.has(view.id) || state.show?.length) && !included) return { visible: false, code: 'not-in-view', reason: '未加入当前视角' }
  return { visible: true, code: 'visible', reason: '' }
}

// Preserve the runtime's automatic return-button hiding policy. The editor
// reports this state; it must not turn an automatic hide into a manual edit.
export function returnNavigationVisibility(view = {}, context = {}, defaultViewId = 'factory_overview') {
  const targetType = String(view.targetType || '').toLowerCase()
  const mode = String(context.viewMode || view.mode || targetType || 'factory').toLowerCase()
  const deviceView = mode === 'device' || targetType === 'device' || targetType === 'device_part'
    || ['xray', 'exploded', 'part'].includes(String(context.inspectionStage || '').toLowerCase())
  const yes = { visible: true, reason: '', code: 'visible' }
  if (context.sceneReady === false && !deviceView) return { visible: false, code: 'scene-loading', reason: '场景就绪后显示' }
  if (!deviceView && (mode === 'factory' || context.viewId === defaultViewId)) return { visible: false, code: 'root-return', reason: '首层视角自动隐藏返回键' }
  if (deviceView && context.inspectionStage && context.inspectionStage !== 'solid' || deviceView && targetType === 'device_part') return yes
  if (!view.returnViewId && !view.parentViewId) return deviceView || ['line', 'workshop'].includes(mode)
    ? yes : { visible: false, code: 'no-parent', reason: '没有上一级视角' }
  const target = deviceView ? context.deviceId || view.targetId || context.partId
    : mode === 'line' ? context.lineId || view.targetId
    : mode === 'workshop' ? context.workshopId || view.targetId : true
  return target ? yes : { visible: false, code: 'no-target', reason: '选择目标设备或区域后显示' }
}

export function widgetPresentationState(widget, { view, context = {}, policy, defaultViewId, ...runtime } = {}) {
  const rules = widgetRuntimeVisibility(widget, { ...runtime, context })
  if (!rules.visible) return rules
  if (!view || runtimeViewHidden(view) || !globalViewEnabled(policy, view.id)) return { visible: false, code: 'view-disabled', reason: '当前视角已关闭或隐藏' }
  const membership = widgetViewVisibility(widget, view)
  if (!membership.visible) return membership
  if ((widget.type || widget.widget_type) === 'return_button' && !MAP_SURFACE_VIEW_IDS.has(view.id)) return returnNavigationVisibility(view, context, defaultViewId)
  return rules
}
