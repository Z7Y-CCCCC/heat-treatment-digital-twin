import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick } from 'vue'
import { adminApi } from '../src/config/factoryConfig.js'
import { useSystemSettings } from '../src/views/admin/composables/useSystemSettings.js'
import { deferred, installBrowser, json, settle } from './helpers.mjs'

const healthy = () => ({
    status: 'healthy', message: 'HTTP 204', responseTimeMs: 12,
    httpStatus: 204, checkedAt: '2026-09-13T03:00:00.000Z'
})
const apiSource = (patch = {}) => ({
    id: 'api-a', name: 'API A', sourceType: 'http_api', type: 'http_api', enabled: true,
    baseUrl: 'https://a.example.test/api', healthPath: '/health', method: 'GET',
    authType: 'none', apiKeyHeader: 'X-API-Key', apiKey: '', token: '', user: '', password: '',
    requestTimeoutMs: 8000, health: null, ...patch
})
const sourceList = connections => ({ success: true, connections, backup: {}, backupStatus: {} })

function fixture(t) {
    const browser = installBrowser(t)
    const scope = effectScope()
    t.after(() => scope.stop())
    const settings = scope.run(() => useSystemSettings({ alert: async () => {}, confirm: async () => true }))
    t.mock.method(adminApi, 'getDataSources', async () => sourceList([...settings.dataSourceConnections.value]))
    return { ...settings, ...browser, scope }
}

function mockSave(t) {
    return t.mock.method(adminApi, 'saveDataSource', async input => {
        const { healthToken, ...fields } = input
        const connection = { ...fields, id: input.id || 'created-api', health: healthToken ? healthy() : null }
        return { success: true, connection, connections: [connection] }
    })
}

test('selecting a saved API keeps its health and does not fabricate or carry credentials', async t => {
    const s = fixture(t)
    s.editDataSource({ id: 'db-a', name: 'DB A', type: 'mysql', password: '******', user: 'db-user', database: 'factory', health: healthy() })
    s.editDataSource(apiSource({ health: healthy() }))
    await nextTick()
    assert.equal(s.dataSourceTestHealth.status, 'healthy')
    assert.equal(s.dataSourceTestHealth.httpStatus, 204)
    assert.equal(s.dataSourceEditor.password, '')
    assert.equal(s.dataSourceEditor.apiKey, '')
    assert.equal(s.dataSourceEditor.token, '')
    assert.equal(s.dataSourceEditor.database, '')
    assert.equal('health' in s.dataSourceEditor, false)
    s.resetDataSourceEditor()
    assert.equal(s.dataSourceEditor.id, '')
    assert.equal(s.dataSourceEditor.user, '')
    assert.equal(s.dataSourceTestHealth.status, '')
})

test('masked credentials are kept only when supplied by the server, and explicit empty strings are sent unchanged', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ authType: 'bearer', token: '******' }))
    const check = t.mock.method(adminApi, 'testDataSource', async () => ({ success: true, health: healthy(), healthToken: 'signed-1' }))
    await s.testExternalDataSource()
    assert.equal(check.mock.calls[0].arguments[0].token, '******')
    assert.equal('password' in check.mock.calls[0].arguments[0], false)
    s.dataSourceEditor.token = ''
    const save = mockSave(t)
    await s.saveExternalDataSource()
    assert.equal(save.mock.calls[0].arguments[0].token, '')
    assert.equal(save.mock.calls[0].arguments[0].healthToken, '')
})

