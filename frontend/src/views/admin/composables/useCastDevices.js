import { computed, reactive, ref, onScopeDispose } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'

/**
 * 局域网电视发现与一键投屏。
 *
 * 交互模型对齐手机投屏：后台直接列出局域网里电视的名字，点“投屏”就把大屏画面
 * 推过去，点“停止投屏”收回。当前大屏画面统一来自 Unity 原生客户端。
 */
export function useCastDevices({ alert, confirm } = {}) {
    const castState = reactive({
        loaded: false,
        devices: [],
        interfaces: [],
        scanning: false,
        lastScanAt: '',
        error: '',
        ffmpegChecked: false,
        ffmpegChecking: false,
        ffmpegAvailable: null,
        ffmpegError: '',
        ignoredCount: 0,
        casting: false,
        session: null,
        castError: ''
    })
    const castBusyDeviceId = ref('')
    const castMessage = ref('')
    let castRefreshTimer = null
    let castRequestSeq = 0
    let castLoading = false
    let castDisposed = false

    const castingDeviceId = computed(() => castState.session?.deviceId || '')
    const castingDeviceName = computed(() => castState.session?.deviceName || '')

    function applyPayload(result) {
        if (castDisposed || !result) return
        if (result.error && !Array.isArray(result.devices)) throw new Error(result.error)
        castState.devices = Array.isArray(result.devices) ? result.devices : []
        castState.interfaces = Array.isArray(result.interfaces) ? result.interfaces : []
        castState.scanning = result.scanning === true
        castState.lastScanAt = result.lastScanAt || ''
        castState.error = result.error || ''
        castState.ignoredCount = Number(result.ignoredCount) || 0
        castState.ffmpegChecked = result.cast?.ffmpegChecked === true
        castState.ffmpegChecking = result.cast?.ffmpegChecking === true
        castState.ffmpegAvailable = result.cast?.ffmpegAvailable === true
        castState.ffmpegError = result.cast?.ffmpegError || ''
        castState.casting = result.cast?.casting === true
        castState.session = result.cast?.session || null
        castState.castError = result.cast?.error || ''
        castState.loaded = true
    }

    function deviceLabel(device) {
        // 电视自己上报的 friendlyName 往往就是「客厅的电视」这类中文名，优先用它。
        return device?.name || device?.modelName || '未命名设备'
    }

    function deviceSubtitle(device) {
        const parts = [device?.brand || device?.manufacturer, device?.modelName, device?.address]
            .map(part => String(part || '').trim())
            .filter(Boolean)
        return Array.from(new Set(parts)).join(' · ')
    }

    function sessionStateLabel(session = castState.session) {
        const labels = {
            starting: '正在连接',
            waiting_for_tv: '等待电视接收画面',
            reconnecting: '正在自动重连',
            reconnect_failed: '等待再次重连',
            casting: '正在投屏'
        }
        return labels[session?.state] || (castState.casting ? '投屏会话已建立' : '待机')
    }

    async function loadCastDevices({ silent = true } = {}) {
        if (castDisposed || (silent && castLoading)) return
        const requestSeq = ++castRequestSeq
        castLoading = true
        try {
            const result = await adminApi.getCastDevices()
            if (castDisposed || requestSeq !== castRequestSeq) return
            applyPayload(result)
        } catch (error) {
            if (castDisposed || requestSeq !== castRequestSeq) return
            const message = `读取电视列表失败：${error.message || error}`
            if (!silent || !castState.loaded) castMessage.value = message
        } finally {
            if (requestSeq === castRequestSeq) castLoading = false
        }
    }

    async function refreshCastDevices() {
        castRequestSeq += 1
        castLoading = false
        castState.scanning = true
        castMessage.value = '正在搜索局域网内的电视...'
        try {
            const result = await adminApi.refreshCastDevices()
            applyPayload(result)
            castMessage.value = castState.devices.length
                ? `搜索完成，找到 ${castState.devices.length} 台可投屏设备。`
                : (castState.error || '没有搜到可投屏的电视。')
        } catch (error) {
            castMessage.value = `搜索失败：${error.message || error}`
        } finally {
            castState.scanning = false
        }
    }

    async function startCast(device) {
        if (!device?.id) return
        if (!castState.loaded || !castState.ffmpegChecked) {
            castMessage.value = '正在检查投屏服务...'
            await loadCastDevices({ silent: false })
        }
        if (!castState.ffmpegAvailable) {
            await alert?.(
                '内置投屏编码器没有准备好，暂时无法把 Unity 大屏画面推送给电视。\n\n'
                + '正式安装包会自动内置；开发环境请在 desktop 目录执行 npm run prepare:ffmpeg，等待几秒后重新搜索。\n'
                + (castState.ffmpegError ? `检测结果：${castState.ffmpegError}\n` : '')
                + '在此之前，可以先用下方的二维码 / 网址让电视浏览器打开大屏。',
                { title: '投屏编码器未就绪', type: 'warning' }
            )
            return
        }
        castBusyDeviceId.value = device.id
        castRequestSeq += 1
        castLoading = false
        castMessage.value = `正在把大屏推送到「${deviceLabel(device)}」...`
        try {
            const result = await adminApi.startCast(device.id)
            applyPayload(result)
            castMessage.value = castState.session?.viewers > 0
                ? `已连接「${deviceLabel(device)}」，电视正在接收大屏画面。`
                : `已把播放命令发送给「${deviceLabel(device)}」，正在等待电视连接视频流；未连接时系统会自动重试。`
        } catch (error) {
            castMessage.value = `投屏失败：${error.message || error}`
        } finally {
            castBusyDeviceId.value = ''
        }
    }

    async function stopCast() {
        const name = castingDeviceName.value
        if (name && confirm && !(await confirm(`确定停止向「${name}」投屏吗？`))) return
        castBusyDeviceId.value = castingDeviceId.value || 'stopping'
        castRequestSeq += 1
        castLoading = false
        castMessage.value = '正在停止投屏...'
        try {
            applyPayload(await adminApi.stopCast())
            castMessage.value = name ? `已停止向「${name}」投屏。` : '已停止投屏。'
        } catch (error) {
            castMessage.value = `停止投屏失败：${error.message || error}`
        } finally {
            castBusyDeviceId.value = ''
        }
    }

    function startCastRefresh() {
        if (castRefreshTimer) clearInterval(castRefreshTimer)
        castRefreshTimer = setInterval(() => loadCastDevices({ silent: true }), 6000)
        castRefreshTimer.unref?.()
    }

    function stopCastRefresh() {
        if (castRefreshTimer) clearInterval(castRefreshTimer)
        castRefreshTimer = null
        castRequestSeq += 1
        castLoading = false
    }

    onScopeDispose(() => {
        castDisposed = true
        stopCastRefresh()
    })

    return {
        castState,
        castBusyDeviceId,
        castMessage,
        castingDeviceId,
        castingDeviceName,
        deviceLabel,
        deviceSubtitle,
        sessionStateLabel,
        loadCastDevices,
        refreshCastDevices,
        startCast,
        stopCast,
        startCastRefresh,
        stopCastRefresh
    }
}
