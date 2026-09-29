// Real backend + local HTTP fixture + production Vue SFC, isolated from site data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { exportDashboardTemplate, importDashboardTemplate, rebindDashboardTemplate } from '../src/runtime/dashboardTemplate.js'

const require = createRequire(import.meta.url)
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, forceStop, requestJson, waitForHttp, waitUntil } = require('../../backend/scripts/integration-test-utils.cjs')
const directory = createRunDirectory('template-http-e2e')
const checks = [], calls = []
let backend, app, value = 73.25
const fixture = http.createServer((req, res) => {
  calls.push({ method: req.method, path: req.url, value })
  if (req.method !== 'GET' || req.url !== '/v2/metrics') { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ payload: { measurements: [{ actual_temperature: value }] }, old: { temperature: -999 } }))
})
const originals = { inspectHttpDataSource: adminApi.inspectHttpDataSource, previewHttpDataSource: adminApi.previewHttpDataSource }
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`
  await createTestDatabase(path.join(directory, 'factory.db'))
  const port = await findFreePort()
  const origin = `http://127.0.0.1:${port}`
  backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...process.env, APP_DATA_DIR: directory, PORT: String(port) }, logFile: path.join(directory, 'backend.log') })
  await waitForHttp(`${origin}/api/health`)
  const call = (route, body, method = 'POST') => requestJson(`${origin}/api/${route}`, body === undefined ? {} : { method, body: JSON.stringify(body) })
  const connection = await call('data-sources/connections', { id: 'mapping_target_api', name: 'HTTP mapping local fixture', sourceType: 'http_api', type: 'http_api', baseUrl: fixtureOrigin, authType: 'none', responseFormat: 'json', enabled: true })
  assert.equal(connection.success, true)
  const initial = await call('platform/designer')
  const source = normalizeDashboardDocument({ ...initial.document, widgets: [{ id: 'http_mapped_metric', type: 'value', title: 'HTTP 字段映射验收', frame: { x: 50, y: 50, width: 400, height: 180 }, data: { mode: 'http_api', connectionId: 'source_api', apiPath: '/old/metrics', jsonPath: 'old.temperature', refreshMs: 5000 } }] })
  const imported = importDashboardTemplate(exportDashboardTemplate(source), initial.document)
  const rebound = rebindDashboardTemplate(imported, { 'connections:source_api': 'mapping_target_api' }, { connections: [connection.connection] })

  // Replace only transport destinations, not response data: the production SFC
  // still executes its own inspect, preview, validation and confirmation logic.
  adminApi.inspectHttpDataSource = binding => call('data-sources/inspect-http', binding)
  adminApi.previewHttpDataSource = binding => call('data-sources/preview-http', binding)
  const url = new URL('../src/views/admin/components/TemplateFieldMapper.vue', import.meta.url)
  const { descriptor, errors } = parse(fs.readFileSync(url, 'utf8'))
  assert.deepEqual(errors, [])
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'http-e2e' }).errors, [])
  let compiled = compileScript(descriptor, { id: 'http-e2e' }).content
  for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) compiled = compiled.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], url).href : import.meta.resolve(match[2]))}`)
  const { default: Mapper } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  Mapper.render = () => null
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null), applied = []
  app = renderer.createApp({ render: () => h(Mapper, { ref: instance, document: rebound, onApply: document => applied.push(document) }) })
  app.mount({})
  const state = instance.value.$.setupState
  await waitUntil(() => !state.rows[0].busy, 10000, 'initial HTTP inspection')
  const row = state.rows[0]
  assert.match(row.error, /404/, 'old endpoint failure must be visible')
  row.target.apiPath = '/v2/metrics'
  await state.inspect(row)
  assert.equal(row.error, '')
  const targetPath = 'payload.measurements[0].actual_temperature'
  const discovered = row.fields.find(field => field.path === targetPath)
  assert.equal(discovered.kind, 'number')
  assert.equal(discovered.sample, '73.25')
  checks.push('real HTTP inspection discovers changed endpoint and nested target JSON field')
  row.target.jsonPath = targetPath
  state.invalidate(row)
  await state.preview(row)
  assert.equal(row.error, '')
  assert.equal(row.preview.value, 73.25)
  assert.equal(row.preview.quality, 'good')
  state.apply()
  assert.equal(applied.length, 0)
  row.confirmed = true
  state.apply()
  assert.equal(applied.length, 1)
  checks.push('SFC blocks unconfirmed preview and applies manually selected target path after confirmation')
  const saved = await call('platform/designer/draft', { sceneId: initial.scene.id, expectedRevision: initial.revision, document: applied[0] }, 'PUT')
  const published = await call('platform/releases', { sceneId: initial.scene.id })
  assert.equal(saved.document.widgets.find(widget => widget.id === 'http_mapped_metric').data.jsonPath, targetPath)
  assert.equal(published.document.widgets.find(widget => widget.id === 'http_mapped_metric').data.apiPath, '/v2/metrics')
  const runtimeRoute = `data-sources/runtime-values?scene_id=${encodeURIComponent(initial.scene.id)}`
  const runtime = await call(runtimeRoute)
  assert.equal(runtime.releaseId, published.release.id)
  assert.equal(runtime.values.http_mapped_metric.value, 73.25)
  assert.equal(runtime.values.http_mapped_metric.quality, 'good')
  checks.push('real save/publish persists new API and JSON paths and published runtime returns target value, not old -999')
  value = 86.5
  let refreshed
  await waitUntil(async () => { refreshed = await call(runtimeRoute); return refreshed.values.http_mapped_metric.value === value }, 12000, 'published runtime refresh', 700)
  checks.push('published runtime fetches changed target value 86.5, independent of cached SFC preview 73.25')
  const report = { ok: true, directory, source: { apiPath: '/old/metrics', jsonPath: 'old.temperature' }, target: { apiPath: '/v2/metrics', jsonPath: targetPath }, checks, discoveredFields: row.fields, preview: row.preview, savedRevision: saved.revision, release: published.release, runtime, refreshedRuntime: refreshed, fixtureRequests: calls }
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ok: true, checks, directory, releaseId: published.release.id, runtimeValue: runtime.values.http_mapped_metric.value, refreshedValue: refreshed.values.http_mapped_metric.value }, null, 2))
} catch (error) {
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2))
  console.error(error.stack)
  process.exitCode = 1
} finally {
  app?.unmount()
  Object.assign(adminApi, originals)
  await forceStop(backend)
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
}
