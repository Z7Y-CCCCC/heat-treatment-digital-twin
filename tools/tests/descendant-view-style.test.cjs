'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  applyDescendantViewStyle, isViewEligible, textRole,
  validateViewOverrides, DEFAULT_SFC_ACCENT, DEFAULT_SFC_BACKDROP_FILTER,
  SOURCE_WIDGETS, DEFAULT_TARGET_VIEW_IDS,
} = require('../lib/descendant-view-style.cjs');
const { appearanceChanges } = require('../apply-dashboard-appearance-patch.cjs');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const referenceIds = Object.values(SOURCE_WIDGETS).map(([id]) => id);
  const surface = {
    color: '#eef7ff', shadow: 'soft', opacity: 1,
    background: 'rgba(10, 18, 34, .12)', borderColor: 'rgba(137, 149, 245, .24)',
    borderRadius: 18, backgroundOpacity: .12,
  };
  const refs = Object.entries(SOURCE_WIDGETS).map(([role, [id, type]]) => ({
    id, type, title: `Source ${role}`, data: { mode: 'runtime', path: `${role}.data` },
    style: { ...surface,
      ...(role === 'devices' ? { borderColor: 'rgba(113, 203, 216, .2)' } : {}),
      ...(role === 'alarms' ? { borderColor: 'rgba(231, 127, 152, .2)' } : {}),
      ...(role === 'trend' ? { color: '#dbeeff', background: '#241f2e', backgroundOpacity: 1, borderColor: '#ffc45f', borderRadius: 10, fontSize: '' } : {}),
    },
    content: role === 'trend'
      ? { lineColor: '#68d5ff', areaColor: '#ffc45f', lineWidth: 1.4, areaOpacity: .2, chartType: 'area', showTitle: true }
      : { items: [{ path: 'preserve.source', label: 'Source item' }] },
    frame: { x: 100, y: 200, width: 300, height: 400 },
    visibility: { viewIds: ['factory_overview'] },
  }));
  function widget(id, type = 'text', extra = {}) {
    return {
      id, type, title: 'Business title', runtimeTarget: 'web',
      style: { color: '#66ddf7', shadow: 'glow', opacity: .9, padding: 7, fontSize: 23, background: '#071C2D', borderColor: '#28536C', borderRadius: 10, backgroundOpacity: .12 },
      content: { text: '{value} ℃', tone: 'normal', align: 'right', showTitle: false, fallback: '--' },
      data: { mode: 'plc', path: 'analog.actual_temp', pointId: '638', deviceId: 'deleted-but-do-not-rebind', unit: '℃', datasets: [{ field: 'value', color: '#ff0000', pointId: '123' }], rotationDeviceIds: ['first', 'second'] },
      frame: { x: 11, y: 22, width: 133, height: 44, rotation: 5 },
      visibility: { viewIds: [...DEFAULT_TARGET_VIEW_IDS], viewModes: [], rules: [{ source: 'context', path: 'deviceId', operator: '==', value: 'second' }] },
      events: [{ trigger: 'click', action: 'switch_view', viewId: 'device_detail' }],
      conditions: [], animation: { enter: 'fade' }, zIndex: 19,
      ...extra,
    };
  }
  const candidates = [
    widget('overview_metrics', 'container'), widget('gas_metrics', 'container'),
    widget('line_monitor', 'container'), widget('running_devices', 'container'),
    widget('cfg_detail_status_panel', 'container'), widget('alarm_history', 'container'),
    widget('temperature_trend', 'container'), widget('detail_trend', 'container'),
    widget('cfg_temperature_trend_title', 'text', { content: { text: '▸  实际炉温趋势', showTitle: false } }),
    widget('cfg_param_1_label', 'text', { content: { text: '实际炉温' } }),
    widget('cfg_param_1_value'), widget('cfg_usage_note', 'text', { content: { text: '说明文字' } }),
    widget('cfg_alarm_second', 'text', { content: { text: '{value}', onText: '报警', offText: '正常' }, style: { color: '#66e3bf', background: '#103932', padding: 4 }, conditions: [{ operator: 'truthy', color: '#FF8990', background: '#4C2632', borderColor: '#9C4C5E' }] }),
    widget('door_value', 'text', { data: { mode: 'plc', path: 'deviceDataMap.second.doors.front_door_open' } }),
    widget('online_value', 'text', { data: { mode: 'runtime', path: 'deviceStatusMap.second.online' } }),
    widget('conditional_value', 'text', { conditions: [{ operator: '>', value: 900, color: '#ff0000' }] }),
    widget('cfg_overview_temp_chart', 'trend', { content: { chartType: 'area', lineColor: '#45df9b', areaColor: '#55c7ff', lineWidth: 2, areaOpacity: .4, showAxis: true, showTitle: false, seriesName: 'Business series', valueField: 'value', timeField: 'time', historyLength: 120, showLegend: false } }),
    widget('cfg_device_trend_Furnace_01', 'trend', { content: { chartType: 'area', lineColor: '#45df9b', areaColor: '#55c7ff', lineWidth: 2, areaOpacity: .4, showTitle: false, seriesName: 'Device series', historyLength: 120 } }),
    widget('cfg_usage_oee_value', 'trend', { content: { chartType: 'gauge', min: 0, max: 100, lineColor: '#68d5ff', showLegend: true, text: '{value}%' } }),
    widget('reference_oee_ring', 'metrics', { content: { items: [], chartPath: 'metrics.overall_oee', chartLabel: '综合效率', compact: true } }),
    widget('widget_device_part_metrics', 'metrics', { content: { items: [{ path: 'selectedPart.points.0.value', label: '参数 1' }], compact: true, layout: 'list' } }),
    widget('not-yet-supported', 'image'),
  ];
  const shared = widget('shared', 'text', { visibility: { viewIds: ['factory_overview', 'workshop_overview'] } });
  const protectedNonTarget = widget('protectedNonTarget', 'text', { visibility: { viewIds: ['workshop_overview', 'another_view'] } });
  const outside = widget('outside', 'text', { visibility: { viewIds: ['another_view'] } });
  const hidden = widget('hidden-prototype', 'text', { visible: false });
  const hiddenByGroup = widget('hidden-group-prototype', 'text', { groupId: 'hidden-group' });
  const mapOnly = widget('mapItem', 'text', { visibility: {} });
  return {
    schemaVersion: 3, projectId: 'factory-owned', name: 'Preserve all data',
    scene: { views: [
      { id: 'factory_overview', mode: 'factory', camera: { yaw: 5 }, componentState: { show: [], hide: ['group:hidden-group', 'mapItem'] } },
      ...DEFAULT_TARGET_VIEW_IDS.map(id => ({ id, parentViewId: 'factory_overview', mode: id.startsWith('device') ? 'device' : id.startsWith('line') ? 'line' : 'workshop', camera: { yaw: 40 }, componentState: { show: [], hide: [...referenceIds, 'group:hidden-group', 'mapItem', ...(['device_detail', 'device_part'].includes(id) ? ['detail_trend'] : [])] } })),
      { id: 'another_view', mode: 'custom', componentState: { show: ['protectedNonTarget', 'outside'], hide: [] } },
      { id: 'map_world', mode: 'custom', componentState: { show: ['mapItem'], hide: [] } },
    ] },
    canvas: { width: 1920, height: 1080 }, theme: { fontFamily: 'Microsoft YaHei UI' },
    metadata: { revision: 135, updatedAt: 'original' }, parameters: [{ id: 'filter', defaultValue: 7 }],
    tooltipTemplates: { templates: [{ id: 'keep-tooltip', widgets: [widget('tooltip-text')] }] },
    widgets: [...refs, ...candidates, shared, protectedNonTarget, outside, hidden, hiddenByGroup, mapOnly],
  };
}
const byId = (document, id) => document.widgets.find(widget => widget.id === id);