test('switching source or authentication types clears incompatible fields and credentials', async t => {
    const s = fixture(t)
    s.editDataSource({ id: 'db-a', name: 'DB A', type: 'postgres', port: 6543, user: 'readonly', password: '******', defaultSchema: 'custom' })
    s.dataSourceEditor.sourceType = 'http_api'
    assert.equal(s.dataSourceEditor.id, 'db-a')
    assert.equal(s.dataSourceEditor.type, 'http_api')
    assert.equal(s.dataSourceEditor.user, '')
    assert.equal(s.dataSourceEditor.password, '')
    assert.equal(s.dataSourceEditor.defaultSchema, '')
    s.dataSourceEditor.authType = 'api_key'
    s.dataSourceEditor.apiKey = 'draft-secret'
    s.dataSourceEditor.authType = 'bearer'
    assert.equal(s.dataSourceEditor.apiKey, '')
    s.dataSourceEditor.token = 'new-token'
    s.dataSourceEditor.baseUrl = 'https://example.test'
    const check = t.mock.method(adminApi, 'testDataSource', async () => ({ success: true, health: healthy() }))
    await s.testExternalDataSource()
    const submitted = check.mock.calls[0].arguments[0]
    assert.equal(submitted.type, 'http_api')
    assert.equal(submitted.token, 'new-token')
    assert.equal('host' in submitted, false)
    assert.equal('apiKey' in submitted, false)
    s.dataSourceEditor.sourceType = 'database'
    assert.equal(s.dataSourceEditor.type, 'mysql')
    assert.equal(s.dataSourceEditor.port, 3306)
    assert.equal(s.dataSourceEditor.token, '')
    assert.equal(s.dataSourceEditor.baseUrl, '')
})

test('database type changes update default ports and schemas but preserve loaded custom values', t => {
    const s = fixture(t)
    s.dataSourceEditor.type = 'postgres'
    assert.equal(s.dataSourceEditor.port, 5432)
    assert.equal(s.dataSourceEditor.defaultSchema, 'public')
    s.dataSourceEditor.type = 'sqlserver'
    assert.equal(s.dataSourceEditor.port, 1433)
    assert.equal(s.dataSourceEditor.defaultSchema, 'dbo')
    s.editDataSource({ id: 'db-a', name: 'custom', type: 'postgres', port: 6432, defaultSchema: 'production' })
    assert.equal(s.dataSourceEditor.port, 6432)
    assert.equal(s.dataSourceEditor.defaultSchema, 'production')
})

test('editing an endpoint while testing discards the old result and its token', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource())
    const response = deferred()
    const check = t.mock.method(adminApi, 'testDataSource', () => response.promise)
    const pending = s.testExternalDataSource()
    s.dataSourceEditor.baseUrl = 'https://b.example.test'
    response.resolve({ success: true, health: healthy(), healthToken: 'for-api-a' })
    await pending
    assert.equal(check.mock.calls[0].arguments[0].baseUrl, 'https://a.example.test/api')
    assert.equal(s.dataSourceTestHealth.status, '')
    assert.match(s.dataSourceMessage.value, /重新测试/)
    const save = mockSave(t)
    await s.saveExternalDataSource()
    assert.equal(save.mock.calls[0].arguments[0].healthToken, '')
    assert.equal('health' in save.mock.calls[0].arguments[0], false)
})

test('selecting another connection invalidates pending results even if later returning to identical values', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource())
    const response = deferred()
    t.mock.method(adminApi, 'testDataSource', () => response.promise)
    const pending = s.testExternalDataSource()
    s.editDataSource(apiSource({ id: 'api-b', name: 'API B' }))
    s.editDataSource(apiSource())
    response.resolve({ success: true, health: healthy(), healthToken: 'old-check' })
    await pending
    assert.equal(s.dataSourceTestHealth.status, '')
    assert.equal(s.dataSourceMessage.value, '正在编辑：API A')
})

test('a current successful test saves the server token, not client-supplied health, and keeps the saved feedback', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ id: '' }))
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: true, health: healthy(), healthToken: 'signed-health' }))
    await s.testExternalDataSource()
    const save = mockSave(t)
    await s.saveExternalDataSource()
    assert.equal(save.mock.calls[0].arguments[0].healthToken, 'signed-health')
    assert.equal('health' in save.mock.calls[0].arguments[0], false)
    assert.equal(s.dataSourceEditor.id, 'created-api')
    assert.equal(s.dataSourceTestHealth.status, 'healthy')
    assert.equal(s.dataSourceMessage.value, '已保存：API A')
})

