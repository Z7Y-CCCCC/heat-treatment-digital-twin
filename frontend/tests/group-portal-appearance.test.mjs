import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GROUP_PORTAL_APPEARANCE, groupPortalAppearanceForLevel, normalizeGroupPortalAppearance } from '../src/runtime/groupPortalAppearance.js'

test('group appearance supports backend JSON and preserves defaults', () => {
    const value = normalizeGroupPortalAppearance(JSON.stringify({ brandTitle: '华北工厂群', showDock: false, accent: '#AABBCC' }))
    assert.equal(value.brandTitle, '华北工厂群')
    assert.equal(value.showDock, false)
    assert.equal(value.accent, '#aabbcc')
    assert.equal(value.panelTitle, DEFAULT_GROUP_PORTAL_APPEARANCE.panelTitle)
})

test('each map level can override components and camera without changing its siblings', () => {
    const raw = { showPanel: true, accent: '#123456', logoUrl: '/uploads/brand/logo.png', levels: {
        province: { showPanel: false, accent: '#ABCDEF', mapZoom: 1.4, factsTitle: '本省工厂', dockLocationTitle: '城市覆盖', logoUrl: '/uploads/brand/province.png', layout: { panel: { x: 68.5, y: 12 }, dock: { x: 5, y: 75 } } },
        city: { showDock: false }
    } }
    const province = groupPortalAppearanceForLevel(raw, 'province')
    const city = groupPortalAppearanceForLevel(raw, 'city')
    assert.equal(province.showPanel, false)
    assert.equal(province.accent, '#abcdef')
    assert.equal(province.mapZoom, 1.4)
    assert.equal(province.factsTitle, '本省工厂')
    assert.equal(province.dockLocationTitle, '城市覆盖')
    assert.equal(province.logoUrl, '/uploads/brand/province.png')
    assert.deepEqual(province.layout.panel, { x: 68.5, y: 12 })
    assert.equal(city.layout, undefined)
    assert.equal(city.showPanel, true)
    assert.equal(city.showDock, false)
    assert.equal(city.showBrand, true)
    assert.equal(city.factsTitle, '当前区域登记工厂')
    assert.equal(city.accent, '#123456')
    assert.equal(city.logoUrl, '/uploads/brand/logo.png')
    assert.equal(normalizeGroupPortalAppearance({ logoUrl: 'javascript:alert(1)' }).logoUrl, '')
})

test('invalid appearance colors and malformed JSON cannot reach CSS', () => {
    assert.equal(normalizeGroupPortalAppearance('{').background, DEFAULT_GROUP_PORTAL_APPEARANCE.background)
    assert.equal(normalizeGroupPortalAppearance({ background: 'url(javascript:bad)' }).background,
        DEFAULT_GROUP_PORTAL_APPEARANCE.background)
    assert.equal(normalizeGroupPortalAppearance({ markerPrimary: 'red', mapZoom: 4 }).markerPrimary,
        DEFAULT_GROUP_PORTAL_APPEARANCE.markerPrimary)
    assert.equal(normalizeGroupPortalAppearance({ mapZoom: 4 }).mapZoom,
        DEFAULT_GROUP_PORTAL_APPEARANCE.mapZoom)
    assert.equal(normalizeGroupPortalAppearance({ mapZoom: 1.3 }).mapZoom, 1.3)
    assert.equal(groupPortalAppearanceForLevel({ levels: { world: { showBrand: false } } }, 'world').showBrand, false)
    assert.deepEqual(normalizeGroupPortalAppearance({ levels: { world: { layout: { brand: { x: -1, y: 3 }, facts: { x: 12, y: 20 } } } } }).levels.world.layout,
        { facts: { x: 12, y: 20 } })
})

test('map metrics keep independent per-level HTTP bindings', () => {
    const binding = { mode:'http_api', connectionId:'erp_api', apiPath:'/stats', jsonPath:'data.factories', refreshMs:30000 }
    const source = { levels:{ province:{ dataBindings:{ factsFactoryCount:binding } }, city:{ dataBindings:{} } } }
    assert.deepEqual(groupPortalAppearanceForLevel(source,'province').dataBindings.factsFactoryCount,{...binding,factoryId:''})
    assert.deepEqual(groupPortalAppearanceForLevel(source,'city').dataBindings,{})
    assert.equal(groupPortalAppearanceForLevel(source,'world').dataBindings,undefined)
})