test('the complete document passes an independent appearance-only contract', () => {
  const before = fixture();
  const { document, manifest } = applyDescendantViewStyle(before);
  const changes = appearanceChanges(before, document);
  assert.equal(changes.length, manifest.changedWidgets);
  for (const change of changes) {
    assert.ok(manifest.changes.some(entry => entry.id === change.id));
    assert.ok(!change.style.includes('fontSize') && !change.style.includes('padding'));
    assert.ok(change.content.every(key => ['lineColor', 'areaColor', 'lineWidth', 'areaOpacity'].includes(key)));
  }
});

test('does not mutate or normalize the input, even when frozen', () => {
  const before = fixture(); const original = copy(before);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(before);
  applyDescendantViewStyle(before);
  assert.deepEqual(before, original);
  assert.equal(byId(before, 'cfg_alarm_second').style.shadow, undefined);
});

test('is idempotent and reports no changes on a second migration', () => {
  const first = applyDescendantViewStyle(fixture());
  const second = applyDescendantViewStyle(first.document);
  assert.deepEqual(second.document, first.document);
  assert.equal(second.manifest.changedWidgets, 0);
  assert.equal(second.manifest.unchangedWidgets, first.manifest.changedWidgets);
});

test('preserves all accepted source elements and shared non-target elements verbatim', () => {
  const before = fixture(); const { document, manifest } = applyDescendantViewStyle(before);
  for (const id of [...manifest.sourceProtectedWidgetIds, 'protectedNonTarget', 'outside', 'mapItem']) assert.deepEqual(byId(document, id), byId(before, id));
  assert.deepEqual(manifest.protected.map(entry => entry.id).sort(), ['protectedNonTarget', 'shared']);
});

