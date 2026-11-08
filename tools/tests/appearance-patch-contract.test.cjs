'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appearanceChanges } = require('../apply-dashboard-appearance-patch.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const before = { sceneId: 'owned', scene: { views: [{ id: 'factory_overview' }, { id: 'device_detail', parentViewId: 'factory_overview' }] }, metadata: { revision: 5 }, tooltipTemplates: { templates: [{ id: 'tooltip', widgets: [{ id: 'dynamic', data: { mode: 'runtime', path: 'hover.device.status' } }] }] }, widgets: [{ id: 'value', type: 'text', title: '温度', style: { color: '#123456' }, content: { text: '{value}', lineColor: '#778899' }, frame: { x: 1, y: 2, width: 80, height: 30 }, data: { mode: 'plc', pointId: '638', deviceId: 'gone', unit: '℃' }, visibility: { viewIds: ['device_detail'] }, conditions: [{ color: '#ff0000' }] }] };
test('allows only the intended visual fields while retaining original dynamic IDs', () => {
  const after = copy(before); after.widgets[0].style.color = '#eef7ff'; after.widgets[0].style.borderRadius = 18; after.widgets[0].content.lineColor = '#dfbd73';
  assert.deepEqual(appearanceChanges(before, after), [{ id: 'value', index: 0, style: ['color','borderRadius'], content: ['lineColor'] }]);
  assert.equal(after.widgets[0].data.pointId, '638'); assert.equal(before.widgets[0].style.color, '#123456');
});
for (const [name, edit] of [
  ['binding', d => { d.widgets[0].data.pointId = 'replacement'; }],
  ['static text', d => { d.widgets[0].content.text = 'changed'; }],
  ['chart meaning', d => { d.widgets[0].content.chartType = 'gauge'; }],
  ['layout', d => { d.widgets[0].frame.height = 400; }],
  ['component type', d => { d.widgets[0].type = 'hud_chart_dock'; }],
  ['conditional alarm', d => { d.widgets[0].conditions[0].color = '#eeeeee'; }],
  ['tooltip bindings', d => { d.tooltipTemplates.templates[0].widgets[0].data.path = 'constant'; }],
  ['view structure', d => { d.scene.views[1].id = 'other'; }],
  ['metadata', d => { d.metadata.revision++; }],
  ['unrecognized style control', d => { d.widgets[0].style.display = 'none'; }]
]) test(`rejects unintended ${name} changes`, () => { const after = copy(before); edit(after); assert.throws(() => appearanceChanges(before, after)); });
test('rejects additions and ID reassignment', () => {
  const added = copy(before); added.widgets.push(copy(added.widgets[0])); assert.throws(() => appearanceChanges(before, added));
  const renamed = copy(before); renamed.widgets[0].id = 'replacement'; assert.throws(() => appearanceChanges(before, renamed));
});
test('accepts a constrained opt-in glass skin and originally visible child-view surface override', () => {
  const after = copy(before);
  Object.assign(after.widgets[0].style, { surfaceSkin: 'inline', surfaceAccent: '#a2a7ed', backdropFilter: 'none',
    viewOverrides: { device_detail: { surfaceSkin: 'glass', background: '#241f2e', backgroundOpacity: 1, borderColor: '#ffc45f', borderRadius: 10, shadow: 'soft', backdropFilter: 'blur(12px) saturate(125%)' } } });
  assert.equal(appearanceChanges(before, after).length, 1);
  assert.deepEqual(after.widgets[0].data, before.widgets[0].data);
});
for (const [name, value] of [
  ['source view', { factory_overview: { background: '#ffffff' } }],
  ['unknown view', { other: { background: '#ffffff' } }],
  ['data path', { device_detail: { data: { path: 'constant' } } }],
  ['text content', { device_detail: { content: { text: 'changed' } } }],
  ['layout', { device_detail: { frame: { height: 400 } } }],
  ['display visibility', { device_detail: { display: 'none' } }],
  ['font sizing', { device_detail: { fontSize: 99 } }],
  ['padding', { device_detail: { padding: 99 } }],
  ['nested overrides', { device_detail: { viewOverrides: {} } }],
  ['array styles', { device_detail: [] }],
  ['object inside color', { device_detail: { color: { path: 'hidden' } } }],
  ['invalid opacity', { device_detail: { backgroundOpacity: 2 } }],
  ['invalid radius', { device_detail: { borderRadius: -1 } }],
  ['unknown skin', { device_detail: { surfaceSkin: 'replacement' } }],
  ['unbounded glass blur', { device_detail: { backdropFilter: 'blur(999px)' } }],
  ['unbounded saturation', { device_detail: { backdropFilter: 'blur(12px) saturate(999%)' } }],
  ['CSS injection', { device_detail: { background: '#fff;display:none' } }],
  ['remote CSS resource', { device_detail: { background: 'url(https://example.invalid/x)' } }],
]) test(`rejects appearance overrides containing ${name}`, () => {
  const after = copy(before); after.widgets[0].style.viewOverrides = value;
  assert.throws(() => appearanceChanges(before, after));
});
test('rejects surface overrides for a component originally hidden in that child view', () => {
  const hidden = copy(before); hidden.scene.views[1].componentState = { hide: ['value'] };
  const after = copy(hidden); after.widgets[0].style.viewOverrides = { device_detail: { background: '#ffffff' } };
  assert.throws(() => appearanceChanges(hidden, after));
});
for (const [key, value] of [['surfaceSkin', { data: 'bad' }], ['surfaceAccent', ['#ffffff']], ['backdropFilter', { filter: 'none' }]]) {
  test(`rejects non-scalar opt-in ${key}`, () => {
    const after = copy(before); after.widgets[0].style[key] = value;
    assert.throws(() => appearanceChanges(before, after));
  });
}
