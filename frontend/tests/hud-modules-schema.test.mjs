import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createDashboardWidget, createDashboardWidgetPreset, normalizeDashboardDocument, DASHBOARD_WIDGET_LIBRARY } from '../src/runtime/dashboardSchema.js'
import { hudTextFields, hudTextDefaults, resolveHudText } from '../src/runtime/hudTextConfig.js'
const require = createRequire(import.meta.url)
const { normalizeDocument, validateDocument } = require('../../backend/utils/dashboardDocument.js')
const types = ['hud_kpi_panel','hud_device_status','hud_alarm_panel','hud_chart_dock']

test('HUD inspector defaults match visible copy and authored blanks survive publication and reload', () => {
    for (const type of types) {
        const widget = createDashboardWidget(type)
        const defaults = hudTextDefaults(type)
        assert.ok(defaults.eyebrow)
        assert.equal(widget.content.eyebrow, defaults.eyebrow)
        assert.equal(resolveHudText(type).eyebrow, defaults.eyebrow)
        for (const { key } of hudTextFields(type)) {
            assert.equal(widget.content[key], defaults[key], `${type}.${key}`)
            widget.content[key] = `自定义 ${key}`
        }
        widget.style.eyebrowFontSize = 14
        widget.style.eyebrowColor = '#aad9ff'
        let document = normalizeDashboardDocument(normalizeDocument({ widgets: [widget] }))
        assert.deepEqual(document.widgets[0].content, widget.content)
        assert.equal(document.widgets[0].style.eyebrowFontSize, 14)
        assert.equal(document.widgets[0].style.eyebrowColor, '#aad9ff')
        for (const { key } of hudTextFields(type)) document.widgets[0].content[key] = ''
        document = normalizeDashboardDocument(normalizeDocument(document))
        for (const { key } of hudTextFields(type)) {
            assert.equal(document.widgets[0].content[key], '')
            assert.equal(resolveHudText(type, document.widgets[0].content)[key], '')
        }
        assert.equal(resolveHudText(type, { eyebrow: null }).eyebrow, '')
    }
})

test('HUD modules survive the frontend/backend publish round trip without type downgrade', () => {
    const source = normalizeDashboardDocument({ widgets: types.map(type => createDashboardWidget(type)) })
    const document = normalizeDocument(source)
    for (const type of types) {
        assert.ok(DASHBOARD_WIDGET_LIBRARY.some(item => item.type === type))
        const widget = document.widgets.find(item => item.type === type)
        assert.ok(widget, type)
        assert.equal(widget.runtimeTarget, 'overlay')
        assert.equal(widget.data.readOnly, true)
        assert.equal(widget.style.backgroundOpacity, .08)
    }
    const result = validateDocument(document)
    assert.deepEqual(result, [])
})

test('HUD presets keep caller view membership and independent copies', () => {
    const widgets = createDashboardWidgetPreset('factory_hud_modules', { viewIds: ['new_factory_view'] })
    assert.deepEqual(widgets.map(widget => widget.type), types)
    assert.equal(new Set(widgets.map(widget => widget.id)).size, 4)
    for (const widget of widgets) {
        assert.deepEqual(widget.visibility.viewIds, ['new_factory_view'])
        assert.ok(widget.frame.x >= 0 && widget.frame.y >= 0)
        assert.ok(widget.frame.x + widget.frame.width <= 1920)
        assert.ok(widget.frame.y + widget.frame.height <= 1080)
    }
    widgets[0].content.items[0].label = 'Changed'
    assert.notEqual(createDashboardWidgetPreset('factory_hud_modules')[0].content.items[0].label, 'Changed')
})
