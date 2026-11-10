import { runtimeViewHidden } from '../../../shared/viewNavigation.mjs'

// A native-owned, session-scoped entry is not the device's plant hierarchy.
// Inspection stages still return internally before using the entry view.
export function deviceReturnOrigin(context, views = []) {
  if (context?.viewMode !== 'device' || context.inspectionStage && context.inspectionStage !== 'solid') return null
  const origin = context.returnOrigin
  if (!origin || !origin.factoryId || !origin.sceneId || origin.factoryId !== context.factoryId || origin.sceneId !== context.sceneId
    || !['factory', 'workshop', 'line'].includes(origin.viewMode)) return null
  const view = views.find(view => view.id === origin.viewId)
  if (!view || runtimeViewHidden(view)) return null
  const mode = view.mode === 'custom' ? view.targetType : view.mode
  if (mode !== origin.viewMode) return null
  return { ...origin, name: view.name || origin.viewName || '进入设备前的视角' }
}

export function deviceBackRequest(context) {
  return { action: 'inspection_back', source: 'dashboard_overlay', viewId: context.viewId,
    focus: { mode: 'device', deviceId: context.deviceId || '', inspectionStage: context.inspectionStage || '' } }
}
