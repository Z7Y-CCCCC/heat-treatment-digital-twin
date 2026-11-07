import { validateLoadingPorts } from '../../../../../shared/loadingPorts.mjs'
import { cadMotionActions } from '../../../three/cadMotionProfiles.js'
import { CLEANER_ACTIONS } from './motionEntries.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value.trim() : ''

function savedMetadata(model) {
    const raw = model?.metadata
    if (raw === undefined || raw === null || raw === '') return {}
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        return object(parsed) ? parsed : null
    } catch { return null }
}

const hasTarget = part => object(part) && (
    text(part.node_path ?? part.nodePath) || text(part.node_name ?? part.nodeName)
    || [part.node_paths ?? part.nodePaths, part.node_names ?? part.nodeNames]
        .some(values => Array.isArray(values) && values.some(value => text(value)))
)
const validVector = value => value === undefined || Array.isArray(value) && value.length === 3
    && Array.from(value).every(component => typeof component === 'number' && Number.isFinite(component))

export function loadingPortSetupStatus(model) {
    const metadata = savedMetadata(model)
    if (!metadata) return '配置异常'
    const result = validateLoadingPorts(metadata.loadingPorts)
    if (!result.valid) return '配置异常'
    const { inlet, outlet } = result.normalized
    return inlet && outlet ? '双口已设置' : inlet ? '仅进料口' : outlet ? '仅出料口' : '未设置'
}

export function disassemblySetupStatus(model) {
    const metadata = savedMetadata(model)
    if (!metadata) return '配置异常'
    const inspection = metadata.inspection
    if (inspection == null) return '未设置'
    if (!object(inspection) || inspection.parts !== undefined && !Array.isArray(inspection.parts)) return '配置异常'
    // Do not normalize here: normalization can fabricate zero-offset parts
    // from part bindings. Only saved node targets belong to this page's status.
    const parts = (inspection.parts || []).filter(hasTarget)
    if (!parts.length) return '未设置'
    const vectors = parts.flatMap(part => [part.explode_offset ?? part.explodeOffset, part.explode_rotation ?? part.explodeRotation])
    if (!vectors.every(validVector)) return '配置异常'
    const explicitlySaved = metadata.disassemblyLayout?.version === 1 && metadata.disassemblyLayout?.configured === true
    // Legacy nonzero layouts remain recognized. All-zero legacy layouts have
    // no provenance; label them default rather than falsely claiming a save.
    return explicitlySaved || vectors.some(value => value?.some(component => component !== 0))
        ? `已设置 ${parts.length} 个部件` : '默认布局'
}

export function partMotionSetupStatus(model) {
    const metadata = savedMetadata(model)
    if (!metadata || metadata.partBindings != null && !Array.isArray(metadata.partBindings)) return '配置异常'
    const signatures = new Set()
    for (const binding of metadata.partBindings || []) {
        if (!object(binding)) continue
        const node = text(binding.node_path) || text(binding.node_name ?? binding.nodeName)
        const source = text(binding.source_key || binding.value_role || binding.key)
        if (!node || !source) continue
        // Match the part-action editor's saved-binding deduplication without
        // generating draft IDs or modifying the underlying metadata.
        signatures.add([node, `${binding.source_group || binding.category || 'analog'}.${source}`,
            binding.action || 'rotate_speed', binding.axis || 'y'].join('|').toLowerCase())
    }
    const saved = signatures.size
    const builtin = cadMotionActions(model?.id).length + (model?.id === 'ultrasonic_cleaner_cad' ? CLEANER_ACTIONS.length : 0)
    // Built-in demonstrations are usable actions, not proof of PLC binding.
    // Retired motionAuthoring clips intentionally do not participate.
    return [saved && `已设置 ${saved} 项`, builtin && `内置 ${builtin} 项`].filter(Boolean).join('／') || '未设置'
}

const statusFor = { ports: loadingPortSetupStatus, disassembly: disassemblySetupStatus, parts: partMotionSetupStatus }
export function formatModelSetupOption(model, section) {
    return `${model?.name || model?.id || '未命名模型'} · ${statusFor[section](model)}`
}
