// Explicit, revision-checked rollout of the reviewed binding plan. No PLC writes.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultDirectory = path.join(root, 'output/binding-workflow-redesign-20261109/resume')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const action = args.find(arg => ['--snapshot', '--apply', '--verify'].includes(arg))
const directory = path.resolve(option('--out', defaultDirectory))
const base = option('--base', 'http://127.0.0.1:3001').replace(/\/$/, '')
const target = new URL(base)
assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'This rollout tool only operates on the local desktop backend')
const factoryId = option('--factory', 'factory_default')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const identical = (a, b, message) => assert.deepEqual(canonical(a), canonical(b), message)
const read = async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
const write = async (name, value) => {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2))
}

// Everything except the requested binding behavior is immutable during rollout.
export function layoutProjection(document) {
  const value = structuredClone(document)
  delete value.metadata
  const widget = item => {
    delete item.data
    if (item.content) {
      delete item.content.eventFilters
      delete item.content.useBoundRing
      for (const metric of item.content.items || []) delete metric.binding
    }
  }
  for (const item of value.widgets || []) widget(item)
  for (const template of Object.values(value.tooltipTemplates || {})) for (const item of template.widgets || []) widget(item)
  return value
}
export function acquisitionProjection(snapshot) {
  const select = (items, excluded = []) => items.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => !excluded.includes(key)))).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return {
    devices: select(snapshot.devices),
    points: select(snapshot.points, ['quality']),
    sourceMode: snapshot.sourceMode
  }
}
export function explicitPointMappings(document, points) {
  const readings = new Map(points.map(point => [String(point.id), point]))
  const result = []
  for (const widget of document.widgets) {
    const sources = [{ label: widget.title || widget.id, binding: widget.data }, ...(widget.content?.items || []).filter(item => item.binding).map(item => ({ label: item.label, binding: item.binding }))]
    for (const source of sources) for (const row of source.binding?.deviceBindings || []) {
      if (row.binding?.mode !== 'plc') continue
      const point = readings.get(String(row.binding.pointId))
      assert.ok(point, 'Missing exact configured point ' + row.binding.pointId)
      assert.equal(String(point.device_id), String(row.deviceId), 'A source belongs to a different device')
      assert.equal(String(point.access_type || 'READ').toUpperCase(), 'READ', 'A display source must be read-only')
      result.push({ widgetId: widget.id, metric: source.label, deviceId: row.deviceId, deviceName: point.device_name || '', pointId: String(point.id),
        address: point.plc_tag, unit: row.binding.unit || point.unit || '', quality: point.quality || 'unknown',
        value: point.quality === 'good' ? point.value ?? null : null, lastReadAt: point.lastReadAt || null })
    }
  }
  return result
}
function bindingProjection(document) {
  return document.widgets.map(widget => ({ id: widget.id, data: widget.data, items: (widget.content?.items || []).map(item => item.binding || null), filters: widget.content?.eventFilters, ring: widget.content?.useBoundRing }))
}