test('retains every binding, business label, item, layout and rule across device contexts', () => {
  const before = fixture(); const { document } = applyDescendantViewStyle(before);
  for (const old of before.widgets) {
    const next = byId(document, old.id);
    for (const key of ['data', 'frame', 'visibility', 'events', 'conditions', 'animation', 'zIndex', 'type', 'title']) assert.deepEqual(next[key], old[key], `${old.id}.${key}`);
    for (const key of Object.keys(old.content || {}).filter(key => !['lineColor', 'areaColor', 'lineWidth', 'areaOpacity'].includes(key))) assert.deepEqual(next.content[key], old.content[key], `${old.id}.content.${key}`);
    assert.equal(next.style?.padding, old.style?.padding);
    assert.equal(next.style?.fontSize, old.style?.fontSize);
  }
  for (const key of ['scene', 'canvas', 'theme', 'metadata', 'parameters', 'tooltipTemplates', 'projectId']) assert.deepEqual(document[key], before[key]);
  assert.equal(byId(document, 'cfg_param_1_value').data.pointId, '638');
});

test('takes glass card appearances from the accepted six references, not old hidden prototypes', () => {
  const before = fixture(); const { document } = applyDescendantViewStyle(before);
  for (const [id, role] of [['overview_metrics', 'kpi'], ['gas_metrics', 'media'], ['line_monitor', 'consumption'], ['running_devices', 'devices'], ['cfg_detail_status_panel', 'devices'], ['alarm_history', 'alarms'], ['temperature_trend', 'trend'], ['detail_trend', 'trend']]) {
    const source = byId(before, SOURCE_WIDGETS[role][0]); const target = byId(document, id);
    for (const key of ['color', 'shadow', 'opacity', 'background', 'backgroundOpacity', 'borderColor', 'borderRadius']) assert.equal(target.style[key], source.style[key], `${id}.style.${key}`);
    assert.equal(target.style.surfaceSkin, 'glass');
    assert.equal(target.style.surfaceAccent, source.content.lineColor || DEFAULT_SFC_ACCENT);
    assert.equal(target.style.backdropFilter, DEFAULT_SFC_BACKDROP_FILTER);
    assert.equal(target.style.fontSize, 23);
    assert.equal(target.style.padding, 7);
  }
});

