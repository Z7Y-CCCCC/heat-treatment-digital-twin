<script setup>
import { permissionDirective as vPermission } from '../../../runtime/pagePermissionUi.js'
import { computed, onUnmounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import { cacheFactoryDraft, clearFactoryDraft, readFactoryDraft } from '../../../runtime/factoryDraftCache.js'
import AdminNotice from './AdminNotice.vue'
import { useAdminNotice } from '../composables/useAdminNotice.js'
import { lineSceneUnitsPerMeter, movementSceneUnitsPerMeter } from '../../../../../shared/lineRailSpacing.mjs'
import {displayCoordinateNumber,displaySceneUnits} from '../../../../../shared/sceneNumberPolicy.mjs'
import { isLastConfirmedMotion, isActualMovingFeedback, lastConfirmedMotionError } from '../utils/mobileMotionPolicy.js'

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

function positionOr(value, fallback) {
    const source = value && typeof value === 'object' ? value : {}
    return {
        x: numberOr(source.x, fallback.x),
        y: numberOr(source.y, fallback.y),
        z: numberOr(source.z, fallback.z)
    }
}

function validPosition(value) {
    return value && typeof value === 'object' && ['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]) && Math.abs(value[axis]) <= 100000)
}

function authoredPosition(value) {
    return Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, typeof value?.[axis] === 'number' && Number.isFinite(value[axis]) ? value[axis] : '']))
}

function railBasisError(movement) {
    if (!validPosition(movement.start) || !validPosition(movement.end)) return '请完整填写轨道基准和参考终点的 X / Y / Z 坐标'
    if (Math.hypot(movement.end.x - movement.start.x, movement.end.z - movement.start.z) < .0001) return '轨道基准与参考终点的水平坐标不能重合，未推测导轨方向'
    return ''
}

function normalizeStations(value, fallback) {
    if (!Array.isArray(value)) return fallback.map(station => ({ ...station, position: { ...station.position } }))
    const stations = value
        .map((station, index) => {
            const source = station && typeof station === 'object' ? station : {}
            const valueNumber = typeof source.value === 'number' && Number.isFinite(source.value) ? source.value : ''
            return {
                value: valueNumber,
                label: String(source.label || (valueNumber === '' ? '待配置工位' : `${valueNumber}号工位`)),
                anchorDeviceId: pointIdOr(source.anchorDeviceId ?? source.anchor_device_id),
                deviceLineKey: pointIdOr(source.deviceLineKey ?? source.device_line_key),
                deviceLineName: String(source.deviceLineName ?? source.device_line_name ?? ''),
                distanceMeters: index === 0
                    ? 0
                    : (Number.isFinite(Number(source.distanceMeters ?? source.distance_meters))
                        ? Math.max(0, Number(source.distanceMeters ?? source.distance_meters))
                        : ''),
                position: authoredPosition(source.position || source)
            }
        })
        .sort((left, right) => left.value - right.value)
    return stations
}

function defaultMotion(device = {}) {
    let units
    try { units = lineSceneUnitsPerMeter(parseJson(device.lineLayout)) } catch { units = '' }
    const start = {
        x: numberOr(device.pos_x),
        y: numberOr(device.pos_y),
        z: numberOr(device.pos_z)
    }
    return {
        enabled: false,
        currentPositionPointId: '',
        startActionPointId: '',
        arrivalPositionPointId: '',
        valueMode: 'station',
        stationInputMeaning: '',
        valueMin: 0,
        valueMax: 100,
        smoothingMs: 0,
        staleMs: 5000,
        diagnosticLogging: false,
        diagnosticIntervalSeconds: 5,
        simulationEnabled: false,
        speedMode: 'auto',
        maxSpeed: 2,
        acceleration: 1,
        sceneUnitsPerMeter: units,
        start,
        end: { ...start, x: start.x + 10 },
        stations: []
    }
}

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
    if (!validPosition(position)) throw new Error('工位坐标不完整，未用默认坐标替代')
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

