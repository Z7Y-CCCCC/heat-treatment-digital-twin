import test from 'node:test'
import assert from 'node:assert/strict'
import { DATA_SOURCE_CATALOG, filterSources, sourceCatalogEntry, sourceEndpoint, sourceStatus } from '../src/views/admin/utils/dataSourceCatalog.js'
test('complete catalog distinguishes real adapters, device channels and planned connectors', () => {
    assert.equal(DATA_SOURCE_CATALOG.length, 28)
    assert.equal(DATA_SOURCE_CATALOG.filter(entry => entry.status === 'ready').length, 13)
    assert.equal(DATA_SOURCE_CATALOG.filter(entry => entry.status === 'device').length, 3)
    for (const entry of DATA_SOURCE_CATALOG) {
        assert.match(entry.image, /^\/images\/data-sources\/[\w-]+\.svg$/)
        if (entry.status === 'ready') assert.ok(['mysql', 'postgres', 'sqlserver', 'sqlite', 'http_api'].includes(entry.draft.type))
        else assert.equal(entry.draft, undefined, 'unimplemented connectors must not create a false working connection')
    }
    assert.equal(DATA_SOURCE_CATALOG.find(item => item.key === 'postgres').draft.port, 5432)
    assert.equal(DATA_SOURCE_CATALOG.find(item => item.key === 'odata').draft.type, 'http_api')
    assert.equal(DATA_SOURCE_CATALOG.find(item => item.key === 'sqlserver').draft.trustServerCertificate, false)
    assert.equal(DATA_SOURCE_CATALOG.find(item => item.key === 'excel').draft.connector, 'file')
    assert.equal(sourceCatalogEntry({ sourceType: 'http_api', connector: 'file', baseUrl: 'sample.xlsx' }).key, 'excel')
})
test('source search covers name, address and database without exposing credentials or including the primary database', () => {
    const connections = [{ id: 'primary', primary: true, name: '主库' }, { name: 'MES', type: 'postgres', host: 'db.internal', database: 'orders', user: 'secret', password: 'secret', enabled: true }, { name: '工单接口', sourceType: 'http_api', baseUrl: 'https://mes.internal', enabled: false }]
    assert.equal(filterSources(connections).length, 2)
    assert.equal(filterSources(connections, 'MES').length, 2)
    assert.equal(filterSources(connections, 'orders', 'database').length, 1)
    assert.equal(filterSources(connections, '', 'http').length, 1)
    assert.equal(filterSources(connections, 'secret').length, 0)
    assert.equal(sourceCatalogEntry(connections[2]).key, 'http')
    assert.ok(!sourceEndpoint(connections[1]).includes('secret'))
})
test('disabled sources are not presented as healthy and unknown is not mistaken for online', () => {
    assert.equal(sourceStatus({ enabled: false, health: { status: 'healthy' } }).label, '已停用')
    assert.equal(sourceStatus({ enabled: true }).label, '未检查')
    assert.equal(sourceStatus({ enabled: true, health: { status: 'healthy' } }).label, '检查通过')
})
