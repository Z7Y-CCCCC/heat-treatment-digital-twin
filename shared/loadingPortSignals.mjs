// Site bindings belong to a device instance, never to a reusable model/pack.
export function normalizeLoadingPortSignals(value) {
  if (value == null) return { version: 1, inletPointId: null, outletPointId: null }
  const fail = () => { throw Object.assign(new Error('进出料信号配置无效：请选择本设备的只读 BOOL 点位'), { statusCode: 400, code: 'LOADING_PORT_SIGNALS_INVALID' }) }
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'inletPointId', 'outletPointId'].includes(key))) fail()
  const result = { version: 1 }
  for (const field of ['inletPointId', 'outletPointId']) {
    const id = value[field]
    if (id !== null && !(typeof id === 'string' && id.length > 0 && id.length <= 120 && !/[\u0000-\u0020\u007f]/.test(id))) fail()
    result[field] = id
  }
  if (result.inletPointId && result.inletPointId === result.outletPointId) fail()
  return result
}