test('credential edits clear previous health synchronously before an immediate save', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ authType: 'bearer', token: 'old' }))
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: true, health: healthy(), healthToken: 'old-token' }))
    await s.testExternalDataSource()
    s.dataSourceEditor.token = 'new'
    assert.equal(s.dataSourceTestHealth.status, '')
    const save = mockSave(t)
    await s.saveExternalDataSource()
    assert.equal(save.mock.calls[0].arguments[0].healthToken, '')
})

test('a failed test replaces previous success with complete diagnostics and preserves a signed failure for saving', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ health: healthy() }))
    const failed = { status: 'auth_failed', message: 'HTTP 401', responseTimeMs: 3, httpStatus: 401, checkedAt: '2026-09-13T03:01:00.000Z' }
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: false, health: failed, healthToken: 'signed-failure' }))
    await s.testExternalDataSource()
    assert.deepEqual({ ...s.dataSourceTestHealth }, failed)
    assert.match(s.dataSourceMessage.value, /接口检查失败.*HTTP 401/)
    const save = mockSave(t)
    await s.saveExternalDataSource()
    assert.equal(save.mock.calls[0].arguments[0].healthToken, 'signed-failure')
})

test('testing a saved connection refreshes its card from persisted health without overwriting backup edits', async t => {
    const s = fixture(t)
    const connection = apiSource({ health: healthy() })
    s.dataSourceConnections.value = [connection]
    s.editDataSource(connection)
    s.dataSourceBackupConfig.selectedConnectionIds = ['draft-database']
    const failed = { ...healthy(), status: 'auth_failed', message: 'HTTP 401', httpStatus: 401 }
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: false, health: failed, healthToken: 'signed-failure' }))
    const reload = t.mock.method(adminApi, 'getDataSources', async () => ({
        ...sourceList([apiSource({ health: failed })]), backup: { selectedConnectionIds: ['primary'] }
    }))
    await s.testExternalDataSource()
    assert.equal(reload.mock.callCount(), 1)
    assert.equal(s.dataSourceConnections.value[0].health.status, 'auth_failed')
    assert.equal(s.dataSourceTestHealth.status, 'auth_failed')
    assert.deepEqual([...s.dataSourceBackupConfig.selectedConnectionIds], ['draft-database'])
    assert.match(s.dataSourceMessage.value, /接口检查失败.*HTTP 401/)
})

test('testing an unsaved draft never copies its health onto the saved connection card', async t => {
    const s = fixture(t)
    const saved = apiSource({ health: healthy() })
    s.dataSourceConnections.value = [saved]
    s.editDataSource(saved)
    s.dataSourceEditor.baseUrl = 'https://unsaved.example.test'
    const failed = { ...healthy(), status: 'auth_failed', message: 'HTTP 401', httpStatus: 401 }
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: false, health: failed, healthToken: 'draft-failure' }))
    t.mock.method(adminApi, 'getDataSources', async () => sourceList([saved]))
    await s.testExternalDataSource()
    assert.equal(s.dataSourceTestHealth.status, 'auth_failed')
    assert.equal(s.dataSourceConnections.value[0].health.status, 'healthy')
    assert.equal(s.dataSourceConnections.value[0].baseUrl, 'https://a.example.test/api')
    assert.equal(s.dataSourceEditor.baseUrl, 'https://unsaved.example.test')
})

test('post-test refresh trusts the server when a concurrent save prevented persisting the test', async t => {
    const s = fixture(t)
    const saved = apiSource({ health: healthy() })
    s.dataSourceConnections.value = [saved]
    s.editDataSource(saved)
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: true, health: healthy(), healthToken: 'tested-old-config' }))
    t.mock.method(adminApi, 'getDataSources', async () => sourceList([
        apiSource({ baseUrl: 'https://saved-elsewhere.example.test', health: null })
    ]))
    await s.testExternalDataSource()
    assert.equal(s.dataSourceConnections.value[0].health, null)
    assert.equal(s.dataSourceConnections.value[0].baseUrl, 'https://saved-elsewhere.example.test')
    assert.equal(s.dataSourceEditor.baseUrl, 'https://a.example.test/api')
})

