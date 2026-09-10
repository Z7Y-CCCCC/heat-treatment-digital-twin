<script setup>
import { computed, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'

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

function defaultStations(start, end) {
    return [
        { value: 1, label: '1号工位', anchorDeviceId: '', distanceMeters: 0, position: { ...start } },
        { value: 2, label: '2号工位', anchorDeviceId: '', distanceMeters: '', position: { ...end } }
    ]
}

function normalizeStations(value, fallback) {
    if (!Array.isArray(value)) return fallback.map(station => ({ ...station, position: { ...station.position } }))
    const stations = value
        .map((station, index) => {
            const source = station && typeof station === 'object' ? station : {}
            const defaultValue = fallback[index]?.value ?? index + 1
            const defaultPosition = fallback[index]?.position || fallback[fallback.length - 1]?.position || { x: 0, y: 0, z: 0 }
            const valueNumber = Number(source.value)
            return {
                value: Number.isFinite(valueNumber) ? valueNumber : defaultValue,
                label: String(source.label || `${Number.isFinite(valueNumber) ? valueNumber : defaultValue}号工位`),
                anchorDeviceId: pointIdOr(source.anchorDeviceId ?? source.anchor_device_id),
                distanceMeters: index === 0
                    ? 0
                    : (Number.isFinite(Number(source.distanceMeters ?? source.distance_meters))
                        ? Math.max(0, Number(source.distanceMeters ?? source.distance_meters))
                        : ''),
                position: positionOr(source.position || source, defaultPosition)
            }
        })
        .filter(station => Number.isFinite(station.value))
        .sort((left, right) => left.value - right.value)
    return stations.length > 0
        ? stations
        : fallback.map(station => ({ ...station, position: { ...station.position } }))
}

function defaultMotion(device = {}) {
    const start = {
        x: numberOr(device.pos_x),
        y: numberOr(device.pos_y),
        z: numberOr(device.pos_z)
    }
    return {
        enabled: false,
        currentPositionPointId: '',
        startActionPointId: '',
        valueMode: 'station',
        valueMin: 0,
        valueMax: 100,
        smoothingMs: 0,
        simulationEnabled: false,
        speedMode: 'auto',
        maxSpeed: 2,
        acceleration: 1,
        sceneUnitsPerMeter: 1,
        start,
        end: { ...start, x: start.x + 10 },
        stations: defaultStations(start, { ...start, x: start.x + 10 })
    }
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
        valueMode: ['normalized', 'range', 'station'].includes(source.valueMode) ? source.valueMode : fallback.valueMode,
        valueMin: numberOr(source.valueMin ?? source.value_min, fallback.valueMin),
        valueMax: numberOr(source.valueMax ?? source.value_max, fallback.valueMax),
        smoothingMs: Math.max(0, Math.min(1000, numberOr(source.smoothingMs ?? source.smoothing_ms, 0))),
        simulationEnabled: source.simulationEnabled === true || source.simulation_enabled === true,
        speedMode: String(source.speedMode ?? source.speed_mode ?? fallback.speedMode).toLowerCase() === 'fixed' ? 'fixed' : 'auto',
        maxSpeed: Math.max(0.01, numberOr(source.maxSpeed ?? source.max_speed, fallback.maxSpeed)),
        acceleration: Math.max(0.01, numberOr(source.acceleration, fallback.acceleration)),
        sceneUnitsPerMeter: Math.max(0.0001, numberOr(source.sceneUnitsPerMeter ?? source.scene_units_per_meter, fallback.sceneUnitsPerMeter)),
        start: positionOr(source.start, fallback.start),
        end: positionOr(source.end, fallback.end),
        stations: normalizeStations(source.stations, fallback.stations)
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

function isAuxiliaryDevice(device) {
    const config = parseJson(device?.instance_config)
    return device?.model_type === 'transfer_cart'
        || String(config.role || '').toLowerCase() === 'transfer_cart'
        || String(config.role || '').toLowerCase() === 'auxiliary'
        || config.sceneObject === true
}

const mobileDevices = computed(() => props.devices.filter(isAuxiliaryDevice))
const selectedDevice = computed(() => mobileDevices.value.find(device => String(device.id) === String(selectedDeviceId.value)) || null)
const lineStationDevices = computed(() => {
    const lineId = deviceDetail.value?.line_id
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
        .map(device => ({ ...device, stationNumber: nextById.get(device.id) }))
        .sort((left, right) => left.stationNumber - right.stationNumber)
})
const numericPoints = computed(() => dataPoints.value.filter(point => {
    const type = String(point.data_type || '').toUpperCase()
    return String(point.access_type || 'READ').toUpperCase() !== 'WRITE'
        && !['BOOL', 'STRING', 'CHAR', 'DT', 'DTL'].includes(type)
}))
const actionPoints = computed(() => dataPoints.value.filter(point => (
    String(point.access_type || 'READ').toUpperCase() !== 'WRITE'
)))

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

async function loadDevice(deviceId) {
    if (!deviceId) {
        deviceDetail.value = null
        dataPoints.value = []
        motion.value = defaultMotion()
        return
    }
    loading.value = true
    message.value = ''
    errorMessage.value = ''
    try {
        const detail = await adminApi.getDevice(deviceId)
        if (!detail || detail.error) throw new Error(detail?.error || '读取设备详情失败')
        deviceDetail.value = detail
        dataPoints.value = Array.isArray(detail?.dataPoints) ? detail.dataPoints : []
        motion.value = normalizeMotion(detail)
    } catch (error) {
        deviceDetail.value = null
        dataPoints.value = []
        errorMessage.value = error.message || '读取设备点位失败'
    } finally {
        loading.value = false
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

watch(selectedDeviceId, value => { loadDevice(value) })

function addStation() {
    const stations = Array.isArray(motion.value.stations) ? motion.value.stations : []
    const last = stations[stations.length - 1]
    const nextValue = stations.reduce((max, station) => Math.max(max, numberOr(station.value, 0)), 0) + 1
    const base = last?.position || motion.value.end || motion.value.start
    stations.push({
        value: nextValue,
        label: `${nextValue}号工位`,
        anchorDeviceId: '',
        distanceMeters: '',
        position: {
            x: numberOr(base?.x) + (last ? 10 : 0),
            y: numberOr(base?.y),
            z: numberOr(base?.z)
        }
    })
    motion.value.stations = stations
}

function removeStation(index) {
    if (!Array.isArray(motion.value.stations) || motion.value.stations.length <= 1) return
    motion.value.stations.splice(index, 1)
}

function applyStationAnchor(station) {
    const device = props.devices.find(item => String(item.id) === String(station.anchorDeviceId))
    if (!device) return
    station.position = {
        x: numberOr(device.pos_x),
        y: numberOr(device.pos_y),
        z: numberOr(device.pos_z)
    }
}

function syncStationsFromLine() {
    if (!lineStationDevices.value.length) {
        errorMessage.value = '当前设备所属产线还没有固定设备，请先在产线画布中摆放设备'
        return
    }
    const previousDistances = new Map((motion.value.stations || []).map(station => [Number(station.value), station.distanceMeters]))
    motion.value.stations = lineStationDevices.value.map((device, index) => {
        const value = device.stationNumber
        return {
            value,
            label: `${value}号工位 · ${device.name || device.id}`,
            anchorDeviceId: String(device.id),
            distanceMeters: index === 0 ? 0 : (previousDistances.get(value) ?? ''),
            position: {
                x: numberOr(device.pos_x),
                y: numberOr(device.pos_y),
                z: numberOr(device.pos_z)
            }
        }
    })
    message.value = `已从当前产线导入 ${lineStationDevices.value.length} 个工位位置`
    errorMessage.value = ''
}

function sceneDistance(left, right) {
    const dx = numberOr(right?.x) - numberOr(left?.x)
    const dy = numberOr(right?.y) - numberOr(left?.y)
    const dz = numberOr(right?.z) - numberOr(left?.z)
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz))
}

const stationDistanceSummary = computed(() => {
    const stations = [...(motion.value.stations || [])].sort((left, right) => numberOr(left.value) - numberOr(right.value))
    let totalMeters = 0
    let totalSceneUnits = 0
    let missingCount = 0
    stations.forEach((station, index) => {
        if (index === 0) return
        const distance = Number(station.distanceMeters)
        if (!Number.isFinite(distance) || distance <= 0) {
            missingCount += 1
        } else {
            totalMeters += distance
        }
        totalSceneUnits += sceneDistance(stations[index - 1]?.position, station.position)
    })
    return {
        stationCount: stations.length,
        totalMeters,
        totalSceneUnits,
        missingCount,
        sceneUnitsPerMeter: totalMeters > 0 && totalSceneUnits > 0 ? totalSceneUnits / totalMeters : 1
    }
})

async function saveMotion() {
    if (!deviceDetail.value?.id) return
    if (motion.value.enabled && !motion.value.currentPositionPointId) {
        errorMessage.value = '启用移动同步时，请先绑定“当前位置”数值点位'
        return
    }
    if (motion.value.valueMode === 'range' && motion.value.valueMax <= motion.value.valueMin) {
        errorMessage.value = '输入范围的最大值必须大于最小值'
        return
    }
    if (motion.value.valueMode === 'station') {
        const stations = Array.isArray(motion.value.stations) ? motion.value.stations : []
        const values = stations.map(station => Number(station.value))
        if (stations.length === 0 || values.some(value => !Number.isFinite(value))) {
            errorMessage.value = '工位编号模式至少需要配置一个有效的工位编号'
            return
        }
        if (new Set(values).size !== values.length) {
            errorMessage.value = '工位编号不能重复，请检查工位映射'
            return
        }
        if (motion.value.simulationEnabled && motion.value.maxSpeed <= 0) {
            if (motion.value.speedMode === 'fixed') {
                errorMessage.value = '选择固定速度时，最大速度必须大于 0'
                return
            }
        }
        if (motion.value.simulationEnabled && stationDistanceSummary.value.missingCount > 0) {
            errorMessage.value = '请填写每个相邻工位之间的现场间距；第一站不需要填写'
            return
        }
        if (motion.value.simulationEnabled && motion.value.acceleration <= 0) {
            errorMessage.value = '启用运动细节模拟时，加速度必须大于 0'
            return
        }
    }

    saving.value = true
    message.value = ''
    errorMessage.value = ''
    try {
        const existingConfig = parseJson(deviceDetail.value.instance_config)
        const nextConfig = {
            ...existingConfig,
            movement: {
                enabled: motion.value.enabled === true,
                currentPositionPointId: pointIdOr(motion.value.currentPositionPointId),
                startActionPointId: pointIdOr(motion.value.startActionPointId),
                valueMode: ['range', 'station'].includes(motion.value.valueMode) ? motion.value.valueMode : 'normalized',
                valueMin: numberOr(motion.value.valueMin),
                valueMax: numberOr(motion.value.valueMax, 100),
                smoothingMs: Math.max(0, Math.min(1000, numberOr(motion.value.smoothingMs))),
                simulationEnabled: motion.value.simulationEnabled === true,
                speedMode: motion.value.speedMode === 'fixed' ? 'fixed' : 'auto',
                maxSpeed: Math.max(0.01, numberOr(motion.value.maxSpeed, 2)),
                acceleration: Math.max(0.01, numberOr(motion.value.acceleration, 1)),
                sceneUnitsPerMeter: stationDistanceSummary.value.sceneUnitsPerMeter,
                stations: [...(motion.value.stations || [])].sort((left, right) => numberOr(left.value) - numberOr(right.value)).map((station, index) => ({
                    value: numberOr(station.value),
                    label: String(station.label || `${numberOr(station.value)}号工位`),
                    anchorDeviceId: pointIdOr(station.anchorDeviceId),
                    distanceMeters: index === 0 ? 0 : Math.max(0, numberOr(station.distanceMeters)),
                    position: {
                        x: numberOr(station.position?.x),
                        y: numberOr(station.position?.y),
                        z: numberOr(station.position?.z)
                    }
                })),
                start: {
                    x: numberOr(motion.value.start.x),
                    y: numberOr(motion.value.start.y),
                    z: numberOr(motion.value.start.z)
                },
                end: {
                    x: numberOr(motion.value.end.x),
                    y: numberOr(motion.value.end.y),
                    z: numberOr(motion.value.end.z)
                }
            }
        }

        const detail = deviceDetail.value
        const result = await adminApi.updateDevice(detail.id, {
            name: detail.name || detail.id,
            line_id: detail.line_id || null,
            model_type: detail.model_type || 'builtin_furnace',
            model_file: detail.model_file || null,
            template_id: detail.template_id || '',
            instance_config: nextConfig,
            pos_x: numberOr(detail.pos_x),
            pos_y: numberOr(detail.pos_y),
            pos_z: numberOr(detail.pos_z),
            rotation_y: numberOr(detail.rotation_y),
            scale: numberOr(detail.scale, 1),
            coordinate_space: detail.coordinate_space || 'line_local',
            sort_order: numberOr(detail.sort_order),
            plc_enabled: detail.plc_enabled ? 1 : 0,
            plc_protocol: detail.plc_protocol || 'S7',
            plc_ip: detail.plc_ip || '',
            plc_port: numberOr(detail.plc_port, 102),
            plc_rack: numberOr(detail.plc_rack),
            plc_slot: numberOr(detail.plc_slot, 1),
            plc_timeout: numberOr(detail.plc_timeout, 5000),
            plc_retry_interval: numberOr(detail.plc_retry_interval, 10000),
            plc_max_retries: numberOr(detail.plc_max_retries),
            plc_options: parseJson(detail.plc_options)
        })
        if (result?.error) throw new Error(result.error)
        if (!result?.success) throw new Error('后端没有返回成功状态')

        const selectedIds = new Set([
            motion.value.currentPositionPointId,
            motion.value.startActionPointId
        ].filter(Boolean).map(String))
        if (selectedIds.size > 0 && dataPoints.value.length > 0) {
            const pointResult = await adminApi.syncDataPoints(
                detail.id,
                dataPoints.value.map(point => pointPayload(point, selectedIds))
            )
            if (pointResult?.error) throw new Error(pointResult.error)
            if (!pointResult?.success) throw new Error('点位采集周期保存失败')
            dataPoints.value = dataPoints.value.map(point => selectedIds.has(String(point.id))
                ? { ...point, sample_interval_ms: 100 }
                : point)
        }

        deviceDetail.value = { ...detail, instance_config: nextConfig }
        message.value = '已保存。绑定点位采集周期已设为 100ms，Unity 将实时应用移动配置。'
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
        <div class="page-heading-row">
            <div>
                <h2>移动设备</h2>
                <p class="desc">将设备模型绑定到 PLC 位置点位，收到实时位置后直接驱动 Unity 中的模型移动。</p>
            </div>
            <span class="motion-latency-badge">实时通道 · 100ms</span>
        </div>

        <div v-if="!mobileDevices.length" class="empty-state">暂无辅助设备，请先在“设备管理”中添加小车或其他辅助设备。</div>
        <template v-else>
            <section class="motion-card motion-device-picker">
                <label class="motion-device-select">选择移动设备（小车 / 辅助设备）
                    <select v-model="selectedDeviceId" class="input">
                        <option v-for="device in mobileDevices" :key="device.id" :value="String(device.id)">
                            {{ device.name || device.id }}（{{ device.id }}）
                        </option>
                    </select>
                </label>
                <span v-if="loading" class="motion-muted">正在读取点位…</span>
                <span v-else class="motion-muted">{{ dataPoints.length }} 个点位可供绑定</span>
            </section>

            <div v-if="errorMessage" class="motion-alert motion-alert-error">{{ errorMessage }}</div>
            <div v-if="message" class="motion-alert motion-alert-success">{{ message }}</div>

            <section v-if="deviceDetail" class="motion-card">
                <div class="motion-card-header">
                    <div>
                        <h3>移动控制</h3>
                        <p>推荐流程：绑定 PLC 的当前工位编号 → 导入产线工位 → 填写现场间距 → 保存。你不需要填写 Unity 坐标。</p>
                    </div>
                    <label class="motion-switch">
                        <input v-model="motion.enabled" type="checkbox" />
                        启用移动同步
                    </label>
                </div>

                <section class="motion-step-card">
                    <div class="motion-step-title"><span>1</span><div><strong>绑定 PLC 位置点位</strong><small>PLC 只需要传 1、2、3… 这样的当前工位编号。</small></div></div>
                    <div class="motion-form-grid">
                    <label>PLC 当前工位编号点位 <span class="motion-required">*</span>
                        <select v-model="motion.currentPositionPointId" class="input">
                            <option value="">请选择 PLC 数值点位</option>
                            <option v-for="point in numericPoints" :key="point.id" :value="String(point.id)">
                                {{ pointLabel(point) }}
                            </option>
                        </select>
                        <small>例如：PLC 当前值为 1，小车就停在 1 号工位；变为 2，就移动到 2 号工位。</small>
                    </label>
                    <label>移动开始信号（可选）
                        <select v-model="motion.startActionPointId" class="input">
                            <option value="">不绑定（收到编号就移动）</option>
                            <option v-for="point in actionPoints" :key="point.id" :value="String(point.id)">
                                {{ pointLabel(point) }}
                            </option>
                        </select>
                        <small>如果现场没有单独的启动信号，保持“不绑定”即可。</small>
                    </label>
                    </div>
                </section>

                <details class="motion-advanced-settings">
                    <summary>高级兼容设置（普通工位编号模式无需修改）</summary>
                    <div class="motion-form-grid">
                        <label>位置值模式
                            <select v-model="motion.valueMode" class="input">
                                <option value="station">工位编号（推荐）</option>
                                <option value="normalized">归一化进度（旧配置）</option>
                                <option value="range">输入范围映射（旧配置）</option>
                            </select>
                        </label>
                        <label>视觉平滑时间（ms）
                            <input v-model.number="motion.smoothingMs" type="number" min="0" max="1000" step="10" class="input" />
                            <small>只影响画面跟手程度，不是现场速度。0 表示延迟最低。</small>
                        </label>
                    </div>
                    <div v-if="motion.valueMode === 'range'" class="motion-range-row">
                        <label>输入最小值<input v-model.number="motion.valueMin" type="number" class="input" /></label>
                        <label>输入最大值<input v-model.number="motion.valueMax" type="number" class="input" /></label>
                    </div>
                    <p class="motion-advanced-note">只有 PLC 不是传工位编号，而是传连续进度或其他数值时，才需要使用这里的旧模式。</p>
                </details>

                <section v-if="motion.valueMode === 'station'" class="motion-step-card motion-position-section">
                    <div class="motion-section-heading">
                        <div class="motion-step-title"><span>2</span><div><strong>导入现场工位</strong><small>设备在画布中的位置由系统自动读取，不需要手动填写 X / Y / Z。</small></div></div>
                        <div class="motion-section-actions">
                            <button type="button" class="btn btn-secondary motion-add-station" :disabled="!lineStationDevices.length" @click="syncStationsFromLine">从当前产线导入 {{ lineStationDevices.length }} 个</button>
                            <button type="button" class="btn btn-secondary motion-add-station" @click="addStation">+ 手动添加</button>
                        </div>
                    </div>
                    <div class="motion-distance-summary" :class="{ warning: stationDistanceSummary.missingCount > 0 }">
                        <strong>{{ stationDistanceSummary.stationCount }} 个工位</strong>
                        <span v-if="stationDistanceSummary.missingCount">还需要填写 {{ stationDistanceSummary.missingCount }} 段现场间距</span>
                        <span v-else-if="stationDistanceSummary.totalMeters > 0">已配置现场总距离 {{ stationDistanceSummary.totalMeters.toFixed(2) }} 米</span>
                        <span v-else>开启运动模拟后，再填写相邻工位间距</span>
                    </div>
                    <div class="motion-station-list">
                        <div v-for="(station, index) in motion.stations" :key="index" class="motion-station-row">
                            <div class="motion-station-order">{{ index + 1 }}</div>
                            <label>PLC 编号<input v-model.number="station.value" type="number" step="1" class="input" /></label>
                            <label>工位名称（可选）<input v-model="station.label" type="text" class="input" placeholder="例如：1号工位" /></label>
                            <label v-if="index > 0" class="motion-distance-field">与上一站间距（米）<input v-model.number="station.distanceMeters" type="number" min="0.01" step="0.1" class="input" placeholder="例如 8.5" /></label>
                            <div v-else class="motion-start-station"><strong>起始工位</strong><small>不需要填写间距</small></div>
                            <button v-if="motion.stations.length > 1" type="button" class="motion-remove-station" title="删除工位" @click="removeStation(index)">删除</button>
                        </div>
                    </div>
                    <p v-if="!lineStationDevices.length" class="motion-inline-warning">当前小车没有找到同一产线的固定设备。请先在产线画布中摆放设备并设置工位编号，之后点击“从当前产线导入”。</p>
                </section>

                <section v-if="motion.valueMode === 'station'" class="motion-step-card motion-simulation-panel">
                    <div class="motion-step-title"><span>3</span><div><strong>选择移动效果</strong><small>你只需要提供小车加速度；最大速度可以由系统按现场间距自动估算。</small></div></div>
                    <label class="motion-switch motion-simulation-switch">
                        <input v-model="motion.simulationEnabled" type="checkbox" />
                        开启运动细节模拟
                    </label>
                    <div v-if="motion.simulationEnabled" class="motion-simulation-fields">
                        <label>小车加速度（米 / 秒²）
                            <input v-model.number="motion.acceleration" type="number" min="0.01" step="0.1" class="input" />
                            <small>向电气工程人员要这个参数即可。</small>
                        </label>
                        <label>速度计算方式
                            <select v-model="motion.speedMode" class="input">
                                <option value="auto">自动估算（推荐）</option>
                                <option value="fixed">我知道现场最大速度</option>
                            </select>
                            <small>自动估算会根据相邻工位间距和加速度计算，不需要填写最大速度。</small>
                        </label>
                        <label v-if="motion.speedMode === 'fixed'">现场最大速度（米 / 秒）
                            <input v-model.number="motion.maxSpeed" type="number" min="0.01" step="0.1" class="input" />
                        </label>
                    </div>
                    <p class="motion-simulation-note">关闭模拟时，小车收到新编号后直接切换到目标工位，并显示短暂的“移动中”提示；这是无法取得完整现场参数时的保底方式。</p>
                </section>

                <div v-if="motion.valueMode !== 'station'" class="motion-position-section">
                    <div class="motion-section-title">旧模式的起始位置 / 终点位置</div>
                    <div class="motion-position-columns">
                        <div>
                            <strong>起始位置</strong>
                            <div class="motion-coordinate-grid">
                                <label>X<input v-model.number="motion.start.x" type="number" step="0.1" class="input" /></label>
                                <label>Y<input v-model.number="motion.start.y" type="number" step="0.1" class="input" /></label>
                                <label>Z<input v-model.number="motion.start.z" type="number" step="0.1" class="input" /></label>
                            </div>
                        </div>
                        <div>
                            <strong>终点位置</strong>
                            <div class="motion-coordinate-grid">
                                <label>X<input v-model.number="motion.end.x" type="number" step="0.1" class="input" /></label>
                                <label>Y<input v-model.number="motion.end.y" type="number" step="0.1" class="input" /></label>
                                <label>Z<input v-model.number="motion.end.z" type="number" step="0.1" class="input" /></label>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="motion-performance-note">
                    <strong>低延迟策略</strong>
                    <span>移动点位和开始行动点位保存时会自动设置为 100ms 采集；Unity 不轮询、不等待下一次渲染周期之外的额外队列，收到实时帧后直接更新模型。</span>
                </div>

                <div class="modal-actions motion-actions">
                    <button type="button" class="btn btn-primary" :disabled="saving || loading" @click="saveMotion">
                        {{ saving ? '保存中…' : '保存移动配置' }}
                    </button>
                </div>
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
    font-size: 12px;
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
.motion-device-select { flex: 1; max-width: 520px; gap: 8px; color: #344054; font-size: 13px; font-weight: 700; }
.motion-muted, .motion-card-header p, .motion-card small { color: #778397; font-size: 12px; }
.motion-card-header { align-items: flex-start; margin-bottom: 20px; }
.motion-card-header h3 { margin: 0 0 6px; }
.motion-card-header p { margin: 0; }
.motion-step-card { padding: 16px; border: 1px solid #e5ebf2; border-radius: 12px; background: #fbfcfe; }
.motion-step-title { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; }
.motion-step-title > span { display: grid; place-items: center; flex: 0 0 26px; width: 26px; height: 26px; border-radius: 50%; color: #fff; background: linear-gradient(135deg, #4f8df7, #2563eb); font-size: 12px; font-weight: 800; }
.motion-step-title > div { display: grid; gap: 4px; }
.motion-step-title strong { color: #1d2939; font-size: 14px; }
.motion-step-title small { color: #778397; font-size: 12px; font-weight: 400; line-height: 1.5; }
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
    font-size: 13px;
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
.motion-form-grid label, .motion-range-row label, .motion-coordinate-grid label { display: flex; flex-direction: column; gap: 7px; color: #344054; font-size: 13px; font-weight: 600; }
.motion-form-grid small { font-weight: 400; line-height: 1.5; }
.motion-required { color: #d92d20; }
.motion-range-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; }
.motion-advanced-settings { margin-top: 14px; padding: 12px 14px; border: 1px dashed #cfd9e6; border-radius: 10px; background: #fff; }
.motion-advanced-settings summary { color: #52657d; cursor: pointer; font-size: 12px; font-weight: 700; }
.motion-advanced-settings[open] summary { margin-bottom: 14px; color: #24577a; }
.motion-advanced-note { margin: 12px 0 0; color: #8a97a8; font-size: 12px; line-height: 1.5; }
.motion-simulation-panel { margin-top: 18px; border-color: #d9e7f0; background: linear-gradient(135deg, #f3f9fd, #f8fbfd); }
.motion-simulation-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.motion-simulation-heading > div { display: grid; gap: 4px; }
.motion-simulation-heading strong { color: #1f4f68; font-size: 13px; }
.motion-simulation-heading small, .motion-simulation-note { color: #6a8190; font-size: 12px; line-height: 1.5; }
.motion-kinematics-row { margin-top: 12px; }
.motion-simulation-note { display: block; margin-top: 10px; }
.motion-simulation-switch { margin: -2px 0 12px 36px; color: #1f4f68; }
.motion-simulation-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-left: 36px; }
.motion-simulation-fields label { display: flex; flex-direction: column; gap: 7px; color: #344054; font-size: 13px; font-weight: 600; }
.motion-simulation-fields small { color: #778397; font-size: 12px; font-weight: 400; line-height: 1.5; }
.motion-position-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid #edf0f4; }
.motion-section-title { margin-bottom: 14px; color: #1d2939; font-weight: 700; }
.motion-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.motion-section-heading .motion-section-title { margin-bottom: 5px; }
.motion-section-heading small { color: #778397; font-size: 12px; line-height: 1.5; }
.motion-section-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.motion-add-station { flex: 0 0 auto; min-height: 34px; padding: 0 12px; }
.motion-distance-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 4px 0 12px; padding: 9px 11px; color: #42617b; background: #eef7fd; border-radius: 8px; font-size: 12px; }
.motion-distance-summary strong { color: #1f4f68; }
.motion-distance-summary.warning { color: #8a5a16; background: #fff8e7; }
.motion-distance-summary.warning strong { color: #8a5a16; }
.motion-station-list { display: grid; gap: 10px; }
.motion-station-row { display: grid; grid-template-columns: 32px minmax(100px, .7fr) minmax(160px, 1.2fr) minmax(180px, 1fr) 48px; gap: 10px; align-items: end; padding: 12px; border: 1px solid #e8ecf1; border-radius: 10px; background: #fff; }
.motion-station-order { display: grid; place-items: center; width: 28px; height: 28px; margin-bottom: 4px; border-radius: 8px; color: #24577a; background: #e8f2f9; font-size: 12px; font-weight: 800; }
.motion-station-row label { display: flex; flex-direction: column; gap: 7px; color: #344054; font-size: 12px; font-weight: 600; }
.motion-station-row .input { height: 36px; line-height: 36px; }
.motion-start-station { display: flex; flex-direction: column; justify-content: center; min-height: 36px; gap: 3px; color: #52657d; font-size: 12px; }
.motion-start-station small { color: #98a2b3; font-size: 11px; }
.motion-inline-warning { margin: 12px 0 0; color: #8a5a16; font-size: 12px; line-height: 1.5; }
.motion-remove-station { height: 36px; padding: 0; border: 0; color: #b42318; background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
.motion-remove-station:hover { color: #d92d20; text-decoration: underline; }
.motion-position-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.motion-position-columns > div { padding: 14px; border: 1px solid #e8ecf1; border-radius: 10px; background: #fbfcfd; }
.motion-coordinate-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.motion-performance-note { display: flex; gap: 10px; margin-top: 22px; padding: 12px 14px; border-radius: 10px; background: #f1f8ff; color: #285377; font-size: 12px; line-height: 1.6; }
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
    font-size: 13px;
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
.motion-alert { margin-bottom: 16px; padding: 10px 14px; border-radius: 8px; font-size: 13px; }
.motion-alert-error { color: #b42318; background: #fff1f0; border: 1px solid #fecdca; }
.motion-alert-success { color: #16794c; background: #effaf4; border: 1px solid #b7ebcf; }
.empty-state { padding: 36px; border: 1px dashed #cfd7e3; border-radius: 12px; color: #667085; text-align: center; }
@media (max-width: 760px) {
    .page-heading-row, .motion-card-header, .motion-device-picker { align-items: flex-start; flex-direction: column; }
    .motion-form-grid, .motion-range-row, .motion-position-columns { grid-template-columns: 1fr; }
    .motion-section-heading { flex-direction: column; }
    .motion-simulation-fields { grid-template-columns: 1fr; margin-left: 0; }
    .motion-simulation-switch { margin-left: 0; }
    .motion-station-row { grid-template-columns: 28px repeat(2, minmax(0, 1fr)); }
    .motion-remove-station { justify-self: start; padding: 0 8px; }
}
</style>
