// Editor hierarchy only: hiding a row never deletes a view, its widgets or
// original links. Children are presented under the nearest unhidden ancestor.
export const hierarchyHidden = view => view?.metadata?.hierarchyHidden === true
export const viewDisplayName = view => /^(map_|site_)/.test(view?.id || '')
  ? String(view.name || '').replace(/^\s*\d{2}\s+/, '') : String(view?.name || '')

export function visibleViewLink(views, view, field = 'parentViewId') {
  const byId = new Map(views.map(v => [v.id, v])), seen = new Set([view?.id])
  let id = view?.[field] || ''
  while (id && !seen.has(id)) {
    seen.add(id)
    const parent = byId.get(id)
    if (!parent) return ''
    if (!hierarchyHidden(parent)) return id
    id = parent[field] || (field === 'returnViewId' ? parent.parentViewId : '') || ''
  }
  return ''
}

export function viewDescendants(views, id) {
  const ids = new Set([id])
  for (let n = 0; n < views.length; n++) {
    let changed = false
    for (const view of views) if (ids.has(view.parentViewId) && !ids.has(view.id)) { ids.add(view.id); changed = true }
    if (!changed) break
  }
  return ids
}

function orderedViews(views) {
  if (views.some(v => Number.isFinite(v.metadata?.hierarchyOrder)))
    return [...views].sort((a, b) => (a.metadata?.hierarchyOrder ?? 999) - (b.metadata?.hierarchyOrder ?? 999))
  return [...views].sort((a, b) => Number(b.id === 'map_world') - Number(a.id === 'map_world'))
}

export function viewTreeRows(views, collapsed = new Set(), includeHidden = false) {
  const ordered = includeHidden ? orderedViews(views) : viewTreeRows(views, new Set(), true).map(row => row.view)
  const ids = new Set(views.map(v => v.id)), children = new Map([['', []]])
  for (const view of ordered) {
    if (!includeHidden && hierarchyHidden(view)) continue
    const parent = includeHidden ? view.parentViewId : visibleViewLink(views, view)
    const key = parent && parent !== view.id && ids.has(parent) ? parent : ''
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(view)
  }
  const rows = [], seen = new Set(), reachable = new Set()
  const mark = view => { if (reachable.has(view.id)) return; reachable.add(view.id); (children.get(view.id) || []).forEach(mark) }
  ;(children.get('') || []).forEach(mark)
  const flatten = (view, level, parentId) => {
    if (seen.has(view.id)) return
    seen.add(view.id)
    const nested = children.get(view.id) || []
    rows.push({ view, level, parentId, hasChildren: nested.length > 0, collapsed: collapsed.has(view.id) })
    if (!collapsed.has(view.id)) nested.forEach(child => flatten(child, level + 1, view.id))
  }
  ;(children.get('') || []).forEach(v => flatten(v, 0, ''))
  ordered.filter(v => !reachable.has(v.id) && (includeHidden || !hierarchyHidden(v))).forEach(v => flatten(v, 0, ''))
  return rows
}

export function moveView(views, sourceId, targetId = '', placement = 'inside') {
  const source = views.find(v => v.id === sourceId), target = views.find(v => v.id === targetId)
  if (!source || hierarchyHidden(source) || (targetId && (!target || hierarchyHidden(target)))) return null
  const branch = viewDescendants(views, sourceId)
  if (branch.has(targetId) || !['inside', 'before', 'after', 'root'].includes(placement)) return null
  const parentId = placement === 'root' ? '' : placement === 'inside' ? targetId : visibleViewLink(views, target)
  if (branch.has(parentId)) return null
  const ordered = viewTreeRows(views, new Set(), true).map(row => row.view)
  const block = ordered.filter(v => branch.has(v.id)), remaining = ordered.filter(v => !branch.has(v.id))
  let index = remaining.length
  if (target) {
    index = remaining.findIndex(v => v.id === targetId)
    if (placement !== 'before') {
      const targetBranch = viewDescendants(remaining, targetId)
      while (index < remaining.length && targetBranch.has(remaining[index].id)) index++
    }
  }
  remaining.splice(index, 0, ...block)
  const moved = remaining.map((view, hierarchyOrder) => ({ ...view,
    ...(view.id === sourceId ? { parentViewId: parentId, returnViewId: parentId } : {}),
    metadata: { ...view.metadata, hierarchyOrder } }))
  const byId = new Map(moved.map(view => [view.id, view]))
  for (const start of moved) {
    const seen = new Set()
    let cursor = start
    while (cursor) {
      if (seen.has(cursor.id)) return null
      seen.add(cursor.id)
      cursor = byId.get(cursor.returnViewId || cursor.parentViewId)
    }
  }
  return moved
}

export function setHierarchyHidden(views, id, hidden) {
  if (!views.some(v => v.id === id)) return null
  if (hidden && !views.some(v => v.id !== id && !hierarchyHidden(v))) return null
  return views.map(v => v.id === id ? { ...v, metadata: { ...v.metadata, hierarchyHidden: !!hidden } } : v)
}
