export const defaultCartTransfer = () => ({ version: 1, kind: 'single', presentation: 'model', turntableNodeName: '' })
export function normalizeCartTransfer(value) {
  if (value == null) return defaultCartTransfer()
  const fail = message => { throw Object.assign(new Error(message), { statusCode: 400, code: 'CART_TRANSFER_INVALID' }) }
  if (typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'kind', 'presentation', 'turntableNodeName'].includes(key))) fail('小车机构配置无效')
  if (!['single', 'rotating'].includes(value.kind) || !['model', 'simple'].includes(value.presentation)) fail('小车机构类型无效')
  const node = value.turntableNodeName
  if (typeof node !== 'string' || node.length > 512 || /[\u0000-\u001f\u007f]/.test(node)) fail('转台节点名称无效')
  if (value.kind === 'single' && (value.presentation !== 'model' || node)) fail('单向小车沿用原模型')
  if (value.kind === 'rotating' && value.presentation === 'model' && !node.trim()) fail('请选择模型的上转台节点')
  if (value.presentation === 'simple' && node) fail('简模使用自带转台节点')
  return { version: 1, kind: value.kind, presentation: value.presentation, turntableNodeName: node }
}
