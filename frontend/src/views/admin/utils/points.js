// 点位格式化纯函数:实时值/质量/时间显示。点位映射与实时监视两处 template 共用。
export function formatPointValue(point) {
    if (point.value === undefined || point.value === null) return '-'
    if (typeof point.value === 'boolean') return point.value ? 'ON / true' : 'OFF / false'
    if (typeof point.value === 'number') {
        const format = String(point.display_format || '').trim()
        const decimals = format.includes('.') ? Math.min(6, format.split('.')[1].length) : null
        const text = decimals === null ? String(point.value) : point.value.toFixed(decimals)
        return point.unit ? `${text} ${point.unit}` : text
    }
    return String(point.value)
}

export function formatQualityLabel(quality) {
    const labels = { good: '正常', stale: '过期', bad: '异常' }
    return labels[quality] || quality || '-'
}

export function formatPointTime(value) {
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
    return new Date(timestamp).toLocaleTimeString()
}

export function formatPointDateTime(value) {
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
    const date = new Date(timestamp)
    if (!Number.isFinite(date.getTime())) return '-'
    const pad = part => String(part).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
