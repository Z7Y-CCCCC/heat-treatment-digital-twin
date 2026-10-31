// The single page registration point for navigation AND authorization.
// New destinations belong here, never in a second permission-only list.
export const PAGE_ACTIONS = { view: '查看', edit: '新增 / 修改 / 导入', delete: '删除', publish: '发布 / 启用版本' }
const page = (key, label, options = {}) => ({ key, label, actions: ['view', 'edit'], ownerOnly: false, ...options })
export const ADMIN_PAGES = [
  page('factories', '工厂与区域', { navGroup: 'main', icon: 'factories', menuOrder: 10 }),
  page('workshops', '车间管理', { navGroup: 'factory', icon: 'workshops', actions: ['view', 'edit', 'delete'] }),
  page('lines', '产线管理', { navGroup: 'factory', icon: 'lines', actions: ['view', 'edit', 'delete'] }),
  page('devices', '设备管理', { navGroup: 'factory', icon: 'devices', actions: ['view', 'edit', 'delete'] }),
  page('mobile-devices', '设备运动配置', { navGroup: 'factory', icon: 'mobile' }),
  page('composer', '现场编排器', { navGroup: 'main', icon: 'composer', menuOrder: 20 }),
  page('models', '模型库 · 模型管理', { navGroup: 'models', navLabel: '模型管理', icon: 'models', actions: ['view', 'edit', 'delete', 'publish'] }),
  page('disassembly-layout', '模型库 · 拆解布局', { navGroup: 'models', navLabel: '拆解布局', icon: 'models' }),
  page('points', '点位映射 · PLC 点位映射', { navGroup: 'data', navLabel: '点位映射', icon: 'points', container: 'points', subpage: 'mapping', tabLabel: 'PLC 点位映射', actions: ['view', 'edit', 'delete'] }),
  page('points.alarms', '点位映射 · 报警配置', { container: 'points', subpage: 'alarms', tabLabel: '报警配置' }),
  page('point-monitor', '点位监视', { navGroup: 'data', icon: 'points', actions: ['view'] }),
  page('platform.designer', '组件配置 · 大屏设计器', { container: 'platform', subpage: 'designer', tabLabel: '大屏设计器', description: '地图分层、Logo、加载画面与场景组件', actions: ['view', 'edit', 'delete', 'publish'] }),
  page('platform.scene', '组件配置 · 项目与场景', { container: 'platform', subpage: 'scene', tabLabel: '项目与场景', description: '项目归属与场景基础信息' }),
  page('platform.environment', '组件配置 · 场景与光效', { container: 'platform', subpage: 'environment', tabLabel: '场景与光效', description: 'Unity 灯光、后处理、围墙与空间' }),
  page('settings.security', '后台安全（仅管理员）', { container: 'settings', subpage: 'security', tabLabel: '后台安全', description: '后台密码、无操作自动锁定与立即锁定', ownerOnly: true }),
  page('settings.runtime', '系统设置 · 运行与投屏', { container: 'settings', subpage: 'runtime', tabLabel: '运行与投屏', description: '自启动、电视投屏与本地运行服务' }),
  page('settings.database', '系统设置 · 数据连接与备份', { container: 'settings', subpage: 'database', tabLabel: '数据连接与备份', description: '数据库、ERP / MES 接口、备份与恢复', actions: ['view', 'edit', 'delete'] }),
  page('settings.performance', '系统设置 · 客户端性能', { container: 'settings', subpage: 'performance', tabLabel: '客户端性能', description: 'Unity 画质' }),
  page('settings.data', '系统设置 · 数据通路', { container: 'settings', subpage: 'data', tabLabel: '数据通路', description: 'PLC 实时采集或离线模拟模式' }),
  page('settings.license', '系统设置 · 授权与版本', { container: 'settings', subpage: 'license', tabLabel: '授权与版本', description: '离线许可证、有效期与发布信息', actions: ['view'] }),
  page('users', '用户与权限（仅管理员）', { navGroup: 'main', navLabel: '用户与权限', icon: 'users', menuOrder: 50, actions: ['view', 'edit', 'delete'], ownerOnly: true })
]
const groups = [
  { key: 'models', label: '模型库', icon: 'models', menuOrder: 30 },
  { key: 'platform', label: '组件配置', icon: 'platform', menuOrder: 40 },
  { key: 'settings', label: '系统设置', icon: 'settings', menuOrder: 60 }
]
export const getAdminPageCatalog = () => JSON.parse(JSON.stringify(ADMIN_PAGES))
export const adminNavPages = (group, pages = ADMIN_PAGES) => pages.filter(p => p.navGroup === group).map(p => ({ ...p, label: p.navLabel || p.label }))
export const adminMainTabs = (pages = ADMIN_PAGES) => [...adminNavPages('main', pages), ...groups].sort((a, b) => (a.menuOrder || 100) - (b.menuOrder || 100))
export const adminSubpages = (container, pages = ADMIN_PAGES) => pages.filter(p => p.container === container).map(p => ({ ...p, permissionKey: p.key, key: p.subpage, label: p.tabLabel || p.label }))

export function mergeAdminPageCatalog(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 256) throw new TypeError('页面目录无效')
  const keys = new Set()
  for (const p of pages) {
    if (!p || !/^[a-z][a-z0-9.-]{0,100}$/.test(p.key) || typeof p.label !== 'string' || !p.label || p.label.length > 160
      || !Array.isArray(p.actions) || !p.actions.includes('view') || p.actions.some(a => !Object.hasOwn(PAGE_ACTIONS, a))
      || new Set(p.actions).size !== p.actions.length || typeof p.ownerOnly !== 'boolean' || keys.has(p.key)) throw new TypeError('页面目录格式无效')
    if (ADMIN_PAGES.find(old => old.key === p.key)?.ownerOnly && !p.ownerOnly) throw new TypeError('管理员专属页面不可降级')
    keys.add(p.key)
  }
  const before = JSON.stringify(ADMIN_PAGES)
  for (const source of pages) {
    const value = JSON.parse(JSON.stringify(source)), index = ADMIN_PAGES.findIndex(p => p.key === value.key)
    if (index < 0) ADMIN_PAGES.push(value)
    else ADMIN_PAGES[index] = value
  }
  return before !== JSON.stringify(ADMIN_PAGES)
}
