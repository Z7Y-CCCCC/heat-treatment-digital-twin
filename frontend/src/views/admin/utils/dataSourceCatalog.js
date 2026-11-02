// Capability is explicit. Planned entries never create a fake working connection.
const ready = [
    { key: 'mysql', name: 'MySQL / MariaDB', badge: 'MY', group: 'database', color: '#16759c', description: '业务表、视图与字段', draft: { sourceType: 'database', type: 'mysql', port: 3306 } },
    { key: 'postgres', name: 'PostgreSQL', badge: 'PG', group: 'database', color: '#426b96', description: 'Schema、表与视图', draft: { sourceType: 'database', type: 'postgres', port: 5432, defaultSchema: 'public' } },
    { key: 'sqlserver', name: 'SQL Server', badge: 'SQL', group: 'database', color: '#9162a8', description: '业务表、视图与字段', draft: { sourceType: 'database', type: 'sqlserver', port: 1433, defaultSchema: 'dbo', encrypt: true, trustServerCertificate: false } },
    { key: 'sqlite', name: 'SQLite', badge: 'DB', group: 'database', color: '#597888', description: '本地数据库文件，只读接入', draft: { sourceType: 'database', type: 'sqlite', port: 0 } },
    { key: 'http', name: 'HTTP / REST', badge: 'API', group: 'http', color: '#2672d9', description: 'GET · JSON / XML / CSV', draft: { sourceType: 'http_api', type: 'http_api', responseFormat: 'auto' } },
    { key: 'odata', name: 'OData', badge: 'OD', group: 'http', color: '#33857c', description: '通过 HTTP GET 读取 OData 响应', draft: { sourceType: 'http_api', type: 'http_api', responseFormat: 'json' } },
    { key: 'websocket', name: 'WebSocket', badge: 'WS', group: 'stream', color: '#c59616', description: '接收服务端推送消息', draft: { sourceType: 'http_api', type: 'http_api', connector: 'websocket', healthPath: '/', responseFormat: 'json' } },
    { key: 'mqtt', name: 'MQTT', badge: 'MQ', group: 'stream', color: '#2f90a8', description: '只读订阅主题，不发布消息', draft: { sourceType: 'http_api', type: 'http_api', connector: 'mqtt', healthPath: 'factory/telemetry', responseFormat: 'json', authType: 'basic' } },
    { key: 'tcp', name: 'TCP', badge: 'TCP', group: 'stream', color: '#caa51b', description: '接收 JSON / 换行分隔帧', draft: { sourceType: 'http_api', type: 'http_api', connector: 'tcp', healthPath: '/', responseFormat: 'json' } },
    { key: 'udp', name: 'UDP', badge: 'UDP', group: 'stream', color: '#429bb9', description: '本机端口接收数据报', draft: { sourceType: 'http_api', type: 'http_api', connector: 'udp', healthPath: '/', responseFormat: 'json' } },
    { key: 'redis', name: 'Redis', badge: 'RED', group: 'nosql', color: '#cb4934', description: '字符串键 · 只读取样', draft: { sourceType: 'http_api', type: 'http_api', connector: 'redis', healthPath: 'telemetry', responseFormat: 'auto', authType: 'basic' } },
    { key: 'file', name: 'CSV / JSON', badge: 'FILE', group: 'file', color: '#8a67bf', description: '导入文件，读取字段与样例', draft: { sourceType: 'http_api', type: 'http_api', connector: 'file', healthPath: '/', responseFormat: 'auto' } }
]
const industrial = [
    { key: 's7', name: 'S7 PLC', badge: 'S7', color: '#0064aa', description: '西门子 S7 · 设备 PLC 通道' },
    { key: 'modbus', name: 'MODBUS TCP', badge: 'MB', color: '#1c618b', description: '寄存器 / 线圈 · 设备 PLC 通道' },
    { key: 'opcua', name: 'OPC UA', badge: 'OPC', color: '#2467d4', description: 'NodeId · 设备 PLC 通道' }
]
const planned = [
    ['hikvision', 'HIKVISION', 'industrial', '#373e42'], ['bacnet', 'BACnet/IP', 'industrial', '#5caebb'],
    ['oracle', 'Oracle', 'database', '#bb2025'], ['dm8', 'DM8', 'database', '#64a59d'],
    ['kingbase', 'KingbaseES', 'database', '#123b5f'], ['gbase', 'GBase 8s', 'database', '#36433c'],
    ['mongodb', 'MongoDB', 'nosql', '#2c963c'], ['influxdb', 'InfluxDB', 'nosql', '#10a0aa'],
    ['iotdb', 'IoTDB', 'nosql', '#178ec1'], ['tdengine', 'TDengine', 'nosql', '#058bba'],
    ['opengauss', 'openGauss', 'database', '#1664c4'], ['dis', 'DIS', 'stream', '#3298a4'],
    ['excel', 'Excel/CSV', 'file', '#6688a2']
]
const order = ['http', 'websocket', 'hikvision', 'mqtt', 'modbus', 'opcua', 'bacnet', 's7', 'tcp', 'udp', 'mysql', 'sqlserver', 'postgres', 'oracle', 'dm8', 'kingbase', 'gbase', 'mongodb', 'redis', 'influxdb', 'iotdb', 'tdengine', 'opengauss', 'dis', 'excel', 'sqlite', 'odata', 'file']
export const DATA_SOURCE_CATALOG = Object.freeze([
    ...ready.map(entry => ({ ...entry, status: 'ready' })),
    ...industrial.map(entry => ({ ...entry, group: 'industrial', status: 'device' })),
    ...planned.map(([key, name, group, color]) => ({ key, name, group, color, status: 'planned', badge: name.slice(0, 3), description: '后续批次接入验证' }))
].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)).map(entry => ({ ...entry, image: `/images/data-sources/${entry.key}.svg` })))
export const SOURCE_GROUPS = [{ key: 'all', label: '全部类型' }, { key: 'database', label: '关系数据库' }, { key: 'http', label: 'HTTP 接口' }, { key: 'stream', label: '消息 / 网络' }, { key: 'industrial', label: '工业协议' }, { key: 'nosql', label: 'NoSQL / 时序' }, { key: 'file', label: '文件' }]
export function capabilityLabel(entry) { return ({ ready: '已接入', device: '设备采集', planned: '待接入' })[entry.status] }

