import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GROUP_PORTAL_APPEARANCE, normalizeGroupPortalAppearance } from '../src/runtime/groupPortalAppearance.js'

test('group appearance supports backend JSON and preserves defaults', () => {
    const value = normalizeGroupPortalAppearance(JSON.stringify({ brandTitle: '华北工厂群', showDock: false, accent: '#AABBCC' }))
    assert.equal(value.brandTitle, '华北工厂群')
    assert.equal(value.showDock, false)
    assert.equal(value.accent, '#aabbcc')
    assert.equal(value.panelTitle, DEFAULT_GROUP_PORTAL_APPEARANCE.panelTitle)
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
})
