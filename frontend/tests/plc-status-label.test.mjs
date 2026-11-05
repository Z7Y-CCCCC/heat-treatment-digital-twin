import test from 'node:test'
import assert from 'node:assert/strict'
import { PLC_STATUS_LABELS, plcDeviceStatusLabel } from '../src/views/admin/utils/plcStatus.js'
test('PLC statuses use Chinese, including offline when no readable points exist', () => {
  const device = { plc_enabled: 1, plc_ip: '127.0.0.1' }
  assert.equal(plcDeviceStatusLabel(device, { status: 'offline', noReadablePoints: true }), '离线')
  assert.equal(plcDeviceStatusLabel(device, { status: 'offline' }), '离线')
  assert.equal(plcDeviceStatusLabel(device, { status: 'no_points', noReadablePoints: true }), '无点位')
  assert.equal(plcDeviceStatusLabel({ ...device, plc_enabled: 0 }, { status: 'offline' }), '未启用')
  assert.equal(plcDeviceStatusLabel(device), '等待采集')
  assert.equal(plcDeviceStatusLabel({ plc_enabled: 1 }), '未配置')
  assert.equal(plcDeviceStatusLabel(device, { status: 'new_unknown_code' }), '未知')
  for (const label of Object.values(PLC_STATUS_LABELS)) assert.match(label, /[\u4e00-\u9fff]/)
})
