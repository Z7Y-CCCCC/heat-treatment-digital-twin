export const DEFAULT_GROUP_PORTAL_APPEARANCE = Object.freeze({
    brandTitle: '生产运营 · 集团总览',
    brandSubtitle: 'GLOBAL PRODUCTION MANAGEMENT',
    panelTitle: 'OPERATING NETWORK',
    showFacts: true, showPanel: true, showDock: true, showHelp: true,
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

const LEVEL_KEYS = new Set(GROUP_MAP_LEVELS.map(level => level.key))
const COLOR_KEYS = ['background', 'panelSurface', 'accent', 'text', 'mapBase', 'mapMuted', 'markerPrimary', 'markerTip']
const TOGGLE_KEYS = ['showFacts', 'showPanel', 'showDock', 'showHelp']

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
        if (typeof raw.panelTitle === 'string' && raw.panelTitle.trim()) level.panelTitle = raw.panelTitle.trim().slice(0, 60)
        if (Number.isFinite(Number(raw.mapZoom)) && Number(raw.mapZoom) >= 0.8 && Number(raw.mapZoom) <= 1.5) level.mapZoom = Number(raw.mapZoom)
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
    for (const key of ['brandTitle', 'brandSubtitle', 'panelTitle']) {
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
    return { ...appearance, ...(appearance.levels[level] || {}) }
}