test('a failed silent health refresh cannot replace another editor\'s message or draft', async t => {
    const s = fixture(t)
    s.dataSourceConnections.value = [apiSource()]
    s.editDataSource(apiSource())
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: true, health: healthy(), healthToken: 'checked' }))
    const response = deferred()
    t.mock.method(adminApi, 'getDataSources', () => response.promise)
    const pending = s.testExternalDataSource()
    await settle()
    s.editDataSource(apiSource({ id: 'api-b', name: 'API B' }))
    response.reject(new Error('refresh unavailable'))
    await pending
    assert.equal(s.dataSourceEditor.id, 'api-b')
    assert.equal(s.dataSourceTestHealth.status, '')
    assert.equal(s.dataSourceMessage.value, '正在编辑：API B')
    assert.equal(s.dataSourceConnections.value[0].id, 'api-a')
    assert.equal(s.dataSourceBusy.value, false)
})

test('backend transport failure cannot leave a green health result from an older test', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ health: healthy() }))
    t.mock.method(adminApi, 'testDataSource', async () => { throw new TypeError('Failed to fetch') })
    await s.testExternalDataSource()
    assert.equal(s.dataSourceTestHealth.status, 'check_failed')
    assert.equal(s.dataSourceTestHealth.httpStatus, null)
    assert.equal(s.dataSourceTestHealth.checkedAt, null)
    assert.match(s.dataSourceMessage.value, /Failed to fetch/)
})

test('repeated test and save clicks cannot issue overlapping mutations', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource())
    const response = deferred()
    const check = t.mock.method(adminApi, 'testDataSource', () => response.promise)
    const save = mockSave(t)
    const pending = s.testExternalDataSource()
    await s.testExternalDataSource()
    await s.saveExternalDataSource()
    assert.equal(check.mock.callCount(), 1)
    assert.equal(save.mock.callCount(), 0)
    response.resolve({ success: true, health: healthy() })
    await pending
    assert.equal(s.dataSourceBusy.value, false)
})

test('typing during a save keeps newer edits and associates the new server id instead of creating duplicates', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ id: '' }))
    const response = deferred()
    t.mock.method(adminApi, 'saveDataSource', () => response.promise)
    const pending = s.saveExternalDataSource()
    s.dataSourceEditor.name = 'More recent name'
    s.dataSourceEditor.baseUrl = 'https://new.example.test'
    response.resolve({ success: true, connection: apiSource({ id: 'created-api' }), connections: [apiSource({ id: 'created-api' })] })
    await pending
    assert.equal(s.dataSourceEditor.id, 'created-api')
    assert.equal(s.dataSourceEditor.name, 'More recent name')
    assert.equal(s.dataSourceEditor.baseUrl, 'https://new.example.test')
    assert.match(s.dataSourceMessage.value, /未保存的修改/)
})

test('list errors preserve existing data and are shown as failures', async t => {
    const s = fixture(t)
    s.dataSourceConnections.value = [apiSource()]
    t.mock.method(adminApi, 'getDataSources', async () => ({ error: 'session expired' }))
    await s.loadDataSources()
    assert.equal(s.dataSourceConnections.value[0].id, 'api-a')
    assert.match(s.dataSourceMessage.value, /数据源读取失败.*session expired/)
})

test('refresh cannot resurrect stale saved health on an edited draft or overwrite a newer local check', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ health: healthy() }))
    t.mock.method(adminApi, 'getDataSources', async () => sourceList([apiSource({ health: healthy() })]))
    s.dataSourceEditor.baseUrl = 'https://b.example.test'
    await s.loadDataSources()
    assert.equal(s.dataSourceTestHealth.status, '')
    s.editDataSource(apiSource({ health: healthy() }))
    t.mock.method(adminApi, 'testDataSource', async () => ({ success: false, health: { status: 'timeout', message: 'timeout', checkedAt: null }, healthToken: 'latest' }))
    await s.testExternalDataSource()
    await s.loadDataSources()
    assert.equal(s.dataSourceTestHealth.status, 'timeout')
    assert.equal(s.dataSourceTestHealth.httpStatus, null)
})