test('uses the source white hierarchy without turning all numbers lilac', () => {
  const { document } = applyDescendantViewStyle(fixture());
  assert.equal(byId(document, 'cfg_param_1_value').style.color, '#eef7ff');
  assert.equal(byId(document, 'cfg_temperature_trend_title').style.color, '#eef7ff');
  assert.equal(byId(document, 'cfg_param_1_label').style.color, 'rgba(238,247,255,0.76)');
  assert.equal(byId(document, 'cfg_usage_note').style.color, 'rgba(238,247,255,0.60)');
  for (const id of ['cfg_param_1_value', 'cfg_temperature_trend_title', 'cfg_param_1_label', 'cfg_usage_note']) {
    assert.equal(byId(document, id).style.background, 'transparent');
    assert.equal(byId(document, id).style.backgroundOpacity, 0);
    assert.equal(byId(document, id).style.shadow, 'none');
    assert.equal(byId(document, id).style.surfaceSkin, 'inline');
    assert.equal(byId(document, id).style.backdropFilter, 'none');
  }
});

test('preserves semantic alarm, status, door and connection colors and conditions', () => {
  const before = fixture(); const { document } = applyDescendantViewStyle(before);
  for (const id of ['cfg_alarm_second', 'door_value', 'online_value', 'conditional_value']) {
    assert.equal(textRole(byId(before, id)), 'semantic-state');
    assert.equal(byId(document, id).style.color, byId(before, id).style.color);
    assert.deepEqual(byId(document, id).conditions, byId(before, id).conditions);
    assert.deepEqual(byId(document, id).content, byId(before, id).content);
  }
});

test('keeps a single outer trend card and does not overwrite chart series data', () => {
  const before = fixture(); const { document } = applyDescendantViewStyle(before);
  const chart = byId(document, 'cfg_overview_temp_chart');
  assert.equal(chart.style.background, 'transparent'); assert.equal(chart.style.borderColor, 'transparent');
  assert.equal(chart.style.shadow, 'none');
  assert.equal(chart.content.lineColor, '#68d5ff'); assert.equal(chart.content.areaColor, '#ffc45f');
  assert.equal(chart.content.lineWidth, 1.4); assert.equal(chart.content.areaOpacity, .2);
  assert.deepEqual(chart.data, byId(before, chart.id).data);
  assert.equal(chart.content.seriesName, 'Business series');
  assert.equal(byId(document, 'temperature_trend').style.borderColor, '#ffc45f');
});

test('does not mistake the small OEE gauge and metrics ring for full trend cards', () => {
  const before = fixture(); const { document } = applyDescendantViewStyle(before);
  const gauge = byId(document, 'cfg_usage_oee_value');
  assert.deepEqual(gauge.content, byId(before, gauge.id).content);
  assert.equal(gauge.style.color, byId(before, gauge.id).style.color);
  assert.equal(gauge.style.borderColor, 'transparent'); assert.equal(gauge.style.backgroundOpacity, 0);
  const ring = byId(document, 'reference_oee_ring');
  assert.deepEqual(ring.content, byId(before, ring.id).content);
  assert.equal(ring.style.borderColor, 'transparent');
  const part = byId(document, 'widget_device_part_metrics');
  assert.equal(part.style.borderColor, 'transparent'); assert.equal(part.style.borderRadius, 0);
  assert.equal(part.style.surfaceSkin, 'inline'); assert.equal(part.style.backdropFilter, 'none');
  assert.deepEqual(part.content, byId(before, part.id).content);
});

test('device chart gains a source card only in views where its original outer card is hidden', () => {
  const before = fixture(); const { document } = applyDescendantViewStyle(before);
  const chart = byId(document, 'cfg_device_trend_Furnace_01');
  assert.equal(chart.style.surfaceSkin, 'inline');
  assert.equal(chart.style.backdropFilter, 'none');
  assert.deepEqual(Object.keys(chart.style.viewOverrides).sort(), ['device_detail', 'device_part']);
  for (const override of Object.values(chart.style.viewOverrides)) {
    assert.equal(override.surfaceSkin, 'glass'); assert.equal(override.borderColor, '#ffc45f');
    assert.equal(override.background, '#241f2e'); assert.equal(override.surfaceAccent, '#68d5ff');
    assert.equal(override.backdropFilter, DEFAULT_SFC_BACKDROP_FILTER);
    assert.ok(!Object.hasOwn(override, 'fontSize') && !Object.hasOwn(override, 'padding'));
  }
  assert.equal(chart.style.viewOverrides.device_xray, undefined);
  assert.equal(chart.style.viewOverrides.device_exploded, undefined);
  assert.deepEqual(chart.visibility, byId(before, chart.id).visibility);
  assert.deepEqual(chart.frame, byId(before, chart.id).frame);
});

