import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { baseParse } from '@vue/compiler-dom'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'

// Source-only acceptance: one point is one table row, including advanced columns.
// These tests never start a backend/browser/database/collector/Unity/PLC.
const panelUrl = new URL('../src/views/AdminPanel.vue', import.meta.url)
const pickerUrl = new URL('../src/views/admin/components/PointDeviceSelect.vue', import.meta.url)
const panel = await readFile(panelUrl, 'utf8'), picker = await readFile(pickerUrl, 'utf8')
const composable = await readFile(new URL('../src/views/admin/composables/useDataPoints.js', import.meta.url), 'utf8')
const parsedPanel = parse(panel, { filename: panelUrl.pathname }), parsedPicker = parse(picker, { filename: pickerUrl.pathname })
const template = parsedPanel.descriptor.template.content
const start = template.indexOf('<section id="points-panel-mapping"'), end = template.indexOf('</section>', start)
assert.ok(start >= 0 && end > start)
const mapping = template.slice(start, end + '</section>'.length)
function elements(node, ancestors = []) {
  return (node.children || []).flatMap(child => [
    ...(child.type === 1 ? [{ node: child, ancestors }] : []),
    ...elements(child, child.type === 1 ? [...ancestors, child] : ancestors)
  ])
}
const entries = elements(baseParse(mapping))
const attr = (node, name) => node.props?.find(prop => prop.type === 6 && prop.name === name)?.value?.content
const dir = (node, name, arg) => node.props?.find(prop => prop.type === 7 && prop.name === name && (arg === undefined || prop.arg?.content === arg))
const expression = (node, name, arg) => dir(node, name, arg)?.exp?.content
const classed = (node, name) => String(attr(node, 'class') || '').split(/\s+/).includes(name)
const compact = value => String(value || '').replace(/\s+/g, '')
const children = (node, tag) => (node.children || []).filter(child => child.type === 1 && (!tag || child.tag === tag))
const one = predicate => { const matches = entries.filter(({ node, ancestors }) => predicate(node, ancestors)); assert.equal(matches.length, 1); return matches[0] }
const field = model => one(node => expression(node, 'model') === model)
const nativeModels = ['p.label', 'p.__usage', 'p.data_type', 'p.plc_tag', 'p.sample_interval_ms', 'p.access_type', 'p.unit', 'p.alarm_condition', 'p.scale', 'p.offset', 'p.display_format']
const advancedModels = ['p.scale', 'p.offset', 'p.display_format']
const styles = parsedPanel.descriptor.styles.filter(style => !style.src).map(style => compileStyle({ source: style.content, filename: panelUrl.pathname, id: 'point-mapping-layout' }))
const pickerStyles = parsedPicker.descriptor.styles.filter(style => !style.src).map(style => compileStyle({ source: style.content, filename: pickerUrl.pathname, id: 'point-mapping-picker' }))
const normalizeSelector = value => value.replace(/\s*>\s*/g, '>').replace(/\s+/g, ' ').trim()
function cssValues(selector, results = styles) {
  const values = {}; let found = false
  for (const result of results) result.rawResult.root.walkRules(rule => {
    if (!rule.selector.split(',').some(value => normalizeSelector(value) === normalizeSelector(selector))) return
    found = true
    for (const declaration of rule.nodes.filter(node => node.type === 'decl')) values[declaration.prop] = declaration.value
  })
  assert.ok(found, `Missing style for ${selector}`); return values
}

