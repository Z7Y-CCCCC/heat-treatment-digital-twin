export const DEFAULT_GROUP_PORTAL_APPEARANCE = Object.freeze({
    brandTitle: '生产运营 · 集团总览',
    brandSubtitle: 'GLOBAL PRODUCTION MANAGEMENT',
    panelTitle: 'OPERATING NETWORK',
    factsTitle: '登记工厂',
    dockNetworkTitle: '站点网络',
    dockLocationTitle: '行政区归属',
    dockHierarchyTitle: '集团现场配置',
    showBrand: true, showFacts: true, showPanel: true, showDock: true, showHelp: true,
    background: '#303134', panelSurface: '#3d3d40', accent: '#9caaff', text: '#e5e3de',
    mapBase: '#747682', mapMuted: '#494b52', markerPrimary: '#376ff0', markerTip: '#bbfff0', mapZoom: 1.12,
    logoUrl: '', levels: {}
})

export const GROUP_MAP_LEVELS = Object.freeze([
    { key: 'world', label: '全球' },
    { key: 'country', label: '国家' },
    { key: 'province', label: '省份 / 直辖市' },
    { key: 'city', label: '城市' },
    { key: 'district', label: '区县' }
])

export const GROUP_MAP_DATA_FIELDS = Object.freeze({
    facts: [
        { key: 'factsFactoryCount', label: '登记工厂数' },
        { key: 'factsLocalCount', label: '本机运行端数' },
        { key: 'factsDeviceCount', label: '现场设备配置数' }
    ],
    panel: [{ key: 'panelRegionRows', label: '区域列表（按 code 对应地图区域）' }],
    dock: [
        { key: 'dockFactoryCount', label: '登记工厂数' },
        { key: 'dockLocalCount', label: '本机运行端数' },
        { key: 'dockAssignedCount', label: '已归属区县工厂数' },
        { key: 'dockCoverage', label: '行政区归属率 %' },
        { key: 'dockWorkshops', label: '车间数' },
        { key: 'dockLines', label: '产线数' },
        { key: 'dockDevices', label: '设备数' }
    ]
})

const LEVEL_KEYS = new Set(GROUP_MAP_LEVELS.map(level => level.key))
const COLOR_KEYS = ['background', 'panelSurface', 'accent', 'text', 'mapBase', 'mapMuted', 'markerPrimary', 'markerTip']
const TOGGLE_KEYS = ['showBrand', 'showFacts', 'showPanel', 'showDock', 'showHelp']
const LAYOUT_KEYS = ['brand', 'facts', 'panel', 'dock']
const TITLE_KEYS = ['brandTitle', 'brandSubtitle', 'panelTitle', 'factsTitle', 'dockNetworkTitle', 'dockLocationTitle', 'dockHierarchyTitle']
const DATA_KEYS = new Set(Object.values(GROUP_MAP_DATA_FIELDS).flat().map(field => field.key))

function normalizeDataBindings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result = {}
    for (const [key, binding] of Object.entries(value)) {
        if (!DATA_KEYS.has(key) || !binding || typeof binding !== 'object' || Array.isArray(binding)) continue
        if (binding.mode !== 'http_api') continue
        result[key] = {
            mode: 'http_api',
            factoryId: String(binding.factoryId || '').slice(0, 80),
            connectionId: String(binding.connectionId || '').slice(0, 80),
            apiPath: String(binding.apiPath || '').slice(0, 1024),
            jsonPath: String(binding.jsonPath || '').slice(0, 255),
            refreshMs: Math.max(5000, Math.min(3600000, Number(binding.refreshMs) || 30000))
        }
    }
    return result
}

function normalizeLayout(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result = {}
    for (const key of LAYOUT_KEYS) {
        const item = value[key]
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const x = Number(item.x), y = Number(item.y)
        if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 95 && y >= 0 && y <= 95)
            result[key] = { x, y }
    }
    return result
}

export function normalizeGroupLogoUrl(value) {
    const url = typeof value === 'string' ? value.trim().slice(0, 400) : ''
    return /^\/(?!\/)[\w/%.~+-]+$/.test(url) || /^https:\/\/[\w.-]+(?:\/[\w/%?&=.#~+-]*)?$/.test(url) ? url : ''
}

function normalizeLevelOverrides(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const result = {}
    for (const [key, raw] of Object.entries(value)) {
        if (!LEVEL_KEYS.has(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const level = {}
        for (const field of TOGGLE_KEYS) if (typeof raw[field] === 'boolean') level[field] = raw[field]
        for (const field of COLOR_KEYS) if (typeof raw[field] === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw[field])) level[field] = raw[field].toLowerCase()
        for (const field of TITLE_KEYS) if (typeof raw[field] === 'string' && raw[field].trim()) level[field] = raw[field].trim().slice(0, 80)
        if (raw.logoUrl) {
            const logoUrl = normalizeGroupLogoUrl(raw.logoUrl)
            if (logoUrl) level.logoUrl = logoUrl
        }
        if (Number.isFinite(Number(raw.mapZoom)) && Number(raw.mapZoom) >= 0.8 && Number(raw.mapZoom) <= 1.5) level.mapZoom = Number(raw.mapZoom)
        if (raw.layout !== undefined) level.layout = normalizeLayout(raw.layout)
        if (raw.dataBindings !== undefined) level.dataBindings = normalizeDataBindings(raw.dataBindings)
        result[key] = level
    }
    return result
}

export function normalizeGroupPortalAppearance(raw) {
    let value = raw
    if (typeof raw === 'string') {
        try { value = JSON.parse(raw) } catch { value = null }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_GROUP_PORTAL_APPEARANCE }
    const result = { ...DEFAULT_GROUP_PORTAL_APPEARANCE }
    for (const key of TITLE_KEYS) {
        if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim().slice(0, 80)
    }
    for (const key of TOGGLE_KEYS) {
        if (typeof value[key] === 'boolean') result[key] = value[key]
    }
    for (const key of COLOR_KEYS) {
        if (typeof value[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(value[key])) result[key] = value[key].toLowerCase()
    }
    if (Number.isFinite(Number(value.mapZoom)) && Number(value.mapZoom) >= 0.8 && Number(value.mapZoom) <= 1.5) result.mapZoom = Number(value.mapZoom)
    result.logoUrl = normalizeGroupLogoUrl(value.logoUrl)
    result.levels = normalizeLevelOverrides(value.levels)
    return result
}

export function groupPortalAppearanceForLevel(raw, level) {
    const appearance = normalizeGroupPortalAppearance(raw)
    const override = appearance.levels[level] || {}
    return { ...appearance, ...override, factsTitle: override.factsTitle || `${level === 'world' ? '全球' : '当前区域'}${appearance.factsTitle}` }
}