test('per-view visual overrides cannot smuggle bindings, dimensions, nested objects or unknown views', () => {
  for (const bad of [
    { device_detail: { data: { path: 'wrong' } } },
    { device_detail: { content: { text: 'wrong' } } },
    { device_detail: { visibility: false } },
    { device_detail: { frame: { width: 500 } } },
    { device_detail: { padding: 50 } },
    { device_detail: { fontSize: 50 } },
    { device_detail: { background: { data: 'wrong' } } },
    { device_detail: { viewOverrides: { other: {} } } },
    { device_detail: { surfaceSkin: 'other' } },
    { wrong_view: { color: '#eef7ff' } },
    { device_detail: [] }, [],
  ]) assert.throws(() => validateViewOverrides(bad, [...DEFAULT_TARGET_VIEW_IDS]));
  const valid = { device_detail: { surfaceSkin: 'glass', color: '#eef7ff', backdropFilter: 'blur(12px)', opacity: 1 } };
  assert.equal(validateViewOverrides(valid, [...DEFAULT_TARGET_VIEW_IDS]), valid);
});

test('leaves disabled, hidden group and unsupported prototypes intact and reports unsupported types', () => {
  const before = fixture(); const { document, manifest } = applyDescendantViewStyle(before);
  for (const id of ['hidden-prototype', 'hidden-group-prototype', 'not-yet-supported']) assert.deepEqual(byId(document, id), byId(before, id));
  assert.equal(manifest.skipped.length, 1);
  assert.equal(manifest.skipped[0].id, 'not-yet-supported');
});

test('static eligibility honors IDs, type/group hides, show whitelists, modes and map surfaces', () => {
  const widget = { id: 'w', type: 'text', groupId: 'g', visibility: {} };
  for (const hide of [['w'], ['text'], ['system:text'], ['group:g']]) assert.equal(isViewEligible(widget, { id: 'v', componentState: { hide } }), false);
  assert.equal(isViewEligible(widget, { id: 'map_world', componentState: { show: [] } }), false);
  assert.equal(isViewEligible(widget, { id: 'map_world', componentState: { show: ['group:g'] } }), true);
  assert.equal(isViewEligible(widget, { id: 'custom', componentState: { show: ['other'] } }), false);
  assert.equal(isViewEligible(widget, { id: 'custom', componentState: { show: [] } }), true);
  widget.visibility = { viewIds: ['first'], viewModes: ['device'] };
  assert.equal(isViewEligible(widget, { id: 'second', mode: 'device' }), false);
  assert.equal(isViewEligible(widget, { id: 'first', mode: 'factory' }), false);
  assert.equal(isViewEligible(widget, { id: 'first', mode: 'device' }), true);
});

test('rejects missing source view/widget/style and target views rather than guessing defaults', () => {
  const missingView = fixture(); missingView.scene.views = missingView.scene.views.filter(view => view.id !== 'factory_overview');
  assert.throws(() => applyDescendantViewStyle(missingView), /Source view is missing/);
  const missingWidget = fixture(); missingWidget.widgets = missingWidget.widgets.filter(widget => widget.id !== SOURCE_WIDGETS.kpi[0]);
  assert.throws(() => applyDescendantViewStyle(missingWidget), /Source widget is missing/);
  const missingStyle = fixture(); delete byId(missingStyle, SOURCE_WIDGETS.kpi[0]).style.background;
  assert.throws(() => applyDescendantViewStyle(missingStyle), /Source appearance is missing/);
  const missingTarget = fixture(); missingTarget.scene.views = missingTarget.scene.views.filter(view => view.id !== 'device_part');
  assert.throws(() => applyDescendantViewStyle(missingTarget), /Target view is missing/);
  const hiddenSource = fixture(); byId(hiddenSource, SOURCE_WIDGETS.kpi[0]).visible = false;
  assert.throws(() => applyDescendantViewStyle(hiddenSource), /Source widget is not visible/);
  assert.throws(() => applyDescendantViewStyle(fixture(), { targetViewIds: ['factory_overview'] }), /source view cannot also be a target/);
});

