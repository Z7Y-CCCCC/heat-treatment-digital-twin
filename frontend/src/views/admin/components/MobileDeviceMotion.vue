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
        { value: 1, label: '1号工位', anchorDeviceId: '', position: { ...start } },
        { value: 2, label: '2号工位', anchorDeviceId: '', position: { ...end } }
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
        valueMode: 'normalized',
        valueMin: 0,
        valueMax: 100,
        smoothingMs: 0,
        simulationEnabled: false,
        maxSpeed: 2,
        acceleration: 1,
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
        valueMode: ['range', 'station'].includes(source.valueMode) ? source.valueMode : 'normalized',
        valueMin: numberOr(source.valueMin ?? source.value_min, fallback.valueMin),
        valueMax: numberOr(source.valueMax ?? source.value_max, fallback.valueMax),
        smoothingMs: Math.max(0, Math.min(1000, numberOr(source.smoothingMs ?? source.smoothing_ms, 0))),
        simulationEnabled: source.simulationEnabled === true || source.simulation_enabled === true,
        maxSpeed: Math.max(0.01, numberOr(source.maxSpeed ?? source.max_speed, fallback.maxSpeed)),
        acceleration: Math.max(0.01, numberOr(source.acceleration, fallback.acceleration)),
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

const selectedDevice = computed(() => props.devices.find(device => String(device.id) === String(selectedDeviceId.value)) || null)
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

