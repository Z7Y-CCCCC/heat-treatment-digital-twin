import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import { adminApi } from '../config/factoryConfig.js'

// Same secured casting API as Settings; closing this picker never stops a TV.
export function useQuickCast({ allowed, identity, api = adminApi, intervalMs = 3000 }) {
    const state = reactive({ loaded: false, devices: [], casting: false, session: null, encoderReady: false })
    const busy = ref(''), error = ref(''), selectedId = ref('')
    const selected = computed(() => state.devices.find(device => device.id === selectedId.value))
    const activeId = computed(() => state.session?.deviceId || '')
    const phase = computed(() => ({ starting: '正在连接', waiting_for_tv: '等待电视接收', reconnecting: '正在重连', reconnect_failed: '连接中断', casting: '正在投屏' }[state.session?.state] || (state.casting ? '正在投屏' : '')))
    let epoch = 0, revision = 0, timer, disposed = false, reading = false
    const valid = token => !disposed && allowed.value && token === epoch
    function apply(result) {
        if (!result || result.success === false || (result.error && !Array.isArray(result.devices))) throw new Error(result?.error || '投屏服务暂不可用')
        state.loaded = true
        state.devices = Array.isArray(result.devices) ? result.devices : []
        state.casting = result.cast?.casting === true
        state.session = result.cast?.session || null
        state.encoderReady = result.cast?.ffmpegAvailable === true
        error.value = result.cast?.error || result.historyError || result.error || ''
        if (selectedId.value && !state.devices.some(device => device.id === selectedId.value)) selectedId.value = ''
    }
    async function load() {
        if (!allowed.value || disposed || reading || busy.value) return
        const token = epoch, version = revision
        reading = true
        try {
            const result = await api.getCastDevices()
            if (valid(token) && version === revision) apply(result)
        } catch (reason) {
            if (valid(token) && version === revision) error.value = reason.message || '读取投屏状态失败'
        } finally { if (token === epoch) reading = false }
    }
    async function command(key, operation) {
        if (!allowed.value || disposed || busy.value) return false
        const token = epoch
        revision++
        busy.value = key
        error.value = ''
        try {
            const result = await operation()
            if (!valid(token)) return false
            apply(result)
            return true
        } catch (reason) {
            if (valid(token)) error.value = reason.message || '操作失败，请重试'
            return false
        } finally { if (valid(token)) busy.value = '' }
    }
    const search = () => command('search', () => api.refreshCastDevices())
    async function start() {
        const device = selected.value
        if (!device || device.id === activeId.value) return
        if (!state.encoderReady) { error.value = '投屏编码器未就绪，请重试'; return }
        if (await command('start', () => api.startCast(device.id))) selectedId.value = ''
    }
    const stop = () => command('stop', () => api.stopCast())
    const retry = () => activeId.value ? command('retry', () => api.startCast(activeId.value)) : false
    watch([allowed, identity], async () => {
        const token = ++epoch
        revision++
        clearInterval(timer)
        reading = false
        busy.value = ''; error.value = ''; selectedId.value = ''
        Object.assign(state, { loaded: false, devices: [], casting: false, session: null, encoderReady: false })
        if (!allowed.value || disposed) return
        await load()
        if (!valid(token)) return
        // Search once on entry, not continuously. Status polling never changes target.
        if (state.loaded && !state.devices.some(device => device.available !== false) && !state.casting && !error.value) await search()
        if (valid(token)) timer = setInterval(load, intervalMs)
    }, { immediate: true })
    onScopeDispose(() => { disposed = true; epoch++; clearInterval(timer) })
    return { state, busy, error, selectedId, selected, activeId, phase, load, search, start, stop, retry }
}