function normalizeMotion(device) {
    const fallback = defaultMotion(device)
    const config = parseJson(device?.instance_config)
    const source = config.movement && typeof config.movement === 'object' ? config.movement : {}
    return {
        ...fallback,
        ...source,
        enabled: source.enabled === true,
        currentPositionPointId: pointIdOr(source.currentPositionPointId ?? source.current_position_point_id),
        startActionPointId: pointIdOr(source.startActionPointId ?? source.start_action_point_id),
        arrivalPositionPointId: pointIdOr(source.arrivalPositionPointId),
        valueMode: ['normalized', 'range', 'station'].includes(source.valueMode) ? source.valueMode : fallback.valueMode,
        stationInputMeaning: ['current', 'target', 'last-confirmed'].includes(source.stationInputMeaning) ? source.stationInputMeaning : '',
        valueMin: numberOr(source.valueMin ?? source.value_min, fallback.valueMin),
        valueMax: numberOr(source.valueMax ?? source.value_max, fallback.valueMax),
        smoothingMs: Math.max(0, Math.min(1000, numberOr(source.smoothingMs ?? source.smoothing_ms, 0))),
        staleMs: Math.round(Math.max(1000, Math.min(60000, numberOr(source.staleMs ?? config.animationBindings?.staleMs, 5000)))),
        diagnosticLogging: (source.diagnosticLogging ?? config.animationBindings?.diagnosticLogging) === true,
        diagnosticIntervalSeconds: Math.max(1, Math.min(60, numberOr(source.diagnosticIntervalSeconds ?? config.animationBindings?.diagnosticIntervalSeconds, 5))),
        simulationEnabled: source.simulationEnabled === true || source.simulation_enabled === true,
        speedMode: String(source.speedMode ?? source.speed_mode ?? fallback.speedMode).toLowerCase() === 'fixed' ? 'fixed' : 'auto',
        maxSpeed: Math.max(0.01, numberOr(source.maxSpeed ?? source.max_speed, fallback.maxSpeed)),
        acceleration: Math.max(0.01, numberOr(source.acceleration, fallback.acceleration)),
        sceneUnitsPerMeter: (() => {
            if (!Object.hasOwn(source, 'sceneUnitsPerMeter') && !Object.hasOwn(source, 'scene_units_per_meter')) return fallback.sceneUnitsPerMeter
            try { return movementSceneUnitsPerMeter(source) } catch { return '' }
        })(),
        start: source.enabled === true || source.start !== undefined ? authoredPosition(source.start) : fallback.start,
        end: source.enabled === true || source.end !== undefined ? authoredPosition(source.end) : fallback.end,
        stations: Array.isArray(source.stations)
            ? normalizeStations(source.stations, fallback.stations).map(station => {
                try { return { ...station, position: projectStationPosition(device, station.position, source, source.stations) } }
                catch { return station } // Leave invalid authored fields editable; save rejects them.
            })
            : []
    }
}

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
const lastConfirmedMotion = computed(() => isLastConfirmedMotion(motion.value))
const directStationFeedback = computed(() => ['current', 'last-confirmed'].includes(motion.value.stationInputMeaning))
const actionPoints = computed(() => dataPoints.value.filter(point => (
    String(point.access_type || 'READ').toUpperCase() === 'READ'
    && (!(lastConfirmedMotion.value || motion.value.arrivalPositionPointId) || isActualMovingFeedback(point, deviceDetail.value?.id))
)))

