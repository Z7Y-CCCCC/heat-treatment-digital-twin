import { computed, onBeforeUnmount, onMounted, ref, unref, watch } from 'vue'
import { normalizeParameterDefinitions, resolveParameters } from '../../../shared/dashboardParameters.mjs'

const copy = value => JSON.parse(JSON.stringify(value ?? null))
const EVENTS = new Set(['ready', 'contextChanged', 'viewChanged', 'deviceSelected', 'parametersChanged', 'widgetAction'])
export const SOFTWARE_METHODS = [
  { name: 'getContext', label: '读取当前视角', args: [], example: 'await DigitalTwin.getContext()' },
  { name: 'getParameters', label: '读取参数', args: [], example: 'await DigitalTwin.getParameters()' },
  { name: 'setParameters', label: '更新参数', args: [{}], example: 'await DigitalTwin.setParameters({ batch: "A01" })' },
  { name: 'resetParameters', label: '恢复默认参数', args: [], example: 'await DigitalTwin.resetParameters()' },
  { name: 'refreshData', label: '刷新组件数据', args: [], example: 'await DigitalTwin.refreshData()' },
  { name: 'switchView', label: '切换视角', args: ['factory_overview'], example: 'await DigitalTwin.switchView("factory_overview")' },
  { name: 'focusDevice', label: '定位设备', args: ['DEVICE_ID'], example: 'await DigitalTwin.focusDevice("DEVICE_ID")' },
  { name: 'setVisible', label: '组件显隐', args: ['WIDGET_ID', true], example: 'await DigitalTwin.setVisible("WIDGET_ID", true)' }
]

// Same-window interface only: no eval, arbitrary host messages, SQL or PLC writes.
export function createSoftwareInterface(hooks) {
  let disposed = false
  const listeners = new Map()
  function guard() {
    if (disposed) throw new Error('画面接口已关闭')
    if (!hooks.authorize()) throw new Error('当前账户没有画面访问权限')
    if (!hooks.isReady()) throw new Error('画面尚未就绪')
  }
  const methods = Object.fromEntries(SOFTWARE_METHODS.map(({ name }) => [name, async (...args) => {
    guard()
    const result = await hooks[name](...args)
    guard()
    if (['switchView','focusDevice'].includes(name) && result===false) throw new Error('视角切换未完成，请检查 Unity 连接')
    return copy(result)
  }]))
  const api = Object.freeze({ version: '1.0', ...methods,
    async ready() {
      const deadline=Date.now()+10000
      while (!disposed && !hooks.isReady() && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25))
      guard(); return copy(hooks.getContext())
    },
    on(name, listener) {
      guard()
      if (!EVENTS.has(name) || typeof listener !== 'function') throw new Error('无效的画面事件')
      const set = listeners.get(name) || new Set()
      if (set.size >= 32) throw new Error('画面事件监听过多')
      set.add(listener); listeners.set(name, set)
      if (name==='ready') queueMicrotask(()=>{
        if (!disposed && set.has(listener) && hooks.authorize() && hooks.isReady()) {
          try { Promise.resolve(listener(copy(hooks.getContext()))).catch(()=>{}) } catch { /* isolate integrations */ }
        }
      })
      return () => set.delete(listener)
    },
    off(name, listener) { listeners.get(name)?.delete(listener) }
  })
  return { api,
    emit(name, data) {
      if (disposed || !hooks.authorize() || !hooks.isReady()) return
      for (const listener of listeners.get(name) || []) {
        if (disposed || !hooks.authorize()) break
        try { Promise.resolve(listener(copy(data))).catch(()=>{}) } catch { /* isolate integrations */ }
      }
    },
    dispose() { disposed = true; listeners.clear() }
  }
}

const installations = new WeakMap()
export function installSoftwareInterface(target, api) {
  const state=installations.get(target) || {original:target.DigitalTwin,active:[]}
  state.active.push(api);installations.set(target,state);target.DigitalTwin=api
  return () => {
    state.active=state.active.filter(item=>item!==api)
    if (target.DigitalTwin===api) {
      const next=state.active.at(-1) ?? state.original
      if (next===undefined) delete target.DigitalTwin
      else target.DigitalTwin=next
    }
    if (!state.active.length) installations.delete(target)
  }
}