test('single-row mapping, compact picker and all local styles compile', () => {
  assert.deepEqual(parsedPanel.errors, []); assert.deepEqual(parsedPicker.errors, [])
  assert.deepEqual(compileTemplate({ source: mapping, filename: panelUrl.pathname, id: 'point-mapping-layout' }).errors, [])
  const script = compileScript(parsedPicker.descriptor, { id: 'point-mapping-picker' })
  assert.deepEqual(compileTemplate({ source: parsedPicker.descriptor.template.content, filename: pickerUrl.pathname, id: 'point-mapping-picker', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  for (const style of [...styles, ...pickerStyles]) assert.deepEqual(style.errors, [])
})

test('one paginated point is one native table row with a stable key and pending marker, never a stacked card', () => {
  const table = one(node => classed(node, 'point-mapping-table')).node, row = one(node => classed(node, 'point-mapping-row')).node
  assert.equal(table.tag, 'table'); assert.ok(classed(table, 'points-table') && classed(table, 'data-table'))
  assert.equal(row.tag, 'tr'); assert.equal(expression(row, 'for'), 'p in paginatedDataPoints')
  assert.equal(expression(row, 'bind', 'key'), 'pointRowKey(p)'); assert.equal(expression(row, 'bind', 'id'), 'pointRowKey(p)')
  assert.equal(expression(row, 'bind', 'data-point-id'), 'p.id || pointRowKey(p)')
  assert.match(expression(row, 'bind', 'class'), /'is-new-point': !p\.id/); assert.match(expression(row, 'bind', 'aria-label'), /未保存/)
  assert.equal(entries.filter(({ node }) => expression(node, 'for') === 'p in paginatedDataPoints').length, 1)
  assert.doesNotMatch(mapping, /<article\b|point-mapping-card|point-fields-(?:main|secondary|advanced)|role="listitem"/)
  for (const model of [...nativeModels, 'p.device_id']) {
    const entry = field(model); assert.equal(entry.ancestors.findLast(node => node.tag === 'tr'), row, `${model} remains in the same tr`)
    assert.ok(entry.ancestors.some(node => node.tag === 'td'))
  }
  for (const name of ['voice-config-button', 'point-delete-button']) assert.equal(one(node => classed(node, name)).ancestors.findLast(node => node.tag === 'tr'), row)
})

test('colgroup, headers and cells align with ordinary, advanced and optional history columns', () => {
  const table = one(node => classed(node, 'point-mapping-table')).node
  assert.equal(children(table, 'colgroup').length, 1); assert.equal(children(table, 'thead').length, 1); assert.equal(children(table, 'tbody').length, 1)
  const columns = children(children(table, 'colgroup')[0], 'col'), headerRows = children(children(table, 'thead')[0], 'tr')
  assert.equal(headerRows.length, 1)
  const headers = children(headerRows[0], 'th'), cells = children(one(node => classed(node, 'point-mapping-row')).node, 'td')
  assert.equal(columns.length, 15); assert.equal(headers.length, columns.length); assert.equal(cells.length, columns.length)
  const conditions = nodes => nodes.map(node => compact(expression(node, 'if')))
  assert.deepEqual(conditions(headers), conditions(columns)); assert.deepEqual(conditions(cells), conditions(columns))
  assert.equal(conditions(cells).filter(condition => condition === 'isAllPointsMode').length, 1)
  assert.equal(conditions(cells).filter(condition => condition === 'showPointAdvancedFields').length, 3)
  assert.equal(conditions(cells).filter(condition => condition === 'pointHistoryColumn.visible.value').length, 1)
  for (const all of [false,true]) for (const advanced of [false,true]) for (const history of [false,true]) {
    const enabled = {'':true,isAllPointsMode:all,showPointAdvancedFields:advanced,'pointHistoryColumn.visible.value':history}
    const expected = 10 + Number(all) + 3 * Number(advanced) + Number(history)
    for (const nodes of [columns,headers,cells]) assert.equal(conditions(nodes).filter(condition => enabled[condition]).length, expected)
  }
  for (const model of advancedModels) assert.equal(expression(field(model).ancestors.findLast(node => node.tag === 'td'), 'if'), 'showPointAdvancedFields')
  assert.equal(expression(field('p.device_id').ancestors.findLast(node => node.tag === 'td'), 'if'), 'isAllPointsMode')
  for (const model of nativeModels) assert.ok(attr(field(model).node, 'aria-label') || expression(field(model).node, 'bind', 'aria-label'), `${model} has an accessible field name`)
})

test('one accessible horizontal scroll region preserves nonwrapping rows and scaled readable controls instead of hiding large text', () => {
  const region = one(node => classed(node, 'point-table-scroll')).node
  assert.equal(attr(region, 'role'), 'region'); assert.equal(attr(region, 'aria-label'), '点位配置列表'); assert.equal(attr(region, 'tabindex'), '0')
  const scroll = cssValues('.point-table-scroll'); assert.equal(scroll['min-width'], '0'); assert.equal(scroll.width, '100%')
  assert.ok(['auto', 'scroll'].includes(scroll['overflow-x'] || scroll.overflow))
  const table = cssValues('.points-table'); assert.equal(table['table-layout'], 'fixed')
  assert.match(table['--point-column-scale'], /var\(--admin-font-scale/); assert.match(table['min-width'], /var\(--point-column-scale\)/)
  assert.match(cssValues('.points-table.points-table-all')['min-width'], /calc\((?:8\d\d|9\d\d)px \* var\(--point-column-scale\)\)/, 'ordinary full-device columns fit the common 900-940px content range')
  assert.equal(cssValues('.points-table th')['white-space'], 'nowrap'); assert.equal(cssValues('.points-table td')['white-space'], 'nowrap')
  const input = cssValues('.points-table .input-sm'); assert.equal(input.width, '100%'); assert.equal(input['min-width'], '0'); assert.match(input['font-size'], /var\(--admin-font-scale/)
  for (const result of styles) result.rawResult.root.walkRules(rule => {
    if (!rule.selector.split(',').some(selector => /\.(?:point-mapping-row|point-mapping-table|points-table)(?:\s*>?\s*(?:tbody|tr|td|th))?\s*$/.test(selector.trim()))) return
    const values = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
    assert.ok(!['flex', 'grid', 'block', 'inline-block'].includes(values.display), `${rule.selector} cannot stack table cells/rows`)
    assert.notEqual(values['flex-wrap'], 'wrap'); assert.doesNotMatch(values.transform || '', /scale\(/); assert.equal(values.zoom, undefined)
  })
})

test('every point mutation keeps original native busy/edit guards while readonly users may inspect advanced values', () => {
  for (const model of nativeModels) {
    const node = field(model).node; assert.ok(['input', 'select'].includes(node.tag))
    assert.equal(compact(expression(node, 'permission')), "{page:controlPermissionPage,action:'edit'}")
    assert.match(expression(node, 'bind', 'disabled'), /pointsLoading/); assert.match(expression(node, 'bind', 'disabled'), /pointsSaving/)
  }
  assert.match(expression(field('p.unit').node, 'bind', 'disabled'), /isBoolPoint\(p\)/)
  assert.equal(compact(expression(field('p.device_id').node, 'bind', 'disabled')), "pointsLoading||pointsSaving||!canAdminPage(controlPermissionPage,'edit')")
  const remove = one(node => classed(node, 'point-delete-button')).node
  assert.equal(compact(expression(remove, 'permission')), "{page:controlPermissionPage,action:'edit'}"); assert.match(expression(remove, 'bind', 'disabled'), /pointsLoading.*pointsSaving/)
  assert.match(expression(remove, 'bind', 'aria-label'), /删除点位/); assert.match(expression(one(node => classed(node, 'voice-config-button')).node, 'bind', 'aria-label'), /配置点位语音/)
  for (const name of ['voice-config-button', 'point-delete-button']) assert.ok(elements(one(node => classed(node, name)).node).some(({ node }) => node.tag === 'svg'), `${name} is an accessible icon action`)
})

test('selected short usage/type overlays are aria-hidden and keep the full Chinese native options and original handlers', () => {
  for (const [model, loop, caption] of [['p.__usage', 'item in pointUsageOptions', 'item.label'], ['p.data_type', 'type in pointDataTypes', 'type.label']]) {
    const entry = field(model), options = elements(entry.node).filter(({ node }) => node.tag === 'option')
    assert.equal(options.length, 1); assert.equal(expression(options[0].node, 'for'), loop)
    assert.ok(options[0].node.children.some(child => child.type === 5 && child.content.content === caption))
    const overlays = elements(entry.ancestors.at(-1)).filter(({ node }) => node.tag === 'span' && attr(node, 'aria-hidden') === 'true')
    assert.equal(overlays.length, 1); assert.equal(dir(overlays[0].node, 'model'), undefined)
  }
  assert.equal(cssValues('.point-short-select>span')['pointer-events'], 'none')
  assert.equal(cssValues('.points-table .point-short-select select').color, 'transparent')
  assert.equal(cssValues('.points-table .point-short-select select:disabled').color, 'transparent', 'disabled native text cannot overlap its short-label overlay')
  assert.notEqual(cssValues('.points-table .point-short-select select option').color, 'transparent')
  assert.equal(expression(field('p.__usage').node, 'on', 'change'), 'setPointUsage(p, p.__usage)')
  assert.equal(expression(field('p.data_type').node, 'on', 'change'), 'handlePointDataTypeChange(p)')
})

test('dirty tracking, access modes, protocol address hints, alarm inputs and row actions preserve original point objects', () => {
  for (const model of nativeModels.filter(value => !['p.__usage', 'p.data_type', 'p.access_type', 'p.alarm_condition'].includes(value))) assert.equal(expression(field(model).node, 'on', 'input'), 'markPointsDirty')
  assert.equal(expression(field('p.alarm_condition').node, 'on', 'change'), 'markPointsDirty');
  assert.equal(expression(field('p.access_type').node, 'on', 'change'), 'markPointsDirty'); assert.equal(expression(field('p.device_id').node, 'on', 'change'), 'markPointsDirty')
  const address = field('p.plc_tag').node
  assert.equal(expression(address, 'bind', 'title'), 'getPlcDuplicateWarning(p) || getPlcAddressWarning(p) || getPointAddressTitle(p)'); assert.equal(expression(address, 'bind', 'placeholder'), 'getPointAddressPlaceholder(p)')
  assert.match(expression(address, 'bind', 'class'), /'has-warning': !!getPlcAddressWarning\(p\)/); assert.match(expression(address, 'bind', 'class'), /'has-duplicate': !!getPlcDuplicateWarning\(p\)/)
  assert.ok(mapping.indexOf('v-if="getPlcDuplicateWarning(p)"') < mapping.indexOf('v-else-if="getPlcAddressWarning(p)"'))
  assert.equal(expression(one(node => classed(node, 'point-delete-button')).node, 'on', 'click'), 'removeDataPoint(p)'); assert.equal(expression(one(node => classed(node, 'voice-config-button')).node, 'on', 'click'), 'openVoiceConfig(p)')
  assert.equal(expression(field('p.alarm_condition').node, 'if'), "normalizePointUsage(p) === 'alarm_trigger'")
  assert.deepEqual(elements(field('p.access_type').node).filter(({ node }) => node.tag === 'option').map(({ node }) => attr(node, 'value')), ['READ', 'READ_WRITE', 'WRITE'])
  assert.match(composable, /function pointRowKey\(point\)[\s\S]*?point = toRaw\(point\)[\s\S]*?rowKeys\.get\(point\)/)
  assert.match(composable, /function removeDataPoint\(target\)[\s\S]*?dataPoints\.value\.indexOf\(target\)/)
})

test('one global voice toolbar and UI-only advanced state retain pending borders and original save/payload readiness guards', () => {
  assert.equal((template.match(/<FactoryVoiceToggle\b/g) || []).length, 1)
  const voice = one(node => node.tag === 'FactoryVoiceToggle'); assert.ok(voice.ancestors.some(parent => classed(parent, 'point-toolbar'))); assert.ok(!voice.ancestors.some(parent => parent.tag === 'tr'))
  const toggle = one(node => expression(node, 'on', 'click') === 'togglePointExtraColumns').node
  assert.equal(expression(toggle, 'on', 'click'), 'togglePointExtraColumns'); assert.equal(expression(toggle, 'bind', 'aria-expanded'), 'showPointAdvancedFields')
  assert.doesNotMatch(expression(toggle, 'on', 'click'), /\bp\.|markPointsDirty|save/); assert.equal(dir(toggle, 'permission'), undefined)
  assert.deepEqual(entries.map(({ node }) => expression(node, 'model')).filter(value => value?.startsWith('p.')).toSorted(), [...nativeModels, 'p.device_id'].toSorted())
  assert.match(composable, /const showPointAdvancedFields = ref\(!!storedAdminUiState\.showPointAdvancedFields\)/)
  assert.match(composable, /if \(pointsLoading\.value \|\| !pointsLoaded\) return alert/); assert.match(composable, /const errors = validatePointRows\(dataPoints\.value\)/)
  assert.match(composable, /await adminApi\.syncDataPoints\(deviceId, rows\)/); assert.match(composable, /draftSnapshot !== JSON\.stringify\(dataPoints\.value\)/); assert.match(composable, /stayedOnOriginalDevice[\s\S]*?result\.id = id/)
  const saves = elements(baseParse(template)).filter(({ node }) => expression(node, 'on', 'click') === 'savePointsPage')
  assert.equal(saves.length, 1)
  assert.equal(compact(expression(saves[0].node, 'permission')), "{page:controlPermissionPage,action:'edit'}")
  assert.match(expression(saves[0].node, 'bind', 'disabled'), /pointsLoading.*pointsSaving/)
  const pending = cssValues('.points-table tr.is-new-point>td'); assert.match(pending['border-top'], /#42b883/); assert.match(pending['border-bottom'], /#42b883/)
  assert.match(cssValues('.points-table tr.is-new-point>td:first-child')['border-left'], /#42b883/); assert.match(cssValues('.points-table tr.is-new-point>td:last-child')['border-right'], /#42b883/)
})

test('compact device captions remain one line while full hierarchy search/options and guarded keyboard selection are preserved', () => {
  const instance = field('p.device_id').node
  assert.ok(dir(instance, 'bind', 'compact') || instance.props.some(prop => prop.type === 6 && prop.name === 'compact'))
  assert.match(expression(instance, 'bind', 'options'), /shortLabel: d\.name \|\| d\.id/); assert.match(expression(instance, 'bind', 'options'), /label: deviceHierarchyLabel\(d\)/)
  assert.match(picker, /compact:\s*Boolean/)
  assert.match(picker, /const selectedCaption = computed\(\(\) => props\.compact\s*\? selected\.value\?\.shortLabel \|\| selected\.value\?\.value \|\| '选择设备'\s*: selected\.value\?\.label \|\| '选择设备'\)/)
  assert.match(picker, /<span>\{\{ selectedCaption \}\}<\/span>/)
  assert.match(picker, /:title="selected\?\.label \|\| '选择设备'"/)
  assert.equal(cssValues('.compact .point-device-trigger>span', pickerStyles)['white-space'], 'nowrap')
  assert.match(picker, /item\.label\.toLowerCase\(\)/); assert.match(picker, /<span>\{\{ item\.label \}\}<\/span>/)
  const option = cssValues('.point-device-popup [role=option]>span', pickerStyles); assert.equal(option['white-space'], 'normal'); assert.equal(option['overflow-wrap'], 'anywhere')
  assert.match(picker, /role="listbox"/); assert.match(picker, /role="option" :aria-selected="item\.value === modelValue"/)
  assert.match(picker, /if \(event\.isComposing\) return/); assert.match(picker, /function choose\(value\) \{ if \(props\.disabled\) return/); assert.match(picker, /watch\(\(\) => props\.disabled, disabled => \{ if \(disabled\) close\(\)/); assert.match(picker, /innerWidth - width - 8/)
})
