import { globalViewEnabled } from '../../../shared/viewNavigation.mjs'
import { hierarchyHidden } from './viewHierarchy.js'

export function designerViewAvailable(view, policy) {
  return !!view && !hierarchyHidden(view) && view.metadata?.runtimeHidden !== true && globalViewEnabled(policy, view.id)
}

export function designerEntryView(views = [], policy, preferred = []) {
  const available = views.filter(view => designerViewAvailable(view, policy))
  for (const id of preferred) if (available.some(view => view.id === id)) return id
  return [...available].sort((a, b) => (a.metadata?.hierarchyOrder ?? views.indexOf(a)) - (b.metadata?.hierarchyOrder ?? views.indexOf(b)))[0]?.id || ''
}
