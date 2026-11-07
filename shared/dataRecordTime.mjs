// Read-only source-time semantics shared by the data browser and its displays.
// A fetch heartbeat is never a replacement for a missing source timestamp.
const numericTimestamp = /^(?:\d{10}(?:\.\d{1,3})?|\d{13})$/
const calendarTimestamp = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]((?:[01]\d|2[0-3])):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/
const updateAliases = new Set(['updatedat', 'updatetime', 'updatedtime', 'updateat', 'lastupdatedat', 'lastupdatetime', 'lastupdatedtime', 'lastmodifiedat', 'lastmodifiedtime', 'modifiedat', 'modificationtime', '更新时间', '最后更新时间', '数据更新时间', '最近更新时间', '最后修改时间', '修改时间'])
const canonicalName = value => String(value ?? '').trim().replace(/[\s_-]/g, '').toLocaleLowerCase()
function pathLeaf(path) {
    // Accept a configured field's last property only, never fetch/request paths.
    return String(path ?? '').trim().replace(/\[['"]([^'"\]]+)['"]\]$/, '.$1').split('.').at(-1) || ''
}
export function normalizeRecordTimestamp(value) {
    let milliseconds
    if (value instanceof Date) milliseconds = value.getTime()
    else if (typeof value === 'number') milliseconds = Number.isFinite(value) ? value < 1e11 ? value * 1000 : value : NaN
    else if (typeof value === 'string') {
        const text = value.trim()
        if (numericTimestamp.test(text)) { const number = Number(text); milliseconds = number < 1e11 ? number * 1000 : number }
        else {
            const match = calendarTimestamp.exec(text)
            if (!match) return null
            const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
            const calendar = new Date(0)
            calendar.setUTCFullYear(year, month - 1, day)
            if (month < 1 || month > 12 || day < 1 || day > 31 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null
            milliseconds = Date.parse(text)
        }
    } else return null
    return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 8.64e15 ? new Date(milliseconds).toISOString() : null
}
export function isSourceUpdateColumn(column) {
    if (!column || typeof column !== 'object' || column.role) return false
    return [column.name, pathLeaf(column.path), column.label].some(name => updateAliases.has(canonicalName(name)))
}
export function resolveRecordTimeColumn(columns = []) {
    const fields = Array.isArray(columns) ? columns : []
    const explicit = fields.find(column => column?.role === 'time')
    if (explicit) return { column: explicit, inferred: false, ambiguous: false }
    const candidates = fields.filter(isSourceUpdateColumn)
    return { column: candidates.length === 1 ? candidates[0] : null, inferred: candidates.length === 1, ambiguous: candidates.length > 1 }
}
