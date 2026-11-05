export const PLC_STATUS_LABELS = Object.freeze({
  connected: '已连接', connecting: '连接中', retrying: '重连中', offline: '离线',
  error: '异常', degraded: '部分异常', disabled: '未启用', no_points: '无点位',
  unconfigured: '未配置', unsupported: '暂不支持', stopped: '已停止', idle: '等待',
  no_devices: '无设备', starting: '启动中', recovering: '恢复中',
  unresponsive: '采集无响应', stopping: '停止中', unknown: '未知'
})

export function plcDeviceStatusLabel(device, status) {
  if (!Number(device.plc_enabled || 0)) return '未启用'
  if (!status) return device.plc_ip ? '等待采集' : '未配置'
  if (status.status === 'unconfigured' && device.plc_ip && !status.plc_ip) return '配置已更新'
  return PLC_STATUS_LABELS[status.status] || '未知'
}
