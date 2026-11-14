export const DOOR_ENDPOINT_CONVENTION = Object.freeze({ closed: 0, open: 1 })
// An explicit adapter for legacy authoring rigs, never a live-data migration.
export function canonicalDoorProgress(progress, source = DOOR_ENDPOINT_CONVENTION) {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('Door progress must be within 0..1')
  if (![0, 1].includes(source.closed) || source.open !== 1 - source.closed) throw new Error('Declare door closed/open endpoints before exporting')
  return source.closed + (source.open - source.closed) * progress
}
