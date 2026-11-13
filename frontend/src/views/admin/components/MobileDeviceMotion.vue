<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { computed, onUnmounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import { cacheFactoryDraft, clearFactoryDraft, readFactoryDraft } from '../../../runtime/factoryDraftCache.js'
import AdminNotice from './AdminNotice.vue'
import { useAdminNotice } from '../composables/useAdminNotice.js'
import { isActualMovingFeedback, simpleMotionError } from '../utils/mobileMotionPolicy.js'
import { canvasMotionBasis, simpleMotionDraft, simpleMovementPayload } from '../utils/simpleMotionDraft.js'

defineOptions({ name: 'MobileDeviceMotion' })

const props = defineProps({
    devices: { type: Array, default: () => [] }
})

const emit = defineEmits(['saved'])

function numberOr(value, fallback = 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
}

function pointIdOr(value) {
    return value === undefined || value === null ? '' : String(value)
}

function parseJson(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
        return {}
    }
}

function validPosition(value) {
    return value && typeof value === 'object' && ['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]) && Math.abs(value[axis]) <= 100000)
}

function railBasisError(movement) {
    if (!validPosition(movement.start) || !validPosition(movement.end)) return '轨道信息不完整，请在产线画布修正导轨并重新导入工位'
    if (Math.hypot(movement.end.x - movement.start.x, movement.end.z - movement.start.z) < .0001) return '轨道方向无效，请在产线画布修正导轨并重新导入工位'
    return ''
}

const defaultMotion = device => simpleMotionDraft(device)

function isRailBoundDevice(device) {
    const config = parseJson(device?.instance_config)
    const role = String(config.role || '').toLowerCase()
    return device?.model_type === 'transfer_cart'
        || role === 'transfer_cart'
        || role === 'auxiliary'
        || Boolean(config.railId || config.rail_id || config.railLineId || config.rail_line_id)
}

// Fixed equipment supplies the station number and its longitudinal coordinate.
// A mobile carrier must keep its own rail plane, otherwise importing a furnace's
// Z coordinate would send the cart off its track.
function projectStationPosition(device, position, movement = {}, stations = [], railDevice = device) {
    if (!validPosition(position)) throw new Error('工位画布位置无效，请在产线画布修正后重新导入')
    const source = { ...position }
    if (!isRailBoundDevice(railDevice)) return source
    const invalid = railBasisError(movement)
    if (invalid) throw new Error(invalid)
    const railOrigin = movement.start, railEnd = movement.end
    const dx = railEnd.x - railOrigin.x, dz = railEnd.z - railOrigin.z
    const squared = dx * dx + dz * dz
    const fraction = ((source.x - railOrigin.x) * dx + (source.z - railOrigin.z) * dz) / squared
    return { x: railOrigin.x + dx * fraction, y: railOrigin.y, z: railOrigin.z + dz * fraction }
}

const normalizeMotion = device => simpleMotionDraft(device)

const selectedDeviceId = ref('')
const deviceDetail = ref(null)
const dataPoints = ref([])
const motion = ref(defaultMotion())
const loading = ref(false)
const saving = ref(false)
const message = ref('')
const errorMessage = ref('')
const { notice, show: showNotice, clear: clearNotice } = useAdminNotice()
watch(message, value => { if (value) showNotice(value) }, { flush: 'sync' })
watch(errorMessage, value => { if (value) showNotice(value, 'error') }, { flush: 'sync' })
let loadGeneration = 0
const draftFactoryId = getFactoryScope()
let savedMotionSnapshot = ''
let savedMovementBaseline = null
let requiresMovementReload = false
const motionSnapshot = () => JSON.stringify(motion.value)

function isAuxiliaryDevice(device) {
    const config = parseJson(device?.instance_config)
    return device?.model_type === 'transfer_cart'
        || String(config.role || '').toLowerCase() === 'transfer_cart'
        || String(config.role || '').toLowerCase() === 'auxiliary'
        || config.sceneObject === true
}

const mobileDevices = computed(() => props.devices.filter(isAuxiliaryDevice))
const selectedDevice = computed(() => mobileDevices.value.find(device => String(device.id) === String(selectedDeviceId.value)) || null)

function deviceLineInfo(device) {
    const config = parseJson(device?.instance_config)
    const productionLineId = pointIdOr(config.laneLineId ?? config.lane_line_id ?? device?.line_id)
    const deviceLineId = pointIdOr(config.laneId ?? config.lane_id)
    const deviceLineName = String(config.laneName ?? config.lane_name ?? '').trim()
    if (!deviceLineId) {
        return {
            key: `${productionLineId || 'unknown'}::unassigned`,
            name: '未指定设备线',
            deviceLineId: '',
            productionLineId
        }
    }
    return {
        key: `${productionLineId || 'unknown'}::${deviceLineId}`,
        name: deviceLineName || `设备线 ${deviceLineId}`,
        deviceLineId,
        productionLineId
    }
}

const lineStationDevices = computed(() => {
    const deviceConfig = parseJson(deviceDetail.value?.instance_config)
    const lineId = deviceDetail.value?.line_id
        || deviceConfig.railLineId
        || deviceConfig.rail_line_id
        || deviceConfig.laneLineId
        || deviceConfig.lane_line_id
    if (!lineId) return []
    const candidates = props.devices
        .filter(device => {
            if (String(device.id) === String(deviceDetail.value?.id)) return false
            if (String(device.line_id) !== String(lineId)) return false
            const config = parseJson(device.instance_config)
            const role = String(config.role || '').toLowerCase()
            if (device.model_type === 'transfer_cart' || role === 'transfer_cart' || config.railLineId || config.railId) return false
            return true
        })
        .sort((left, right) => Number(left.pos_x || 0) - Number(right.pos_x || 0))
    const used = new Set()
    const nextById = new Map()
    const unnumbered = []
    candidates.forEach(device => {
        const config = parseJson(device.instance_config)
        const value = Number(config.stationNumber ?? config.station_number)
        if (Number.isInteger(value) && value > 0 && !used.has(value)) {
            used.add(value)
            nextById.set(device.id, value)
        } else {
            unnumbered.push(device)
        }
    })
    let next = 1
    unnumbered.forEach(device => {
        while (used.has(next)) next += 1
        nextById.set(device.id, next)
        used.add(next)
        next += 1
    })
    return candidates
        .map(device => {
            const line = deviceLineInfo(device)
            return {
                ...device,
                stationNumber: nextById.get(device.id),
                deviceLineKey: line.key,
                deviceLineName: line.name
            }
        })
        .sort((left, right) => left.stationNumber - right.stationNumber)
})

const deviceLineGroups = computed(() => {
    const groups = new Map()
    lineStationDevices.value.forEach(device => {
        const info = deviceLineInfo(device)
        if (!groups.has(info.key)) {
            groups.set(info.key, {
                key: info.key,
                name: info.name,
                deviceLineId: info.deviceLineId,
                devices: []
            })
        }
        groups.get(info.key).devices.push(device)
    })
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
})

function stationDeviceLineInfo(station) {
    const explicitKey = pointIdOr(station?.deviceLineKey ?? station?.device_line_key)
    if (explicitKey) {
        const knownGroup = deviceLineGroups.value.find(group => group.key === explicitKey)
        return knownGroup || {
            key: explicitKey,
            name: String(station?.deviceLineName ?? station?.device_line_name ?? '未指定设备线') || '未指定设备线',
            deviceLineId: '',
            devices: []
        }
    }
    const anchor = lineStationDevices.value.find(device => String(device.id) === String(station?.anchorDeviceId))
    if (anchor) return {
        key: anchor.deviceLineKey,
        name: anchor.deviceLineName,
        deviceLineId: deviceLineInfo(anchor).deviceLineId,
        devices: []
    }
    if (deviceLineGroups.value.length === 1) return deviceLineGroups.value[0]
    const productionLineId = pointIdOr(deviceDetail.value?.line_id)
    return {
        key: `${productionLineId || 'unknown'}::unassigned`,
        name: '待分配设备线',
        deviceLineId: '',
        devices: []
    }
}

const stationGroups = computed(() => {
    const groups = new Map()
    deviceLineGroups.value.forEach(group => {
        groups.set(group.key, { ...group, stations: [] })
    })
    ;(motion.value.stations || []).forEach(station => {
        const info = stationDeviceLineInfo(station)
        if (!groups.has(info.key)) {
            groups.set(info.key, { ...info, stations: [] })
        }
        groups.get(info.key).stations.push(station)
    })
    return [...groups.values()]
        .map(group => ({
            ...group,
            stations: group.stations.slice().sort((left, right) => numberOr(left.value) - numberOr(right.value))
        }))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
})
const numericPoints = computed(() => dataPoints.value.filter(point => {
    const type = String(point.data_type || '').toUpperCase()
    return String(point.access_type || 'READ').toUpperCase() === 'READ'
        && !['BOOL', 'STRING', 'CHAR', 'DT', 'DTZ', 'DTL', 'DTLZ', 'DATE', 'TIME', 'TOD'].includes(type)
}))
const arrivalPoints = computed(() => dataPoints.value.filter(point => isActualMovingFeedback(point, deviceDetail.value?.id)))

function pointLabel(point) {
    const name = point.label || point.name || `点位 ${point.id}`
    const address = point.plc_tag ? ` · ${point.plc_tag}` : ''
    return `${name}${address}`
}

function pointPayload(point, selectedIds) {
    const persisted = [
        'name', 'label', 'plc_tag', 'data_type', 'category', 'value_role', 'quality',
        'scale', 'offset', 'expression', 'display_format', 'unit', 'sample_interval_ms',
        'access_type', 'db_number', 'db_byte_offset', 'bit_offset', 'point_kind',
        'alarm_record_role', 'alarm_text', 'alarm_level', 'alarm_condition',
        'voice_config', 'alarm_high', 'alarm_low'
    ]
    const payload = { id: point.id }
    persisted.forEach(key => { payload[key] = point[key] ?? '' })
    if (selectedIds.has(String(point.id))) payload.sample_interval_ms = 100
    return payload
}

function motionDraftPayload() {
    const detail = deviceDetail.value
    if (!detail?.id) return null
    const existingConfig = parseJson(detail.instance_config)
    const stations = stationGroups.value
        .flatMap(group => group.stations.map(station => ({
            value: station.value,
            label: String(station.label || `${numberOr(station.value)}号工位`),
            anchorDeviceId: pointIdOr(station.anchorDeviceId),
            deviceLineKey: String(station.deviceLineKey || group.key || ''),
            deviceLineName: String(station.deviceLineName || group.name || ''),
            position: {
                x: station.position?.x, y: station.position?.y, z: station.position?.z
            }
        })))
        .sort((left, right) => left.value - right.value)
    const nextConfig = {
        ...existingConfig,
        movement: simpleMovementPayload({ ...motion.value, stations })
    }
    const selectedIds = new Set([
        motion.value.currentPositionPointId, motion.value.arrivalSignalPointId
    ].filter(Boolean).map(String))
    return {
        deviceId: detail.id,
        expectedMovement: JSON.parse(JSON.stringify(savedMovementBaseline)),
        ...(requiresMovementReload ? { requiresMovementReload: true } : {}),
        motion: JSON.parse(motionSnapshot()),
        selectedPointIds: [...selectedIds],
        devicePayload: {
            name: detail.name || detail.id,
            line_id: detail.line_id || null,
            model_type: detail.model_type || 'builtin_furnace',
            model_file: detail.model_file || null,
            template_id: detail.template_id || '',
            instance_config: nextConfig,
            pos_x: numberOr(detail.pos_x), pos_y: numberOr(detail.pos_y), pos_z: numberOr(detail.pos_z),
            rotation_y: numberOr(detail.rotation_y), scale: numberOr(detail.scale, 1),
            coordinate_space: detail.coordinate_space || 'line_local', sort_order: numberOr(detail.sort_order),
            plc_enabled: detail.plc_enabled ? 1 : 0,
            plc_protocol: detail.plc_protocol || 'S7', plc_ip: detail.plc_ip || '',
            plc_port: numberOr(detail.plc_port, 102), plc_rack: numberOr(detail.plc_rack),
            plc_slot: numberOr(detail.plc_slot, 1), plc_timeout: numberOr(detail.plc_timeout, 5000),
            plc_retry_interval: numberOr(detail.plc_retry_interval, 10000),
            plc_max_retries: numberOr(detail.plc_max_retries), plc_options: parseJson(detail.plc_options)
        },
        pointRows: selectedIds.size && dataPoints.value.length
            ? dataPoints.value.map(point => pointPayload(point, selectedIds)) : []
    }
}

function cacheCurrentMotionDraft() {
    if (!deviceDetail.value?.id || !savedMotionSnapshot) return
    if (motionSnapshot() === savedMotionSnapshot) {
        clearFactoryDraft(draftFactoryId, `mobile-motion:${deviceDetail.value.id}`)
        return
    }
    const payload = motionDraftPayload()
    if (payload) cacheFactoryDraft(draftFactoryId, `mobile-motion:${payload.deviceId}`, 'mobile-motion', payload)
}

defineExpose({
    savePending: async () => {
        if (!deviceDetail.value?.id || !savedMotionSnapshot || motionSnapshot() === savedMotionSnapshot) return true
        await saveMotion()
        if (motionSnapshot() !== savedMotionSnapshot) throw new Error(errorMessage.value || '设备运动配置保存失败')
        return true
    },
    discardPending: () => { if (deviceDetail.value?.id) clearFactoryDraft(draftFactoryId, `mobile-motion:${deviceDetail.value.id}`) }
})

onUnmounted(() => { cacheCurrentMotionDraft(); loadGeneration += 1 })

async function loadDevice(deviceId) {
    const requestGeneration = ++loadGeneration
    if (!deviceId) {
        if (requestGeneration !== loadGeneration) return
        deviceDetail.value = null
        dataPoints.value = []
        motion.value = defaultMotion()
        savedMotionSnapshot = ''
        savedMovementBaseline = null
        requiresMovementReload = false
        return
    }
    loading.value = true
    message.value = ''
    errorMessage.value = ''
    try {
        const detail = await adminApi.getDevice(deviceId)
        if (!detail || detail.error) throw new Error(detail?.error || '读取设备详情失败')
        if (requestGeneration !== loadGeneration) return
        deviceDetail.value = detail
        dataPoints.value = Array.isArray(detail?.dataPoints) ? detail.dataPoints : []
        motion.value = normalizeMotion(detail)
        savedMovementBaseline = JSON.parse(JSON.stringify(parseJson(detail.instance_config).movement ?? null))
        requiresMovementReload = false
        savedMotionSnapshot = motionSnapshot()
        const pending = readFactoryDraft(draftFactoryId, `mobile-motion:${detail.id}`)
        if (pending?.motion) {
            motion.value = simpleMotionDraft(detail, pending.motion)
            if (pending.expectedMovement !== undefined) savedMovementBaseline = pending.expectedMovement
            requiresMovementReload = pending.requiresMovementReload === true || pending.expectedMovement === undefined
        }
    } catch (error) {
        if (requestGeneration !== loadGeneration) return
        deviceDetail.value = null
        dataPoints.value = []
        errorMessage.value = error.message || '读取设备点位失败'
    } finally {
        if (requestGeneration === loadGeneration) loading.value = false
    }
}

watch(mobileDevices, devices => {
    if (!devices.length) {
        selectedDeviceId.value = ''
        return
    }
    if (!devices.some(device => String(device.id) === String(selectedDeviceId.value))) {
        selectedDeviceId.value = String(devices[0].id)
    }
}, { immediate: true })

// The device picker assigns its first option before this watcher is registered.
// Running once immediately guarantees that the initial selection also loads its
// detail and PLC points instead of leaving the page blank until the user changes it.
watch(selectedDeviceId, (value, previous) => {
    if (previous && String(deviceDetail.value?.id) === String(previous)) cacheCurrentMotionDraft()
    loadDevice(value)
}, { immediate: true })

function removeStation(station) {
    if (!Array.isArray(motion.value.stations) || motion.value.stations.length <= 1) return
    const index = motion.value.stations.indexOf(station)
    if (index >= 0) motion.value.stations.splice(index, 1)
}

function applyStationAnchor(station) {
    const device = props.devices.find(item => String(item.id) === String(station.anchorDeviceId))
    if (!device) return
    if ((device.coordinate_space || 'line_local') !== (deviceDetail.value?.coordinate_space || 'line_local')) {
        errorMessage.value = '作业设备与小车的坐标系不同，请先在设备编排中统一坐标'
        return
    }
    try { station.position = projectStationPosition(device, {
        x: numberOr(device.pos_x),
        y: numberOr(device.pos_y),
        z: numberOr(device.pos_z)
    }, motion.value, motion.value.stations, deviceDetail.value) }
    catch (error) { errorMessage.value = error.message; return }
    const info = deviceLineInfo(device)
    station.deviceLineKey = info.key
    station.deviceLineName = info.name
}

function syncStationsFromLine() {
    if (!lineStationDevices.value.length) {
        errorMessage.value = '当前设备所属产线还没有固定设备，请先在产线画布中摆放设备'
        return
    }
    if (railBasisError(motion.value)) {
        try { Object.assign(motion.value, canvasMotionBasis(deviceDetail.value)) }
        catch (error) { errorMessage.value = error.message; return }
    }
    try { motion.value.stations = lineStationDevices.value.map(device => {
        if ((device.coordinate_space || 'line_local') !== (deviceDetail.value?.coordinate_space || 'line_local')) throw new Error('产线内设备与小车的坐标系不同，请先统一坐标')
        const value = device.stationNumber
        const info = deviceLineInfo(device)
        return {
            value,
            label: `${value}号工位 · ${device.name || device.id}`,
            anchorDeviceId: String(device.id),
            deviceLineKey: info.key,
            deviceLineName: info.name,
            position: projectStationPosition(device, {
                x: numberOr(device.pos_x),
                y: numberOr(device.pos_y),
                z: numberOr(device.pos_z)
            }, motion.value, lineStationDevices.value.map(item => ({
                position: {
                    x: numberOr(item.pos_x),
                    y: numberOr(item.pos_y),
                    z: numberOr(item.pos_z)
                }
            })), deviceDetail.value)
        }
    }) } catch (error) { errorMessage.value = error.message; return }
    message.value = `已按 ${deviceLineGroups.value.length} 条设备线导入 ${lineStationDevices.value.length} 个工位位置`
    errorMessage.value = ''
}

async function discardAndReloadMotion() {
    if (saving.value || loading.value || !selectedDeviceId.value) return
    clearFactoryDraft(draftFactoryId, `mobile-motion:${selectedDeviceId.value}`)
    await loadDevice(selectedDeviceId.value)
}

async function saveMotion() {
    if (saving.value || loading.value) return
    message.value = ''; errorMessage.value = ''
    if (!deviceDetail.value?.id) return
    const inputPolicyError = simpleMotionError(motion.value, dataPoints.value, deviceDetail.value.id)
    if (inputPolicyError) { errorMessage.value = inputPolicyError; return }
    if (requiresMovementReload) {
        errorMessage.value = '此旧草稿没有保存时的移动配置快照，请先放弃本页修改并重新读取，未覆盖当前路径'
        return
    }
    if (motion.value.enabled && !motion.value.currentPositionPointId) {
        errorMessage.value = '请选择 PLC 目标工位编号点位'
        return
    }
    if (!Number.isInteger(motion.value.staleMs) || motion.value.staleMs < 1000 || motion.value.staleMs > 60000) {
        errorMessage.value = '数据过期阈值必须为 1000～60000 毫秒的整数'
        return
    }
    const invalidBasis = railBasisError(motion.value)
    if (motion.value.enabled && invalidBasis) { errorMessage.value = '轨道信息不完整，请先在产线画布修正导轨，再从画布重新导入工位'; return }
    if (motion.value.enabled) {
        const stations = Array.isArray(motion.value.stations) ? motion.value.stations : []
        const values = stations.map(station => station.value)
        if (stations.length === 0 || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
            errorMessage.value = '工位编号模式至少需要配置一个有效的工位编号'
            return
        }
        if (stations.some(station => !validPosition(station.position))) {
            errorMessage.value = '工位画布位置无效，请在产线画布修正后重新导入工位'
            return
        }
        if (stations.some(station => station.anchorDeviceId && !lineStationDevices.value.some(device => String(device.id) === String(station.anchorDeviceId)
            && (device.coordinate_space || 'line_local') === (deviceDetail.value?.coordinate_space || 'line_local')))) {
            errorMessage.value = '关联工位的作业设备已不存在、移出产线或坐标系不同，请重新选择'
            return
        }
        if (new Set(values).size !== values.length) {
            errorMessage.value = '工位编号不能重复，请检查工位映射'
            return
        }
    }

    saving.value = true
    message.value = ''
    errorMessage.value = ''
    try {
        const detail = deviceDetail.value
        const draft = motionDraftPayload()
        if (!draft) throw new Error('设备运动配置尚未就绪')
        const selectedPointIds = draft.selectedPointIds
        const result = await adminApi.updateDeviceMovement(detail.id, draft.devicePayload.instance_config.movement, selectedPointIds, draft.expectedMovement)
        if (result?.error) throw new Error(result.error)
        if (!result?.success) throw new Error('后端没有返回成功状态')

        if (draft.pointRows.length) {
            const selectedIds = new Set(selectedPointIds.map(String))
            dataPoints.value = dataPoints.value.map(point => selectedIds.has(String(point.id))
                ? { ...point, sample_interval_ms: 100 }
                : point)
        }

        deviceDetail.value = { ...detail, instance_config: draft.devicePayload.instance_config }
        savedMovementBaseline = JSON.parse(JSON.stringify(draft.devicePayload.instance_config.movement))
        savedMotionSnapshot = motionSnapshot()
        clearFactoryDraft(draftFactoryId, `mobile-motion:${detail.id}`)
        message.value = '移动配置已保存'
        emit('saved', detail.id)
    } catch (error) {
        errorMessage.value = error.message || '移动配置保存失败'
    } finally {
        saving.value = false
    }
}
</script>

<template>
    <div class="tab-content mobile-motion-page">
        <AdminNotice :state="notice" @close="clearNotice" />
        <div class="page-heading-row">
            <div>
                <h2>设备运动配置</h2>
                <p class="desc">将设备模型绑定到 PLC 位置点位，收到实时位置后直接驱动 Unity 中的模型移动。</p>
            </div>
            <span class="motion-latency-badge" title="保存运动绑定后，相关点位的采集周期设为 100ms。这不是实测传输延迟，画面响应还受 PLC 通信、数据传输和 Unity 渲染影响。">运动点位采集周期 · 100ms</span>
        </div>

        <div v-if="!mobileDevices.length" class="empty-state">暂无辅助设备，请先在“设备管理”中添加小车或其他辅助设备。</div>
        <template v-else>
            <section class="motion-card motion-device-picker">
                <label class="motion-device-select">选择设备（小车 / 辅助设备）
                    <select v-model="selectedDeviceId" class="input" :disabled="saving">
                        <option v-for="device in mobileDevices" :key="device.id" :value="String(device.id)">
                            {{ device.name || device.id }}（{{ device.id }}）
                        </option>
                    </select>
                </label>
                <span v-if="loading" class="motion-muted">正在读取点位…</span>
                <span v-else-if="deviceDetail" class="motion-muted">{{ dataPoints.length }} 个点位可供绑定</span>
                <span v-else class="motion-muted">设备配置尚未读取</span>
            </section>


            <section v-if="loading && !deviceDetail" class="motion-card motion-loading-state" aria-live="polite">
                <div class="motion-loading-dot" aria-hidden="true"></div>
                <div>
                    <h3>正在读取设备配置</h3>
                    <p>正在加载 PLC 点位和已保存的运动设置，请稍候。</p>
                </div>

            </section>

            <section v-else-if="deviceDetail" class="motion-card">
                <div class="motion-card-header">
                    <div>
                        <h3>移动控制</h3>
                    </div>
                    <label class="motion-switch">
                        <input v-model="motion.enabled" type="checkbox"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/>
                        启用移动同步
                    </label>
                </div>



                <section class="motion-step-card">
                    <div class="motion-step-title"><span>1</span><div><strong>绑定 PLC 点位</strong></div></div>
                    <div class="motion-form-grid">
                    <label>
                        <span class="motion-field-label">PLC 目标工位编号 <span class="motion-required">*</span></span>
                        <select v-model="motion.currentPositionPointId" class="input" aria-label="移动位置数值点位" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                            <option value="">请选择 PLC 数值点位</option>
                            <option v-if="motion.currentPositionPointId && !numericPoints.some(point => String(point.id) === motion.currentPositionPointId)" :value="motion.currentPositionPointId">已保存点位 {{ motion.currentPositionPointId }}（位置反馈类型或归属无效，请重新选择）</option>
                            <option v-for="point in numericPoints" :key="point.id" :value="String(point.id)">
                                {{ pointLabel(point) }}
                            </option>
                        </select>
                    </label>
                    <label>
                        <span class="motion-field-label">PLC 到位信号（BOOL） <span class="motion-required">*</span></span>
                        <select v-model="motion.arrivalSignalPointId" class="input" aria-label="PLC 到位 BOOL 信号" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                            <option value="">请选择到位信号</option>
                            <option v-if="motion.arrivalSignalPointId && !arrivalPoints.some(point => String(point.id) === motion.arrivalSignalPointId)" :value="motion.arrivalSignalPointId">已保存点位 {{ motion.arrivalSignalPointId }}（非本设备只读 BOOL，请重新选择）</option>
                            <option v-for="point in arrivalPoints" :key="point.id" :value="String(point.id)">{{ pointLabel(point) }}</option>
                        </select>
                    </label>



                    </div>
                </section>



                <section v-if="motion.valueMode === 'station'" class="motion-step-card motion-position-section">
                    <div class="motion-section-heading">
                        <div class="motion-step-title"><span>2</span><div><strong>导入工位</strong></div></div>
                        <div class="motion-section-actions">
                            <button type="button" class="btn btn-secondary motion-add-station" :disabled="!lineStationDevices.length" @click="syncStationsFromLine">从当前产线导入 {{ lineStationDevices.length }} 个</button>
                        </div>
                    </div>
                    <div class="motion-distance-summary">
                        <strong>{{ stationGroups.length }} 条设备线 · {{ motion.stations.length }} 个工位</strong>
                    </div>
                    <div class="motion-device-line-groups">
                        <section v-for="group in stationGroups" :key="group.key" class="motion-device-line-group">
                            <div class="motion-device-line-heading">
                                <div>
                                    <strong>{{ group.name }}</strong>
                                    <small>{{ group.devices.length ? `${group.devices.length} 个固定设备` : '还没有导入工位' }}</small>
                                </div>
                            </div>
                            <div v-if="group.stations.length" class="motion-station-list">
                                <div v-for="(station, index) in group.stations" :key="station.anchorDeviceId || `${group.key}-${station.value}-${index}`" class="motion-station-row">
                                    <div class="motion-station-order">{{ index + 1 }}</div>
                                    <label>PLC 工位编号<input v-model.number="station.value" type="number" step="1" class="input"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                    <label>关联作业设备<select v-model="station.anchorDeviceId" class="input" :aria-label="`工位 ${station.value} 关联作业设备`" @change="applyStationAnchor(station)" v-permission="{ page: 'mobile-devices', action: 'edit' }"><option value="">未关联设备（保留已有位置）</option><option v-for="device in lineStationDevices" :key="device.id" :value="String(device.id)">{{ device.name || device.id }}</option></select></label>


                                    <button v-if="motion.stations.length > 1" type="button" class="motion-remove-station" title="删除工位" @click="removeStation(station)" v-permission="{ page: 'mobile-devices', action: 'edit' }">删除</button>

                                </div>
                            </div>
                            <div v-else class="motion-device-line-empty">从当前产线导入工位即可，无需手动添加坐标。</div>
                        </section>
                        <div v-if="!stationGroups.length" class="motion-device-line-empty">当前小车没有可用的设备线，请先在产线画布中摆放固定设备并绑定设备线。</div>
                    </div>
                    <p v-if="!lineStationDevices.length" class="motion-inline-warning">当前小车所属产线没有找到带设备线的固定设备。请先在产线画布中摆放设备、绑定设备线并设置工位编号，之后点击“从当前产线导入”。</p>
                </section>

                <section class="motion-step-card">
                    <div class="motion-step-title"><span>3</span><div><strong>显示效果</strong></div></div>
                    <label class="motion-switch"><input v-model="motion.arrivalSmoothing" type="checkbox" aria-label="到位时平滑对齐" v-permission="{ page: 'mobile-devices', action: 'edit' }" />到位时平滑对齐</label>
                </section>





                <div class="modal-actions motion-actions">
                    <button type="button" class="btn btn-secondary" :disabled="saving || loading" aria-label="放弃移动修改并重新读取配置" @click="discardAndReloadMotion">放弃修改并重新读取</button>
                    <button type="button" class="btn btn-primary" :disabled="saving || loading" @click="saveMotion" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                        {{ saving ? '保存中…' : '保存移动配置' }}
                    </button>
                </div>
            </section>

            <section v-else-if="selectedDeviceId" class="motion-card motion-load-failed">
                <div>
                    <h3>设备配置未加载</h3>
                    <p>暂时无法读取该设备的 PLC 点位与运动配置。请重新读取；若仍失败，请检查后台服务连接。</p>
                </div>
                <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadDevice(selectedDeviceId)">
                    重新读取配置
                </button>
            </section>
        </template>
    </div>
</template>

<style scoped>
.mobile-motion-page {
    max-width: 1120px;
    color: #1d2939;
    font-family: inherit;
}
.page-heading-row, .motion-card-header, .motion-device-picker, .motion-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
}
.page-heading-row { margin-bottom: 20px; }
.page-heading-row h2 { margin-bottom: 8px; }
.motion-latency-badge {
    flex: 0 0 auto;
    border: 1px solid #b8e8d2;
    border-radius: 999px;
    padding: 7px 12px;
    color: #16794c;
    background: #f0fbf5;
    font-size: calc(12px * var(--admin-font-scale, 1));
    font-weight: 700;
}
.motion-card {
    margin-bottom: 18px;
    padding: 20px;
    border: 1px solid #e3e8ef;
    border-radius: 14px;
    background: #fff;
    box-shadow: 0 8px 24px rgba(33, 49, 71, .05);
}
.motion-device-picker { background: #f8fafc; }
.motion-device-select { flex: 1; max-width: 520px; gap: 8px; color: #344054; font-size: calc(13px * var(--admin-font-scale, 1)); font-weight: 700; }
.motion-muted, .motion-card-header p, .motion-card small { color: #778397; font-size: calc(12px * var(--admin-font-scale, 1)); }
.motion-loading-state, .motion-load-failed { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 108px; }
.motion-loading-state { border-color: #dceafa; background: linear-gradient(135deg, #f7fbff, #fff); }
.motion-loading-state h3, .motion-load-failed h3 { margin: 0 0 6px; color: #1d2939; font-size: calc(15px * var(--admin-font-scale, 1)); }
.motion-loading-state p, .motion-load-failed p { margin: 0; color: #778397; font-size: calc(13px * var(--admin-font-scale, 1)); line-height: 1.6; }
.motion-loading-dot { width: 18px; height: 18px; flex: 0 0 18px; border: 3px solid #cfe3fc; border-top-color: #2f80ed; border-radius: 50%; animation: motion-loading-spin .8s linear infinite; }
.motion-load-failed { border-color: #f2d5b5; background: #fffdf9; }
@keyframes motion-loading-spin { to { transform: rotate(360deg); } }
.motion-card-header { align-items: flex-start; margin-bottom: 20px; }
.motion-card-header h3 { margin: 0 0 6px; }
.motion-card-header p { margin: 0; }
.motion-step-card { padding: 16px; border: 1px solid #e5ebf2; border-radius: 12px; background: #fbfcfe; }
.motion-step-title { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; }
.motion-step-title > span { display: grid; place-items: center; flex: 0 0 26px; width: 26px; height: 26px; border-radius: 50%; color: #fff; background: linear-gradient(135deg, #4f8df7, #2563eb); font-size: calc(12px * var(--admin-font-scale, 1)); font-weight: 800; }
.motion-step-title > div { display: grid; gap: 4px; }
.motion-step-title strong { color: #1d2939; font-size: calc(14px * var(--admin-font-scale, 1)); }
.motion-step-title small { color: #778397; font-size: calc(12px * var(--admin-font-scale, 1)); font-weight: 400; line-height: 1.5; }
.motion-switch, .inline-check { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; font-weight: 700; }
.motion-switch input { width: 16px; height: 16px; accent-color: #1677ff; }
.mobile-motion-page .input {
    width: 100%;
    min-width: 0;
    height: 40px;
    box-sizing: border-box;
    padding: 0 12px;
    border: 1px solid #cfd7e3;
    border-radius: 8px;
    outline: none;
    background: #fff;
    color: #1d2939;
    font: inherit;
    font-size: calc(13px * var(--admin-font-scale, 1));
    line-height: 40px;
    transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
}
.mobile-motion-page select.input { padding-right: 34px; cursor: pointer; }
.mobile-motion-page .input:hover { border-color: #98a2b3; }
.mobile-motion-page .input:focus {
    border-color: #1677ff;
    box-shadow: 0 0 0 3px rgba(22, 119, 255, .12);
}
.mobile-motion-page .input:disabled { background: #f2f4f7; color: #98a2b3; cursor: not-allowed; }
.motion-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.motion-form-grid label, .motion-range-row label, .motion-coordinate-grid label { display: flex; flex-direction: column; gap: 7px; color: #344054; font-size: calc(13px * var(--admin-font-scale, 1)); font-weight: 600; }
.motion-field-label { display: inline-flex; align-items: center; min-height: 18px; gap: 4px; line-height: 1.4; }
.motion-form-grid small { font-weight: 400; line-height: 1.5; }
.motion-required { color: #d92d20; }
.motion-range-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; }
.motion-advanced-settings { margin-top: 14px; padding: 12px 14px; border: 1px dashed #cfd9e6; border-radius: 10px; background: #fff; }
.motion-advanced-settings summary { color: #52657d; cursor: pointer; font-size: calc(12px * var(--admin-font-scale, 1)); font-weight: 700; }
.motion-advanced-settings[open] summary { margin-bottom: 14px; color: #24577a; }
.motion-advanced-note { margin: 12px 0 0; color: #8a97a8; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.5; }
.motion-simulation-panel { margin-top: 18px; border-color: #d9e7f0; background: linear-gradient(135deg, #f3f9fd, #f8fbfd); }
.motion-simulation-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.motion-simulation-heading > div { display: grid; gap: 4px; }
.motion-simulation-heading strong { color: #1f4f68; font-size: calc(13px * var(--admin-font-scale, 1)); }
.motion-simulation-heading small, .motion-simulation-note { color: #6a8190; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.5; }
.motion-kinematics-row { margin-top: 12px; }
.motion-simulation-note { display: block; margin-top: 10px; }
.motion-simulation-switch { margin: -2px 0 12px 36px; color: #1f4f68; }
.motion-simulation-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-left: 36px; }
.motion-simulation-fields label { display: flex; flex-direction: column; gap: 7px; color: #344054; font-size: calc(13px * var(--admin-font-scale, 1)); font-weight: 600; }
.motion-simulation-fields small { color: #778397; font-size: calc(12px * var(--admin-font-scale, 1)); font-weight: 400; line-height: 1.5; }
.motion-position-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid #edf0f4; }
.motion-section-title { margin-bottom: 14px; color: #1d2939; font-weight: 700; }
.motion-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.motion-section-heading .motion-section-title { margin-bottom: 5px; }
.motion-section-heading small { color: #778397; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.5; }
.motion-section-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.motion-add-station { flex: 0 0 auto; min-height: 34px; padding: 0 12px; }
.motion-distance-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 4px 0 12px; padding: 9px 11px; color: #42617b; background: #eef7fd; border-radius: 8px; font-size: calc(12px * var(--admin-font-scale, 1)); }
.motion-distance-summary strong { color: #1f4f68; }
.motion-distance-summary.warning { color: #8a5a16; background: #fff8e7; }
.motion-distance-summary.warning strong { color: #8a5a16; }
.motion-device-line-groups { display: grid; gap: 12px; }
.motion-device-line-group { overflow: hidden; border: 1px solid #dce6ef; border-radius: 11px; background: #fff; }
.motion-device-line-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; background: linear-gradient(135deg, #f4f9fd, #fbfdff); border-bottom: 1px solid #e8eef4; }
.motion-device-line-heading > div { display: grid; gap: 4px; min-width: 0; }
.motion-device-line-heading strong { color: #1f4f68; font-size: calc(13px * var(--admin-font-scale, 1)); }
.motion-device-line-heading small { color: #778397; font-size: calc(11px * var(--admin-font-scale, 1)); line-height: 1.45; }
.motion-device-line-heading .motion-add-station { min-height: 30px; padding: 0 10px; font-size: calc(11px * var(--admin-font-scale, 1)); }
.motion-device-line-group .motion-station-list { padding: 10px; }
.motion-device-line-empty { padding: 14px; color: #8a97a8; background: #fbfcfe; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.5; text-align: center; }
.motion-station-list { display: grid; gap: 10px; }
.motion-station-row { display: grid; grid-template-columns: 32px minmax(100px, .4fr) minmax(180px, 1fr) 48px; gap: 10px; align-items: end; padding: 12px; border: 1px solid #e8ecf1; border-radius: 10px; background: #fff; }
.motion-station-coordinate-fields { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;grid-column:2/-1; }
.motion-station-order { display: grid; place-items: center; width: 28px; height: 28px; margin-bottom: 4px; border-radius: 8px; color: #24577a; background: #e8f2f9; font-size: calc(12px * var(--admin-font-scale, 1)); font-weight: 800; }
.motion-station-row label { display: flex; flex-direction: column; gap: 7px; color: #344054; font-size: calc(12px * var(--admin-font-scale, 1)); font-weight: 600; }
.motion-station-row .input { height: 36px; line-height: 36px; }
.motion-start-station { display: flex; flex-direction: column; justify-content: center; min-height: 36px; gap: 3px; color: #52657d; font-size: calc(12px * var(--admin-font-scale, 1)); }
.motion-start-station small { color: #98a2b3; font-size: calc(11px * var(--admin-font-scale, 1)); }
.motion-inline-warning { margin: 12px 0 0; color: #8a5a16; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.5; }
.motion-remove-station { height: 36px; padding: 0; border: 0; color: #b42318; background: transparent; cursor: pointer; font: inherit; font-size: calc(12px * var(--admin-font-scale, 1)); }
.motion-remove-station:hover { color: #d92d20; text-decoration: underline; }
.motion-position-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.motion-position-columns > div { padding: 14px; border: 1px solid #e8ecf1; border-radius: 10px; background: #fbfcfd; }
.motion-coordinate-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.motion-performance-note { display: flex; gap: 10px; margin-top: 22px; padding: 12px 14px; border-radius: 10px; background: #f1f8ff; color: #285377; font-size: calc(12px * var(--admin-font-scale, 1)); line-height: 1.6; }
.motion-actions { justify-content: flex-start; margin-top: 18px; }
.motion-actions .btn {
    min-width: 132px;
    height: 40px;
    padding: 0 18px;
    border: 1px solid #cfd7e3;
    border-radius: 8px;
    background: #fff;
    color: #344054;
    cursor: pointer;
    font: inherit;
    font-size: calc(13px * var(--admin-font-scale, 1));
    font-weight: 700;
    transition: background .16s ease, border-color .16s ease, box-shadow .16s ease, transform .16s ease;
}
.motion-actions .btn-primary {
    border-color: #1d4ed8;
    background: #1d4ed8;
    color: #fff;
}
.motion-actions .btn:hover { border-color: #98a2b3; background: #f8fafc; }
.motion-actions .btn-primary:hover { border-color: #1e40af; background: #1e40af; box-shadow: 0 4px 12px rgba(29, 78, 216, .2); }
.motion-actions .btn:active { transform: translateY(1px); }
.motion-actions .btn:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; transform: none; }
.empty-state { padding: 36px; border: 1px dashed #cfd7e3; border-radius: 12px; color: #667085; text-align: center; }
@media (max-width: 760px) {
    .page-heading-row, .motion-card-header, .motion-device-picker { align-items: flex-start; flex-direction: column; }
    .motion-loading-state, .motion-load-failed { align-items: flex-start; flex-direction: column; }
    .motion-form-grid, .motion-range-row, .motion-position-columns { grid-template-columns: 1fr; }
    .motion-section-heading { flex-direction: column; }
    .motion-simulation-fields { grid-template-columns: 1fr; margin-left: 0; }
    .motion-simulation-switch { margin-left: 0; }
    .motion-device-line-heading { align-items: flex-start; flex-direction: column; }
    .motion-station-row { grid-template-columns: 28px repeat(2, minmax(0, 1fr)); }
    .motion-remove-station { justify-self: start; padding: 0 8px; }
}
</style>
