// Shared policy vocabulary. Missing grants are always false; editing one page
// never turns a user into the legacy owner/admin role.
export const PAGE_ACTIONS = { view: '查看', edit: '新增 / 修改 / 导入', delete: '删除', publish: '发布 / 启用版本' }
const page = (key, label, actions = ['view', 'edit'], ownerOnly = false) => ({ key, label, actions, ownerOnly })
export const PAGE_PERMISSIONS = [
  page('factories', '工厂与区域'),
  page('workshops', '车间管理', ['view', 'edit', 'delete']),
  page('lines', '产线管理', ['view', 'edit', 'delete']),
  page('devices', '设备管理', ['view', 'edit', 'delete']),
  page('mobile-devices', '设备运动配置'),
  page('disassembly-layout', '拆解布局'),
  page('composer', '现场编排器'),
  page('models', '模型库', ['view', 'edit', 'delete', 'publish']),
  page('points', '点位映射', ['view', 'edit', 'delete']),
  page('point-monitor', '点位监视', ['view']),
  page('platform.designer', '组件配置 · 大屏设计器', ['view', 'edit', 'delete', 'publish']),
  page('platform.scene', '组件配置 · 项目与场景'),
  page('platform.environment', '组件配置 · 场景与光效'),
  page('settings.runtime', '系统设置 · 运行与投屏'),
  page('settings.database', '系统设置 · 数据连接与备份', ['view', 'edit', 'delete']),
  page('settings.performance', '系统设置 · 客户端性能'),
  page('settings.data', '系统设置 · 数据通路'),
  page('settings.license', '系统设置 · 授权与版本', ['view']),
  page('users', '用户与权限（仅管理员）', ['view', 'edit', 'delete'], true),
  page('settings.security', '后台安全（仅管理员）', ['view', 'edit'], true)
]
const registry = new Map(PAGE_PERMISSIONS.map(p => [p.key, p]))
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function normalizePagePermissions(value, { owner = false } = {}) {
  if (value !== undefined) {
    if (!plainObject(value)) throw new TypeError('页面权限必须是对象')
    for (const [key, grants] of Object.entries(value)) {
      const definition = registry.get(key)
      if (!definition || !plainObject(grants)) throw new TypeError('未知页面或页面权限格式无效')
      for (const [action, enabled] of Object.entries(grants)) {
        if (!definition.actions.includes(action) || typeof enabled !== 'boolean'
          || (definition.ownerOnly && enabled && !owner)) throw new TypeError('页面操作权限无效或不可委派')
      }
      if (!owner && grants.view !== true && Object.entries(grants).some(([a, enabled]) => a !== 'view' && enabled)) {
        throw new TypeError('操作权限必须同时授予该页面的查看权限')
      }
    }
  }
  return Object.fromEntries(PAGE_PERMISSIONS.map(p => [p.key,
    Object.fromEntries(p.actions.map(a => [a, owner || (!p.ownerOnly && value?.[p.key]?.view === true && value?.[p.key]?.[a] === true)]))
  ]))
}

export function canPage(grants, key, action = 'view') {
  const definition = registry.get(key)
  return !!definition && definition.actions.includes(action)
    && grants?.[key]?.view === true && grants?.[key]?.[action] === true
}
export function canAccessAdmin(grants) { return PAGE_PERMISSIONS.some(p => canPage(grants, p.key)) }
export function pagePermission(key, action = 'view') { return `page:${key}:${action}` }

// Requirements compose AND/OR explicitly. Unknown names/empty groups deny even
// for an owner, so a typo or newly added route cannot silently grant access.
export function allowsRequirement(requirement, { owner = false, active = false, permissions = {}, pagePermissions = {} } = {}) {
  if (typeof requirement === 'string') {
    if (['admin', 'owner', 'edit'].includes(requirement)) return owner && active
    if (requirement === 'session') return active
    if (requirement === 'account') return true // cookie/CSRF already checked; switching never unlocks a session
    if (['view', 'launch', 'cast', 'backup'].includes(requirement)) return permissions[requirement] === true
    const match = /^page:([^:]+):([^:]+)$/.exec(requirement)
    return !!match && active && canPage(pagePermissions, match[1], match[2])
  }
  if (!plainObject(requirement)) return false
  if (Array.isArray(requirement.any) && requirement.any.length) return requirement.any.some(r => allowsRequirement(r, { owner, active, permissions, pagePermissions }))
  if (Array.isArray(requirement.all) && requirement.all.length) return requirement.all.every(r => allowsRequirement(r, { owner, active, permissions, pagePermissions }))
  return false
}
