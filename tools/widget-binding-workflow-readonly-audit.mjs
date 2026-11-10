// File/API-only commissioning check. It never saves or publishes a document,
// changes acquisition, opens a browser, or reads browser session cookies.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { layoutProjection, acquisitionProjection } from './widget-binding-workflow-live-migration.mjs'
import { systemSourceTrace, widgetSourceTrace } from '../frontend/src/runtime/widgetSourceTrace.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const target = new URL(option('--base', 'http://127.0.0.1:3001')), base = target.origin
assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Only the local commissioned backend may be inspected')
assert.ok(target.pathname === '/' && !target.search && !target.hash && !target.username && !target.password, 'Supply only the local backend origin')
const directory = path.resolve(option('--out', path.join(root, 'output/binding-workflow-redesign-20261109/resume/non-ui-live-audit')))
const relativeOutput = path.relative(path.join(root, 'output'), directory)
assert.ok(relativeOutput !== '..' && !relativeOutput.startsWith('..' + path.sep) && !path.isAbsolute(relativeOutput), 'Evidence must remain in workspace output')
const write = async (name, data) => { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, name), JSON.stringify(data, null, 2)) }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const identical = (a, b, message) => assert.deepEqual(canonical(a), canonical(b), message)

async function credentials() {
  if (!args.includes('--stdin')) return { username: process.env.DASHBOARD_USERNAME || 'admin', password: process.env.DASHBOARD_PASSWORD }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  const reader = readline.createInterface({ input: process.stdin, terminal: false })
  console.log('Waiting for the previously supplied local administrator login on stdin; input is not echoed or saved.')
  try {
    const input = await new Promise((resolve, reject) => {
      reader.once('line', resolve)
      reader.once('close', () => reject(new Error('No existing login was supplied on stdin')))
    })
    return JSON.parse(input)
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    reader.close(); process.stdin.pause()
  }
}

async function main() {
  const login = await credentials()
  assert.ok(login.password, 'Use the existing supplied password, not a guessed default')
  const response = await fetch(base + '/api/admin-auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-admin-request': '1' },
    body: JSON.stringify(login), signal: AbortSignal.timeout(15000) })
  const session = await response.json()
  assert.ok(response.ok, session.error || 'Existing login failed')
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).filter(cookie => !cookie.endsWith('='))
  const headers = { origin: base, 'x-admin-request': '1', 'x-factory-id': option('--factory', 'factory_default'), cookie: cookies.join('; ') }
  const api = async route => {
    const response = await fetch(base + '/api' + route, { headers, signal: AbortSignal.timeout(60000) })
    const body = await response.json(); assert.ok(response.ok, `${route}: ${response.status}`); return body
  }
  const [designer, runtime, devices, points, settings, health, catalog, events, factories, workshops, lines, models] = await Promise.all([
    '/platform/designer', '/config', '/devices', '/datapoints', '/settings', '/health', '/data-center/catalog', '/platform/events?limit=10',
    '/factories', '/workshops', '/lines', '/models'
  ].map(api))
  const snapshot = { checkedAt: new Date().toISOString(), document: designer.document, runtimeDocument: runtime.platform?.document || null,
    revision: designer.revision, version: designer.currentRelease?.version, devices, points, settings,
    sourceMode: settings.data_mode || settings.dataMode || '', factories, workshops, lines, models, health }
  const localPath = path.resolve(option('--local', path.join(root, 'output/binding-workflow-redesign-20261109/resume/local-draft-backup/local-editor-document.json')))
  const localBytes = await fs.readFile(localPath), localDocument = JSON.parse(localBytes)
  const summary = { success: true, checkedAt: snapshot.checkedAt, widgets: snapshot.document.widgets.length,
    devices: devices.length, points: points.length, revision: snapshot.revision, version: snapshot.version, sourceMode: snapshot.sourceMode,
    localUnsavedWidgets: localDocument.widgets.length, localUnsavedDocument: localPath,
    localUnsavedSha256: crypto.createHash('sha256').update(localBytes).digest('hex'),
    realEventCatalog: !!catalog.items?.find(item => item.id === 'internal_event_records' && item.binding?.path === 'events'),
    realEventRecords: Array.isArray(events) ? events.length : 0,
    ownershipPresent: Array.isArray(events) && events.every(event => event.factory_id !== undefined),
    ready: health.readiness?.displayReady === true, readinessFailures: health.readiness?.failures || [], backendMode: health.engine?.mode,
    authoredHierarchyCaptured: true, completeAuthoredSections: ['document', 'runtimeDocument', 'devices', 'points', 'settings', 'revision', 'version', 'sourceMode', 'factories', 'workshops', 'lines', 'models'],
    configurationWrites: 0, documentPublishes: 0, browserOperations: 0 }
  const beforePath = option('--before', '')
  if (beforePath) {
    const before = JSON.parse(await fs.readFile(path.resolve(beforePath), 'utf8'))
    identical(layoutProjection(before.document), layoutProjection(snapshot.document), 'A lifecycle restart changed dashboard layout or authored content')
    identical(acquisitionProjection(before), acquisitionProjection(snapshot), 'A lifecycle restart changed devices, point definitions, or acquisition mode')
    identical(before.settings, snapshot.settings, 'A lifecycle restart changed system settings')
    assert.equal(before.revision, snapshot.revision, 'A lifecycle restart unexpectedly saved the designer draft')
    summary.layoutPreserved = true; summary.acquisitionPreserved = true; summary.systemSettingsPreserved = true; summary.draftRevisionPreserved = true
  }
  if (args.includes('--require-event-catalog')) assert.ok(summary.realEventCatalog, 'Updated event catalog is not served by the commissioned backend')
  if (args.includes('--require-ready')) assert.ok(summary.ready, 'Display is not ready: ' + summary.readinessFailures.join(', '))
  if (args.includes('--source-inventory')) {
    const [dataSets, dataSources] = await Promise.all(['/data-sources/datasets', '/data-sources'].map(api))
    const options = { devices, points, datasets: dataSets.datasets || [], connections: dataSources.connections || [] }
    const localBefore = JSON.stringify(localDocument)
    const components = localDocument.widgets.map(widget => ({ id: widget.id, type: widget.type || widget.widget_type,
      title: widget.title, sources: widgetSourceTrace(widget, options) }))
    assert.ok(components.every(component => component.sources.length > 0), 'A local component has no source explanation')
    assert.equal(JSON.stringify(localDocument), localBefore, 'Source tracing modified the unsaved local document')
    await write('component-source-inventory.json', { checkedAt: snapshot.checkedAt, localUnsavedSha256: summary.localUnsavedSha256,
      componentCount: components.length, systemSources: systemSourceTrace(), nonMutating: true, components })
    summary.tracedComponents = components.length
    summary.sourceInventory = path.join(directory, 'component-source-inventory.json')
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'frontend/dist/.vite/manifest.json'), 'utf8'))
  const entry = Object.values(manifest).find(value => value.isEntry && value.src === 'index.html')
  assert.ok(entry?.file, 'Source-matched interface manifest is missing')
  const html = await fetch(base + '/admin', { signal: AbortSignal.timeout(15000) })
  assert.ok(html.ok && (await html.text()).includes('/' + entry.file), 'The local server is not serving the verified interface entry')
  summary.servedEntry = entry.file
  await write('live-state.json', snapshot); await write('verification.json', summary)
  console.log(JSON.stringify(summary, null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
