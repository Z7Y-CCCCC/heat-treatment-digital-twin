import { reactive, computed, onUnmounted } from 'vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch, adminSession, canAdminApi, canAdminPage, refreshAdminSession } from '../../../runtime/adminSession.js'
import { getFactoryScope, FACTORY_SCOPE_CHANGE_EVENT } from '../../../runtime/factoryScope.js'
import { reconnectActiveDashboardChannels, getActiveDashboardChannelCount } from '../../../runtime/DataStore.js'
import { createServiceConnectionBridge } from '../../../runtime/serviceConnectionBridge.js'

export const RESTART_RECEIPT_KEY = 'digital-twin-service-restart-receipt-v1'
const names = { unity: 'Unity', devices: '设备采集', data: '数据服务', session: '登录状态' }
const empty = () => Object.entries(names).map(([key, name]) => ({ key, name, label: '等待检测',
  detail: '尚未取得服务响应', tone: 'is-unknown', connected: false }))

// Pure controller for permission/failure/continuous-click tests.
export function createConnectionControl({ state, read, session, allow, native, bridge, reconnect,
  activeChannels, confirm, prepareRestart, unlock, storage, scope = () => '', now = Date.now, delay = ms => new Promise(r => setTimeout(r, ms)) }) {
  let generation = 0, reading = null, disposed = false
  function fail(error) {
    state.services = state.services.map(item => ({ ...item, connected: false, stale: true,
      tone: 'is-unknown', label: '检测失败', detail: error.message || '服务不可达' }))
  }
  async function refresh() {
    if (disposed) return null
    if (reading) return reading
    const epoch = ++generation
    const factoryId = scope()
    reading = (async () => {
      try {
        const result = await read('/system/connections/status', 'GET', { factoryId })
        if (disposed || epoch !== generation) return null
        if (scope() !== factoryId || factoryId && result?.factoryId !== factoryId) throw new Error('工厂上下文已改变，请重新检测')
        if (result?.success !== true || !Array.isArray(result.services) ||
          !Object.keys(names).every(key => result.services.some(item => item.key === key))) throw new Error('服务状态响应异常')
        state.snapshot = result; state.services = result.services; return result
      } catch (error) { if (!disposed && epoch === generation) fail(error); return null }
      finally { if (epoch === generation) reading = null }
    })()
    return reading
  }
  function actions() {
    const controls = Object.fromEntries(Object.keys(names).map(key => [key, [{ id: 'check', label: '重新检测' }]]))
    const operation = (kind, id, label, allowed, reason, extra = {}) => controls[kind].push({ id, label,
      disabled: !allowed || Boolean(state.busy), reason: allowed ? '' : reason, ...extra })
    const runtimeEdit = allow('runtime'), dataEdit = allow('data')
    operation('unity', 'reconnect', '重连 Unity 实时通道', native && runtimeEdit, native ? '需要运行配置编辑权限' : '仅桌面宿主支持')
    operation('unity', 'restart', '重启当前大屏（不重启采集）', native && runtimeEdit,
      native ? '需要运行配置编辑权限' : '仅桌面宿主支持', { dangerous: true })
    operation('devices', 'restart', '重启采集进程（不是 Windows 服务）', dataEdit, '需要采集配置编辑权限', { dangerous: true })
    operation('devices', 'center', '打开采集运行中心', native && dataEdit, native ? '需要采集配置编辑权限' : '请在现场电脑打开运行中心')
    operation('data', 'reconnect', '重连当前大屏数据通道', native ? runtimeEdit : allow('view') && activeChannels() > 0,
      native ? '需要运行配置编辑权限' : '当前页面没有活跃数据通道')
    operation('data', 'center', '打开运行中心（后台 / Windows 服务）', native && runtimeEdit,
      native ? '需要运行配置编辑权限' : '请在现场电脑打开运行中心')
    operation('session', 'unlock', '返回登录 / 解锁', true, '')
    return controls
  }
  async function run({ kind, action } = {}) {
    if (disposed || state.busy || !Object.hasOwn(names, kind)) return false
    const item = actions()[kind].find(item => item.id === action)
    if (!item || item.disabled) return false
    state.busy = kind; state.feedback[kind] = null
    try {
      // Reserve the mutex BEFORE the confirmation, preventing duplicate prompts.
      if (item.dangerous) {
        if (kind === 'unity' && !await prepareRestart()) return false
        if (!await confirm(kind === 'unity' ? '将重启当前电脑的大屏和后台窗口，不重启采集服务。请确认所有表单与布局已保存。'
          : '将短暂停止并重启采集进程，期间不能补造读数。不会重启 Windows 服务或修改数据源。', { title: item.label, type: 'warning' })) return false
      }
      if (disposed) return false
      // Permissions may have changed while the confirmation was open.
      if (actions()[kind].find(value => value.id === action)?.reason) throw new Error('操作权限已改变，请重新检测')
      if (action === 'check') {
        await session()
        if (!await refresh()) throw new Error('重新检测失败，已保留最近通信时间')
        state.feedback[kind] = { type: 'success', message: '已重新检测（未修改配置）' }
      } else if (action === 'unlock') { await unlock() }
      else if (action === 'reconnect') {
        if (native) await bridge.request(kind === 'unity' ? 'unity_reconnect' : 'data_reconnect')
        else await reconnect()
        const snapshot = await refresh()
        state.feedback[kind] = snapshot ? { type: 'success', message: '新实时通道握手已确认；设备状态以检测结果为准' }
          : { type: 'error', message: '新通道握手已确认，但服务状态检测失败；未确认服务恢复' }
      } else if (action === 'center') {
        await bridge.request(kind === 'devices' ? 'collector_center_data' : 'collector_center_runtime')
        state.feedback[kind] = { type: 'success', message: '运行中心已打开；服务操作仍需在运行中心确认' }
      } else if (kind === 'unity') {
        // Persist only a non-secret correlation id before the old WebView exits.
        const result = await bridge.request('unity_restart')
        if (!result.accepted || !/^[a-f0-9]{32}$/.test(result.operationId || '')) throw new Error('大屏重启未受理')
        try { storage?.setItem(RESTART_RECEIPT_KEY, JSON.stringify({ operationId: result.operationId, at: now() })) }
        catch { throw new Error('重启已受理，但无法保存确认回执；重开后请手动重新检测，未报告恢复成功') }
        state.feedback.unity = { type: 'info', message: '重启已受理，等待新大屏就绪；尚未确认恢复' }
      } else {
        const startedAt = now()
        await read('/engine/restart', 'POST')
        let result
        const deadline = now() + 25000
        do {
          await delay(750); result = await refresh()
          if (disposed) return false
          if (result?.collection?.processRunning && result.collection.lastCommunicationAt >= startedAt &&
            ['healthy', 'simulation', 'online'].includes(result.collection.state)) break
        } while (now() < deadline)
        if (!result?.collection?.processRunning || !(result.collection.lastCommunicationAt >= startedAt) ||
          !['healthy', 'simulation', 'online'].includes(result.collection.state)) throw new Error('采集重启已受理，但尚未确认有效读数恢复；请检查设备状态')
        state.feedback.devices = { type: 'success', message: result.collection.mode === 'simulation'
          ? '采集进程已恢复模拟读数（不代表 PLC 在线）' : '采集进程和新有效读数已确认' }
      }
      return true
    } catch (error) {
      if (!disposed) state.feedback[kind] = { type: 'error', message: error.message || '操作失败' }
      await refresh(); return false
    } finally { state.busy = '' }
  }
  async function recoverReceipt() {
    if (!native || disposed || state.busy) return
    let receipt
    try { receipt = JSON.parse(storage?.getItem(RESTART_RECEIPT_KEY) || 'null') } catch { return }
    if (!receipt || !/^[a-f0-9]{32}$/.test(receipt.operationId) || !Number.isFinite(receipt.at)
      || now() - receipt.at > 120000 || receipt.at > now()) { try { storage?.removeItem(RESTART_RECEIPT_KEY) } catch {} return }
    state.busy = 'unity'
    try {
      const deadline = now() + 55000
      let result, snapshot
      do {
        result = await bridge.request('restart_status', { operationId: receipt.operationId, timeoutMs: Math.max(1, deadline - now()) })
        if (result.state === 'failed') throw new Error('当前大屏重启失败，请查看运行日志')
        snapshot = await refresh()
        if (result.state === 'ready' && snapshot?.unity?.state === 'ready') break
        await delay(800)
      } while (!disposed && now() < deadline)
      if (disposed) return
      if (result?.state !== 'ready' || snapshot?.unity?.state !== 'ready') throw new Error('新大屏尚未确认场景就绪；请重新检测')
      state.feedback.unity = { type: 'success', message: '新大屏进程、数据层及场景就绪已确认' }
    } catch (error) { if (!disposed) state.feedback.unity = { type: 'error', message: error.message } }
    finally { state.busy = ''; try { storage?.removeItem(RESTART_RECEIPT_KEY) } catch {} }
  }
  return { refresh, run, actions, recoverReceipt,
    invalidate() { generation++; reading = null; state.snapshot = null; state.services = empty() },
    dispose() { disposed = true; generation++; bridge?.dispose() } }
}