async function main() {
  assert.ok(action, 'Choose --snapshot, --apply or --verify; --snapshot --backup also creates and downloads a database backup')
  assert.ok(process.env.DASHBOARD_PASSWORD, 'Set DASHBOARD_PASSWORD to the existing administrator password; no password is stored by this tool')
  const response = await fetch(base + '/api/admin-auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-admin-request': '1' },
    body: JSON.stringify({ username: process.env.DASHBOARD_USERNAME || 'admin', password: process.env.DASHBOARD_PASSWORD }), signal: AbortSignal.timeout(15000)
  })
  const session = await response.json()
  assert.ok(response.ok, session.error || 'Administrator login failed')
  const cookies = new Map(response.headers.getSetCookie().map(value => { const entry = value.split(';')[0]; const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)] }))
  const headers = { 'content-type': 'application/json', origin: base, 'x-admin-request': '1', 'x-factory-id': factoryId,
    cookie: [...cookies].filter(([, value]) => value).map(([key, value]) => key + '=' + value).join('; '), 'x-csrf-token': session.csrfToken }
  const api = async (route, method = 'GET', body, timeout = 30000) => {
    const result = await fetch(base + '/api' + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) })
    const text = await result.text()
    assert.ok(result.ok, route + ': ' + result.status + ' ' + text.slice(0, 1000))
    return JSON.parse(text)
  }
  const snapshot = async () => {
    const [designer, devices, points, settings, runtime] = await Promise.all(['/platform/designer', '/devices', '/datapoints', '/settings', '/platform'].map(route => api(route)))
    return { checkedAt: new Date().toISOString(), revision: designer.revision, currentVersion: designer.currentRelease?.version,
      document: designer.document, designer, devices, points, settings, runtime, sourceMode: settings.data_mode || settings.dataMode || '' }
  }
  if (action === '--snapshot') {
    const current = await snapshot()
    await write('before-resume-live-state.json', current)
    if (args.includes('--backup')) {
      const backup = await api('/database/backups', 'POST', {}, 180000)
      await write('database-backup.json', backup)
      const filename = backup.backup?.filename
      assert.ok(filename && path.basename(filename) === filename, 'Backend did not return a safe backup filename')
      const download = await fetch(base + '/api/database/backups/' + encodeURIComponent(filename) + '/download', { headers, signal: AbortSignal.timeout(180000) })
      assert.ok(download.ok, 'Database backup download failed')
      const bytes = Buffer.from(await download.arrayBuffer())
      const destination = path.join(directory, filename)
      await fs.writeFile(destination, bytes)
      const payload = filename.endsWith('.gz') ? gunzipSync(bytes) : bytes
      const tables = ['scenes', 'devices', 'data_points'].map(name => ({ name, present: payload.includes(Buffer.from('`' + name + '`')) }))
      if (filename.endsWith('.sql.gz')) assert.ok(tables.every(table => table.present), 'Database dump is missing required configuration tables')
      await write('database-backup-proof.json', { filename: destination, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), gzipVerified: filename.endsWith('.gz'), uncompressedBytes: payload.length, tables })
    }
    console.log(JSON.stringify({ success: true, snapshot: path.join(directory, 'before-resume-live-state.json'), revision: current.revision, version: current.currentVersion, widgets: current.document.widgets.length, devices: current.devices.length, points: current.points.length, sourceMode: current.sourceMode, databaseBackup: args.includes('--backup') }, null, 2))
    return
  }
  const original = JSON.parse(await fs.readFile(path.resolve(option('--baseline', path.join(root, 'output/binding-workflow-redesign-20261109/before-live-state.json'))), 'utf8'))
  const plan = JSON.parse(await fs.readFile(path.resolve(option('--plan', path.join(root, 'output/binding-workflow-redesign-20261109/migration-plan.json'))), 'utf8'))
  const before = await read('before-resume-live-state.json')
  identical(layoutProjection(original.document), layoutProjection(plan.document), 'The plan changed unrelated layout, content or scene configuration')
  identical(acquisitionProjection(original), acquisitionProjection(before), 'Acquisition configuration changed since the reviewed plan')
  if (action === '--apply') {
    const current = await snapshot()
    assert.equal(current.revision, before.revision, 'Another editor changed the draft; do not overwrite it')
    identical(layoutProjection(current.document), layoutProjection(plan.document), 'Current layout differs from the reviewed binding-only plan')
    identical(bindingProjection(original.document), bindingProjection(before.document), 'Draft bindings changed since the reviewed plan; regenerate it')
    const saved = await api('/platform/designer/draft', 'PUT', { sceneId: current.document.sceneId, document: plan.document, expectedRevision: current.revision }, 60000)
    await write('saved-migration.json', saved)
    const reloaded = await api('/platform/designer')
    identical(bindingProjection(saved.document), bindingProjection(reloaded.document), 'Saved bindings did not reopen identically')
    const release = await api('/platform/releases', 'POST', { sceneId: reloaded.document.sceneId, notes: '明确逐设备数据绑定、HUD 指标及真实报警事件来源；保留布局和采集配置。' }, 60000)
    await write('published-migration.json', release)
    console.log(JSON.stringify({ success: true, revision: saved.revision, version: release.release?.version, warnings: saved.warnings || [], converted: plan.converted.length, secondaryMetrics: plan.metrics.length, missingDeviceSources: plan.limited }, null, 2))
  }
  const current = await snapshot()
  const saved = await read('saved-migration.json')
  identical(bindingProjection(saved.document), bindingProjection(current.document), 'Bindings changed after publishing or reopening')
  identical(bindingProjection(current.document), bindingProjection(current.runtime.document), 'The running release is not using the saved explicit bindings')
  identical(layoutProjection(before.document), layoutProjection(current.document), 'Rollout changed unrelated layout or scene configuration')
  identical(acquisitionProjection(before), acquisitionProjection(current), 'Rollout changed acquisition configuration')
  identical(before.settings, current.settings, 'Rollout changed unrelated system or collection settings')
  const catalog = await api('/data-center/catalog')
  assert.ok(catalog.items.find(item => item.id === 'internal_event_records' && item.binding?.path === 'events'), 'Real event catalog source is missing')
  const events = await api('/data-center/tables/internal_events/records?page_size=10')
  const readings = await api('/plc/points/realtime')
  const mappings = explicitPointMappings(current.document, readings.points)
  const used = [...new Map(mappings.map(mapping => [mapping.pointId, mapping])).values()]
  await write('after-resume-live-state.json', current)
  await write('live-event-records.json', events)
  await write('live-point-readings.json', readings)
  await write('live-explicit-point-mappings.json', mappings)
  const summary = { success: true, checkedAt: new Date().toISOString(), revision: current.revision, version: current.currentVersion,
    widgets: current.document.widgets.length, devices: current.devices.length, points: current.points.length, sourceMode: current.sourceMode,
    layoutPreserved: true, acquisitionPreserved: true, systemSettingsPreserved: true, saveReopenBindingsIdentical: true, publishedBindingsIdentical: true, realEventTable: true,
    explicitPointMappings: mappings.length, uniqueMappedPoints: used.length, mappedPointQuality: Object.fromEntries([...new Set(used.map(point => point.quality))].map(quality => [quality, used.filter(point => point.quality === quality).length])),
    converted: plan.converted.length, secondaryMetrics: plan.metrics.length, missingDeviceSources: plan.limited }
  await write('live-verification.json', summary)
  console.log(JSON.stringify(summary, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
