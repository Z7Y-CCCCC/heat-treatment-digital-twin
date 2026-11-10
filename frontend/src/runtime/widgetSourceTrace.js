// Read-only explanations of the fields the renderers already consume. This
// module never creates a binding, resolves a point by name, or reads a source.
import { hudTextDefaults, hudTextFields } from './hudTextConfig.js'
import { resolveWidgetViewStyle, widgetSurfacePresentation } from './widgetSurfaceSkin.js'
import { normalizePlayback, isDeviceBinding } from '../../../shared/widgetPlayback.mjs'
import { bindingForDevice } from '../../../shared/widgetBindingWorkflow.mjs'

const array = value => Array.isArray(value) ? value : []
const text = value => value == null ? '' : String(value)
const record = (field, origin, source, path, updates, scope = '') => ({ field, origin, source, path, updates, scope })
const fixed = (field, path, value, defaults = false) => record(field, defaults ? '内置文字' : '固定配置',
  value == null || value === '' ? '未设置 / 隐藏' : text(value), path, '编辑并保存后更新；不是采集数据')
const metricNames = {
  current_output: '今日产出', daily_target: '日产目标', overall_oee: '综合效率', energy_consumption: '能耗',
  total_devices: '配置设备数量', online_devices: '在线设备数量', running_devices: '运行设备数量', alarm_devices: '报警设备数量'
}
const countMetrics = new Set(['total_devices', 'online_devices', 'running_devices', 'alarm_devices'])

function scopeLabel(binding) {
  return ({ current: '当前查看设备', fixed: '指定设备', rotation: '明确设备清单轮播', global: '当前工厂 / 全局数据' })[binding.deviceScope]
    || (binding.deviceId ? '指定设备' : '当前视角')
}

function runtimeSource(field, path, binding = {}, options = {}) {
  path = text(path)
  const scope = scopeLabel(binding)
  if (!path) return record(field, '缺少来源', '未选择运行数据字段', '', '不会拿其他字段代替', scope)
  if (path === 'metrics.progress_percent') return record(field, '计算结果',
    '今日产出 ÷（日产目标或旧版默认值 1）× 100，限制在 0–100%；目标为 0 / 缺失时沿用默认分母 1', path, '随生产指标更新', '当前工厂')
  if (path.startsWith('metrics.')) {
    const key = path.slice(8)
    return record(field, '运行指标', `${metricNames[key] || key} · ${countMetrics.has(key)
      ? '当前工厂已配置设备及实时状态统计'
      : '后台生产指标快照（/api/platform/metrics/latest）'}`, path,
    countMetrics.has(key) ? '设备配置 / 实时采集帧变化时重算' : '现有指标刷新周期更新；采集过期 / 无在线设备时由质量保护清零并暂停快照读取，不是新采集的零值', '当前工厂')
  }
  if (path === 'events' || path.startsWith('events.')) {
    const projected = ['id', 'time', 'occurred_at', 'msg', 'level', 'source_id', 'sourceId', 'device_id', 'deviceId', 'factory_id', 'factoryId', 'event_type', 'quality']
    const selected = path.match(/^events\.\d+\.([^.]+)/)?.[1]
    const placeholder = selected === 'placeholder', missing = selected && !projected.includes(selected) && !placeholder
    return record(field, missing ? '缺少来源' : placeholder ? '本机占位标记' : '报警 / 事件记录',
      `当前工厂 event_logs 表 · /api/platform/events：真实记录经 DataStore.formatEvent 组成展示列表；msg = title || message || “系统事件”，time 为 occurred_at 转本地时间（日期缺失 / 无效时用本机当前时间）；原始 title / message 不单独保留；启动等待 / 空窗口无记录时由 DataStore 生成 placeholder:true 的本机占位提示（id 为 boot / empty，time 用本机当前时间）；占位提示不是 event_logs 记录${placeholder ? '；placeholder 仅在占位项存在，正常 formatEvent 记录不含该字段' : missing ? `；展示列表没有 ${selected} 字段，不改读数据库原列` : path === 'events' ? '' : `；读取展示列表的 ${path.slice(7)}`}`,
      path, '按现有共享事件窗口更新展示列表；序号表示当前展示列表位置，不是固定报警编号；离线保留已有列表；仅凭路径不能断定当前项是真实记录；缺少展示字段时不另找原始响应字段', scope)
  }
  if (path.startsWith('map.') || path === 'map') return record(field, '地图区域资料',
    '当前区域、工厂目录、行政区归属和地图展示设置', path, '切换区域或刷新工厂配置时更新', '当前地图区域')
  if (path.startsWith('context.')) return record(field, '场景上下文',
    'Unity / 原生场景确认的当前视角、设备或部件', path, '场景切换 / 选中对象变化时更新', scope)
  if (path.startsWith('parameters.')) return record(field, '全局参数',
    '设计器“接口与参数”定义；运行控件或软件接口传入', path, '参数变化时更新', '当前页面参数')
  if (path.startsWith('dataset.')) return record(field, '数据表输出字段',
    `${binding.datasetId || '主数据绑定的数据表'} · ${path.slice(8)}`, path,
    '跟随当前主数据表读取；空值 / 异常不回退其他来源', scope)
  if (path.startsWith('selectedPart.') || path.startsWith('hover.part.')) return record(field,
    /\.points\.|\.pointMap\./.test(path) ? '部件采集数据' : '部件资料',
    '当前设备检查配置及明确关联的部件点位；不同部件不相互代替', path, '选中 / 悬停部件和实时帧变化时更新', scope)
  if (path.startsWith('deviceInfo.') || path.startsWith('hover.device.')) return record(field, '设备资料 / 质量',
    '已配置设备资料和该设备实时连接质量；不是手填读数', path, '设备配置、选中对象或采集质量变化时更新', scope)
  if (/^(device\.|deviceDataMap\.|deviceStatusMap\.|points\.)/.test(path)) return record(field, '设备实时数据',
    '当前绑定设备的已有采集帧 / 状态；未配置或异常时显示缺项', path, '随实时采集帧更新', scope)
  if (path === 'trendPoints') return record(field, '实时趋势窗口',
    '现有采集帧中质量正常、具有实际温度的设备均值，不是历史数据库', path, '随已有趋势采样周期更新', '当前工厂')
  return record(field, '现有运行字段', `运行上下文中的“${path}”`, path,
    '跟随该字段更新；来源未识别时不宣称为 PLC 或数据表', scope)
}

const credentialName = value => /token|secret|password|passwd|pwd|authorization|credential|cookie|api[_.-]?key|access[_.-]?key|private[_.-]?key|session[_.-]?(?:id|key)|signature|^(?:key|sig|auth|bearer|user|username|login|code)$/i.test(text(value))