export function useDashboardIntegration(options) {
  const parameters = ref({}), error = ref('')
  const definitions = computed(() => normalizeParameterDefinitions(unref(options.document)?.parameters || []))
  let disposed = false, uninstall = null
  function setParameters(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('参数值必须是键值对象')
    const next = resolveParameters(definitions.value, { ...parameters.value, ...patch })
    error.value = ''
    if (JSON.stringify(next) !== JSON.stringify(parameters.value)) {
      parameters.value = next
      controller.emit('parametersChanged', next)
    }
    return next
  }
  function contextValue() {
    const c=unref(options.context) || {}
    return Object.fromEntries(['factoryId','sceneId','viewId','viewMode','workshopId','lineId','deviceId','partId'].map(key=>[key,String(c[key] || (key==='sceneId'?unref(options.document)?.sceneId:'') || '')]))
  }
  const controller = createSoftwareInterface({
    authorize: options.authorize,
    isReady: () => !disposed && !!unref(options.document)?.scene?.views?.length && options.ready?.() !== false,
    getContext: contextValue,
    getParameters: () => parameters.value,
    setParameters,
    resetParameters: () => setParameters(resolveParameters(definitions.value)),
    refreshData: () => options.refresh(),
    switchView: id => {
      if (!(unref(options.document)?.scene?.views || []).some(view => view.id === id && !view.metadata?.hierarchyHidden)) throw new Error('视角不存在或已隐藏')
      return options.action({ event: { action:'switch_view', viewId:id } })
    },
    focusDevice: id => {
      if (!(unref(options.devices) || []).some(device => device.id === id)) throw new Error('设备不属于当前工厂')
      return options.action({ event: { action:'enter_device', deviceId:id } })
    },
    setVisible: (id, visible) => {
      if (typeof visible !== 'boolean' || !(unref(options.document)?.widgets || []).some(widget => widget.id === id)) throw new Error('请选择有效组件与显隐状态')
      return options.action({ event: { action:'set_visibility', targetType:'widget',targetId:id, visibility:visible?'show':'hide' } })
    }
  })
  watch(() => [unref(options.scope), JSON.stringify(definitions.value)], () => {
    parameters.value = resolveParameters(definitions.value); error.value = ''
  }, { immediate:true })
  watch(parameters, () => { if (!disposed && options.authorize() && options.ready?.()!==false && unref(options.document)?.scene?.views?.length) void Promise.resolve(options.refresh()).catch(() => {}) })
  const contextSnapshot = computed(contextValue)
  let emittedContext=contextSnapshot.value
  watch([() => JSON.stringify(contextSnapshot.value), () => options.ready?.()], ([value]) => {
    if (options.ready?.()===false || !options.authorize()) return
    const current=JSON.parse(value), old=emittedContext
    controller.emit('contextChanged',current)
    if (current.viewId!==old.viewId) controller.emit('viewChanged',current)
    if (current.deviceId && current.deviceId!==old.deviceId) controller.emit('deviceSelected',current)
    emittedContext=current
  })
  function handle(event) {
    if (!['set_parameter','reset_parameters','refresh_data'].includes(event?.action)) return false
    try {
      if (!options.authorize()) throw new Error('当前账户没有画面访问权限')
      if (event.action === 'set_parameter') setParameters({ [event.parameterKey]: event.value })
      if (event.action === 'reset_parameters') setParameters(resolveParameters(definitions.value))
      if (event.action === 'refresh_data') void Promise.resolve(options.refresh()).catch(() => {})
    } catch (e) { error.value = e.message }
    return true
  }
  onMounted(() => { if (options.install !== false) {
    uninstall = installSoftwareInterface(window, controller.api)
    void controller.api.ready().then(context=>{if (!disposed) {window.dispatchEvent?.(new CustomEvent('digital-twin-ready'))}}).catch(()=>{})
  } })
  onBeforeUnmount(() => { disposed = true; uninstall?.(); controller.dispose() })
  return { parameters, definitions, error, api:controller.api, handle, emit:controller.emit }
}
