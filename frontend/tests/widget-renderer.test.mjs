import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileStyle } from 'vue/compiler-sfc'
import { installBrowser } from './helpers.mjs'

const charts = []
mock.module('echarts', { namedExports: { init: element => {
    const chart = {
        element, options: [], disposed: false, resizeCount: 0,
        setOption(...args) { this.options.push(args) },
        resize() { this.resizeCount += 1 },
        dispose() { this.disposed = true }
    }
    charts.push(chart)
    return chart
} } })

const source = await readFile(new URL('../src/runtime/WidgetRenderer.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, { id: 'widget-regression', inlineTemplate: true }).content
    .replace(/from (['"])(vue|echarts)\1/g, (_, _quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
    .replace(/from (['"])\.\/hudPresentation\.js\1/g, `from ${JSON.stringify(new URL('../src/runtime/hudPresentation.js', import.meta.url).href)}`)
const { default: WidgetRenderer } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const hudSource = await readFile(new URL('../src/runtime/hudWidgets.css', import.meta.url), 'utf8')
const hudStyles = compileStyle({ source: hudSource, id: 'hud-regression' })
assert.deepEqual(hudStyles.errors, [])

function hudDeclarations(selector) {
    const declarations = {}
    hudStyles.rawResult.root.walkRules(rule => {
        if (rule.selector === selector) rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value })
    })
    assert.ok(Object.keys(declarations).length, `Missing HUD rule: ${selector}`)
    return declarations
}

function node(type, text = '') { return { type, text, children: [], props: {}, style: {}, parent: null } }
function fixture(t) {
    const environment = installBrowser(t)
    charts.length = 0
    const observers = []
    environment.replace('ResizeObserver', class {
        constructor(callback) { this.callback = callback; observers.push(this) }
        observe(element) { this.element = element; this.disconnected = false }
        disconnect() { this.disconnected = true }
    })
    const renderer = createRenderer({
        createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
        setText: (element, text) => { element.text = text }, setElementText: (element, text) => { element.text = text; element.children = [] },
        parentNode: element => element.parent, nextSibling: () => null,
        patchProp: (element, key, _previous, value) => { element.props[key] = value },
        insert(element, parent, anchor = null) {
            if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
            element.parent = parent
            const index = parent.children.indexOf(anchor)
            if (index < 0) parent.children.push(element)
            else parent.children.splice(index, 0, element)
        },
        remove(element) {
            if (element.parent) element.parent.children = element.parent.children.filter(child => child !== element)
            element.parent = null
        }
    })
    const root = node('root')
    environment.beforeRestore(() => renderer.render(null, root))
    return {
        root, observers,
        render: async props => { renderer.render(h(WidgetRenderer, props), root); await nextTick(); await nextTick() }
    }
}

const textContent = root => [root.text, ...root.children.map(textContent)].join(' ')
const findNode = (root, match) => match(root) ? root : root.children.map(child => findNode(child, match)).find(Boolean)

test('HUD KPIs keep the live value and unit in separate typography elements', async t => {
    const view = fixture(t)
    const widget = { id: 'energy_value', type: 'text', content: { text: '今日用电量\n{value} kWh', showTitle: false }, data: { path: 'metrics.energy_consumption' } }
    await view.render({ widget, overlayMode: true, metrics: { energy_consumption: 3712 } })
    assert.match(view.root.children[0].props.class, /text-is-kpi/)
    assert.equal(findNode(view.root, element => element.type === 'small')?.text, 'kWh')
    assert.match(textContent(view.root), /3,?712/)
    await view.render({ widget, overlayMode: true, metrics: { energy_consumption: 3900 } })
    assert.match(textContent(view.root), /3,?900/)
    await view.render({ widget, overlayMode: false, metrics: { energy_consumption: 3900 } })
    assert.doesNotMatch(view.root.children[0].props.class, /text-is-kpi/)
})

test('heading styling is attached to the renderer in every preview context', async t => {
    const view = fixture(t)
    await view.render({ overlayMode: true, widget: { id: 'heading', type: 'text', content: { text: '▸ 生产运行参数', showTitle: false } } })
    assert.match(view.root.children[0].props.class, /hud-heading/)
    await view.render({ overlayMode: true, widget: { id: 'heat_header_brand', type: 'text', content: { text: '热处理 · 生产运行中心\nHEAT TREATMENT / DIGITAL TWIN', showTitle: false } } })
    assert.match(view.root.children[0].props.class, /hud-brand/)
    const body = findNode(view.root, element => element.props.class === 'text-widget-body')
    assert.equal(body.children.filter(element => element.type === 'p').length, 2)
})

test('HUD labels and values retain their migrated font hierarchy and live bindings', async t => {
    const view = fixture(t)
    const label = {
        id: 'cfg_total_label', type: 'text', content: { text: '设备总数', showTitle: false },
        style: { fontSize: 13.88976377952756, color: '#ABC6D8' }
    }
    const value = {
        id: 'cfg_total_value', type: 'text', content: { text: '{value} 台', showTitle: false },
        style: { fontSize: 17.748031496062993, color: '#66DDF7' },
        data: { path: 'metrics.total_devices', decimals: 0 }
    }
    const before = JSON.stringify([label, value])
    await view.render({ widget: label, overlayMode: true })
    const labelSize = view.root.children[0].props.style['--hud-text-size']
    assert.equal(labelSize, `${label.style.fontSize}px`)
    assert.equal(view.root.children[0].props.style.color, label.style.color)
    await view.render({ widget: value, overlayMode: true, metrics: { total_devices: 6 } })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], `${value.style.fontSize}px`)
    assert.ok(parseFloat(view.root.children[0].props.style['--hud-text-size']) > parseFloat(labelSize))
    assert.equal(view.root.children[0].props.style.fontSize, undefined)
    assert.equal(view.root.children[0].props.style.color, value.style.color)
    assert.match(textContent(view.root), /6 台/)
    await view.render({ widget: value, overlayMode: true, metrics: { total_devices: 7 } })
    assert.match(textContent(view.root), /7 台/)
    assert.equal(JSON.stringify([label, value]), before)
})

test('HUD heading size updates and state text continues inheriting its condition color', async t => {
    const view = fixture(t)
    const heading = { id: 'heading', type: 'text', content: { text: '▸ 生产运行参数', showTitle: false }, style: { fontSize: 16.8 } }
    await view.render({ widget: heading, overlayMode: true })
    assert.match(view.root.children[0].props.class, /hud-heading/)
    assert.equal(view.root.children[0].props.style['--hud-text-size'], '16.8px')
    await view.render({ widget: { ...heading, style: { fontSize: 18 } }, overlayMode: true })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], '18px')
    const state = {
        id: 'cfg_alarm_Furnace_01', type: 'text',
        content: { text: '{value}', showTitle: false, onText: '报警', offText: '正常' },
        style: { fontSize: 13.6, color: '#66E3BF' },
        data: { path: 'metrics.active_alarm' },
        conditions: [{ operator: '==', value: true, color: '#f87171' }]
    }
    for (const alarm of [false, true]) {
        await view.render({ widget: state, overlayMode: true, metrics: { active_alarm: alarm } })
        assert.match(view.root.children[0].props.class, /text-is-state/)
        assert.equal(view.root.children[0].props.style['--hud-text-size'], '13.6px')
        assert.equal(view.root.children[0].props.style.color, alarm ? '#f87171' : '#66E3BF')
        assert.match(textContent(view.root), alarm ? /报警/ : /正常/)
    }
})

test('HUD panel alpha changes the surface without fading the content', async t => {
    const view = fixture(t)
    const widget = {
        id: 'alpha-panel', type: 'trend',
        content: { chartType: 'line' },
        style: { backgroundOpacity: 0.24 }
    }
    await view.render({ widget, overlayMode: true })
    const style = view.root.children[0].props.style
    assert.equal(style['--hud-panel-opacity'], 0.24)
    assert.match(style['--hud-glass-bg'], /rgba\(16, 24, 48, 0\.24\)/)
    assert.equal(style.opacity, 1)

    await view.render({ widget: { ...widget, style: { backgroundOpacity: 0 } }, overlayMode: true })
    const transparentStyle = view.root.children[0].props.style
    assert.equal(transparentStyle['--hud-panel-opacity'], 0)
    assert.match(transparentStyle['--hud-glass-bg'], /rgba\(16, 24, 48, 0\)/)
    assert.equal(transparentStyle.opacity, 1)
})

test('HUD font variables do not replace non-overlay sizing or missing-size fallbacks', async t => {
    const view = fixture(t)
    const widget = { id: 'text', type: 'text', content: { text: '设备总数', showTitle: false }, style: { fontSize: '18px' } }
    await view.render({ widget, overlayMode: true })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], '18px')
    await view.render({ widget, overlayMode: false })
    assert.equal(view.root.children[0].props.style.fontSize, '18px')
    assert.equal(view.root.children[0].props.style['--hud-text-size'], undefined)
    await view.render({ widget: { ...widget, style: {} }, overlayMode: true })
    assert.equal(view.root.children[0].props.style['--hud-text-size'], undefined)
})