test('an old list request cannot overwrite a successful save', async t => {
    const s = fixture(t)
    const response = deferred()
    t.mock.method(adminApi, 'getDataSources', () => response.promise)
    const pending = s.loadDataSources()
    s.editDataSource(apiSource({ id: '' }))
    mockSave(t)
    await s.saveExternalDataSource()
    response.resolve(sourceList([]))
    await pending
    assert.equal(s.dataSourceConnections.value[0].id, 'created-api')
})

test('refresh does not attach another saved configuration\'s health to the old editor values', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ health: healthy() }))
    t.mock.method(adminApi, 'getDataSources', async () => sourceList([
        apiSource({ baseUrl: 'https://changed-elsewhere.example.test', health: healthy() })
    ]))
    await s.loadDataSources()
    assert.equal(s.dataSourceEditor.baseUrl, 'https://a.example.test/api')
    assert.equal(s.dataSourceTestHealth.status, '')
    assert.match(s.dataSourceMessage.value, /重新选择/)
})

test('invalid timeouts are rejected before testing or saving instead of silently changing their meaning', async t => {
    const s = fixture(t)
    s.editDataSource(apiSource({ requestTimeoutMs: 0 }))
    const check = t.mock.method(adminApi, 'testDataSource', async () => ({ success: true, health: healthy() }))
    const save = mockSave(t)
    await s.testExternalDataSource()
    await s.saveExternalDataSource()
    assert.equal(check.mock.callCount(), 0)
    assert.equal(save.mock.callCount(), 0)
    assert.equal(s.dataSourceTestHealth.status, 'config_error')
    assert.match(s.dataSourceMessage.value, /1000.*60000/)
    s.dataSourceEditor.requestTimeoutMs = 1000
    await s.testExternalDataSource()
    assert.equal(check.mock.callCount(), 1)
})

test('delete HTTP errors do not clear the list or report a successful deletion', async t => {
    const s = fixture(t)
    s.dataSourceConnections.value = [apiSource()]
    t.mock.method(adminApi, 'deleteDataSource', async () => ({ error: 'permission denied' }))
    await s.removeExternalDataSource(apiSource())
    assert.equal(s.dataSourceConnections.value.length, 1)
    assert.match(s.dataSourceMessage.value, /删除失败.*permission denied/)
})

test('backup failures have their own visible feedback and do not report success for an HTTP error body', async t => {
    const s = fixture(t)
    s.dataSourceMessage.value = '正在编辑：API A'
    t.mock.method(adminApi, 'runDataSourceBackups', async () => ({ error: 'permission denied' }))
    await s.runSelectedDatabaseBackups()
    assert.match(s.dataSourceBackupMessage.value, /数据库备份失败.*permission denied/)
    assert.equal(s.dataSourceMessage.value, '正在编辑：API A')
    t.mock.method(adminApi, 'saveDataSourceBackupConfig', async () => ({ error: 'configuration unavailable' }))
    await s.saveDataSourceBackupConfiguration()
    assert.match(s.dataSourceBackupMessage.value, /自动备份配置保存失败.*configuration unavailable/)
})

test('disposing the settings scope invalidates an in-flight test', async t => {
    const s = fixture(t)
    const response = deferred()
    t.mock.method(adminApi, 'testDataSource', () => response.promise)
    const pending = s.testExternalDataSource()
    s.scope.stop()
    response.resolve({ success: true, health: healthy(), healthToken: 'late' })
    await pending
    assert.equal(s.dataSourceTestHealth.status, '')
})

test('data-source API preserves structured health on non-2xx responses without claiming success', async t => {
    const { browser } = installBrowser(t)
    const failure = { success: true, error: 'invalid credentials', health: { ...healthy(), status: 'auth_failed', httpStatus: 401 } }
    t.mock.method(browser, 'fetch', async () => json(failure, 400))
    const result = await adminApi.testDataSource(apiSource())
    assert.equal(result.success, false)
    assert.equal(result.health.httpStatus, 401)
    assert.equal(result.error, 'invalid credentials')
})
