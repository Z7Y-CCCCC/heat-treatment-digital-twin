const keyPattern = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/
const forbidden = /^(?:__proto__|prototype|constructor)$/
const secret = /password|passwd|secret|authorization|api[_-]?key|token|cookie/i
export function isParameterKey(key) { return typeof key === 'string' && keyPattern.test(key) && !forbidden.test(key) && !secret.test(key) }
export const PARAMETER_TYPES = ['string', 'number', 'boolean', 'date']
export function parameterValue(value, type, label = '参数') {
  if (value === null || value === undefined || value === '') return type === 'string' ? '' : null
  if (type === 'number') {
    if (!['string','number'].includes(typeof value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1e12) throw new Error(`${label}需要有效数值`)
    return Number(value)
  }
  if (type === 'boolean') {
    if ([true, 'true', 1, '1'].includes(value)) return true
    if ([false, 'false', 0, '0'].includes(value)) return false
    throw new Error(`${label}需要布尔值`)
  }
  if (!['string','number','boolean'].includes(typeof value)) throw new Error(`${label}不支持对象或数组`)
  const text = String(value)
  if (text.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error(`${label}内容过长或包含无效字符`)
  if (type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`)) || new Date(`${text}T00:00:00Z`).toISOString().slice(0,10) !== text)) throw new Error(`${label}需要有效日期`)
  return text
}
export function normalizeParameterDefinitions(input = []) {
  if (!Array.isArray(input) || input.length > 32) throw new Error('最多配置 32 个大屏参数')
  const seen = new Set()
  const normalized = input.map(item => {
    if (!item || !isParameterKey(item.key) || seen.has(item.key)) throw new Error('参数标识无效或重复；请勿保存认证信息')
    seen.add(item.key)
    const type = PARAMETER_TYPES.includes(item.type) ? item.type : 'string'
    const label = String(item.label || item.key).slice(0,80)
    return {key:item.key,label,type,defaultValue:parameterValue(item.defaultValue,type,label)}
  })
  if (encodeURIComponent(JSON.stringify(Object.fromEntries(normalized.map(p=>[p.key,p.defaultValue])))).length>8192) throw new Error('大屏参数过长，请缩短参数内容')
  return normalized
}
export function resolveParameters(definitions, input = {}) {
  const normalized = normalizeParameterDefinitions(definitions)
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 32) throw new Error('参数值必须是键值对象')
  const known = new Map(normalized.map(item => [item.key,item]))
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`未定义的大屏参数：${key}`)
  const result = Object.fromEntries(normalized.map(item => [item.key,parameterValue(Object.hasOwn(input,item.key)?input[item.key]:item.defaultValue,item.type,item.label)]))
  if (encodeURIComponent(JSON.stringify(result)).length>8192) throw new Error('大屏参数过长，请缩短参数内容')
  return result
}
// Preview endpoints accept only the keys explicitly referenced by this dataset.
// Runtime endpoints instead validate against the published document definitions.
export function datasetParameterDefinitions(definition) {
  const values = new Map()
  for (const p of definition.source === 'database' ? [] : (definition.request?.parameters || [])) if (p.source === 'parameter') {
    if (!isParameterKey(p.key)) throw new Error('请选择有效的大屏参数')
    values.set(p.key,{key:p.key,label:p.key,type:p.type || 'string',defaultValue:null})
  }
  if (definition.match?.contextKey === 'parameter') {
    const key=definition.match.parameterKey
    if (!isParameterKey(key)) throw new Error('请选择有效的匹配参数')
    if (!values.has(key)) values.set(key,{key,label:key,type:definition.match.parameterType || 'string',defaultValue:null})
  }
  return [...values.values()]
}