test('HUD CSS consumes authored text sizes without rescaling brand or KPI typography', () => {
    const text = hudDeclarations('.hud-widget .widget-kind-text:not(.text-is-kpi):not(.hud-brand):not(.hud-heading) .text-widget-body')
    const heading = hudDeclarations('.hud-widget .hud-heading .text-widget-body')
    assert.equal(text['font-size'], 'var(--hud-text-size, 12px)')
    assert.equal(heading['font-size'], 'var(--hud-text-size, 13px)')
    assert.equal(text.color, 'inherit')
    assert.equal(text.transform, undefined)
    assert.equal(heading.transform, undefined)
    assert.equal(hudDeclarations('.hud-widget .hud-brand p:first-child')['font-size'], '22px')
    assert.equal(hudDeclarations('.hud-widget .hud-brand p:last-child')['font-size'], '10px')
    assert.equal(hudDeclarations('.hud-widget .text-is-kpi p:first-child')['font-size'], '11px')
    assert.equal(hudDeclarations('.hud-widget .text-is-kpi p:last-child')['font-size'], '20px')
})

test('chart options replace prior chart types and removed series instead of merging', async t => {
    const view = fixture(t)
    await view.render({ widget: { id: 'chart', type: 'trend', content: { chartType: 'line' } }, trendPoints: [{ time: '10:00', value: 42 }] })
    await view.render({ widget: { id: 'chart', type: 'trend', content: { chartType: 'pie' } }, trendPoints: [] })
    assert.ok(charts.length > 0)
    const latest = charts.at(-1).options.at(-1)
    assert.equal(latest[0].series[0].type, 'pie')
    assert.equal(latest[1], true)
    assert.equal(latest[2], true)
})

