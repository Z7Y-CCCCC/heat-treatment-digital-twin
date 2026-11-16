// Fixed native actions; neither a desktop-control token nor an arbitrary URL
// ever crosses this page bridge. A result means confirmation, not dispatch.
export const SERVICE_ACTIONS = new Set(['unity_reconnect', 'unity_restart', 'data_reconnect',
  'collector_center_data', 'collector_center_runtime', 'restart_status'])
// Only locally authored messages for the host's fixed, non-secret failure codes
// can reach the UI. Never display exception/error text supplied by the host.
const SERVICE_FAILURE_MESSAGES = Object.freeze({
  BUSY: '已有服务操作正在执行',
  AUTH_REQUIRED: '当前后台会话已失效，请重新解锁后台',
  PERMISSION_DENIED: '当前账户没有此服务操作权限，请检查权限后重新检测',
  SESSION_CHECK_FAILED: '后台会话检测失败，请检查数据服务后重新检测',
  UNITY_PROCESS_UNAVAILABLE: '当前本机 Unity 进程不可用，请先启动大屏后重新检测',
  UNITY_TICKET_FAILED: 'Unity 会话票据未确认，请检查登录状态后重试',
  UNITY_PIPE_UNAVAILABLE: '无法连接当前 Unity 的本机通信通道，请检查大屏进程后重试',
  UNITY_HANDSHAKE_TIMEOUT: 'Unity 新实时通道握手超时，未确认重连成功，请重新检测',
  CENTER_VIEW_UNCONFIRMED: '运行中心尚未确认打开所选页面，请重试',
  DATA_HANDSHAKE_UNCONFIRMED: '当前大屏数据通道握手未确认，请重新检测',
  DESKTOP_CONTROL_UNCONFIRMED: '本机桌面控制通道未确认，请检查大屏运行状态',
  SERVICE_ACTION_UNCONFIRMED: '宿主操作被拒绝、已取消或未确认，请重新检测'
})
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
    else {
      const code = typeof data.code === 'string' && Object.hasOwn(SERVICE_FAILURE_MESSAGES, data.code)
        ? data.code : 'SERVICE_ACTION_UNCONFIRMED'
      item.reject(Object.assign(new Error(SERVICE_FAILURE_MESSAGES[code]), { code }))
    }
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
