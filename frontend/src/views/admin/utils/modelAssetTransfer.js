export const ASSET_MODULES = [
  { id: 'actions', label: '动作' },
  { id: 'inspection', label: '拆解布局' },
  { id: 'model', label: '模型文件' },
  { id: 'ports', label: '进出料口设置' }
]

export function assetActionChoices(model) {
  let metadata = model?.metadata || {}
  try { if (typeof metadata === 'string') metadata = JSON.parse(metadata) } catch { metadata = {} }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {}
  const motion = model?.motion_package || metadata.motionAuthoring?.bundle
  const array = value => Array.isArray(value) ? value.filter(action => action && typeof action === 'object') : []
  return uniqueActions([
    ...array(motion?.actions).map(action => ({ ...action, label: action.label || action.name || action.id })),
    ...array(metadata.partBindings).map(action => ({ ...action, label: action.name || action.label || action.id })),
    ...array(metadata.motionAuthoring?.actions).map(action => ({ ...action, label: action.label || action.name || action.id }))
  ])
}

export function uniqueActions(actions) {
  const result = new Map()
  for (const action of Array.isArray(actions) ? actions : []) {
    if (typeof action?.id !== 'string' || !action.id || result.has(action.id)) continue
    result.set(action.id, { id: action.id, label: action.label || action.name || action.id, kind: action.kind, module: action.module })
  }
  return [...result.values()]
}

export function checkedActionChoices(checked) {
  return uniqueActions(checked?.updatePlan?.actions?.length ? checked.updatePlan.actions : checked?.actions)
}

export function updateOptionsFor(targetId, modules, actionIds = null, replaceActionIds = []) {
  return {
    targetId, modules: ASSET_MODULES.filter(module => modules.includes(module.id)).map(module => module.id),
    ...(modules.includes('actions') && actionIds !== null ? { actionIds: [...new Set(actionIds)] } : {}),
    ...(modules.includes('actions') && replaceActionIds.length ? { replaceActionIds: [...new Set(replaceActionIds)] } : {})
  }
}

export function importReady(row, updating = false, options = null) {
  if (!row?.checked || row.status === 'imported' || row.status === 'checking') return false
  if (!updating) return true
  const plan = row.checked.updatePlan
  return !!plan && plan.canImport !== false && !plan.conflicts?.length && row.inspectedOptions === JSON.stringify(options)
}

export function toggleAssetAction(ids, id, checked, allIds) {
  const result = new Set(ids === null ? allIds : ids)
  checked ? result.add(id) : result.delete(id)
  return [...result]
}

export function assetUpdateSummary(plan) {
  if (!plan) return ''
  const actions = Array.isArray(plan.actions) ? plan.actions : []
  const added = actions.filter(action => action?.kind === 'add').length
  const replaced = actions.filter(action => action?.kind === 'replace').length
  return [added ? `新增 ${added}` : '', replaced ? `更新 ${replaced}` : '', plan.inspectionChanged ? '更新布局' : '', plan.modelChanged ? '更新模型' : '', plan.portsChanged ? '更新进出料口设置' : ''].filter(Boolean).join(' · ') || '内容一致'
}
