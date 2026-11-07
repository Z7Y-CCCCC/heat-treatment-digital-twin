// A directory sample comes from the authorized records endpoint, never from
// configuration defaults or a later row chosen because it has a nicer value.
export function firstDataCenterSample(records = []) {
  const first = Array.isArray(records) ? records[0] : null
  if (!first || typeof first.fieldId !== 'string') return { values: {}, objectName: '' }
  const values = {}
  for (const record of records) {
    if (!record || typeof record.fieldId !== 'string' || record.objectId !== first.objectId || Object.hasOwn(values, record.fieldId)) break
    values[record.fieldId] = { previewValue: record.value ?? null, quality: record.quality || 'unknown',
      valueType: record.valueType, previewUpdatedAt: record.updatedAt || null }
  }
  return { values, objectName: first.objectName || '第一条记录' }
}
