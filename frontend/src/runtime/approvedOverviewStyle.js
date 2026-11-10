import { applyDescendantViewStyle, DEFAULT_TARGET_VIEW_IDS, SOURCE_WIDGETS } from '../../../shared/descendantViewStyle.mjs'

export const APPROVED_OVERVIEW_STYLE_VERSION = 2

export function approvedOverviewAuthority(document, releasedDocument) {
  if (document?.metadata?.approvedOverviewStyle?.version === APPROVED_OVERVIEW_STYLE_VERSION) return document
  const contract = releasedDocument?.metadata?.approvedOverviewStyle
  if (!document || contract?.version !== APPROVED_OVERVIEW_STYLE_VERSION || contract.sourceViewId !== 'factory_overview'
    || document.sceneId !== releasedDocument.sceneId || document.projectId !== releasedDocument.projectId) return document
  return { ...document, metadata: { ...document.metadata, approvedOverviewStyle: contract } }
}

// Apply the authoritative code-backed appearance even to an older local draft.
// Widget identity, data, text, frames and rules are never replaced by the server.
export function applyApprovedOverviewStyle(document, authority = document) {
  const contract = authority?.metadata?.approvedOverviewStyle
  if (contract?.version !== APPROVED_OVERVIEW_STYLE_VERSION || contract.sourceViewId !== 'factory_overview'
    || !Array.isArray(document?.widgets) || !Array.isArray(document.scene?.views)) return document
  const references = new Map((authority.widgets || []).map(widget => [widget.id, widget]))
  if (!Object.values(SOURCE_WIDGETS).every(([id]) => references.has(id))) return document
  const targetViewIds = DEFAULT_TARGET_VIEW_IDS.filter(id => document.scene.views.some(view => view.id === id))
  if (!targetViewIds.length) return document
  const result = applyDescendantViewStyle(document, { targetViewIds, referenceDocument: authority }).document
  result.metadata = { ...result.metadata, approvedOverviewStyle: { version: contract.version, sourceViewId: contract.sourceViewId } }
  return result
}