export function useServiceConnections({ confirm, prepareRestart }) {
  const state = reactive({ services: empty(), snapshot: null, busy: '', feedback: {} })
  const webview = window.chrome?.webview
  const native = window.location.pathname === '/admin' && Boolean(webview?.postMessage)
  const bridge = native ? createServiceConnectionBridge({ post: message => webview.postMessage(message),
    listen: handler => webview.addEventListener?.('message', handler), unlisten: handler => webview.removeEventListener?.('message', handler) }) : null
  const read = async (path, method = 'GET', { factoryId = getFactoryScope() } = {}) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await adminFetch(`${API_BASE}${path}`, { method, cache: 'no-store', signal: controller.signal,
        headers: { 'X-Factory-ID': factoryId } })
      const result = await response.json()
      if (!response.ok || result?.error || result?.success === false) throw new Error(response.status === 401 ? '会话已失效，请重新登录'
        : response.status === 403 ? '无权限执行此操作' : response.status >= 500 ? '后台服务暂不可用，请检查运行状态' : '服务请求未确认')
      return result
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError || error instanceof SyntaxError)
        throw new Error('服务通信超时或响应异常，请重新检测')
      throw error
    } finally { clearTimeout(timer) }
  }
  const control = createConnectionControl({ state, read, session: refreshAdminSession, native, bridge,
    allow: kind => adminSession.authenticated && (kind === 'runtime' ? canAdminPage('settings.runtime', 'edit')
      : kind === 'data' ? canAdminApi('/api/engine/restart', 'POST') : canAdminApi('/api/system/connections/status')),
    scope: getFactoryScope, activeChannels: getActiveDashboardChannelCount, reconnect: reconnectActiveDashboardChannels, confirm, prepareRestart,
    unlock: async () => { await refreshAdminSession(); webview?.postMessage({ type: 'host_action', action: 'show_admin' }) }, storage: window.localStorage })
  const scopeChanged = () => { control.invalidate(); void control.refresh() }
  window.addEventListener(FACTORY_SCOPE_CHANGE_EVENT, scopeChanged)
  onUnmounted(() => { window.removeEventListener(FACTORY_SCOPE_CHANGE_EVENT, scopeChanged); control.dispose() })
  return { connectionState: state, connectionActions: computed(control.actions), refresh: control.refresh,
    handleConnectionAction: control.run, recoverConnectionRestart: control.recoverReceipt }
}