test('charts observe their own container and are recreated when chart DOM changes', async t => {
    const view = fixture(t)
    await view.render({ widget: { id: 'chart', type: 'metrics', content: {} } })
    const first = charts.at(-1)
    view.observers.at(-1).callback()
    assert.equal(first.resizeCount, 1)
    await view.render({ widget: { id: 'chart', type: 'metrics', content: { layout: 'list' } } })
    assert.equal(first.disposed, true)
    await view.render({ widget: { id: 'chart', type: 'metrics', content: {} } })
    assert.notEqual(charts.at(-1), first)
    assert.equal(charts.at(-1).disposed, false)
})

test('out-of-range metric precision cannot crash the entire dashboard', async t => {
    const view = fixture(t)
    await view.render({
        widget: { id: 'metric', type: 'metrics', content: { layout: 'list', items: [{ label: 'Output', path: 'metrics.current_output', decimals: 1000 }] } },
        metrics: { current_output: 12.5 }
    })
    assert.match(textContent(view.root), /12\.50000000/)
})

test('missing values do not satisfy numeric zero conditions and invalid legacy lists are ignored', async t => {
    const view = fixture(t)
    await view.render({ widget: {
        id: 'value', type: 'text', content: { value: null },
        conditions: [{ operator: '==', value: 0, color: 'red' }],
        config: { events: {} }
    } })
    assert.notEqual(view.root.children[0].props.style?.color, 'red')
    await view.render({ widget: { id: 'value', type: 'text', config: { conditions: {}, events: {} } } })
})

test('a PLC widget without runtime samples is stale, not falsely healthy', async t => {
    const view = fixture(t)
    await view.render({ widget: { id: 'value', type: 'text', data: { mode: 'plc', device_id: 'missing', point_id: 'missing' } } })
    assert.match(view.root.children[0].props.class, /quality-stale/)
})

test('overlay charts use the HUD theme without changing samples or designer styling', async t => {
    const view = fixture(t)
    const widget = { id: 'chart', type: 'trend', content: { chartType: 'area' } }
    const trendPoints = [{ time: '10:00', value: 42 }, { time: '10:01', value: 44 }]
    await view.render({ widget, trendPoints, overlayMode: true })
    const hud = charts.at(-1).options.at(-1)[0]
    assert.equal(hud.backgroundColor, 'transparent')
    assert.equal(hud.series[0].lineStyle.width, 1.4)
    assert.equal(hud.series[0].areaStyle.color.type, 'linear')
    assert.equal(hud.yAxis.splitLine.lineStyle.type, 'dashed')
    const samples = hud.series[0].data
    await view.render({ widget: { ...widget }, trendPoints, overlayMode: false })
    const designer = charts.at(-1).options.at(-1)[0]
    assert.deepEqual(designer.series[0].data, samples)
    assert.equal(designer.series[0].lineStyle.width, 2)
})

test('overlay bar, ring and gauge widgets share lightweight presentation', async t => {
    const view = fixture(t)
    for (const chartType of ['bar', 'stackedBar', 'scatter', 'pie', 'donut', 'gauge']) {
        await view.render({ overlayMode: true, widget: { id: 'themed', type: 'trend', content: { chartType } }, trendPoints: [{ time: '10:00', value: 42 }] })
        const option = charts.at(-1).options.at(-1)[0]
        assert.equal(option.backgroundColor, 'transparent')
        if (chartType.includes('Bar') || chartType === 'bar') assert.equal(option.series[0].barMaxWidth, 12)
        if (chartType === 'donut') assert.deepEqual(option.series[0].radius, ['73%', '81%'])
        if (chartType === 'gauge') {
            assert.equal(option.series[0].progress.width, 4)
            assert.equal(option.series[0].pointer.show, false)
        }
    }
    await view.render({ overlayMode: true, widget: { id: 'oee', type: 'metrics', content: {} }, metrics: { overall_oee: 92 } })
    const ring = charts.at(-1).options.at(-1)[0].series[0]
    assert.deepEqual(ring.data.map(item => item.value), [92, 8])
})