test('new source text/surface colors are read from JSON instead of a hardcoded theme', () => {
  const before = fixture(); const source = byId(before, SOURCE_WIDGETS.kpi[0]);
  source.style.color = '#ffffff'; source.style.background = '#152535'; source.style.backgroundOpacity = .3;
  const { document } = applyDescendantViewStyle(before);
  assert.equal(byId(document, 'overview_metrics').style.background, '#152535');
  assert.equal(byId(document, 'overview_metrics').style.backgroundOpacity, .3);
  assert.equal(byId(document, 'cfg_param_1_value').style.color, '#ffffff');
  assert.equal(byId(document, 'cfg_param_1_label').style.color, 'rgba(255,255,255,0.76)');
  assert.deepEqual(byId(document, source.id), source);
});

test('clears explicit legacy text shadows without changing any dimension', () => {
  const before = fixture(); byId(before, 'cfg_param_1_value').style.boxShadow = '0 0 8px blue';
  const first = applyDescendantViewStyle(before); const second = applyDescendantViewStyle(first.document);
  assert.equal(byId(first.document, 'cfg_param_1_value').style.boxShadow, 'none');
  assert.deepEqual(second.document, first.document);
  appearanceChanges(before, first.document);
});

const snapshotPath = path.resolve(__dirname, '../../output/maintenance/tianjin-view-style-before-20261107.json');
test('current Tianjin document regression: 202 independent elements, six shared controls, no data edits', { skip: !fs.existsSync(snapshotPath) }, async () => {
  const before = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).scenes[0].document;
  const { document, manifest } = applyDescendantViewStyle(before);
  assert.equal(manifest.targetWidgets, 208); assert.equal(manifest.candidateWidgets, 202); assert.equal(manifest.changedWidgets, 202);
  assert.equal(manifest.sourceProtectedWidgetIds.length, 12); assert.equal(manifest.protected.length, 6); assert.equal(manifest.skipped.length, 0);
  assert.deepEqual(manifest.protected.map(entry => entry.id).sort(), ['heat_header_brand', 'energy_value', 'output_value', 'event_marquee', 'widget_navigation', 'widget_return_button'].sort());
  for (const old of before.widgets) {
    const next = byId(document, old.id);
    assert.equal(JSON.stringify(next.data), JSON.stringify(old.data), `${old.id}.data`);
    assert.deepEqual(next.frame, old.frame); assert.deepEqual(next.conditions, old.conditions);
  }
  const changes = appearanceChanges(before, document); assert.equal(changes.length, 202);
  for (const id of ['cfg_device_trend_Furnace_01', 'cfg_device_trend_Furnace_02', 'cfg_device_trend_Furnace_03']) {
    const chart = byId(document, id);
    assert.equal(chart.style.surfaceSkin, 'inline');
    assert.deepEqual(Object.keys(chart.style.viewOverrides).sort(), ['device_detail']);
    assert.equal(chart.style.viewOverrides.device_detail.borderColor, '#ffc45f');
  }
  assert.deepEqual(applyDescendantViewStyle(document).document, document);
  const { widgetViewVisibility } = await import(pathToFileURL(path.resolve(__dirname, '../../frontend/src/runtime/widgetPresentation.js')).href);
  for (const view of before.scene.views) for (const widget of before.widgets) {
    const vis = widget.visibility || {};
    const expected = widget.visible !== false && widget.visible !== 0 && widgetViewVisibility(widget, view).visible
      && (!vis.viewIds?.length || vis.viewIds.includes(view.id)) && (!vis.viewModes?.length || vis.viewModes.includes(view.mode || 'factory'));
    assert.equal(isViewEligible(widget, view), expected, `${widget.id}@${view.id}`);
  }
});