function endpoint(value) {
  // A trace is not a second place to display connection passwords or tokens.
  const input = text(value)
  if (!input) return ''
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(input) || input.startsWith('//'), url = new URL(input, 'http://trace.invalid')
    url.username = ''; url.password = ''
    for (const key of [...url.searchParams.keys()]) if (credentialName(key)) url.searchParams.set(key, '已隐藏')
    // A fragment is not sent to the data endpoint. Do not echo OAuth fragments,
    // route query strings, or opaque fragments that could contain credentials.
    const svgAnchor = /\.svg$/i.test(url.pathname) && /^#[A-Za-z][\w.-]{0,79}$/.test(url.hash) && !credentialName(url.hash.slice(1))
    if (url.hash && !svgAnchor) url.hash = '已隐藏片段'
    return input.startsWith('//') ? `//${url.host}${url.pathname}${url.search}${url.hash}`
      : absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  } catch { return '现有接口路径（格式无法识别）' }
}

const connectionFor = (id, options) => array(options.connections).find(connection => text(connection.id) === text(id))
const connectionLabel = (connection, id) => connection?.name || id || '未选择连接'
const transportNames = { http: 'HTTP', websocket: 'WebSocket', mqtt: 'MQTT', tcp: 'TCP', udp: 'UDP', redis: 'Redis', file: '导入文件' }
// Topics and Redis keys are opaque selectors, not relative URLs. Preserve
// their exact slashes/encoding, while hiding any explicit credential pairs.
const transportLocator = value => text(value).replace(/(^|[?&#;])([^?&#;=]+)=([^&#;]*)/g,
  (match, separator, key) => credentialName(key) ? `${separator}${key}=已隐藏` : match)

function apiProvenance(field, binding, connection, scope, method = 'GET') {
  const name = connectionLabel(connection, binding.connectionId)
  if (!connection) return record(field, '只读接口连接（协议待确认）',
    `连接 ${name} 未在当前连接目录中确认；配置路径 ${endpoint(binding.apiPath) || '未配置'}，不猜 HTTP / MQTT 等实际协议`,
    'connectionId / apiPath', '连接元数据未提供；这里不连接目标、不展示认证参数', scope)
  const connector = connection.connector || 'http', protocol = transportNames[connector] || connector
  const address = endpoint(connection.baseUrl) || '未配置接入地址'
  if (connector === 'http') return record(field, '只读 HTTP 接口',
    `${name} · 基地址 ${address} · ${method} ${endpoint(binding.apiPath) || '未配置路径'}`,
    'connection.baseUrl / apiPath', '现有后台只读查询；认证头、密码、令牌和请求体不在来源说明中展开', scope)
  const locator = ['mqtt', 'redis'].includes(connector) && binding.apiPath && binding.apiPath !== '/'
    ? binding.apiPath : connection.healthPath
  const detail = connector === 'mqtt' ? `订阅主题 ${transportLocator(locator) || '未配置主题'}`
    : connector === 'redis' ? `只读 GETRANGE 键 ${transportLocator(locator) || '未配置键名'}（范围 0..262144）`
      : connector === 'file' ? `已导入的只读文件；工作表配置 ${text(connection.healthPath) || '默认工作表'}`
        : connector === 'udp' ? '本机 UDP 接收；接收端口可用不等于发送端在线'
          : connector === 'tcp' ? '仅接收当前连接提供的数据帧'
            : connector === 'websocket' ? '仅接收 WebSocket 消息' : '以现有连接适配器的读取规则为准'
  return record(field, connector === 'file' ? '已导入数据文件' : `只读 ${protocol} 接入`,
    `${name} · ${protocol} ${address} · ${detail}`, 'connection.connector / baseUrl / healthPath',
    '不是 HTTP GET；由现有后台适配器按需只读采样，不发送发布 / 写入指令', scope)
}

function datasetProvenance(field, binding, table, fields, options, scope) {
  if (!table) return []
  const rows = [], connection = connectionFor(table.connectionId, options), root = `datasets.${table.id || binding.datasetId}`
  if (table.source === 'database') {
    const definition = table.database || {}, schema = definition.schema || connection?.defaultSchema || ''
    rows.push(record(`${field} · 实际来源`, '只读数据库',
      `${connectionLabel(connection, table.connectionId)}${connection?.type ? ` · ${connection.type}` : ''} · ${[schema, definition.table].filter(Boolean).join('.') || '未配置实际表'}`,
      `${root}.connectionId / database.schema / database.table`,
      `${definition.orderBy ? `按 ${definition.orderBy} ${definition.orderDirection === 'asc' ? '升序' : '降序'}读取；` : '按现有数据表查询顺序读取；'}最多映射前 100 条返回记录；数据库账户及连接密码不展示`, scope))
  } else if (table.source === 'http' || table.source === 'http_api') {
    rows.push(apiProvenance(`${field} · 实际来源`, { connectionId: table.connectionId, apiPath: table.request?.path || '/' }, connection, scope, table.request?.method === 'POST' ? 'POST' : 'GET'))
    rows.push(record(`${field} · 结果根节点`, '返回内容映射',
      table.rootPath ? `返回内容中的 ${table.rootPath}` : '完整返回内容；数组逐行映射，对象作为一行', `${root}.rootPath`,
      '先定位根节点、匹配当前对象，再映射前 100 条记录；根节点不存在时读取失败', scope))
    if ((connection?.connector || 'http') === 'http') for (const parameter of array(table.request?.parameters)) {
      rows.push(record(`${field} · 查询参数 ${credentialName(parameter.name) ? '认证参数（已隐藏）' : parameter.name || '未配置'}`, '保存的参数来源',
        credentialName(parameter.name) ? '认证参数不在来源说明中展开'
          : `${parameter.in || 'query'} · ${parameter.source === 'context' ? `当前场景 context.${parameter.key}` : parameter.source === 'parameter' ? `全局参数 parameters.${parameter.key}` : '固定参数（值不展开）'} · ${parameter.required === false ? '可选' : '必填'}`,
        `${root}.request.parameters`, '运行时按已保存的参数映射构造只读查询；此处不取参数值、不展示请求头 / 请求体', scope))
    }
  } else rows.push(record(`${field} · 实际来源`, '来源元数据未提供',
    '当前数据表目录未提供底层接入类型和连接；不能仅凭逻辑表名宣称来自 PLC、数据库或 HTTP', `${root}.source / connectionId`,
    '需在数据表定义中查看实际连接；这里不推测来源', scope))
  if (table.match?.field) rows.push(record(`${field} · 记录匹配`, '当前对象 / 参数筛选',
    `${table.match.field} = ${table.match.contextKey === 'parameter' ? `parameters.${table.match.parameterKey || '未配置'}` : `context.${table.match.contextKey || '未配置'}`}`,
    `${root}.match`, '缺少必需对象 / 参数或匹配多条记录时读取失败，不改用其他对象', scope))
  for (const name of fields) {
    const column = array(table.columns).find(column => column.name === name)
    if (!column) continue
    rows.push(record(`${field} · 原始字段 ${name}`, '返回字段映射',
      `${column.path || '未提供原始字段路径'} → ${column.name}`, `${root}.columns.${name}.path`,
      '读取该原始路径，不按输出列名另找点位或字段；缺失 / 类型不符时数据表质量为异常', scope))
    const scale = column.scale == null || column.scale === '' || !Number.isFinite(Number(column.scale)) ? 1 : Number(column.scale)
    const offset = column.offset == null || column.offset === '' || !Number.isFinite(Number(column.offset)) ? 0 : Number(column.offset)
    rows.push(record(`${field} · 字段转换 ${name}`, column.type === 'number' ? '计算结果' : '字段类型转换',
      column.type === 'number' ? `输出 ${name} = Number(原始字段) × ${scale} + ${offset}`
        : column.type === 'boolean' ? 'true / 1 / "1" / "true" → true；false / 0 / "0" / "false" → false；其他非空值无效'
          : '原始字段转文字；对象转 JSON，日期转 ISO；文字最多 2000 字符', `${root}.columns.${name}.type / scale / offset`,
      '空值保留为空；无效转换不生成正常读数；单位是该输出字段另行配置的元数据', scope))
    if (column.unit) rows.push(fixed(`${field} · 输出字段单位 ${name}`, `${root}.columns.${name}.unit`, column.unit))
  }
  const mode = binding.datasetMode || 'first'
  const aggregation = { first: '主列取映射后第一行的值（不改取第一条有效数值）', count: '主值统计映射后记录行数（不是非空数值数）',
    sum: '主列有限数值求和', avg: '主列有限数值之和 ÷ 有效数值数量', min: '主列有限数值的最小值', max: '主列有限数值的最大值' }[mode] || '以现有主列读取模式为准'
  rows.push(record(`${field} · 读取 / 聚合规则`, ['sum', 'avg', 'min', 'max', 'count'].includes(mode) ? '计算结果' : '映射后记录读取',
    `${aggregation}；数值转换先于聚合；附加曲线列的概要值取各列首行，不应用主列聚合；单位仍由主字段提供`,
    'data.datasetMode / data.datasetField / data.datasetFields', '数据表质量异常时主值为空；无有效数值时数值聚合为空，不补零', scope))
  return rows
}

function sourceTrace(field, binding, options, owner = '') {
  if (!binding) return [record(field, '缺少来源', '该设备未选择对应数据', '', '不读取其他设备或旧值', owner)]
  const scope = owner || scopeLabel(binding), mode = binding.mode || (binding.path || binding.source ? 'runtime' : 'static')
  if (mode === 'plc') {
    const point = array(options.points).find(point => text(point.id) === text(binding.pointId))
    const owned = point && (!binding.deviceId || text(point.device_id) === text(binding.deviceId))
    return [record(field, owned ? '设备采集点位' : '缺少来源', owned
      ? `${point.label || point.name || point.id} · ${point.plc_tag || '未配置地址'}${point.unit ? ` · ${point.unit}` : ''}`
      : binding.pointId ? `点位 ${binding.pointId} 不存在或不属于清单设备` : '未明确选择点位，不按名称猜地址',
    `pointId=${binding.pointId || '未配置'}`, '实时采集帧；具体读数和质量见下方设备清单', scope)]
  }
  if (mode === 'dataset') {
    const table = array(options.datasets).find(table => table.id === binding.datasetId)
    // bindingResult reads at most twelve deduplicated columns, including the
    // required main field. An empty in-range column fails the complete adapter.
    const selected = [...new Set([binding.datasetField, ...array(binding.datasetFields)])], fields = selected.slice(0, 12)
    const columns = array(table?.columns), mainColumn = columns.find(column => column.name === binding.datasetField)
    const failure = !table ? '数据表未配置，本次读取失败，不生成数值或图表序列'
      : !mainColumn ? '主绑定字段未选择或不存在，本次读取失败，不生成数值或图表序列；不回退首列或附加列'
        : fields.some(name => !columns.some(column => column.name === name)) ? '所选图表数值列有空项或不存在，本次读取失败，不生成数值或图表序列；不跳过非法列' : ''
    const rows = fields.map((name, index) => {
      const column = columns.find(column => column.name === name)
      return record(fields.length > 1 ? `${field} · 字段 ${name || '未配置'}` : field, table && column ? failure ? '读取不可用' : '数据表字段' : '缺少来源',
        `${table?.name || binding.datasetId || '未选择数据表'} · ${column?.label || name || '未选择字段'} · ${index ? '附加曲线列（概要值为首行）' : binding.datasetMode || 'first'}`,
        `datasetId=${binding.datasetId || '未配置'} / ${name || '未配置'}`,
        `现有只读数据表刷新（${(binding.refreshMs || 5000) / 1000} 秒）；${failure || (table?.enabled === false ? '该数据表已停用' : '保存并发布后按同一绑定读取')}`, scope)
    })
    if (selected.length > fields.length) rows.push(record(`${field} · 保留字段`, '当前未启用配置',
      `${selected.slice(12).map(name => name || '未配置').join('、')} 超出序列上限；当前只读取去重后的前 12 列（含主字段）`,
      'data.datasetFields', '超出上限的配置不会生成额外序列或参与本次字段校验', scope))
    return [...rows, ...datasetProvenance(field, binding, table, fields, options, scope)]
  }
  if (mode === 'database') {
    const sources = array(binding.datasets).length ? binding.datasets : [binding]
    const rows = sources.map((source, index) => {
      const connection = connectionFor(source.connectionId, options)
      return record(`${field} · ${source.alias || index + 1}`, '只读数据库',
        `${connectionLabel(connection, source.connectionId)}${connection?.type ? ` · ${connection.type}` : ''} · ${[source.schema || connection?.defaultSchema, source.table, source.field].filter(Boolean).join('.') || '未选择表 / 字段'}`,
        [source.table, source.field].filter(Boolean).join('.'), `按 ${source.valueMode || 'latest'} 读取；随配置的刷新周期更新`, scope)
    })
    if (binding.formula) rows.push(record(`${field} · 公式`, '计算结果', binding.formula, 'data.formula', '使用上述数据项计算，不另接采集源', scope))
    return rows
  }
  if (mode === 'http_api') {
    // Legacy http_api bindings normalize to GET; a dataset may separately
    // authorize POST queries. Non-HTTP adapters ignore that HTTP method.
    const provenance = apiProvenance(`${field} · 实际接入`, binding, connectionFor(binding.connectionId, options), scope)
    return [record(field, provenance.origin, `${provenance.source} · 返回字段 ${binding.jsonPath || '未配置'}`, binding.jsonPath || '未配置 JSON 字段',
      '由现有后台按同一接入和 JSON 字段读取；连接凭据不在来源说明中展示', scope), provenance]
  }
  if (mode === 'business') return [record(field, '业务数据库区块',
    `只读连接 ${binding.connectionId || '未配置'} · ${binding.businessSection || 'batches'}`, 'data.businessSection', '跟随现有业务区块刷新', scope)]
  if (mode === 'runtime' || binding.path || binding.source) return [runtimeSource(field, binding.path || binding.source, binding, options)]
  return [fixed(field, 'content.value', options.content?.value)]
}

function bindingTrace(field, binding, options, describe = sourceTrace) {
  if (binding?.bindingVersion !== 2 || binding.deviceScope === 'global' || binding.mode === 'static') return describe(field, binding, options)
  const rows = array(binding.deviceBindings).filter(row => binding.deviceScope !== 'fixed' || text(row.deviceId) === text(binding.deviceId))
  if (!rows.length) return [record(field, '缺少来源', '没有明确设备与对应数据', 'data.deviceBindings', '不自动轮播或替代', scopeLabel(binding))]
  return rows.flatMap(row => {
    const device = array(options.devices).find(device => text(device.id) === text(row.deviceId))
    const owner = device?.name || `设备 ${row.deviceId || '未配置'}`
    return describe(`${field} · ${owner}`, row.binding ? { ...binding, ...row.binding, deviceId: row.deviceId } : null, options, owner)
  })
}

function metricBindingTrace(field, binding, primary, options, describe = sourceTrace) {
  if (binding.mode === 'static') return describe === sourceTrace
    ? [record(field, '停用的指标来源', '指标保留绑定配置但当前不读取；显示已配置的空值文字', 'content.items.binding', '重新选择指标来源后恢复读取')]
    : describe(field, binding, options)
  if (binding.deviceScope === 'global') return bindingTrace(field, binding, options, describe)
  if (primary.deviceScope === 'global') {
    if (binding.deviceScope === 'fixed') {
      if (!array(options.devices).some(device => text(device.id) === text(binding.deviceId || ''))) return [record(field, '缺少来源',
        '指标指定设备未在当前设备目录中确认；工厂范围主卡不会另选设备替代', 'content.items.binding.deviceId', '设备不存在时不读取保留点位或旧值')]
      return bindingTrace(field, binding, options, describe)
    }
    const source = bindingForDevice(binding, '')
    if (source.bindingMissing || isDeviceBinding(source)) return [record(field, '缺少来源',
      '工厂范围主卡没有所选设备；此指标需选工厂范围数据或明确指定设备', 'content.items.binding', '不会从保留设备映射中自动选一台')]
    return describe(field, source, options)
  }
  const scope = primary.bindingVersion === 2 ? primary.deviceScope : normalizePlayback(primary).deviceScope
  if (primary.bindingVersion !== 2) {
    if (binding.bindingVersion !== 2 && !isDeviceBinding(binding)) return bindingTrace(field, binding, options, describe)
    // Legacy detail/inspection scenes override a fixed main card. The designer
    // provides no scene device or rotation phase, so neither can be invented.
    if (scope !== 'fixed' || /^device_/.test(options.viewId || '') || binding.bindingVersion !== 2) {
      const rows = [record(field, '跟随主卡设备',
        '指标跟随旧版主卡的场景设备 / 设备清单选择；指标自身固定设备不覆盖主卡。当前场景设备或轮播相位未提供，须在运行时按主卡实际设备确定来源',
        'data.deviceScope / context.deviceId / content.items.binding', '设备 / 检查视角以场景设备为准；这里不猜第一台设备或当前轮播行', '运行时主卡设备')]
      if (array(binding.deviceBindings).length) rows.push(record(`${field} · 保留映射`, '待运行上下文确认',
        `${array(binding.deviceBindings).map(row => array(options.devices).find(device => text(device.id) === text(row.deviceId))?.name || row.deviceId).join('、')} 的来源配置仍保留，仅在主卡实际选择对应设备时读取；这里未确认当前设备行`,
        'content.items.binding.deviceBindings', '按运行时主卡所选设备匹配，不按指标自身固定设备另选'))
      return rows
    }
  }
  const ids = scope === 'fixed' ? [text(primary.deviceId)].filter(Boolean) : array(primary.deviceBindings).map(row => text(row.deviceId))
  if (scope === 'fixed' && !array(options.devices).some(device => text(device.id) === ids[0])) return [record(field, '缺少来源',
    '主卡指定设备未在当前设备目录中确认；此指标不改用自己的指定设备或其他保留映射', 'data.deviceId / content.items.binding', '主卡设备不存在时不读取指标行')]
  const effective = { ...binding, deviceScope: scope, deviceId: primary.deviceId }
  if (binding.bindingVersion === 2) effective.deviceBindings = ids.map(deviceId => array(binding.deviceBindings).find(row => text(row.deviceId) === deviceId) || { deviceId, binding: null })
  const rows = bindingTrace(field, effective, options, describe)
  if (primary.bindingVersion !== 2) for (const row of rows) row.updates += '；这里列主卡固定配置，设备 / 检查视角运行时以场景所选设备为准'
  const inactive = array(binding.deviceBindings).filter(row => !ids.includes(text(row.deviceId)))
  if (inactive.length) rows.push(record(`${field} · 保留映射`, '当前未启用配置',
    `${inactive.map(row => array(options.devices).find(device => text(device.id) === text(row.deviceId))?.name || row.deviceId).join('、')} 的来源仍保留，但当前主卡设备清单不会读取这些行`,
    'content.items.binding.deviceBindings', '主卡设备清单变化后再按明确对应读取'))
  return rows
}

function chartFieldTrace(content) {
  const type = content.chartType, value = content.valueField || 'value'
  if (type === 'gauge') return record('图表字段 / 当前值 / 区间值', '主来源及采样窗口',
    '仪表读数使用上面的主数据值；min / max 是固定展示范围', 'data / content.min / content.max', '随上述数据源与采样窗口更新')
  const extended = ['pie','donut','rose','funnel','radar','heatmap','candlestick','boxplot','waterfall','horizontalBar','lineBar','smoothLine','stepLine','stackedArea'].includes(type)
  const category = extended ? content.categoryField || content.timeField || 'time' : content.timeField || 'time'
  let mapping = `${category} → ${value}`, path = extended ? 'content.categoryField / content.timeField / content.valueField' : 'content.timeField / content.valueField'
  if (type === 'scatter' && content.xField) {
    mapping = `${content.xField} → ${value}`; path = 'content.xField / content.valueField'
  } else if (type === 'heatmap') {
    mapping = `${content.xField || 'x'} × ${content.yField || 'y'} → ${content.heatValueField || value}`
    path = 'content.xField / content.yField / content.heatValueField / content.valueField'
  } else if (type === 'candlestick' || type === 'boxplot') {
    const fields = type === 'candlestick' ? [content.openField || 'open', content.closeField || 'close', content.lowField || 'low', content.highField || 'high']
      : [content.lowField || 'min', content.q1Field || 'q1', content.medianField || 'median', content.q3Field || 'q3', content.highField || 'max']
    mapping = `${category} → [${fields.join(', ')}]（${type === 'candlestick' ? '开盘 / 收盘 / 最低 / 最高' : '最低 / 下四分位 / 中位 / 上四分位 / 最高'}）`
    path = `content.categoryField / content.timeField / ${type === 'candlestick' ? 'content.openField / content.closeField / content.lowField / content.highField' : 'content.lowField / content.q1Field / content.medianField / content.q3Field / content.highField'} / content.valueField`
  } else if (type === 'radar') {
    mapping = `${category} → 各实际序列的 field（缺省用 id）对应数值；至少 3 个序列，仅显示各维均有有效数值的前 20 行`
    path = 'content.categoryField / content.timeField / sourceSeries.field / sourceSeries.id / content.valueField'
  }
  return record('图表字段 / 当前值 / 区间值', '主来源及采样窗口',
    `${mapping}；区间最低 / 最高按 ${value} 的当前采样窗口计算`, path, '随上述数据源与采样窗口更新')
}

function unitTrace(binding, content, field = '主数据单位') {
  if (binding.unit) return [fixed(`${field}（覆盖来源单位）`, 'data.unit / deviceBindings.binding.unit', binding.unit)]
  if (binding.unitPath || content.unitPath) {
    const row = runtimeSource(field, binding.unitPath || content.unitPath, binding)
    row.updates += '；主数据显示单位：固定 data.unit 优先，其次单位路径；路径返回空 / 假值时再用实际点位或数据表字段单位'
    return [row]
  }
  if (binding.mode === 'plc' || binding.mode === 'dataset') return [record(field, '来源字段元数据', '使用该行实际点位 / 数据表输出的单位，不另读数值', 'point.unit / dataset.unit', '来源或字段配置变化时更新')]
  return []
}

function metricUnitTrace(item, index, primary, options, defaults = false) {
  const field = `指标 ${index + 1} · ${item.label || '未命名'} · 单位`, path = `content.items[${index}]`
  const rows = [record(`${field}优先级`, '显示单位规则',
    '指标项 unitPath 优先于该行 binding.unitPath；存在单位路径时读取其值，不使用 binding.unit；无路径才用 binding.unit，最后以 item.unit 回退。路径 / 绑定单位为 null 或 undefined 才回退，空字符串明确不加单位；指标不自动采用点位元数据单位',
    `${path}.unitPath / binding.unitPath / binding.unit / unit`, '仅格式化指标的同一数值；不产生新的采集值', scopeLabel(primary))]
  if (item.unit !== undefined && item.unit !== null) rows.push(fixed(`${field}固定回退`, `${path}.unit`, item.unit, defaults))
  const describe = (label, source, sourceOptions, owner = '') => {
    const unitPath = item.unitPath || source?.unitPath
    if (unitPath) {
      const row = runtimeSource(label, unitPath, source || primary, sourceOptions)
      row.updates += '；在该指标实际所选设备 / 上下文中读取；空字符串保留为空，null / undefined 才回退固定 item.unit'
      return [row]
    }
    if (source?.unit !== undefined && source?.unit !== null) {
      const row = fixed(label, `${path}.binding.unit / deviceBindings.binding.unit`, source.unit)
      row.scope = owner || scopeLabel(source)
      row.updates += source.unit === '' ? '；绑定明确为空字符串，显示时不回退 item.unit' : '；覆盖固定 item.unit，不自动换用点位单位'
      return [row]
    }
    return [record(label, item.unit == null ? '无显示单位' : defaults ? '内置文字' : '固定配置',
      item.unit == null ? '该指标没有独立单位配置；不会按点位单位另加后缀' : item.unit === '' ? '固定单位为空，不加后缀' : text(item.unit),
      `${path}.unit`, '单位仅来自上述格式配置，不作为采集读数', owner || scopeLabel(primary))]
  }
  rows.push(...(item.binding ? metricBindingTrace(field, item.binding, primary, options, describe) : describe(field, null, options)))
  return rows
}

function metricAuxiliaryTrace(field, path, binding, primary, options) {
  const describe = (label, source, sourceOptions) => [runtimeSource(label, path, source || primary, sourceOptions)]
  return binding ? metricBindingTrace(field, binding, primary, options, describe) : describe(field, null, options)
}

function navigationTrace() {
  return [
    record('导航组件渲染面', '实际宿主显示条件',
      '设计器使用 WidgetRenderer 固定预览；透明 Overlay 单独接管 navigation / return_button，不用 runtimeTarget 判断。原生 OnGUI 仅在有相机、未被 Web Overlay 接管、showHeader 启用且组件当前可见时绘制；此处没有宿主状态，不能断言当前是哪一面',
      'WidgetRenderer / DashboardOverlay.navigationWidgets / FactoryDashboardController.OnGUI', '随宿主、当前视角和组件显隐配置改变；这里只解释条件，不猜当前渲染面'),
    record('导航预览圆点颜色', '内置样式', '#4fd29a', 'WidgetRenderer .navigation-preview-dot',
      '仅预览 CSS / 程序版本变化时更新；编辑状态文字或点位不会改变此固定颜色', '设计器预览'),
    record('导航状态文案颜色', '内置样式', '#f5b95e', 'WidgetRenderer .navigation-preview-status strong',
      '仅预览 CSS / 程序版本变化时更新；编辑状态文字或点位不会改变此固定橙色', '设计器预览'),
    record('透明 Overlay 状态文案颜色', '内置样式', '#ffc45f', 'DashboardOverlay .overlay-status strong / --overlay-warm',
      '取透明 Overlay 内置 --overlay-warm；随对应样式代码 / 程序版本变化，不等同设计器的 #f5b95e，也不随连接健康变色', '透明 Overlay'),
    record('透明 Overlay 导航圆点', '健康与宿主状态计算',
      'health.readiness.displayReady && hostConnected 为真时绿色，否则红色；hostConnected 初始 false，overlay_host_state.visible !== false 或启动完成置为 true，不等同 DataStore.wsConnected',
      'health.readiness.displayReady / hostConnected', '随现有健康检查、Overlay 宿主状态消息和启动阶段更新；不会因此自动改写固定项目 / 状态文案'),
    record('透明 Overlay 状态提示', '健康检查结果',
      '悬停提示读取 health.components.backend / database / unity.status 及 health.components.dataEngine.fresh',
      'health.components / health.components.dataEngine.fresh', '健康检查刷新时更新；与固定状态文字、固定橙色字色分开'),
    record('原生顶部工厂名称', '工厂目录 / 设置与运行内存',
      '/api/config 先合并全局及工厂设置，再由当前 factories.name 覆盖 settings.factory_name。原生只接受非空白新名称；初值为内置标题，后续缺失 / 空白保留既有名称，可能是上一工厂名，不保证重新回退内置标题',
      '/api/config.settings.factory_name / factories.name / _factoryName', '仅原生头部绘制时显示；工厂配置载入或 settings 更新后应用；文字色为固定 Muted'),
    record('原生后台 / PLC 状态文字', 'WebSocket 状态与 PLC 消息',
      '后台值来自 RealtimeWebSocketClient.ConnectionStateChanged；PLC 采用 payload.status ?? payload.message ?? "updated"，status 优先。原生这两个值不读取 health.displayReady 或 engine.mode',
      'BackendState / PlcState', '仅原生头部绘制时更新；空白状态由 setter 变为 unknown，不是自动“正常”'),
    record('原生状态文字 / 色条', '现有状态映射规则',
      'FriendlyState 文案依次匹配 connected / online / running → 正常、simulat → 模拟、connect → 连接中、bad / offline / error → 异常；其余保留原值（最多 8 字），没有 retry 文案分支。StateColor 把 connected / online / running / simulat 设为 Good、connect / retry 设为 Warning、bad / offline / error 设为 Bad，其余 Accent。现有包含匹配会把 disconnected 也先匹配为正常 / Good，不能把该颜色当作已验证健康；背景取同色 × 0.25，边条与文字取同色',
      'FactoryDashboardController.FriendlyState / StateColor', '仅解释现有原生规则，不修改状态映射；未知状态显示截短原值并使用 Accent')
  ]
}

function eventTrace(widget, type, options) {
  const events = Array.isArray(widget.events) ? widget.events : array(widget.config?.events), controls = ['navigation', 'return_button'].includes(type)
  const rows = []
  if (controls) {
    const clicks = events.filter(event => (event.trigger || 'click') === 'click')
    rows.push(record('控件点击目标优先级', '保存的交互配置 / 默认行为', clicks.length
      ? `存在 ${clicks.length} 个 click 事件，按顺序执行全部匹配事件；不执行控件默认点击行为`
      : type === 'return_button' ? '没有 click 事件时走当前视角返回链；不是自动返回工厂'
        : '没有 click 事件时只选择并短暂高亮该导航组件（约 900ms），不自动返回工厂',
    'events / config.events / activateControl', '透明 Overlay 仅匹配 click（缺省也为 click）；显式 events=[] 会遮住旧 config.events，不另找旧点击事件'))
  }
  for (const [index, event] of events.entries()) {
    const field = `交互事件 ${index + 1} · ${event.trigger || 'click'}`, action = event.action || '未配置'
    let target
    if (action === 'switch_view') target = event.viewId ? `指定视角 ${event.viewId}` : '未配置 viewId，现有处理器不切换视角'
    else if (action === 'enter_device' || action === 'focus_line' || action === 'focus_workshop') {
      const key = action === 'enter_device' ? 'deviceId' : action === 'focus_line' ? 'lineId' : 'workshopId'
      const device = key === 'deviceId' ? array(options.devices).find(device => text(device.id) === text(event[key])) : null
      target = `${event[key] ? `保存的 ${key}=${device?.name || event[key]}` : `未固定 ${key}`}；目标依次取事件 ID、所选视角 targetId、对应当前场景上下文。视角优先取事件 viewId，再该模式视角，再现有首视角；由 Unity 确认实际目标与祖先`
    } else if (action === 'focus_factory') target = '当前工厂场景；优先事件 viewId，其次工厂模式视角，不改成另一采集工厂'
    else if (action === 'open_link') target = /^https?:\/\//i.test(event.url || '') ? `打开 ${endpoint(event.url)}` : '未提供 HTTP(S) 地址，现有处理器不打开'
    else if (action === 'set_parameter') target = `parameters.${event.parameterKey || '未配置'}，值来自保存的 event.value（此处不展开）`
    else if (action === 'reset_parameters') target = '设计器“接口与参数”中保存的参数默认值'
    else if (action === 'refresh_data') target = '现有数据刷新入口，不生成新点位或写 PLC'
    else if (action === 'switch_scene') target = event.sceneId ? `场景 ${event.sceneId} 的最新发布版本` : '未配置 sceneId，不切换场景'
    else if (action === 'set_visibility' || action === 'toggle_visibility') target = event.targetId
      ? `${event.targetType === 'widget' ? '组件' : '分组'} ${event.targetId}；${action === 'toggle_visibility' ? '切换其显隐' : event.visibility === 'hide' ? '隐藏' : '显示'}，不是采集字段`
      : '未配置 targetId，不改变显隐'
    else if (action === 'play_voice') target = `${event.audioUrl ? `保存的音频地址 ${endpoint(event.audioUrl)}` : '未配置音频地址'}；文本来自 event.text（不在此展开），以 auto 模式交给现有语音入口；已静音时不播放`
    else target = '现有事件处理器中的同名动作；未识别时不推测目标或执行结果'
    rows.push(record(field, '保存的交互配置', `${action} · ${target}`, `events[${index}]`,
      controls && (event.trigger || 'click') !== 'click' ? '透明 Overlay 的此控件面不处理该非 click 事件'
        : '运行交互时执行所有同 trigger 事件；设计器非交互预览不执行；来源说明本身不会触发事件'))
  }
  return rows
}

export function systemSourceTrace() {
  return [
    record('系统顶部工厂名称', '工厂目录 / 设置与渲染面',
      '当前 factories.name 优先，经 /api/config.settings.factory_name 传给原生宿主；原生未收到非空新名称时保留既有标题。透明 Overlay / 设计器导航文案另外来自 content.projectLabel，不随这个值自动改变',
      'factories.name / settings.factory_name / content.projectLabel', '切换工厂或刷新设置后按实际渲染面应用；此处不猜宿主当前显示面', '当前工厂'),
    record('系统顶部采集 / 连接状态', '数据层健康与连接状态',
      'DataStore.plcStatusText 会被 /api/health 和 /ws PLC 消息共同覆盖，以最后一次写入为准。health 就绪时 engine.mode 仅等于 simulation 才标模拟，其他 / 缺省标实时；JS PLC 消息采用 message || status，message 优先。这不是原生头部 BackendState / PlcState 的同一映射',
      'dataStore.plcStatusText / /api/health / /ws', '健康检查每 5 秒；连接消息到达时更新，后到的消息可覆盖先前健康文案，不能仅凭该文字认定就绪', '当前工厂 / 后台'),
    record('当前视角 / 当前设备', '场景上下文', 'Unity / 原生场景已确认的视角与所选设备，不由点位值推测', 'context.viewId / context.deviceId', '导航或点选场景对象时更新', '当前视角'),
    record('系统时钟', '本机时间', 'Web 数据层读取本机 Date；原生头部在 OnGUI 中逐帧读取 DateTime.Now（yyyy-MM-dd HH:mm:ss），不是 PLC 时间，也不来自未挂载的旧 App.vue 页面',
      'Date / FactoryDashboardController.DateTime.Now', '随各自现有时钟 / 绘制机制更新；原生仍受头部显示门控制', '本机'),
    ...navigationTrace().filter(row => !['导航预览圆点颜色', '导航状态文案颜色'].includes(row.field))
  ]
}

export function widgetSourceTrace(widget = {}, options = {}) {
  const content = widget.content || widget.config || {}, data = widget.data || widget.binding || {}, type = widget.type || widget.widget_type
  options = { ...options, content }
  const rows = [], push = values => rows.push(...values)
  const title = widget.title ?? content.title ?? ''
  if (title) rows.push(fixed('组件标题', widget.title != null ? 'title' : 'content.title', title))
  if (type === 'navigation') {
    rows.push(fixed('导航组件项目文案', 'content.projectLabel', content.projectLabel), fixed('导航组件状态文案', 'content.statusText', content.statusText))
    rows.push(record('系统状态栏与组件文案的区别', '来源说明', '此组件字段在透明 Overlay / 设计器中是固定文案；原生 OnGUI 的工厂名和状态另走条件显示链，见下面各渲染面及“系统信息来源”', 'content', '不把固定文案或固定颜色伪称为实时采集'))
    push(navigationTrace())
  } else if (type === 'return_button') rows.push(record('返回目标', '视角编排 / 交互事件',
    '已配置 click 事件优先。没有 click 时：非设备根视角先走层级 / 分组返回；设备 / 部件通过 /api/native-preview/navigate 的 deviceBackRequest 交给 Unity；其他视角先用已确认设备返回来源，再 returnViewId / parentViewId，最后旧版模式返回映射，不保证返回工厂',
    'events / runtimeContext / scene.views.returnViewId / parentViewId / deviceBackRequest', '由运行时层级与 Unity 确认目标；设计器没有当前导航历史，不编造具体返回设备或视角'))
  else if (['device_label', 'diagnostics', 'line_overview_cards'].includes(type)) rows.push(record('旧版原生运行组件', 'Unity 运行资料', '设备配置、采集状态与场景对象；这类旧组件不由静态 data 字段提供内容', 'runtimeTarget=unity', '随原生场景和采集状态更新'))
  else if (['alarm_list', 'hud_alarm_panel', 'marquee'].includes(type)) {
    const external = ['dataset', 'database', 'http_api'].includes(data.mode)
    push(external ? bindingTrace('报警 / 事件列表', data, options) : [runtimeSource('报警 / 事件列表', data.source || data.path || 'events', data, options)])
    rows.push(record('事件筛选范围', '保存的筛选配置', `${content.eventFilters?.scope === 'current' ? '仅当前查看设备；未选设备时为空' : '当前工厂 / 来源返回的记录'} · ${content.eventFilters?.level || '全部级别'}`, 'content.eventFilters', '筛选真实记录，不生成示例报警'))
    rows.push(record('时间范围来源', external ? '外部数据表 / 接口定义' : '共享事件查询窗口', external
      ? '由所选表或接口的查询定义筛选时间；本组件不另外裁剪为 24 小时'
      : '运行时共享查询按当前可见消息滚动条的 eventWindowHours / windowHours 设置（默认 24 小时）；不是本报警面板单独的时间裁剪',
    external ? '数据表查询 / 接口参数' : 'marquee.content.eventWindowHours / /api/platform/events', '跟随实际源查询的时间条件更新'))
  } else if (['device_list', 'hud_device_status'].includes(type)) {
    push(data.mode === 'dataset' ? bindingTrace('设备列表', data, options) : [record('设备名称 / 运行状态 / 温度', '设备配置及实时采集', '已配置设备 + deviceStatusMap，使用当前工厂设备列表', 'deviceCatalog / deviceStatusMap', '设备配置和质量正常的实时帧更新', '当前工厂')])
    rows.push(record('在线 / 报警计数', '列表计算结果', '对完整源设备列表统计（deviceIds / 显示数量过滤之前），不是仅统计可见卡片，不另取隐藏点位', 'hudDeviceCounts', '源设备列表变化时重算'))
    if (type === 'hud_device_status') rows.push(record('设备卡片点击目标', '保存的设备交互 / 默认行为',
      '优先 content.deviceActions[该设备 ID] 中全部 click 事件；没有匹配项时 enter_device 使用所点击行的 device.id，不读取别的设备 ID',
      'content.deviceActions / device.id', '仅实际设备卡片交互时触发；来源说明不执行导航'))
  } else if (type === 'business_summary') {
    push(['dataset', 'business'].includes(data.mode) ? bindingTrace('业务记录', data, options) : [record('业务记录', '现有只读业务区块',
      '后台业务数据服务提供的记录；未配置或不可用时显示未提供，不生成业务数据', `businessData.sections.${content.section || data.businessSection || 'batches'}`, '跟随现有后台业务读取', scopeLabel(data))])
  } else if (type === 'filter') rows.push(record('筛选控件值', '全局参数', `关联参数 ${content.parameterKey || '未配置'}；选项文字来自 content.options`, 'parameters / content.options', '用户选择或软件接口更新参数时更新'))
  else if (type === 'container') rows.push(record('容器布局与外观', '保存的布局与样式',
    '容器负责组件分组、位置、尺寸和外观，不独立显示采集数值；子组件的数据与文字请各自查看来源',
    'layout / style / style.viewOverrides', '编辑保存或切换视角继承样式时更新', '当前视角'))
  else push(bindingTrace('主数据', data, options))

  if (type === 'text') {
    const rawText = Array.isArray(content.lines) ? content.lines.join('\n') : content.text || content.label || ''
    const value = rawText || title || '文本组件'
    rows.push(fixed(data.mode === 'dataset' && content.datasetTextMode !== 'template' ? '文本模板（当前显示数据值，未启用模板）' : '固定文本 / 格式模板', 'content.lines / content.text', value))
    if (text(value).includes('{value}')) rows.push(record('文本中的 {value}', '主数据格式化', '使用上面主数据的实际值；应用小数位、值映射及空值文字', 'data / content.valueMap / content.fallback', '随主数据更新'))
    for (const key of new Set([...text(value).matchAll(/\{parameters\.([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]))) rows.push(runtimeSource(`文本参数 ${key}`, `parameters.${key}`))
  }
  if (type === 'image') rows.push(content.url ? fixed('实际图片地址（优先于主数据）', 'content.url', endpoint(content.url)) : record('实际图片地址', '主数据字符串', '主数据为字符串时用作图片地址', 'data', '随主数据更新'))

  if (['metrics', 'hud_kpi_panel'].includes(type)) {
    const defaults = [{ label: '今日产出', path: 'metrics.current_output' }, { label: '完成进度', path: 'metrics.progress_percent', unit: '%' }, { label: '能耗估算', path: 'metrics.energy_consumption' }, { label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' }]
    const items = Array.isArray(content.items) ? content.items : defaults
    for (const [index, item] of items.entries()) {
      const label = `指标 ${index + 1} · ${item.label || '未命名'}`
      push(item.binding ? metricBindingTrace(label, item.binding, data, options) : item.path ? [runtimeSource(label, item.path, data, options)] : [fixed(label, `content.items[${index}].value`, item.value)])
      for (const [key, name] of [['labelPath', '名称'], ['suffixPath', '后缀']]) if (item[key]) push(metricAuxiliaryTrace(`${label} · ${name}`, item[key], item.binding, data, options))
      push(metricUnitTrace(item, index, data, options, !Array.isArray(content.items)))
      if (item.suffixPath) rows.push(fixed(`${label} · 分隔符`, `content.items[${index}].separator`, item.separator || '', !Array.isArray(content.items)))
    }
    if (content.usePartPoints) rows.push(record('自动列出的部件指标', '明确关联部件点位', '当前部件检查配置中关联的前 6 个点位，读取其值 / 单位 / 质量', 'selectedPart.points', '选中部件 / 采集帧更新时变化，不读其他部件'))
    const hud = type === 'hud_kpi_panel', ringVisible = hud ? content.showRing !== false : content.layout !== 'list'
    const shared = hud || !!widgetSurfacePresentation(resolveWidgetViewStyle(widget.style || content.style || {}, options.viewId || ''), content.lineColor).skin
    if (ringVisible) push(shared && content.useBoundRing ? [record('圆环读数', '主数据', '使用上面的同一主数据值；质量异常时为空', 'content.useBoundRing', '随主数据更新')] : [runtimeSource('圆环读数', content.chartPath || 'metrics.overall_oee', data, options)])
  }
  if (['trend', 'hud_chart_dock'].includes(type)) {
    if (!['dataset', 'database', 'http_api'].includes(data.mode)) rows.push(data.source && !/^(device\.|deviceDataMap\.|deviceStatusMap\.|selectedPart\.)/.test(data.source)
      ? runtimeSource('曲线采样', data.source, data, options)
      : data.mode === 'plc' || data.mode === 'runtime' ? record('曲线采样', '当前主来源采样窗口', '从上面实际绑定的数据取样；不同设备 / 部件 / 来源的窗口分开保存', 'localTrend / data', '随主来源的合格读数及采样周期更新', scopeLabel(data))
      : runtimeSource('曲线采样', 'trendPoints', data, options))
    rows.push(chartFieldTrace(content))
    if (content.statPath) rows.push(runtimeSource('独立统计读数', content.statPath, data, options))
    if (type === 'hud_chart_dock') rows.push(record('图表摘要单位', '固定格式配置',
      content.statUnit !== undefined && content.statUnit !== null ? `content.statUnit=${text(content.statUnit) || '空字符串（不加单位）'}`
        : data.bindingVersion === 2 && data.deviceScope !== 'global' && data.mode !== 'static'
          ? '未单独设置 statUnit，使用当前设备行经 bindingForDevice 合成的主读数 displayUnit：dataBinding.unit、单位字段路径，再到点位 / 数据表元数据单位；此处不猜当前轮播行，不把旧顶层单位当作已确认的当前单位'
          : `未单独设置 statUnit，使用同一主读数的 displayUnit${data.unit ? `（已配置单位 ${data.unit} 优先）` : ''}，也包含单位字段以及已绑定点位 / 数据表的元数据单位`,
      'content.statUnit ?? displayUnit', '仅格式化摘要读数，不改变图表数值或其来源'))
  }
  if (type === 'map_region_list') rows.push(runtimeSource('区域列表标题', 'map.title', data, options))
  if (data.bindingVersion === 2 && data.deviceScope !== 'global' && data.mode !== 'static') {
    for (const row of array(data.deviceBindings).filter(row => row.binding && (data.deviceScope !== 'fixed' || text(row.deviceId) === text(data.deviceId)))) {
      const device = array(options.devices).find(device => text(device.id) === text(row.deviceId))
      push(unitTrace({ ...data, ...row.binding }, content, `主数据单位 · ${device?.name || row.deviceId}`))
    }
  } else push(unitTrace(data, content))
  for (const { key, label } of hudTextFields(type)) {
    const defaults = hudTextDefaults(type)
    rows.push(fixed(label, `content.${key}`, content[key] ?? defaults[key], content[key] === undefined))
  }
  for (const key of ['label', 'onText', 'offText', 'unknownText', 'fallback', 'emptyText', 'statUnit']) if (content[key] !== undefined && !hudTextFields(type).some(field => field.key === key)) rows.push(fixed(`展示文字 · ${key}`, `content.${key}`, content[key]))
  for (const rule of array(widget.visibility?.rules)) if (rule.path) rows.push(rule.source === 'data'
    ? record('显示条件输入', '组件实际数据值', '使用上面的同一主数据值判断显隐，不另读取点位', rule.path, '主数据变化时重新判断')
    : runtimeSource('显示条件输入', `context.${rule.path}`, data, options))
  if (array(widget.conditions).length) rows.push(record('值映射 / 条件呈现', '组件实际数据值及固定规则', '比较上述主数据与 conditions 中配置的目标值；颜色和文字是展示规则，不是另一个采集源', 'conditions', '主数据变化时重新判断'))
  push(eventTrace(widget, type, options))
  return rows.map((row, index) => ({ ...row, key: `${widget.id || type || 'widget'}:${index}` }))
}