function changeStationInputMeaning() {
    if (motion.value.stationInputMeaning !== 'target') motion.value.arrivalPositionPointId = ''
    if (!lastConfirmedMotion.value) return
    // This is an explicit user selection, not a silent rewrite on reopening.
    // Keep the old signal selection visible so a command cannot masquerade as
    // movement feedback; the user must remove it or choose a valid BOOL.
    motion.value.simulationEnabled = false
    motion.value.smoothingMs = 0
    if (Object.hasOwn(motion.value, 'simulation_enabled')) motion.value.simulation_enabled = false
    if (Object.hasOwn(motion.value, 'smoothing_ms')) motion.value.smoothing_ms = 0
}

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
        .flatMap(group => group.stations.map((station, index) => ({
            value: station.value,
            label: String(station.label || `${numberOr(station.value)}号工位`),
            anchorDeviceId: pointIdOr(station.anchorDeviceId),
            deviceLineKey: String(station.deviceLineKey || group.key || ''),
            deviceLineName: String(station.deviceLineName || group.name || ''),
            distanceMeters: index === 0 ? 0 : Math.max(0, numberOr(station.distanceMeters)),
            position: {
                x: station.position?.x, y: station.position?.y, z: station.position?.z
            }
        })))
        .sort((left, right) => left.value - right.value)
    const nextConfig = {
        ...existingConfig,
        movement: {
            enabled: motion.value.enabled === true,
            currentPositionPointId: pointIdOr(motion.value.currentPositionPointId),
            startActionPointId: pointIdOr(motion.value.startActionPointId),
            ...(motion.value.arrivalPositionPointId ? { arrivalPositionPointId: pointIdOr(motion.value.arrivalPositionPointId) } : {}),
            valueMode: ['range', 'station'].includes(motion.value.valueMode) ? motion.value.valueMode : 'normalized',
            ...(['current', 'target', 'last-confirmed'].includes(motion.value.stationInputMeaning) ? { stationInputMeaning: motion.value.stationInputMeaning } : {}),
            valueMin: numberOr(motion.value.valueMin), valueMax: numberOr(motion.value.valueMax, 100),
            smoothingMs: Math.max(0, Math.min(1000, numberOr(motion.value.smoothingMs))),
            staleMs: motion.value.staleMs,
            diagnosticLogging: motion.value.diagnosticLogging === true,
            diagnosticIntervalSeconds: motion.value.diagnosticIntervalSeconds,
            simulationEnabled: motion.value.simulationEnabled === true,
            speedMode: motion.value.speedMode === 'fixed' ? 'fixed' : 'auto',
            maxSpeed: Math.max(0.01, numberOr(motion.value.maxSpeed, 2)),
            acceleration: Math.max(0.01, numberOr(motion.value.acceleration, 1)),
            sceneUnitsPerMeter: stationDistanceSummary.value.sceneUnitsPerMeter,
            stations,
            start: { ...motion.value.start },
            end: { ...motion.value.end, ...(motion.value.valueMode === 'station' ? { y: motion.value.start.y } : {}) }
        }
    }
    const selectedIds = new Set([
        motion.value.currentPositionPointId, motion.value.startActionPointId, motion.value.arrivalPositionPointId
    ].filter(Boolean).map(String))
    return {
        deviceId: detail.id,
        expectedMovement: JSON.parse(JSON.stringify(savedMovementBaseline)),
        ...(requiresMovementReload ? { requiresMovementReload: true } : {}),
        motion: JSON.parse(motionSnapshot()),
        selectedPointIds: [...selectedIds],
        missingStationDistances: stationDistanceSummary.value.missingCount,
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
            motion.value = pending.motion
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

function addStation(deviceLineKey = '') {
    const stations = Array.isArray(motion.value.stations) ? motion.value.stations : []
    const group = stationGroups.value.find(item => item.key === deviceLineKey)
    const groupStations = group?.stations || []
    const last = groupStations[groupStations.length - 1] || stations[stations.length - 1]
    const nextValue = stations.reduce((max, station) => Math.max(max, numberOr(station.value, 0)), 0) + 1
    const base = last?.position || motion.value.end || motion.value.start
    const fallbackGroup = stationDeviceLineInfo({ deviceLineKey })
    const targetGroup = group || (deviceLineKey ? fallbackGroup : {
        ...fallbackGroup,
        name: '待分配设备线'
    })
    stations.push({
        value: nextValue,
        label: `${nextValue}号工位`,
        anchorDeviceId: '',
        deviceLineKey: targetGroup.key,
        deviceLineName: targetGroup.name,
        distanceMeters: '',
        position: {
            x: numberOr(base?.x) + (last ? 10 : 0),
            y: numberOr(base?.y),
            z: numberOr(base?.z)
        }
    })
    motion.value.stations = stations
}

function removeStation(station) {
    if (!Array.isArray(motion.value.stations) || motion.value.stations.length <= 1) return
    const index = motion.value.stations.indexOf(station)
    if (index >= 0) motion.value.stations.splice(index, 1)
}

function applyStationAnchor(station) {
    const device = props.devices.find(item => String(item.id) === String(station.anchorDeviceId))
    if (!device) return
    if ((device.coordinate_space || 'line_local') !== (deviceDetail.value?.coordinate_space || 'line_local')) {
        errorMessage.value = '作业设备与小车的坐标系不同，请先在设备编排中统一坐标或手动配置工位'
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

function projectManualStation(station) {
    try { station.position = projectStationPosition(deviceDetail.value || {}, station.position, motion.value, motion.value.stations, deviceDetail.value) }
    catch (error) { errorMessage.value = error.message }
}

function updateRailBasis() {
    try {
        const positions = (motion.value.stations || []).map(station => projectStationPosition(deviceDetail.value || {}, station.position, motion.value, motion.value.stations, deviceDetail.value))
        positions.forEach((position, index) => { motion.value.stations[index].position = position })
        if (motion.value.valueMode === 'station') motion.value.end.y = motion.value.start.y
    } catch (error) { errorMessage.value = error.message }
}

function syncStationsFromLine() {
    if (!lineStationDevices.value.length) {
        errorMessage.value = '当前设备所属产线还没有固定设备，请先在产线画布中摆放设备'
        return
    }
    const previousDistances = new Map((motion.value.stations || []).map(station => {
        const info = stationDeviceLineInfo(station)
        return [`${info.key}::${Number(station.value)}`, station.distanceMeters]
    }))
    const groupIndexes = new Map()
    try { motion.value.stations = lineStationDevices.value.map(device => {
        if ((device.coordinate_space || 'line_local') !== (deviceDetail.value?.coordinate_space || 'line_local')) throw new Error('产线内设备与小车的坐标系不同，请先统一坐标或手动配置工位')
        const value = device.stationNumber
        const info = deviceLineInfo(device)
        const groupIndex = groupIndexes.get(info.key) || 0
        groupIndexes.set(info.key, groupIndex + 1)
        return {
            value,
            label: `${value}号工位 · ${device.name || device.id}`,
            anchorDeviceId: String(device.id),
            deviceLineKey: info.key,
            deviceLineName: info.name,
            distanceMeters: groupIndex === 0 ? 0 : (previousDistances.get(`${info.key}::${value}`) ?? ''),
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

function sceneDistance(left, right) {
    const dx = numberOr(right?.x) - numberOr(left?.x)
    const dy = numberOr(right?.y) - numberOr(left?.y)
    const dz = numberOr(right?.z) - numberOr(left?.z)
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz))
}

async function discardAndReloadMotion() {
    if (saving.value || loading.value || !selectedDeviceId.value) return
    clearFactoryDraft(draftFactoryId, `mobile-motion:${selectedDeviceId.value}`)
    await loadDevice(selectedDeviceId.value)
}

const stationDistanceSummary = computed(() => {
    let totalMeters = 0
    let totalSceneUnits = 0
    let missingCount = 0
    stationGroups.value.forEach(group => {
        group.stations.forEach((station, index) => {
            if (index === 0) return
            const distance = Number(station.distanceMeters)
            if (!Number.isFinite(distance) || distance <= 0) {
                missingCount += 1
            } else {
                totalMeters += distance
            }
            totalSceneUnits += sceneDistance(group.stations[index - 1]?.position, station.position)
        })
    })
    return {
        groupCount: stationGroups.value.length,
        stationCount: (motion.value.stations || []).length,
        totalMeters,
        totalSceneUnits,
        missingCount,
        sceneUnitsPerMeter: missingCount === 0 && totalMeters > 0 && totalSceneUnits > 0 ? totalSceneUnits / totalMeters : numberOr(motion.value.sceneUnitsPerMeter, 1)
    }
})

async function saveMotion() {
    if (saving.value || loading.value) return
    message.value = ''; errorMessage.value = ''
    if (!deviceDetail.value?.id) return
    const inputPolicyError = lastConfirmedMotionError(motion.value, dataPoints.value, deviceDetail.value.id)
    if (inputPolicyError) { errorMessage.value = inputPolicyError; return }
    if (requiresMovementReload) {
        errorMessage.value = '此旧草稿没有保存时的移动配置快照，请先放弃本页修改并重新读取，未覆盖当前路径'
        return
    }
    if (motion.value.enabled && !motion.value.currentPositionPointId) {
        errorMessage.value = '启用移动同步时，请先绑定“当前位置”数值点位'
        return
    }
    if (motion.value.arrivalPositionPointId && (motion.value.stationInputMeaning !== 'target' || motion.value.valueMode !== 'station'
        || motion.value.arrivalPositionPointId === motion.value.currentPositionPointId
        || !actionPoints.value.some(point => String(point.id) === motion.value.startActionPointId && isActualMovingFeedback(point, deviceDetail.value?.id)))) {
        errorMessage.value = '独立到位反馈需要目标工位模式、不同的到位数值点位，以及本设备的实际移动 BOOL 反馈'
        return
    }
    if (motion.value.valueMode === 'range' && motion.value.valueMax <= motion.value.valueMin) {
        errorMessage.value = '输入范围的最大值必须大于最小值'
        return
    }
    if (!Number.isInteger(motion.value.staleMs) || motion.value.staleMs < 1000 || motion.value.staleMs > 60000) {
        errorMessage.value = '数据过期阈值必须为 1000～60000 毫秒的整数'
        return
    }
    if (!Number.isFinite(motion.value.diagnosticIntervalSeconds) || motion.value.diagnosticIntervalSeconds < 1 || motion.value.diagnosticIntervalSeconds > 60) {
        errorMessage.value = '运行诊断记录间隔必须为 1～60 秒'
        return
    }
    const invalidBasis = railBasisError(motion.value)
    if (invalidBasis) { errorMessage.value = invalidBasis; return }
    if (!Number.isFinite(motion.value.sceneUnitsPerMeter) || motion.value.sceneUnitsPerMeter <= 0 || motion.value.sceneUnitsPerMeter > 100000) {
        errorMessage.value = '场景单位 / 米必须大于 0、不超过 100000'
        return
    }
    if (motion.value.valueMode === 'station') {
        const simulate = motion.value.simulationEnabled && !directStationFeedback.value
        if (motion.value.enabled && motion.value.stationInputMeaning === 'target' && !motion.value.simulationEnabled) {
            errorMessage.value = '目标工位命令不是当前到位反馈；请开启运动细节模拟以估算过程，或选择实际当前位置反馈'
            return
        }
        const stations = Array.isArray(motion.value.stations) ? motion.value.stations : []
        const values = stations.map(station => station.value)
        if (stations.length === 0 || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
            errorMessage.value = '工位编号模式至少需要配置一个有效的工位编号'
            return
        }
        if (stations.some(station => !validPosition(station.position))) {
            errorMessage.value = '请完整填写所有工位的 X / Y / Z 坐标，未使用默认坐标替代'
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
        if (simulate && motion.value.maxSpeed <= 0) {
            if (motion.value.speedMode === 'fixed') {
                errorMessage.value = '选择固定速度时，最大速度必须大于 0'
                return
            }
        }
        if (simulate && stationDistanceSummary.value.missingCount > 0) {
            errorMessage.value = '请填写同一设备线内相邻工位之间的现场间距；每条设备线的第一站不需要填写'
            return
        }
        if (simulate && motion.value.acceleration <= 0) {
            errorMessage.value = '启用运动细节模拟时，加速度必须大于 0'
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
        const selectedPointIds = [motion.value.currentPositionPointId, motion.value.startActionPointId, motion.value.arrivalPositionPointId].filter(Boolean)
        const result = await adminApi.updateDeviceMovement(detail.id, draft.devicePayload.instance_config.movement, selectedPointIds, draft.expectedMovement)
        if (result?.error) throw new Error(result.error)
        if (!result?.success) throw new Error('后端没有返回成功状态')

        if (draft.pointRows.length) {
            const selectedIds = new Set([motion.value.currentPositionPointId, motion.value.startActionPointId, motion.value.arrivalPositionPointId].filter(Boolean).map(String))
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
                        <p>{{ lastConfirmedMotion ? '推荐流程：绑定 PLC 的最后到位工位编号 → 导入产线工位 → 保存。运动中保持上一工位，不推测途中位置。' : '推荐流程：绑定 PLC 的当前工位编号 → 导入产线工位 → 填写现场间距 → 保存。你不需要填写 Unity 坐标。' }}</p>
                    </div>
                    <label class="motion-switch">
                        <input v-model="motion.enabled" type="checkbox"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/>
                        启用移动同步
                    </label>
                </div>

                <section class="motion-step-card">
                    <div class="motion-step-title"><span>1</span><div><strong>绑定 PLC 位置点位</strong><small>{{ lastConfirmedMotion ? 'PLC 工位编号只在到位时更新，运动中保持上一工位。' : 'PLC 只需要传 1、2、3… 这样的当前工位编号。' }}</small></div></div>
                    <div class="motion-form-grid">
                    <label>
                        <span class="motion-field-label">{{ motion.stationInputMeaning === 'target' ? 'PLC 目标工位命令点位' : lastConfirmedMotion ? 'PLC 最后到位工位编号点位' : 'PLC 当前工位编号点位' }} <span class="motion-required">*</span></span>
                        <select v-model="motion.currentPositionPointId" class="input" aria-label="移动位置数值点位" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                            <option value="">请选择 PLC 数值点位</option>
                            <option v-if="motion.currentPositionPointId && !numericPoints.some(point => String(point.id) === motion.currentPositionPointId)" :value="motion.currentPositionPointId">已保存点位 {{ motion.currentPositionPointId }}（位置反馈类型或归属无效，请重新选择）</option>
                            <option v-for="point in numericPoints" :key="point.id" :value="String(point.id)">
                                {{ pointLabel(point) }}
                            </option>
                        </select>
                        <small>{{ lastConfirmedMotion ? '编号只代表最后到位工位；运动中保持上一站，不推测途中位置或当前停靠状态。' : '例如：PLC 当前值为 1，小车就停在 1 号工位；变为 2，就移动到 2 号工位。' }}</small>
                    </label>
                    <label>
                        <span class="motion-field-label">{{ lastConfirmedMotion || motion.arrivalPositionPointId ? '实际移动状态反馈（仅 BOOL）' : '移动开始信号（可选）' }}</span>
                        <select v-model="motion.startActionPointId" class="input" aria-label="移动开始或实际移动反馈点位" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                            <option value="">{{ lastConfirmedMotion ? '不绑定（不确认当前停靠）' : '不绑定（收到编号就移动）' }}</option>
                            <option v-if="motion.startActionPointId && !actionPoints.some(point => String(point.id) === motion.startActionPointId)" :value="motion.startActionPointId">已保存点位 {{ motion.startActionPointId }}（{{ lastConfirmedMotion ? '非本设备只读 BOOL 实际移动反馈，请解除绑定或重新选择' : '只读采集点位无效，请重新选择' }}）</option>
                            <option v-for="point in actionPoints" :key="point.id" :value="String(point.id)">
                                {{ pointLabel(point) }}
                            </option>
                        </select>
                        <small>{{ lastConfirmedMotion || motion.arrivalPositionPointId ? '仅选择实际移动状态：true 表示正在移动，false 才能辅助确认停靠；未绑定时不确认停靠。' : '如果现场没有单独的启动信号，保持“不绑定”即可。' }}</small>
                    </label>
                    <label v-if="motion.valueMode === 'station' && motion.stationInputMeaning === 'target'">
                        <span class="motion-field-label">独立到位工位反馈（可选）</span>
                        <select v-model="motion.arrivalPositionPointId" class="input" aria-label="独立到位工位反馈点位" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                            <option value="">不绑定（仅估算，不确认停靠与交接）</option>
                            <option v-if="motion.arrivalPositionPointId && !numericPoints.some(point => String(point.id) === motion.arrivalPositionPointId)" :value="motion.arrivalPositionPointId">已保存点位 {{ motion.arrivalPositionPointId }}（类型或归属无效）</option>
                            <option v-for="point in numericPoints.filter(point => String(point.id) !== motion.currentPositionPointId)" :key="point.id" :value="String(point.id)">{{ pointLabel(point) }}</option>
                        </select>
                        <small>保留目标工位＋速度/加速度估算途中画面；仅当此到位编号和实际移动 BOOL 均有效、且 BOOL 为 false 时，确认停靠。估算完成不等于现场到位。</small>
                    </label>
                    <label>数据过期阈值（毫秒）
                        <input v-model.number="motion.staleMs" class="input" type="number" min="1000" max="60000" step="100" aria-label="移动数据过期阈值（毫秒）" v-permission="{ page: 'mobile-devices', action: 'edit' }" />
                    </label>
                    </div>
                </section>

                <details class="motion-advanced-settings">
                    <summary>高级兼容设置（普通工位编号模式无需修改）</summary>
                    <div class="motion-form-grid">
                        <label>位置值模式
                            <select v-model="motion.valueMode" class="input" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                                <option value="station">工位编号（推荐）</option>
                                <option value="normalized">归一化进度（旧配置）</option>
                                <option value="range">输入范围映射（旧配置）</option>
                            </select>
                        </label>
                        <label v-if="motion.valueMode === 'station'">工位编号数据含义
                            <select v-model="motion.stationInputMeaning" class="input" aria-label="工位编号数据含义" @change="changeStationInputMeaning" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                                <option value="">兼容旧设置（未指定）</option>
                                <option value="current">PLC 当前到位反馈（直接还原位置）</option>
                                <option value="last-confirmed">最后到位工位，运动中保持上一工位</option>
                                <option value="target">PLC 目标工位命令（估算移动过程）</option>
                            </select>
                        </label>
                        <label>视觉平滑时间（ms）
                            <input v-model.number="motion.smoothingMs" type="number" min="0" max="1000" step="10" class="input" aria-label="移动视觉平滑时间（毫秒）" :disabled="lastConfirmedMotion" v-permission="{ page: 'mobile-devices', action: 'edit' }"/>
                            <small>{{ lastConfirmedMotion ? '最后到位编号不提供途中位置，因此不启用视觉过渡。' : '只影响画面跟手程度，不是现场速度。0 表示延迟最低。' }}</small>
                        </label>
                        <label class="motion-check"><input v-model="motion.diagnosticLogging" type="checkbox" aria-label="启用移动运行诊断记录" v-permission="{ page: 'mobile-devices', action: 'edit' }" />启用移动运行诊断记录</label>
                        <label v-if="motion.diagnosticLogging">诊断记录间隔（秒）<input v-model.number="motion.diagnosticIntervalSeconds" class="input" type="number" min="1" max="60" step="1" aria-label="移动诊断记录间隔（秒）" v-permission="{ page: 'mobile-devices', action: 'edit' }" /></label>
                        <label>场景单位 / 米<input :value="displaySceneUnits(motion.sceneUnitsPerMeter)" @input="motion.sceneUnitsPerMeter=($event.target.value===''?'':Number($event.target.value))" class="input" type="number" min="0.0001" max="100000" step="0.01" aria-label="移动场景单位每米" v-permission="{ page: 'mobile-devices', action: 'edit' }" /><small>完整填写工位实际间距后自动按间距计算；否则使用此已配置比例。</small></label>
                    </div>
                    <div v-if="motion.valueMode === 'range'" class="motion-range-row">
                        <label>输入最小值<input v-model.number="motion.valueMin" type="number" class="input"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                        <label>输入最大值<input v-model.number="motion.valueMax" type="number" class="input"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                    </div>
                    <p class="motion-advanced-note">只有 PLC 不是传工位编号，而是传连续进度或其他数值时，才需要使用这里的旧模式。</p>
                </details>

                <section v-if="motion.valueMode === 'station'" class="motion-step-card motion-position-section">
                    <div class="motion-section-heading">
                        <div class="motion-step-title"><span>2</span><div><strong>导入现场工位</strong><small>设备在画布中的位置由系统自动读取，不需要手动填写 X / Y / Z。</small></div></div>
                        <div class="motion-section-actions">
                            <button type="button" class="btn btn-secondary motion-add-station" :disabled="!lineStationDevices.length" @click="syncStationsFromLine">从当前产线导入 {{ lineStationDevices.length }} 个</button>
                            <button type="button" class="btn btn-secondary motion-add-station" @click="addStation()" v-permission="{ page: 'mobile-devices', action: 'edit' }">+ 添加待分组工位</button>
                        </div>
                    </div>
                    <div class="motion-distance-summary" :class="{ warning: stationDistanceSummary.missingCount > 0 }">
                        <strong>{{ stationDistanceSummary.groupCount }} 条设备线 · {{ stationDistanceSummary.stationCount }} 个工位</strong>
                        <span v-if="stationDistanceSummary.missingCount">还需要填写 {{ stationDistanceSummary.missingCount }} 段同设备线内的现场间距</span>
                        <span v-else-if="stationDistanceSummary.totalMeters > 0">已按设备线配置现场总距离 {{ stationDistanceSummary.totalMeters.toFixed(2) }} 米</span>
                        <span v-else>相邻间距只在同一设备线内填写，跨设备线不计算</span>
                    </div>
                    <div class="motion-device-line-groups">
                        <section v-for="group in stationGroups" :key="group.key" class="motion-device-line-group">
                            <div class="motion-device-line-heading">
                                <div>
                                    <strong>{{ group.name }}</strong>
                                    <small>{{ group.devices.length ? `${group.devices.length} 个固定设备` : '还没有导入工位' }} · 相邻间距只在本设备线内计算</small>
                                </div>
                                <button type="button" class="btn btn-secondary motion-add-station" @click="addStation(group.key)" v-permission="{ page: 'mobile-devices', action: 'edit' }">+ 添加到此设备线</button>
                            </div>
                            <div v-if="group.stations.length" class="motion-station-list">
                                <div v-for="(station, index) in group.stations" :key="station.anchorDeviceId || `${group.key}-${station.value}-${index}`" class="motion-station-row">
                                    <div class="motion-station-order">{{ index + 1 }}</div>
                                    <label>PLC 编号<input v-model.number="station.value" type="number" step="1" class="input"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                    <label>工位名称（可选）<input v-model="station.label" type="text" class="input" placeholder="例如：1号工位"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                    <label>关联作业设备<select v-model="station.anchorDeviceId" class="input" :aria-label="`工位 ${station.value} 关联作业设备`" @change="applyStationAnchor(station)" v-permission="{ page: 'mobile-devices', action: 'edit' }"><option value="">手动坐标（不关联设备）</option><option v-for="device in lineStationDevices" :key="device.id" :value="String(device.id)">{{ device.name || device.id }}</option></select></label>
                                    <label v-if="index > 0" class="motion-distance-field">与本设备线上一站间距（米）<input :value="station.distanceMeters===''?'':displayCoordinateNumber(station.distanceMeters)" @input="station.distanceMeters=$event.target.value===''?'':Number($event.target.value)" type="number" min="0.01" step="0.1" class="input" placeholder="例如 8.5"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                    <div v-else class="motion-start-station"><strong>本设备线首站</strong><small>不需要填写跨线间距</small></div>
                                    <button v-if="motion.stations.length > 1" type="button" class="motion-remove-station" title="删除工位" @click="removeStation(station)" v-permission="{ page: 'mobile-devices', action: 'edit' }">删除</button>
                                    <div class="motion-station-coordinate-fields">
                                        <label>工位 X<input :value="displayCoordinateNumber(station.position.x)" @input="station.position.x=($event.target.value===''?'':Number($event.target.value))" class="input" type="number" step="0.01" :aria-label="`工位 ${station.value} X 坐标`" @change="projectManualStation(station)" v-permission="{ page: 'mobile-devices', action: 'edit' }" /></label>
                                        <label>轨道基准 Y<input :value="displayCoordinateNumber(motion.start.y)" class="input" type="number" readonly :aria-label="`工位 ${station.value} 轨道基准 Y`" /></label>
                                        <label>工位 Z<input :value="displayCoordinateNumber(station.position.z)" @input="station.position.z=($event.target.value===''?'':Number($event.target.value))" class="input" type="number" step="0.01" :aria-label="`工位 ${station.value} Z 坐标`" @change="projectManualStation(station)" v-permission="{ page: 'mobile-devices', action: 'edit' }" /></label>
                                    </div>
                                </div>
                            </div>
                            <div v-else class="motion-device-line-empty">点击“添加到此设备线”，或先从当前产线导入现场工位。</div>
                        </section>
                        <div v-if="!stationGroups.length" class="motion-device-line-empty">当前小车没有可用的设备线，请先在产线画布中摆放固定设备并绑定设备线。</div>
                    </div>
                    <p v-if="!lineStationDevices.length" class="motion-inline-warning">当前小车所属产线没有找到带设备线的固定设备。请先在产线画布中摆放设备、绑定设备线并设置工位编号，之后点击“从当前产线导入”。</p>
                </section>

                <section v-if="motion.valueMode === 'station'" class="motion-step-card motion-simulation-panel">
                    <div class="motion-step-title"><span>3</span><div><strong>选择移动效果</strong><small>{{ lastConfirmedMotion ? '只显示最后到位工位；不使用速度、加速度估算途中位置。' : '你只需要提供小车加速度；最大速度可以由系统按现场间距自动估算。' }}</small></div></div>
                    <label class="motion-switch motion-simulation-switch">
                        <input v-model="motion.simulationEnabled" type="checkbox" aria-label="开启移动运动细节模拟" :disabled="directStationFeedback" v-permission="{ page: 'mobile-devices', action: 'edit' }"/>
                        开启运动细节模拟
                    </label>
                    <div v-if="motion.simulationEnabled && !directStationFeedback" class="motion-simulation-fields">
                        <label>小车加速度（米 / 秒²）
                            <input v-model.number="motion.acceleration" type="number" min="0.01" step="0.1" class="input"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/>
                            <small>向电气工程人员要这个参数即可。</small>
                        </label>
                        <label>速度计算方式
                            <select v-model="motion.speedMode" class="input" v-permission="{ page: 'mobile-devices', action: 'edit' }">
                                <option value="auto">自动估算（推荐）</option>
                                <option value="fixed">我知道现场最大速度</option>
                            </select>
                            <small>自动估算会根据相邻工位间距和加速度计算，不需要填写最大速度。</small>
                        </label>
                        <label v-if="motion.speedMode === 'fixed'">现场最大速度（米 / 秒）
                            <input v-model.number="motion.maxSpeed" type="number" min="0.01" step="0.1" class="input"  v-permission="{ page: 'mobile-devices', action: 'edit' }"/>
                        </label>
                    </div>
                    <p class="motion-simulation-note" aria-label="移动反馈显示说明">{{ lastConfirmedMotion ? '最后到位工位编号不提供途中位置。画面保持上一次到位位置，在新编号到达时直接更新；未绑定有效实际移动 BOOL 反馈时，不确认当前停靠。' : motion.stationInputMeaning === 'current' ? '当前位置反馈表示现场已到位，直接还原到该工位，不再叠加估算移动时间。' : motion.stationInputMeaning === 'target' ? '目标工位命令仅用于估算移动，不能证明设备到位。未开启模拟时保持原位置，不用目标编号伪造现场位置。' : '运动细节模拟用于估算工位之间的移动，不等同于现场到位反馈；未开启时直接显示接收的工位位置。' }}</p>
                </section>

                <div class="motion-position-section">
                    <div class="motion-section-title">{{ motion.valueMode === 'station' ? '工位轨道基准 / 方向参考（不限制工位编号）' : '连续位置反馈的起始位置 / 终点位置' }}</div>
                    <div class="motion-position-columns">
                        <div>
                            <strong>起始位置</strong>
                            <div class="motion-coordinate-grid">
                                <label>X<input :value="displayCoordinateNumber(motion.start.x)" @input="motion.start.x=($event.target.value===''?'':Number($event.target.value))" type="number" step="0.1" class="input" aria-label="移动轨道起始 X" @change="updateRailBasis" v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                <label>Y<input :value="displayCoordinateNumber(motion.start.y)" @input="motion.start.y=($event.target.value===''?'':Number($event.target.value))" type="number" step="0.1" class="input" aria-label="移动轨道基准 Y" @change="updateRailBasis" v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                <label>Z<input :value="displayCoordinateNumber(motion.start.z)" @input="motion.start.z=($event.target.value===''?'':Number($event.target.value))" type="number" step="0.1" class="input" aria-label="移动轨道起始 Z" @change="updateRailBasis" v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                            </div>
                        </div>
                        <div>
                            <strong>终点位置</strong>
                            <div class="motion-coordinate-grid">
                                <label>X<input :value="displayCoordinateNumber(motion.end.x)" @input="motion.end.x=($event.target.value===''?'':Number($event.target.value))" type="number" step="0.1" class="input" aria-label="移动轨道参考终点 X" @change="updateRailBasis" v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                <label>Y<input v-if="motion.valueMode === 'station'" :value="displayCoordinateNumber(motion.start.y)" type="number" class="input" aria-label="移动轨道终点 Y" readonly /><input v-else :value="displayCoordinateNumber(motion.end.y)" @input="motion.end.y=($event.target.value===''?'':Number($event.target.value))" type="number" step="0.1" class="input" aria-label="移动轨道终点 Y" @change="updateRailBasis" v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                                <label>Z<input :value="displayCoordinateNumber(motion.end.z)" @input="motion.end.z=($event.target.value===''?'':Number($event.target.value))" type="number" step="0.1" class="input" aria-label="移动轨道参考终点 Z" @change="updateRailBasis" v-permission="{ page: 'mobile-devices', action: 'edit' }"/></label>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="motion-performance-note">
                    <strong>低延迟策略</strong>
                    <span>移动点位和开始行动点位保存时会自动设置为 100ms 采集；Unity 不轮询、不等待下一次渲染周期之外的额外队列，收到实时帧后直接更新模型。</span>
                </div>

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
.motion-station-row { display: grid; grid-template-columns: 32px minmax(100px, .7fr) minmax(160px, 1.2fr) minmax(160px, 1fr) minmax(180px, 1fr) 48px; gap: 10px; align-items: end; padding: 12px; border: 1px solid #e8ecf1; border-radius: 10px; background: #fff; }
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
