// 点位映射模块:点位 CRUD、分页、语音播报规则(生成/上传/预览)、报警触发点位与报警文本导入、
// PLC 地址自动转换与重复/格式校验、点位保存(联动实时监视与引擎)、跨设备复制与同产线同步。
// 依赖注入:devices(工厂树)、alert/confirm(弹窗)、storedAdminUiState(持久化初值)、
// loadEngineStatus(引擎)、selectedDeviceForMonitor + loadRealtimePointValues(实时监视,保存后联动)。

import { ref, reactive, computed, watch, nextTick, onScopeDispose } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import {
    getPlcAddressHint,
    getPlcAddressPlaceholder,
    normalizePlcOptions,
    normalizePlcProtocol,
    validatePlcAddress
} from '../../../config/plcProtocols.js'
import { parseVoiceConfig, normalizeVoiceRule, createVoiceAnnouncer } from '../../../runtime/VoiceAnnouncer.js'
import { optionalNumber, isBlank } from '../utils/common.js'

export function useDataPoints({
    devices,
    alert,
    confirm,
    storedAdminUiState,
    loadEngineStatus,
    selectedDeviceForMonitor,
    loadRealtimePointValues
}) {
    const selectedDeviceForPoints = ref(storedAdminUiState.selectedDeviceForPoints || 'all')
    const dataPoints = ref([])
    const isPointsDirty = ref(false)
    const pointsLoading = ref(false)
    const pointsSaving = ref(false)
    let loadedPointSelection = selectedDeviceForPoints.value
    let pointsLoaded = false
    const showPointAdvancedFields = ref(!!storedAdminUiState.showPointAdvancedFields)
    const loadedPointDeviceIds = ref([])
    const alarmTextImportRaw = ref('')
    const alarmTextFileInput = ref(null)
    const selectedVoicePointIndex = ref(-1)
    const voiceFileInput = ref(null)
    const voiceUploadTarget = reactive({ pointIndex: -1, ruleIndex: -1 })
    const systemVoices = ref([])
    const systemVoicesLoaded = ref(false)
    const systemVoicesLoading = ref(false)
    const voiceGeneratingRuleId = ref('')
    const voiceUploadingRuleId = ref('')
    const voicePreviewAnnouncer = createVoiceAnnouncer()
    let pointLoadRequestSeq = 0
    let pointsDisposed = false
    onScopeDispose(() => {
        pointsDisposed = true
        pointLoadRequestSeq += 1
        voicePreviewAnnouncer.dispose()
    })
    const voiceTriggerOptions = [
        { value: 'change', label: '数值发生变化' },
        { value: 'rising', label: '由关变开 / 0→1' },
        { value: 'falling', label: '由开变关 / 1→0' },
        { value: 'equals', label: '变为指定数值' },
        { value: 'above', label: '向上跨过阈值' },
        { value: 'below', label: '向下跨过阈值' }
    ]
    const selectedVoicePoint = computed(() => dataPoints.value[selectedVoicePointIndex.value] || null)
    const pointUsageOptions = [
        { value: 'normal', label: '常规监控' },
        { value: 'alarm_trigger', label: '报警触发' }
    ]

    // ============ 点位表格分页状态 ============
    const pointsCurrentPage = ref(1)
    const pointsPageSize = ref(20)

    const totalPointPages = computed(() => {
        if (pointsPageSize.value <= 0) return 1
        return Math.max(1, Math.ceil(dataPoints.value.length / pointsPageSize.value))
    })

    const paginatedDataPoints = computed(() => {
        if (pointsPageSize.value <= 0) {
            return dataPoints.value
        }
        const start = (pointsCurrentPage.value - 1) * pointsPageSize.value
        return dataPoints.value.slice(start, start + pointsPageSize.value)
    })

    const displayedPageNumbers = computed(() => {
        const total = totalPointPages.value
        const current = pointsCurrentPage.value
        if (total <= 7) {
            return Array.from({ length: total }, (_, i) => i + 1)
        }
        const pages = []
        let start = Math.max(1, current - 2)
        let end = Math.min(total, current + 2)
        if (current <= 3) {
            end = 5
        } else if (current >= total - 2) {
            start = total - 4
        }
        for (let i = start; i <= end; i++) {
            pages.push(i)
        }
        return pages
    })

    watch(totalPointPages, (maxPages) => {
        if (pointsCurrentPage.value > maxPages) {
            pointsCurrentPage.value = maxPages
        }
    })

    watch([selectedDeviceForPoints, pointsPageSize], () => {
        pointsCurrentPage.value = 1
    })
    const pointDataTypes = [
        { value: 'BOOL', label: 'BOOL 开关量' },
        { value: 'BYTE', label: 'BYTE 字节' },
        { value: 'WORD', label: 'WORD 无符号整数' },
        { value: 'INT', label: 'INT 有符号整数' },
        { value: 'DWORD', label: 'DWORD 双字' },
        { value: 'DINT', label: 'DINT 有符号双字' },
        { value: 'REAL', label: 'REAL 浮点数' },
        { value: 'LREAL', label: 'LREAL 双精度浮点' },
        { value: 'STRING', label: 'STRING 文本' },
        { value: 'CHAR', label: 'CHAR 字符数组' },
        { value: 'DT', label: 'DT 日期时间' },
        { value: 'DTL', label: 'DTL 新版日期时间' }
    ]
    const alarmRecordRoleMeta = {
        txt_record: { usage: 'alarm_text_record', label: '报警内容', dataType: 'STRING', pointName: 'txt_record' },
        date1_record: { usage: 'alarm_start_record', label: '报警开始时间', dataType: 'DT', pointName: 'date1_record' },
        date2_record: { usage: 'alarm_end_record', label: '报警结束时间', dataType: 'DT', pointName: 'date2_record' },
        num_record: { usage: 'alarm_number_record', label: '报警编号', dataType: 'WORD', pointName: 'num_record' },
        state_record: { usage: 'alarm_state_record', label: '报警状态', dataType: 'WORD', pointName: 'state_record' }
    }
    const isAllPointsMode = computed(() => selectedDeviceForPoints.value === 'all')

    function normalizePointUsage(point = {}) {
        if (point.__usage) return point.__usage
        const role = String(point.alarm_record_role || point.value_role || point.name || '').trim().toLowerCase()
        if (role === 'txt_record' || role === 'alarm_text_record') return 'alarm_text_record'
        if (role === 'date1_record' || role === 'alarm_start_record') return 'alarm_start_record'
        if (role === 'date2_record' || role === 'alarm_end_record') return 'alarm_end_record'
        if (role === 'num_record' || role === 'alarm_number_record') return 'alarm_number_record'
        if (role === 'state_record' || role === 'alarm_state_record') return 'alarm_state_record'
        if (point.point_kind === 'alarm' || point.is_alarm || /^bj\d+$/i.test(String(point.name || point.label || '').trim())) return 'alarm_trigger'
        return 'normal'
    }

    function pointDisplayName(point = {}) {
        return String(point.label || point.name || '').trim()
    }

    function normalizeLoadedPoint(point) {
        const usage = normalizePointUsage(point)
        const displayName = pointDisplayName(point)
        const voiceConfig = parseVoiceConfig(point.voice_config)
        const deviceId = point.device_id || (isAllPointsMode.value ? devices.value[0]?.id || '' : selectedDeviceForPoints.value)
        return {
            ...point,
            __usage: usage,
            __originalName: point.name || '',
            __originalDeviceId: point.__originalDeviceId || deviceId,
            device_id: deviceId,
            name: point.name || '',
            label: displayName,
            plc_tag: point.plc_tag || composePlcAddressFromParts(point),
            data_type: point.data_type || 'WORD',
            category: point.category || '',
            value_role: point.value_role || '',
            quality: point.quality || 'good',
            scale: point.scale ?? 1,
            offset: point.offset ?? 0,
            expression: point.expression || '',
            display_format: point.display_format || '',
            unit: String(point.data_type || '').toUpperCase() === 'BOOL' ? '' : (point.unit || ''),
            sample_interval_ms: point.sample_interval_ms ?? 1000,
            access_type: point.access_type || 'READ',
            db_number: point.db_number ?? null,
            db_byte_offset: point.db_byte_offset ?? null,
            bit_offset: point.bit_offset ?? null,
            point_kind: point.point_kind || (usage === 'normal' ? 'normal' : 'alarm'),
            alarm_record_role: point.alarm_record_role || '',
            alarm_text: point.alarm_text || '',
            alarm_level: point.alarm_level || 'WARNING',
            alarm_condition: point.alarm_condition || '=1',
            voice_config: point.voice_config || '',
            __voiceRules: voiceConfig.rules.map((rule, index) => normalizeVoiceRule(rule, index))
        }
    }

    function pointVoiceRules(point) {
        if (!Array.isArray(point?.__voiceRules)) {
            const config = parseVoiceConfig(point?.voice_config)
            point.__voiceRules = config.rules.map((rule, index) => normalizeVoiceRule(rule, index))
        }
        return point.__voiceRules
    }

    function enabledVoiceRuleCount(point) {
        return pointVoiceRules(point).filter(rule => rule.enabled).length
    }

    function voiceRuleId() {
        return `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    }

    function defaultVoiceText(point) {
        if (normalizePointUsage(point) === 'alarm_trigger' && point.alarm_text) {
            return `{设备}：${point.alarm_text}`
        }
        return `{设备} ${pointDisplayName(point) || '点位'} 发生变化，当前值 {值}{单位}`
    }

    function addVoiceRule(point = selectedVoicePoint.value) {
        if (!point) return
        const trigger = isBoolPoint(point) || normalizePointUsage(point) === 'alarm_trigger' ? 'rising' : 'change'
        pointVoiceRules(point).push(normalizeVoiceRule({
            id: voiceRuleId(),
            enabled: true,
            trigger,
            threshold: null,
            mode: 'auto',
            text: defaultVoiceText(point),
            audio_url: '',
            cooldown_ms: 10000,
            volume: 1,
            rate: 1,
            voice_name: '',
            announce_on_start: false
        }))
        markPointsDirty()
    }

    function removeVoiceRule(point, ruleIndex) {
        pointVoiceRules(point).splice(ruleIndex, 1)
        markPointsDirty()
    }

    async function loadSystemVoices() {
        if (systemVoicesLoaded.value || systemVoicesLoading.value) return
        systemVoicesLoading.value = true
        try {
            const result = await adminApi.getSystemVoices()
            if (!result?.error && Array.isArray(result?.voices)) systemVoices.value = result.voices
        } finally {
            systemVoicesLoaded.value = true
            systemVoicesLoading.value = false
        }
    }

    function openVoiceConfig(target) {
        const idx = typeof target === 'number' ? target : dataPoints.value.indexOf(target)
        selectedVoicePointIndex.value = idx
        loadSystemVoices()
    }

    function closeVoiceConfig() {
        selectedVoicePointIndex.value = -1
    }

    function updateVoiceCooldown(rule, seconds) {
        const value = Number(seconds)
        rule.cooldown_ms = Number.isFinite(value) ? Math.max(0, Math.min(3600, value)) * 1000 : 10000
        markPointsDirty()
    }

    function voiceRuleNeedsThreshold(rule) {
        return ['equals', 'above', 'below'].includes(rule?.trigger)
    }

    function voiceRuleDeviceName(point) {
        return devices.value.find(device => device.id === point?.device_id)?.name || point?.device_id || '示例设备'
    }

    function fillVoiceTemplate(text, point, sampleValue) {
        const replacements = {
            '{设备}': voiceRuleDeviceName(point),
            '{点位}': pointDisplayName(point) || '示例点位',
            '{值}': sampleValue,
            '{单位}': point?.unit || '',
            '{device}': voiceRuleDeviceName(point),
            '{point}': pointDisplayName(point) || '示例点位',
            '{value}': sampleValue,
            '{unit}': point?.unit || ''
        }
        return Object.entries(replacements).reduce((result, [token, value]) => result.split(token).join(String(value ?? '')), String(text || ''))
    }

    async function previewVoiceRule(rule, point = selectedVoicePoint.value) {
        if (!point) return
        try {
            const sampleValue = rule.threshold ?? (rule.trigger === 'falling' ? 0 : 1)
            await voicePreviewAnnouncer.preview(rule, {
                deviceName: voiceRuleDeviceName(point),
                label: pointDisplayName(point),
                value: sampleValue,
                unit: point.unit || ''
            })
        } catch (error) {
            await alert(`测试播报失败：${error.message}`, { title: '语音测试失败', type: 'danger' })
        }
    }

    async function generateVoiceFile(rule, point = selectedVoicePoint.value) {
        if (!point) return
        const sampleValue = rule.threshold ?? (rule.trigger === 'falling' ? 0 : 1)
        const text = fillVoiceTemplate(rule.text || defaultVoiceText(point), point, sampleValue).trim()
        if (!text) return alert('请先填写播报文字', { title: '无法生成语音', type: 'warning' })
        voiceGeneratingRuleId.value = rule.id
        try {
            const result = await adminApi.generateVoiceFile({
                text,
                voice_name: rule.voice_name || '',
                rate: rule.rate,
                volume: rule.volume
            })
            if (result?.error) return alert(result.error, { title: '语音生成失败', type: 'danger' })
            rule.audio_url = result.url
            rule.mode = 'file'
            markPointsDirty()
            await alert('WAV 语音文件已经生成并关联到本条规则。请继续点击“保存点位配置”。', { title: '语音已生成', type: 'success' })
        } finally {
            voiceGeneratingRuleId.value = ''
        }
    }

    function selectVoiceFile(pointIndex, ruleIndex) {
        voiceUploadTarget.pointIndex = pointIndex
        voiceUploadTarget.ruleIndex = ruleIndex
        voiceFileInput.value?.click()
    }

    async function handleVoiceFileChange(event) {
        const file = event?.target?.files?.[0]
        event.target.value = ''
        if (!file) return
        const point = dataPoints.value[voiceUploadTarget.pointIndex]
        if (!point) return
        const rule = pointVoiceRules(point)[voiceUploadTarget.ruleIndex]
        if (!rule) return
        voiceUploadingRuleId.value = rule.id
        try {
            const result = await adminApi.uploadVoiceFile(file)
            if (result?.error) return alert(result.error, { title: '语音上传失败', type: 'danger' })
            rule.audio_url = result.url
            rule.mode = 'file'
            markPointsDirty()
            await alert('语音文件已经上传并关联到本条规则。请继续点击“保存点位配置”。', { title: '上传成功', type: 'success' })
        } finally {
            voiceUploadingRuleId.value = ''
        }
    }

    async function loadDataPoints() {
        const requestSeq = ++pointLoadRequestSeq
        const deviceId = selectedDeviceForPoints.value
        if (!selectedDeviceForPoints.value) { dataPoints.value = []; return }
        pointsLoading.value = true
        try {
            if (isPointsDirty.value && deviceId !== loadedPointSelection) {
                const discard = await confirm('当前设备有未保存的点位修改，切换设备将丢弃这些修改，确定继续？')
                if (pointsDisposed || requestSeq !== pointLoadRequestSeq) return
                if (!discard) {
                    selectedDeviceForPoints.value = loadedPointSelection
                    return
                }
            }
            const points = await adminApi.getDataPoints(deviceId)
            if (pointsDisposed || requestSeq !== pointLoadRequestSeq || deviceId !== selectedDeviceForPoints.value) return
            if (!Array.isArray(points)) throw new Error(points?.error || '后端返回了无效的点位列表')
            loadedPointDeviceIds.value = [...new Set(points.map(point => point.device_id).filter(Boolean))]
            dataPoints.value = points.map(normalizeLoadedPoint)
            isPointsDirty.value = false
            loadedPointSelection = deviceId
            pointsLoaded = true
        } catch (error) {
            if (!pointsDisposed && requestSeq === pointLoadRequestSeq && deviceId === selectedDeviceForPoints.value) {
                selectedDeviceForPoints.value = loadedPointSelection
                await alert(error.message || '点位读取失败', { title: '点位读取失败', type: 'danger' })
            }
        } finally {
            if (requestSeq === pointLoadRequestSeq) pointsLoading.value = false
        }
    }

    function addDataPoint(usage = 'normal') {
        const deviceId = isAllPointsMode.value ? devices.value[0]?.id || '' : selectedDeviceForPoints.value
        const point = normalizeLoadedPoint({
            device_id: deviceId,
            name: '',
            label: '',
            plc_tag: '',
            data_type: 'WORD',
            category: '',
            value_role: '',
            quality: 'good',
            scale: 1,
            offset: 0,
            expression: '',
            display_format: '',
            unit: '',
            sample_interval_ms: 1000,
            access_type: 'READ',
            db_number: null,
            db_byte_offset: null,
            bit_offset: null
        })
        setPointUsage(point, usage, { markDirty: false })
        dataPoints.value.push(point)
        isPointsDirty.value = true

        nextTick(() => {
            if (pointsPageSize.value > 0) {
                pointsCurrentPage.value = totalPointPages.value
            }
            const tableContainer = document.querySelector('.table-scroll')
            if (tableContainer) {
                tableContainer.scrollTo({ top: tableContainer.scrollHeight, behavior: 'smooth' })
            }
        })
    }

    function addAlarmTriggerPoint() {
        const nextIndex = getNextAlarmPointIndex()
        const deviceId = isAllPointsMode.value ? devices.value[0]?.id || '' : selectedDeviceForPoints.value
        const point = normalizeLoadedPoint({
            device_id: deviceId,
            name: `bj${nextIndex}`,
            label: `bj${nextIndex}`,
            plc_tag: '',
            data_type: 'BOOL',
            sample_interval_ms: 500,
            access_type: 'READ',
            point_kind: 'alarm',
            alarm_condition: '=1',
            alarm_level: 'WARNING'
        })
        setPointUsage(point, 'alarm_trigger', { markDirty: false })
        dataPoints.value.push(point)
        isPointsDirty.value = true
    }

    function removeDataPoint(target) {
        const idx = typeof target === 'number' ? target : dataPoints.value.indexOf(target)
        if (idx < 0) return
        if (selectedVoicePointIndex.value === idx) closeVoiceConfig()
        else if (selectedVoicePointIndex.value > idx) selectedVoicePointIndex.value -= 1
        dataPoints.value.splice(idx, 1)
        isPointsDirty.value = true
    }

    function markPointsDirty() {
        isPointsDirty.value = true
    }

    function isBoolPoint(point) {
        return String(point?.data_type || '').toUpperCase() === 'BOOL'
    }

    function pointDevice(point) {
        const deviceId = point?.device_id || selectedDeviceForPoints.value
        return devices.value.find(device => device.id === deviceId) || null
    }

    function pointProtocol(point) {
        return normalizePlcProtocol(pointDevice(point)?.plc_protocol || 'S7')
    }

    function pointProtocolOptions(point) {
        const device = pointDevice(point)
        return normalizePlcOptions(pointProtocol(point), device?.plc_options)
    }

    function getPointAddressPlaceholder(point) {
        return getPlcAddressPlaceholder(pointProtocol(point))
    }

    function getPointAddressTitle(point) {
        return `${getPlcAddressHint(pointProtocol(point))} ${validatePlcAddress(pointProtocol(point), point?.plc_tag, point?.data_type, pointProtocolOptions(point)) || ''}`.trim()
    }

    function autoConvertPlcTagForDataType(point) {
        if (!point || !point.plc_tag || typeof point.plc_tag !== 'string') return
        if (pointProtocol(point) !== 'S7') return
        const tag = point.plc_tag.trim()
        if (!tag) return

        const dataType = String(point.data_type || 'WORD').toUpperCase()

        const dbMatch = tag.match(/^(DB\d+)\.(DBX|DBB|DBW|DBD)(\d+)(?:\.(\d+))?$/i)
        if (!dbMatch) return

        const dbPrefix = dbMatch[1].toUpperCase()
        const byteOffset = dbMatch[3]
        const bitOffset = dbMatch[4] !== undefined ? dbMatch[4] : '0'

        let targetArea = ''
        let isBit = false

        if (dataType === 'BOOL') {
            targetArea = 'DBX'
            isBit = true
        } else if (['BYTE', 'CHAR'].includes(dataType)) {
            targetArea = 'DBB'
        } else if (['WORD', 'INT'].includes(dataType)) {
            targetArea = 'DBW'
        } else if (['DWORD', 'DINT', 'REAL', 'LREAL'].includes(dataType)) {
            targetArea = 'DBD'
        } else {
            return
        }

        let newTag = `${dbPrefix}.${targetArea}${byteOffset}`
        if (isBit) {
            newTag += `.${bitOffset}`
        }

        if (newTag !== point.plc_tag) {
            point.plc_tag = newTag
        }
    }

    function getPlcDuplicateWarning(point) {
        if (!point || !point.plc_tag || !String(point.plc_tag).trim()) return ''
        const tag = String(point.plc_tag).trim().toUpperCase()

        const currentDeviceId = point.device_id || selectedDeviceForPoints.value
        if (currentDeviceId) {
            const duplicatePoint = dataPoints.value.find(other => {
                if (other === point) return false
                const otherDeviceId = other.device_id || selectedDeviceForPoints.value
                if (otherDeviceId !== currentDeviceId) return false
                return String(other.plc_tag || '').trim().toUpperCase() === tag
            })
            if (duplicatePoint) {
                const dupName = duplicatePoint.label || duplicatePoint.name || '其他点位'
                return `地址与点位「${dupName}」重复（同一设备存在相同 PLC 地址）`
            }
        }
        return ''
    }

    function getPlcAddressWarning(point) {
        if (!point || !point.plc_tag || !String(point.plc_tag).trim()) return ''
        const protocol = pointProtocol(point)
        if (protocol !== 'S7') {
            return validatePlcAddress(protocol, point.plc_tag, point.data_type, pointProtocolOptions(point))
        }
        const tag = String(point.plc_tag).trim().toUpperCase()
        const dataType = String(point.data_type || 'WORD').toUpperCase()

        const dbMatch = tag.match(/^DB(\d+)\.(DBX|DBB|DBW|DBD)(\d+)(?:\.(\d+))?$/i)
        if (dbMatch) {
            const area = dbMatch[2].toUpperCase()
            const bit = dbMatch[4]

            if (dataType === 'BOOL') {
                if (area !== 'DBX' || bit === undefined) {
                    return 'BOOL 类型推荐使用 DBX 位地址，如 DB1.DBX0.0'
                }
            } else if (['BYTE', 'CHAR'].includes(dataType)) {
                if (area !== 'DBB') {
                    return `${dataType} 类型推荐使用 DBB 字节地址，如 DB1.DBB0`
                }
            } else if (['WORD', 'INT'].includes(dataType)) {
                if (area !== 'DBW') {
                    return `${dataType} 类型推荐使用 DBW 字地址，如 DB1.DBW0`
                }
            } else if (['DWORD', 'DINT', 'REAL', 'LREAL'].includes(dataType)) {
                if (area !== 'DBD') {
                    return `${dataType} 类型推荐使用 DBD 双字地址，如 DB1.DBD0`
                }
            }
            return ''
        }

        const generalMatch = tag.match(/^(?:DB\d+\.(?:DBX|DBB|DBW|DBD)\d+(?:\.\d+)?|[IQM](?:X|B|W|D)?\d+(?:\.\d+)?)$/i)
        if (!generalMatch) {
            return '地址格式可能有误，请检查（如 DB1.DBW0 或 DB1.DBX0.0）'
        }

        return ''
    }

    function handlePointDataTypeChange(point) {
        if (isBoolPoint(point)) point.unit = ''
        autoConvertPlcTagForDataType(point)
        markPointsDirty()
    }

    function composePlcAddressFromParts(point = {}) {
        if (isBlank(point.db_number) || isBlank(point.db_byte_offset)) return ''
        const dbNumber = Number(point.db_number)
        const byteOffset = Number(point.db_byte_offset)
        if (!Number.isInteger(dbNumber) || dbNumber < 0 || !Number.isInteger(byteOffset) || byteOffset < 0) return ''

        const type = String(point.data_type || 'WORD').trim().toUpperCase()
        if (type === 'BOOL') {
            const bit = Number.isInteger(Number(point.bit_offset)) ? Math.max(0, Math.min(7, Number(point.bit_offset))) : 0
            return `DB${dbNumber}.DBX${byteOffset}.${bit}`
        }
        if (type === 'BYTE' || type === 'CHAR') return `DB${dbNumber}.DBB${byteOffset}`
        if (type === 'REAL' || type === 'DWORD' || type === 'DINT' || type === 'DT' || type === 'DTL') return `DB${dbNumber}.DBD${byteOffset}`
        return `DB${dbNumber}.DBW${byteOffset}`
    }

    function simpleHash(text) {
        let hash = 0
        const value = String(text || '')
        for (let i = 0; i < value.length; i += 1) {
            hash = ((hash << 5) - hash) + value.charCodeAt(i)
            hash |= 0
        }
        return Math.abs(hash).toString(36)
    }

    function toInternalPointName(label, fallbackIndex = 0) {
        const raw = String(label || '').trim()
        const ascii = raw
            .replace(/[一-龥]+/g, '')
            .replace(/[^a-zA-Z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase()
        if (ascii) return ascii.slice(0, 96)
        return `point_${simpleHash(raw || fallbackIndex)}`
    }

    function inferPointCategory(point, usage) {
        if (usage !== 'normal') return 'status'
        const name = pointDisplayName(point).toLowerCase()
        const type = String(point.data_type || '').toUpperCase()
        if (type === 'BOOL' || name.includes('报警') || name.includes('故障') || name.includes('状态') || name.includes('运行')) return 'status'
        if (name.includes('气') || name.includes('阀') || name.includes('流量')) return 'gas'
        if (name.includes('门')) return 'doors'
        if (name.includes('风机') || name.includes('风扇') || name.includes('搅拌') || name.includes('泵') || name.includes('电机')) return 'motors'
        if (name.includes('链') || name.includes('推') || name.includes('拉') || name.includes('机构')) return 'mechanisms'
        return 'analog'
    }

    function roleFromUsage(usage, internalName) {
        if (usage === 'alarm_text_record') return 'txt_record'
        if (usage === 'alarm_start_record') return 'date1_record'
        if (usage === 'alarm_end_record') return 'date2_record'
        if (usage === 'alarm_number_record') return 'num_record'
        if (usage === 'alarm_state_record') return 'state_record'
        return internalName
    }

    function setPointUsage(point, usage, options = {}) {
        const nextUsage = usage || 'normal'
        const currentType = String(point.data_type || '').toUpperCase()
        point.__usage = nextUsage
        point.point_kind = nextUsage === 'normal' ? 'normal' : 'alarm'
        point.alarm_record_role = ''
        if (nextUsage === 'alarm_trigger') {
            if (!currentType || currentType === 'WORD') point.data_type = 'BOOL'
            point.unit = ''
            point.sample_interval_ms = point.sample_interval_ms || 500
            point.alarm_condition = point.alarm_condition || '=1'
            point.alarm_level = point.alarm_level || 'WARNING'
        } else {
            const recordMeta = Object.entries(alarmRecordRoleMeta).find(([, meta]) => meta.usage === nextUsage)?.[1]
            if (recordMeta) {
                point.alarm_record_role = recordMeta.pointName
                if (!point.name) point.name = recordMeta.pointName
                if (!point.label) point.label = recordMeta.label
                if (!currentType || currentType === 'WORD') point.data_type = recordMeta.dataType
                point.sample_interval_ms = point.sample_interval_ms || 1000
            }
        }
        if (options.markDirty !== false) markPointsDirty()
    }

    function formatPointUsage(point) {
        const usage = typeof point === 'string' ? point : normalizePointUsage(point)
        return pointUsageOptions.find(item => item.value === usage)?.label || '常规监控'
    }

    function isTextPointType(point) {
        return ['STRING', 'CHAR'].includes(String(point.data_type || '').toUpperCase())
    }

    function getAlarmPointNumber(point, fallbackIndex = 0) {
        const text = String(point.name || point.label || '').trim()
        const match = text.match(/^bj(\d+)$/i)
        return match ? Number(match[1]) : fallbackIndex + 1
    }

    const currentAlarmTriggerPoints = computed(() => dataPoints.value
        .filter(point => normalizePointUsage(point) === 'alarm_trigger')
        .map((point, index) => ({ point, number: getAlarmPointNumber(point, index) }))
        .sort((a, b) => a.number - b.number))

    const alarmRecordPointStatus = computed(() => Object.entries(alarmRecordRoleMeta).map(([role, meta]) => ({
        role,
        label: meta.label,
        configured: dataPoints.value.some(point => normalizePointUsage(point) === meta.usage),
        point: dataPoints.value.find(point => normalizePointUsage(point) === meta.usage)
    })))

    function getNextAlarmPointIndex() {
        const used = currentAlarmTriggerPoints.value.map(item => item.number).filter(Number.isFinite)
        return used.length ? Math.max(...used) + 1 : 1
    }

    function parseAlarmText(text) {
        const raw = String(text || '')
        const lines = raw.split(/\r?\n/)
        const map = new Map()
        const hasArrowFormat = /=>/.test(raw)
        let sequence = 1

        lines.forEach((line) => {
            const source = String(line || '').trim()
            if (!source) return
            if (hasArrowFormat) {
                const match = source.match(/(\d+)\s*=>\s*["'“”‘’（(]?(.*?)["'“”‘’）)]?\s*[,，;；]?$/)
                if (!match) return
                const number = Number(match[1])
                const message = String(match[2] || '').trim()
                if (Number.isFinite(number) && message) map.set(number, message)
                return
            }

            const message = source
                .replace(/^\d+[\s.、:：-]+/, '')
                .replace(/^["'“”‘’（(,\s]+|["'“”‘’）),\s;，；]+$/g, '')
                .trim()
            if (message && !/^[\]\};,.\s]+$/.test(message)) {
                map.set(sequence, message)
                sequence += 1
            }
        })

        return map
    }

    const parsedAlarmTextEntries = computed(() => Array.from(parseAlarmText(alarmTextImportRaw.value).entries())
        .map(([number, text]) => ({ number, text }))
        .sort((a, b) => a.number - b.number))

    const alarmTextImportSummary = computed(() => {
        const alarmCount = currentAlarmTriggerPoints.value.length
        const textCount = parsedAlarmTextEntries.value.length
        if (!alarmTextImportRaw.value.trim()) return `当前设备已配置 ${alarmCount} 个报警触发点位`
        if (alarmCount === textCount) return `数量匹配：${alarmCount} 个报警点位，${textCount} 条报警说明`
        return `数量不一致：当前 ${alarmCount} 个报警点位，导入文本 ${textCount} 条，请核对`
    })

    function fillAlarmTextTemplate() {
        if (isAllPointsMode.value) {
            return alert('请先筛选到某一台设备，再生成该设备的报警文本模板。', { title: '需要选择设备', type: 'warning' })
        }
        alarmTextImportRaw.value = currentAlarmTriggerPoints.value
            .map(({ point, number }) => `    ${number} => "${point.alarm_text || point.label || ''}",`)
            .join('\n')
    }

    function triggerAlarmTextFileSelect() {
        alarmTextFileInput.value?.click()
    }

    async function handleAlarmTextFileChange(event) {
        const file = event?.target?.files?.[0]
        if (!file) return
        alarmTextImportRaw.value = await file.text()
        event.target.value = ''
    }

    async function applyAlarmTextImport() {
        if (isAllPointsMode.value) {
            return alert('请先筛选到某一台设备，再导入该设备的报警文本。', { title: '需要选择设备', type: 'warning' })
        }
        const textMap = parseAlarmText(alarmTextImportRaw.value)
        if (textMap.size === 0) {
            return alert('没有解析到报警文本。可以粘贴 1 => "报警内容" 这种格式，也可以一行一条按顺序粘贴。', { title: '报警文本为空', type: 'warning' })
        }
        const triggers = currentAlarmTriggerPoints.value
        if (triggers.length === 0) {
            return alert('当前设备还没有报警触发点位，请先添加 bj1、bj2 这类报警点位并填写 PLC 地址。', { title: '没有报警点位', type: 'warning' })
        }

        let updated = 0
        triggers.forEach(({ point, number }) => {
            const text = textMap.get(number)
            if (!text) return
            point.alarm_text = text
            updated += 1
        })
        markPointsDirty()
        await alert(`已匹配 ${updated} 条报警说明。请点击“保存点位配置”写入数据库。`, { title: '报警文本已导入', type: 'success' })
    }

    function ensureAlarmRecordPoints() {
        if (isAllPointsMode.value) {
            return alert('请先筛选到某一台设备，再补齐报警记录字段。', { title: '需要选择设备', type: 'warning' })
        }
        let added = 0
        Object.entries(alarmRecordRoleMeta).forEach(([role, meta]) => {
            if (role === 'num_record' || role === 'state_record') return
            if (dataPoints.value.some(point => normalizePointUsage(point) === meta.usage)) return
            const point = normalizeLoadedPoint({
                device_id: selectedDeviceForPoints.value,
                name: meta.pointName,
                label: meta.label,
                plc_tag: '',
                data_type: meta.dataType,
                sample_interval_ms: 1000,
                access_type: 'READ',
                point_kind: 'alarm',
                alarm_record_role: role
            })
            setPointUsage(point, meta.usage, { markDirty: false })
            dataPoints.value.push(point)
            added += 1
        })
        if (added > 0) markPointsDirty()
        alert(added > 0 ? `已添加 ${added} 个报警记录字段，请补 PLC 地址后保存。` : '报警内容、开始时间、结束时间字段已经存在。', {
            title: added > 0 ? '已补齐字段' : '无需重复添加',
            type: added > 0 ? 'success' : 'info'
        })
    }

    function validatePointRows(points) {
        const errors = []
        const allowedTypes = pointDataTypes.map(item => item.value)
        const allowedAccessTypes = ['READ', 'READ_WRITE', 'WRITE']

        points.forEach((point, index) => {
            const row = index + 1
            if (isAllPointsMode.value && isBlank(point.device_id)) errors.push(`第 ${row} 行：必须选择设备`)
            if (isBlank(pointDisplayName(point))) errors.push(`第 ${row} 行：点位名称不能为空`)

            const hasPlcTag = !isBlank(point.plc_tag)
            if (!hasPlcTag) {
                errors.push(`第 ${row} 行：必须填写 PLC 地址`)
            }
            if (hasPlcTag) {
                const addressError = validatePlcAddress(pointProtocol(point), point.plc_tag, point.data_type, pointProtocolOptions(point))
                if (addressError) errors.push(`第 ${row} 行：${addressError}`)
            } else if (pointProtocol(point) !== 'S7') {
                errors.push(`第 ${row} 行：${pointProtocol(point)} 必须直接填写协议地址`)
            }
            if (isTextPointType(point) && !hasPlcTag) {
                errors.push(`第 ${row} 行：文本点位请直接填写完整 PLC 地址，例如 DB10,S20.30`)
            }

            if (!allowedTypes.includes(String(point.data_type || '').toUpperCase())) {
                errors.push(`第 ${row} 行：数据类型不正确`)
            }
            const interval = Number(point.sample_interval_ms)
            if (!Number.isFinite(interval) || interval < 100 || interval > 60000) {
                errors.push(`第 ${row} 行：采集周期必须在 100-60000ms 之间`)
            }
            if (!allowedAccessTypes.includes(String(point.access_type || '').toUpperCase())) {
                errors.push(`第 ${row} 行：读写类型不正确`)
            }
            const rules = pointVoiceRules(point)
            if (rules.length > 12) errors.push(`第 ${row} 行：单个点位最多配置 12 条语音规则`)
            rules.forEach((rule, ruleIndex) => {
                if (!rule.enabled) return
                if (!String(rule.text || '').trim() && !String(rule.audio_url || '').trim()) {
                    errors.push(`第 ${row} 行语音 ${ruleIndex + 1}：播报文字和语音文件至少填写一个`)
                }
                if (voiceRuleNeedsThreshold(rule) && !Number.isFinite(Number(rule.threshold))) {
                    errors.push(`第 ${row} 行语音 ${ruleIndex + 1}：当前触发方式必须填写阈值`)
                }
                if (rule.mode === 'file' && !String(rule.audio_url || '').trim()) {
                    errors.push(`第 ${row} 行语音 ${ruleIndex + 1}：文件播放模式尚未生成或上传语音文件`)
                }
            })
        })

        return errors
    }

    function buildDataPointPayload(point, { includeId = false } = {}) {
        const { id, device_id, alarm_high, alarm_low, __usage, __originalName, __originalDeviceId, __voiceRules, ...payload } = point
        const usage = normalizePointUsage({ ...point, __usage })
        const displayName = pointDisplayName(point)
        const internalName = String(payload.name || '').trim() || toInternalPointName(displayName, id || displayName)
        const fieldName = roleFromUsage(usage, internalName)
        const plcTag = String(payload.plc_tag || '').trim()
        const dataType = String(payload.data_type || 'WORD').toUpperCase()
        const result = {
            ...payload,
            name: internalName,
            label: displayName,
            plc_tag: plcTag,
            data_type: dataType,
            access_type: String(payload.access_type || 'READ').toUpperCase(),
            category: inferPointCategory(point, usage),
            value_role: fieldName,
            quality: 'good',
            scale: payload.scale ?? 1,
            offset: payload.offset ?? 0,
            expression: payload.expression || '',
            display_format: payload.display_format || '',
            unit: dataType === 'BOOL' ? '' : (payload.unit || ''),
            db_number: plcTag ? null : optionalNumber(payload.db_number),
            db_byte_offset: plcTag ? null : optionalNumber(payload.db_byte_offset),
            bit_offset: plcTag ? null : optionalNumber(payload.bit_offset),
            point_kind: usage === 'normal' ? 'normal' : 'alarm',
            alarm_record_role: usage === 'alarm_trigger' || usage === 'normal' ? '' : fieldName,
            alarm_text: String(payload.alarm_text || '').trim(),
            alarm_level: payload.alarm_level || 'WARNING',
            alarm_condition: payload.alarm_condition || '=1',
            alarm_high: optionalNumber(alarm_high),
            alarm_low: optionalNumber(alarm_low),
            voice_config: JSON.stringify({
                enabled: pointVoiceRules(point).some(rule => rule.enabled),
                rules: pointVoiceRules(point).map((rule, index) => normalizeVoiceRule(rule, index))
            })
        }
        const stayedOnOriginalDevice = String(device_id || '') === String(__originalDeviceId || device_id || '')
        if (includeId && id !== undefined && id !== null && id !== '' && stayedOnOriginalDevice) result.id = id
        return result
    }

    function mergePointSaveSummary(summary, result, fallbackTotal = 0) {
        summary.inserted += Number(result?.inserted || 0)
        summary.updated += Number(result?.updated || 0)
        summary.deleted += Number(result?.deleted || 0)
        summary.unchanged += Number(result?.unchanged || 0)
        summary.total += Number(result?.total ?? fallbackTotal)
    }

    function pointSaveMessage(summary) {
        const changed = summary.inserted + summary.updated + summary.deleted
        if (changed === 0) return '没有检测到实际变化，数据库未重复写入。'
        const parts = []
        if (summary.updated > 0) parts.push(`修改 ${summary.updated} 条`)
        if (summary.inserted > 0) parts.push(`新增 ${summary.inserted} 条`)
        if (summary.deleted > 0) parts.push(`删除 ${summary.deleted} 条`)
        const skipped = summary.unchanged > 0 ? `其余 ${summary.unchanged} 条未重复写入。` : ''
        return `保存成功：${parts.join('，')}。${skipped}`
    }

    async function saveAllPoints() {
        if (pointsSaving.value) return
        if (pointsLoading.value || !pointsLoaded) return alert('请先成功读取当前设备的点位配置，再执行保存。', { title: '点位尚未就绪', type: 'warning' })
        if (!selectedDeviceForPoints.value) return alert('请先选择设备')
        const errors = validatePointRows(dataPoints.value)
        if (errors.length) {
            return alert(errors.slice(0, 8).join('\n'), { title: '点位配置未保存', type: 'warning' })
        }

        const selection = selectedDeviceForPoints.value
        const draftSnapshot = JSON.stringify(dataPoints.value)
        const groups = isAllPointsMode.value
            ? [...new Set([...loadedPointDeviceIds.value, ...dataPoints.value.map(point => point.device_id).filter(Boolean)])].map(deviceId => ({
                deviceId,
                rows: dataPoints.value.filter(point => point.device_id === deviceId).map(point => buildDataPointPayload(point, { includeId: true }))
            }))
            : [{ deviceId: selection, rows: dataPoints.value.map(point => buildDataPointPayload(point, { includeId: true })) }]
        const summary = { inserted: 0, updated: 0, deleted: 0, unchanged: 0, total: 0 }
        pointsSaving.value = true
        try {
            for (const { deviceId, rows } of groups) {
                const result = await adminApi.syncDataPoints(deviceId, rows)
                if (result?.error || !result?.success) throw new Error(result?.error || '后端没有返回成功状态')
                mergePointSaveSummary(summary, result, rows.length)
            }
            if (pointsDisposed) return
            const changed = summary.inserted + summary.updated + summary.deleted
            await alert(pointSaveMessage(summary), {
                title: changed > 0 ? '点位配置已保存' : '点位配置无变化',
                type: changed > 0 ? 'success' : 'info'
            })
            // Edits made while the request or success dialog was open are a new
            // draft, not part of the saved payload. Never discard that draft.
            if (pointsDisposed || selection !== selectedDeviceForPoints.value || draftSnapshot !== JSON.stringify(dataPoints.value)) return
            isPointsDirty.value = false
            await loadDataPoints()
            if (pointsDisposed) return
            selectedDeviceForMonitor.value = selection
            await loadRealtimePointValues()
            if (changed > 0) setTimeout(() => { if (!pointsDisposed) loadEngineStatus() }, 800)
        } catch (error) {
            if (!pointsDisposed) await alert(`点位保存失败：${error.message || error}`, { title: '保存失败', type: 'danger' })
        } finally {
            pointsSaving.value = false
        }
    }

    // 扩展功能：从其他设备复制
    async function copyPointsFrom(sourceDeviceId) {
        if (pointsSaving.value || pointsLoading.value) return
        if (isAllPointsMode.value) return alert('请先筛选到某一台设备，再从其他设备复制点位配置。')
        if (!sourceDeviceId || sourceDeviceId === selectedDeviceForPoints.value) return
        if (isPointsDirty.value && !(await confirm('当前有未保存的修改，复制将覆盖这些修改，确定继续？'))) return

        const targetDeviceId = selectedDeviceForPoints.value
        const requestSeq = ++pointLoadRequestSeq
        pointsLoading.value = true
        try {
            const sourcePoints = await adminApi.getDataPoints(sourceDeviceId)
            if (pointsDisposed || requestSeq !== pointLoadRequestSeq || targetDeviceId !== selectedDeviceForPoints.value) return
            if (!Array.isArray(sourcePoints)) return alert(sourcePoints?.error || '读取源设备点位失败', { title: '点位复制失败', type: 'danger' })
            if (sourcePoints.length === 0) {
                return alert('源设备没有点位配置')
            }

            // 复制时去掉 id 相关的字段（如果后端有的话），保持干净的映射
            dataPoints.value = sourcePoints.map(p => normalizeLoadedPoint({ ...p, id: undefined, device_id: targetDeviceId, __originalDeviceId: targetDeviceId }))
            isPointsDirty.value = true
            alert(`已成功复制 ${sourcePoints.length} 个点位配置，请检查后点击保存。`)
        } catch (error) {
            if (!pointsDisposed && requestSeq === pointLoadRequestSeq) await alert(error.message || '读取源设备点位失败', { title: '点位复制失败', type: 'danger' })
        } finally {
            if (requestSeq === pointLoadRequestSeq) pointsLoading.value = false
        }
    }

    // 扩展功能：同步到同产线其他设备
    async function syncToLine() {
        if (isAllPointsMode.value) return alert('请先筛选到某一台设备，再同步到同产线设备。')
        if (isPointsDirty.value) {
            return alert('请先保存当前设备的点位配置，再执行同步操作！')
        }
        const currentDevice = devices.value.find(d => d.id === selectedDeviceForPoints.value)
        if (!currentDevice) return

        const targetDevices = devices.value.filter(d => d.line_id === currentDevice.line_id && d.id !== currentDevice.id)
        if (targetDevices.length === 0) return alert('该产线下没有其他设备。')

        if (!(await confirm(`确定将当前点位配置同步到同产线的 ${targetDevices.length} 台设备吗？\n（目标设备的原有配置将被覆盖）`))) return

        const errors = validatePointRows(dataPoints.value)
        if (errors.length) return alert(errors.slice(0, 8).join('\n'), { title: '点位配置未保存', type: 'warning' })
        const validPoints = dataPoints.value.map(buildDataPointPayload)

        try {
            for (const d of targetDevices) {
                const result = await adminApi.saveDataPointsBatch(d.id, validPoints)
                if (result?.error || !result?.success) {
                    throw new Error(`${d.name || d.id}: ${result?.error || '后端没有返回成功状态'}`)
                }
            }
            alert('批量同步成功！现在同产线的所有设备都使用了相同的点位结构。', { title: '同步成功', type: 'success' })
        } catch (e) {
            alert(`同步过程中发生错误：${e.message || e}`, { title: '同步失败', type: 'danger' })
        }
    }

    return {
        selectedDeviceForPoints,
        dataPoints,
        isPointsDirty,
        pointsLoading,
        pointsSaving,
        showPointAdvancedFields,
        loadedPointDeviceIds,
        alarmTextImportRaw,
        alarmTextFileInput,
        selectedVoicePointIndex,
        voiceFileInput,
        voiceUploadTarget,
        systemVoices,
        systemVoicesLoaded,
        systemVoicesLoading,
        voiceGeneratingRuleId,
        voiceUploadingRuleId,
        voiceTriggerOptions,
        selectedVoicePoint,
        pointUsageOptions,
        pointsCurrentPage,
        pointsPageSize,
        totalPointPages,
        paginatedDataPoints,
        displayedPageNumbers,
        pointDataTypes,
        alarmRecordRoleMeta,
        isAllPointsMode,
        normalizePointUsage,
        pointDisplayName,
        normalizeLoadedPoint,
        pointVoiceRules,
        enabledVoiceRuleCount,
        voiceRuleId,
        defaultVoiceText,
        addVoiceRule,
        removeVoiceRule,
        loadSystemVoices,
        openVoiceConfig,
        closeVoiceConfig,
        updateVoiceCooldown,
        voiceRuleNeedsThreshold,
        voiceRuleDeviceName,
        fillVoiceTemplate,
        previewVoiceRule,
        generateVoiceFile,
        selectVoiceFile,
        handleVoiceFileChange,
        loadDataPoints,
        addDataPoint,
        addAlarmTriggerPoint,
        removeDataPoint,
        markPointsDirty,
        isBoolPoint,
        getPointAddressPlaceholder,
        getPointAddressTitle,
        autoConvertPlcTagForDataType,
        getPlcDuplicateWarning,
        getPlcAddressWarning,
        handlePointDataTypeChange,
        composePlcAddressFromParts,
        toInternalPointName,
        inferPointCategory,
        setPointUsage,
        formatPointUsage,
        isTextPointType,
        getAlarmPointNumber,
        currentAlarmTriggerPoints,
        alarmRecordPointStatus,
        getNextAlarmPointIndex,
        parseAlarmText,
        parsedAlarmTextEntries,
        alarmTextImportSummary,
        fillAlarmTextTemplate,
        triggerAlarmTextFileSelect,
        handleAlarmTextFileChange,
        applyAlarmTextImport,
        ensureAlarmRecordPoints,
        validatePointRows,
        buildDataPointPayload,
        saveAllPoints,
        copyPointsFrom,
        syncToLine
    }
}