export function sourceCatalogEntry(connection = {}) {
    return DATA_SOURCE_CATALOG.find(item => item.key === (connection.sourceType === 'http_api' || connection.type === 'http_api' ? connection.connector || 'http' : connection.type)) || ready[0]
}
export function sourceEndpoint(connection = {}) {
    if (connection.connector === 'file') return '已导入数据文件'
    if (connection.sourceType === 'http_api' || connection.type === 'http_api') return connection.baseUrl || '未填写地址'
    if (connection.type === 'sqlite') return connection.filename || '未选择文件'
    return `${connection.host || '未填写主机'}:${connection.port || ''}${connection.database ? ' / ' + connection.database : ''}`
}
export function sourceStatus(connection = {}) {
    if (!connection.enabled) return { key: 'disabled', label: '已停用' }
    const status = connection.health?.status || 'unknown'
    return { key: status, label: ({ healthy: '检查通过', unknown: '未检查', auth_failed: '认证失败', http_error: '接口异常', network_error: '连接失败', timeout: '超时', config_error: '配置有误', check_failed: '检查失败' })[status] || '未检查' }
}
export function filterSources(connections, query = '', group = 'all') {
    const text = query.trim().toLowerCase()
    return connections.filter(item => !item.primary
        && (group === 'all' || sourceCatalogEntry(item).group === group)
        && (!text || [item.name, item.type, sourceEndpoint(item)].some(value => String(value || '').toLowerCase().includes(text))))
}
