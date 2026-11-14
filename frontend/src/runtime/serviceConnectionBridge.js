// Fixed native actions; neither a desktop-control token nor an arbitrary URL
// ever crosses this page bridge. A result means confirmation, not dispatch.
export const SERVICE_ACTIONS = new Set(['unity_reconnect', 'unity_restart', 'data_reconnect',
  'collector_center_data', 'collector_center_runtime', 'restart_status'])
export function createServiceConnectionBridge({ post, listen, unlisten, later = setTimeout, cancel = clearTimeout }) {
  const pending = new Map()
  let sequence = 0, disposed = false
  const prefix = Math.random().toString(36).slice(2)
  const receive = event => {
    const data = event.data
    if (data?.type !== 'service_connection_result' || !pending.has(data.requestId)) return
    const item = pending.get(data.requestId)
    pending.delete(data.requestId); cancel(item.timer)
    if (data.success === true) item.resolve(data)
    else item.reject(Object.assign(new Error(data.code === 'BUSY' ? '已有服务操作正在执行' : '宿主操作被拒绝、已取消或未确认，请重新检测'), { code: data.code }))
  }
  listen(receive)
  return {
    request(action, { operationId = '', timeoutMs = 35000 } = {}) {
      if (disposed || !SERVICE_ACTIONS.has(action)) return Promise.reject(new Error('不支持的宿主操作'))
      const requestId = `${prefix}-${++sequence}`
      return new Promise((resolve, reject) => {
        const timer = later(() => { pending.delete(requestId); reject(new Error('操作确认超时，请重新检测；未报告恢复成功')) }, timeoutMs)
        pending.set(requestId, { resolve, reject, timer })
        try { post({ type: 'service_connection_action', action, requestId, operationId }) }
        catch (error) { cancel(timer); pending.delete(requestId); reject(error) }
      })
    },
    dispose() {
      disposed = true; unlisten(receive)
      for (const item of pending.values()) { cancel(item.timer); item.reject(new Error('连接面板已关闭')) }
      pending.clear()
    }
  }
}