watch(() => props.devices, devices => {
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
        errorMessage.value = '当前设备所属产线还没有已编号的固定设备，请先在产线画布中摆放并编号'
        return
    }
    motion.value.stations = lineStationDevices.value.map(device => {
        const value = device.stationNumber
        return {
            value,
            label: `${value}号工位 · ${device.name || device.id}`,
            anchorDeviceId: String(device.id),
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
            errorMessage.value = '启用运动细节模拟时，最大速度必须大于 0'
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
                maxSpeed: Math.max(0.01, numberOr(motion.value.maxSpeed, 2)),
                acceleration: Math.max(0.01, numberOr(motion.value.acceleration, 1)),
                stations: (motion.value.stations || []).map(station => ({
                    value: numberOr(station.value),
                    label: String(station.label || `${numberOr(station.value)}号工位`),
                    anchorDeviceId: pointIdOr(station.anchorDeviceId),
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

        <div v-if="!props.devices.length" class="empty-state">暂无设备，请先在“设备管理”中添加设备。</div>
        <template v-else>
            <section class="motion-card motion-device-picker">
                <label class="motion-device-select">选择移动设备
                    <select v-model="selectedDeviceId" class="input">
                        <option v-for="device in props.devices" :key="device.id" :value="String(device.id)">
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
                        <p>当前位置点位可传连续值，也可传 1、2、3 等工位编号；工位之间只做近似过渡，最终以编号对应的停靠点为准。</p>
                    </div>
                    <label class="motion-switch">
                        <input v-model="motion.enabled" type="checkbox" />
                        启用移动同步
                    </label>
                </div>

                <div class="motion-form-grid">
                    <label>当前位置点位 <span class="motion-required">*</span>
                        <select v-model="motion.currentPositionPointId" class="input">
                            <option value="">请选择数值点位</option>
                            <option v-for="point in numericPoints" :key="point.id" :value="String(point.id)">
                                {{ pointLabel(point) }}
                            </option>
                        </select>
                        <small v-if="motion.valueMode === 'station'">工位编号模式填写 1、2、3 等编号，对应下方配置的停靠位置。</small>
                        <small v-else>归一化模式填写 0~1 或 0~100；范围模式按下方输入范围换算。</small>
                    </label>
                    <label>开始行动点位
                        <select v-model="motion.startActionPointId" class="input">
                            <option value="">不绑定（收到位置即跟随）</option>
                            <option v-for="point in actionPoints" :key="point.id" :value="String(point.id)">
                                {{ pointLabel(point) }}
                            </option>
                        </select>
                        <small>绑定后，点位为真时才更新模型位置；为假时保持当前位置。</small>
                    </label>
                    <label>位置值模式
                        <select v-model="motion.valueMode" class="input">
                            <option value="normalized">归一化进度（0~1 / 0~100）</option>
                            <option value="range">输入范围映射</option>
                            <option value="station">工位编号（1、2、3…）</option>
                        </select>
                    </label>
                    <label>平滑时间（ms）
                        <input v-model.number="motion.smoothingMs" type="number" min="0" max="1000" step="10" class="input" />
                        <small>0 表示直接应用最新帧，延迟最低。</small>
                    </label>
                </div>

                <div v-if="motion.valueMode === 'range'" class="motion-range-row">
                    <label>输入最小值<input v-model.number="motion.valueMin" type="number" class="input" /></label>
                    <label>输入最大值<input v-model.number="motion.valueMax" type="number" class="input" /></label>
                </div>

                <div v-if="motion.valueMode === 'station'" class="motion-simulation-panel">
                    <div class="motion-simulation-heading">
                        <div>
                            <strong>运动细节模拟</strong>
                            <small>按场景坐标、最大速度和加速度模拟小车从当前点驶向目标工位。</small>
                        </div>
                        <label class="motion-switch">
                            <input v-model="motion.simulationEnabled" type="checkbox" />
                            启用速度 / 加速度模拟
                        </label>
                    </div>
                    <div class="motion-range-row motion-kinematics-row">
                        <label>最大速度（场景单位 / 秒）
                            <input v-model.number="motion.maxSpeed" type="number" min="0.01" step="0.1" class="input" :disabled="!motion.simulationEnabled" />
                        </label>
                        <label>加速度（场景单位 / 秒²）
                            <input v-model.number="motion.acceleration" type="number" min="0.01" step="0.1" class="input" :disabled="!motion.simulationEnabled" />
                        </label>
                    </div>
                    <small class="motion-simulation-note">关闭后保留低延迟保底：收到新工位值就直接到达目标位置；如设置了平滑时间，则只做简单视觉过渡，不代表真实运动过程。</small>
                </div>

                <div v-if="motion.valueMode === 'station'" class="motion-position-section">
                    <div class="motion-section-heading">
                        <div>
                            <div class="motion-section-title">工位编号 / 停靠位置</div>
                            <small>PLC 传入工位编号后，模型会定位到对应坐标；可参考固定设备位置后再微调坐标，留出安全间隙。编号之间的移动轨迹仅为近似动画。</small>
                        </div>
                        <div class="motion-section-actions">
                            <button type="button" class="btn btn-secondary motion-add-station" :disabled="!lineStationDevices.length" @click="syncStationsFromLine">从产线导入 {{ lineStationDevices.length }} 个</button>
                            <button type="button" class="btn btn-secondary motion-add-station" @click="addStation">+ 添加工位</button>
                        </div>
                    </div>
                    <div class="motion-station-list">
                        <div v-for="(station, index) in motion.stations" :key="index" class="motion-station-row">
                            <label>编号<input v-model.number="station.value" type="number" step="1" class="input" /></label>
                            <label>名称<input v-model="station.label" type="text" class="input" placeholder="例如：1号工位" /></label>
                            <label>参考固定设备
                                <select v-model="station.anchorDeviceId" class="input" @change="applyStationAnchor(station)">
                                    <option value="">直接使用坐标</option>
                                    <option v-for="device in props.devices" :key="device.id" :value="String(device.id)">
                                        {{ device.name || device.id }}（{{ device.id }}）
                                    </option>
                                </select>
                            </label>
                            <label>X<input v-model.number="station.position.x" type="number" step="0.1" class="input" /></label>
                            <label>Y<input v-model.number="station.position.y" type="number" step="0.1" class="input" /></label>
                            <label>Z<input v-model.number="station.position.z" type="number" step="0.1" class="input" /></label>
                            <button v-if="motion.stations.length > 1" type="button" class="motion-remove-station" title="删除工位" @click="removeStation(index)">删除</button>
                        </div>
                    </div>
                </div>

                <div v-else class="motion-position-section">
                    <div class="motion-section-title">起始位置 / 终点位置</div>
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
.motion-simulation-panel { margin-top: 18px; padding: 14px 16px; border: 1px solid #d9e7f0; border-radius: 12px; background: linear-gradient(135deg, #f3f9fd, #f8fbfd); }
.motion-simulation-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.motion-simulation-heading > div { display: grid; gap: 4px; }
.motion-simulation-heading strong { color: #1f4f68; font-size: 13px; }
.motion-simulation-heading small, .motion-simulation-note { color: #6a8190; font-size: 12px; line-height: 1.5; }
.motion-kinematics-row { margin-top: 12px; }
.motion-simulation-note { display: block; margin-top: 10px; }
.motion-position-section { margin-top: 22px; padding-top: 18px; border-top: 1px solid #edf0f4; }
.motion-section-title { margin-bottom: 14px; color: #1d2939; font-weight: 700; }
.motion-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.motion-section-heading .motion-section-title { margin-bottom: 5px; }
.motion-section-heading small { color: #778397; font-size: 12px; line-height: 1.5; }
.motion-section-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.motion-add-station { flex: 0 0 auto; min-height: 34px; padding: 0 12px; }
.motion-station-list { display: grid; gap: 10px; }
.motion-station-row { display: grid; grid-template-columns: 76px minmax(140px, 1.15fr) minmax(170px, 1.35fr) repeat(3, minmax(80px, 1fr)) 48px; gap: 10px; align-items: end; padding: 12px; border: 1px solid #e8ecf1; border-radius: 10px; background: #fbfcfd; }
.motion-station-row label { display: flex; flex-direction: column; gap: 7px; color: #344054; font-size: 12px; font-weight: 600; }
.motion-station-row .input { height: 36px; line-height: 36px; }
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
    .motion-station-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .motion-remove-station { justify-self: start; padding: 0 8px; }
}
</style>
