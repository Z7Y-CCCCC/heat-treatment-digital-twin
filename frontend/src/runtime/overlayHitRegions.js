const HIT_SELECTOR = '[data-overlay-hit="true"]'
const isElement = node => node?.nodeType === 1

function hitTargets(node) {
  if (!isElement(node)) return []
  return [...(node.matches?.(HIT_SELECTOR) ? [node] : []), ...(node.querySelectorAll?.(HIT_SELECTOR) || [])]
}

// Noninteractive tooltip elements are not native input regions. Mounting,
// updating or removing one must not rescan every HUD rectangle/style/layout.
// Changes INSIDE an existing hit target still count (its rendered shell may
// change without the outer slot resizing). Release removed observer targets.
export function reconcileOverlayHitTargets(mutations, observer) {
  let changed = false
  for (const mutation of mutations) {
    const added = [...(mutation.addedNodes || [])].filter(isElement)
    const removed = [...(mutation.removedNodes || [])].filter(isElement)
    if ((added.length || removed.length) && mutation.target?.closest?.(HIT_SELECTOR)) changed = true
    for (const node of added) for (const target of hitTargets(node)) {
      observer?.observe(target)
      changed = true
    }
    for (const node of removed) for (const target of hitTargets(node)) {
      observer?.unobserve?.(target)
      changed = true
    }
  }
  return changed
}
