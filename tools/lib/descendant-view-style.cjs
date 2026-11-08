'use strict';

// A document-local, appearance-only migration. This module never initializes
// the application, normalizes a document, writes a DB, or publishes a release.
const assert = require('node:assert/strict');

const DEFAULT_SOURCE_VIEW_ID = 'factory_overview';
const DEFAULT_TARGET_VIEW_IDS = Object.freeze([
  'workshop_overview', 'line_overview', 'device_detail',
  'device_xray', 'device_exploded', 'device_part',
]);
const SOURCE_WIDGETS = Object.freeze({
  kpi: ['reference_hud_factory_kpi', 'hud_kpi_panel'],
  devices: ['reference_hud_factory_devices', 'hud_device_status'],
  alarms: ['reference_hud_factory_alarms', 'hud_alarm_panel'],
  trend: ['reference_hud_factory_trend', 'hud_chart_dock'],
  media: ['reference_hud_factory_media', 'hud_kpi_panel'],
  consumption: ['reference_hud_factory_consumption', 'hud_kpi_panel'],
});
// Intentionally exclude fontSize and padding: the existing basic elements are
// absolutely positioned, unlike the source modules' internal flow layout.
const STYLE_KEYS = Object.freeze([
  'background', 'backgroundOpacity', 'color', 'borderColor',
  'borderRadius', 'opacity', 'shadow', 'boxShadow',
  'surfaceSkin', 'surfaceAccent', 'backdropFilter', 'viewOverrides',
]);
const VIEW_OVERRIDE_STYLE_KEYS = Object.freeze(STYLE_KEYS.filter(key => key !== 'viewOverrides'));
const CONTENT_KEYS = Object.freeze(['lineColor', 'areaColor', 'lineWidth', 'areaOpacity']);
const SURFACE_KEYS = ['background', 'backgroundOpacity', 'color', 'borderColor', 'borderRadius', 'opacity', 'shadow'];
// WidgetRenderer's inline --module-accent overrides the type-specific CSS
// defaults. Read the real SFC fallback, not the colors of hidden old panels.
const DEFAULT_SFC_ACCENT = '#a2a7ed';
const DEFAULT_SFC_BACKDROP_FILTER = 'blur(12px) saturate(125%)';
const clone = value => JSON.parse(JSON.stringify(value));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const MAP_SURFACE_VIEW_IDS = new Set([
  'map_world', 'map_country', 'map_province', 'map_city',
  'map_district', 'site_street', 'site_factory',
]);

// Mirror the renderer's static view assignment, but do not evaluate device,
// data or inspection rules against one currently selected device. All device
// contexts must receive the skin and their original rules remain untouched.
function isViewEligible(widget, view) {
  if (!view || widget.visible === false || widget.visible === 0) return false;
  const type = widget.type || widget.widget_type;
  const keys = [widget.id, type, `system:${type}`, widget.groupId && `group:${widget.groupId}`].filter(Boolean);
  const state = view.componentState || {};
  if (keys.some(key => state.hide?.includes(key))) return false;
  if ((MAP_SURFACE_VIEW_IDS.has(view.id) || state.show?.length) && !keys.some(key => state.show?.includes(key))) return false;
  const visibility = widget.visibility || {};
  if (visibility.viewIds?.length && !visibility.viewIds.includes(view.id)) return false;
  if (visibility.viewModes?.length && !visibility.viewModes.includes(view.mode || 'factory')) return false;
  return true;
}

function tint(color, alpha) {
  const hex = String(color).match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map(character => character.repeat(2)).join('') : hex;
    const rgb = [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16));
    return `rgba(${rgb.join(',')},${alpha.toFixed(2)})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

function readSources(document, sourceView) {
  const byId = new Map(document.widgets.map(widget => [widget.id, widget]));
  const sources = {};
  for (const [role, [id, type]] of Object.entries(SOURCE_WIDGETS)) {
    const source = byId.get(id);
    assert.ok(source, `Source widget is missing: ${id}`);
    assert.equal(source.type || source.widget_type, type, `Unexpected source widget type: ${id}`);
    assert.ok(isViewEligible(source, sourceView), `Source widget is not visible in ${sourceView.id}: ${id}`);
    for (const key of SURFACE_KEYS) assert.ok(has(source.style, key), `Source appearance is missing: ${id}.style.${key}`);
    sources[role] = source;
  }
  for (const key of CONTENT_KEYS) assert.ok(has(sources.trend.content, key), `Source trend appearance is missing: ${sources.trend.id}.content.${key}`);
  return sources;
}

function surface(source) {
  const result = {
    surfaceSkin: 'glass',
    surfaceAccent: source.content?.lineColor || DEFAULT_SFC_ACCENT,
    backdropFilter: DEFAULT_SFC_BACKDROP_FILTER,
  };
  for (const key of SURFACE_KEYS) result[key] = source.style[key];
  if (has(source.style, 'boxShadow')) result.boxShadow = source.style.boxShadow;
  return result;
}

function transparentSurface(color) {
  return {
    ...(color === undefined ? {} : { color }),
    background: 'transparent', backgroundOpacity: 0,
    borderColor: 'transparent', borderRadius: 0, shadow: 'none',
    surfaceSkin: 'inline', backdropFilter: 'none',
  };
}

function validateViewOverrides(overrides, knownViewIds) {
  assert.ok(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'style.viewOverrides must be a view-ID map');
  for (const [viewId, appearance] of Object.entries(overrides)) {
    assert.ok(viewId && (!knownViewIds || knownViewIds.includes(viewId)), `Unknown appearance override view: ${viewId}`);
    assert.ok(appearance && typeof appearance === 'object' && !Array.isArray(appearance), `Invalid appearance override: ${viewId}`);
    for (const [key, value] of Object.entries(appearance)) {
      assert.ok(VIEW_OVERRIDE_STYLE_KEYS.includes(key), `Non-visual or nested override rejected: ${viewId}.${key}`);
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), `Nested appearance value rejected: ${viewId}.${key}`);
      if (key === 'surfaceSkin') assert.ok(['glass', 'inline'].includes(value), `Unknown surface skin: ${viewId}.${value}`);
    }
  }
  return overrides;
}

function textRole(widget) {
  const id = String(widget.id);
  const content = widget.content || {};
  const path = String(widget.data?.path || '');
  if (id.endsWith('_label')) return 'label';
  if (id.includes('_title') || id === 'widget_device_part_name' || /^\s*▸/.test(content.text || '')) return 'heading';
  // Preserve semantic state colors even when the switch is currently false or
  // a PLC is disconnected. Never infer the role from the previous text color.
  if (has(content, 'onText') || has(content, 'offText')
    || /\.(?:status|doors)\./.test(path) || /(?:^|\.)online$/.test(path)
    || /^cfg_(?:alarm|status)_/.test(id)
    || widget.conditions?.some(condition => has(condition, 'color'))) return 'semantic-state';
  if (/_(?:note|description)(?:_|$)/.test(id) || /^cfg_help_(?!title)/.test(id) || id === 'widget_device_part_id') return 'description';
  if (id.endsWith('_value') || has(content, 'text') && /\{value\}/.test(content.text)) return 'value';
  return 'body';
}

function chooseAppearance(widget, sources, document, targetViews) {
  const type = widget.type || widget.widget_type;
  const id = String(widget.id);
  const text = sources.kpi.style.color;
  if (type === 'text') {
    const role = textRole(widget);
    const color = role === 'semantic-state' ? undefined
      : role === 'label' ? tint(text, .76)
        : role === 'description' ? tint(text, .60) : text;
    return { role, source: sources.kpi.id, style: transparentSurface(color) };
  }
  if (type === 'container') {
    const role = ['temperature_trend', 'detail_trend'].includes(id) ? 'trend-card'
      : ['running_devices', 'cfg_detail_status_panel'].includes(id) ? 'device-card'
        : id === 'alarm_history' ? 'alarm-card'
          : ['gas_metrics', 'detail_gas'].includes(id) ? 'media-card'
            : id === 'line_monitor' ? 'consumption-card' : 'kpi-card';
    const source = role === 'trend-card' ? sources.trend
      : role === 'device-card' ? sources.devices
        : role === 'alarm-card' ? sources.alarms
          : role === 'media-card' ? sources.media
            : role === 'consumption-card' ? sources.consumption : sources.kpi;
    return { role, source: source.id, style: surface(source) };
  }
  if (type === 'trend') {
    const chartType = widget.content?.chartType || 'line';
    if (['gauge', 'donut', 'pie', 'radar', 'scatter'].includes(chartType)) {
      return { role: 'inline-non-trend-chart', source: sources.kpi.id, style: transparentSurface() };
    }
    const content = {};
    for (const key of CONTENT_KEYS) content[key] = sources.trend.content[key];
    const style = transparentSurface(sources.trend.style.color);
    // Three existing device charts are shared between views whose outer card
    // is shown and views whose outer card was intentionally hidden. Keep all
    // those assignments intact and apply a card only where no outer card is
    // shown; no duplicated widgets, visibility edits, or layout edits.
    if (/^cfg_device_trend_Furnace_\d+$/.test(id)) {
      const parent = document.widgets.find(candidate => candidate.id === 'detail_trend');
      const overrides = { ...(widget.style?.viewOverrides || {}) };
      for (const view of targetViews.filter(view => isViewEligible(widget, view))) {
        if (!parent || !isViewEligible(parent, view)) overrides[view.id] = surface(sources.trend);
      }
      if (Object.keys(overrides).length) {
        validateViewOverrides(overrides, document.scene.views.map(view => view.id));
        style.viewOverrides = overrides;
      }
    }
    return { role: 'inline-trend-chart', source: sources.trend.id, style, content };
  }
  if (type === 'metrics') {
    return ['reference_oee_ring', 'widget_device_part_metrics'].includes(id)
      ? { role: id === 'reference_oee_ring' ? 'inline-metric-ring' : 'inline-part-metrics', source: sources.kpi.id, style: transparentSurface(text) }
      : { role: 'metric-card', source: sources.kpi.id, style: surface(sources.kpi) };
  }
  return null;
}

function applyPatch(widget, appearance) {
  const changedKeys = [];
  for (const group of ['style', 'content']) {
    const patch = appearance[group];
    if (!patch) continue;
    for (const [key, value] of Object.entries(patch)) {
      assert.ok((group === 'style' ? STYLE_KEYS : CONTENT_KEYS).includes(key), `Non-appearance patch rejected: ${widget.id}.${group}.${key}`);
      if (key === 'viewOverrides') validateViewOverrides(value);
      if (has(widget[group], key) && JSON.stringify(widget[group][key]) === JSON.stringify(value)) continue;
      widget[group] ||= {};
      widget[group][key] = value;
      changedKeys.push(`${group}.${key}`);
    }
  }
  // Explicit legacy shadows must not override the new role's shadow setting.
  if (has(widget.style, 'boxShadow') && !has(appearance.style, 'boxShadow') && widget.style.boxShadow !== 'none') {
    widget.style.boxShadow = 'none';
    changedKeys.push('style.boxShadow');
  }
  return changedKeys;
}

function applyDescendantViewStyle(input, options = {}) {
  assert.ok(input && Array.isArray(input.widgets), 'A raw document with widgets is required');
  assert.ok(Array.isArray(input.scene?.views), 'A raw document with scene.views is required');
  assert.equal(new Set(input.widgets.map(widget => widget.id)).size, input.widgets.length, 'Duplicate widget IDs are not supported');
  const sourceViewId = options.sourceViewId || DEFAULT_SOURCE_VIEW_ID;
  const targetViewIds = options.targetViewIds || [...DEFAULT_TARGET_VIEW_IDS];
  assert.ok(Array.isArray(targetViewIds) && targetViewIds.length, 'At least one target view is required');
  assert.equal(new Set(targetViewIds).size, targetViewIds.length, 'Target view IDs must be unique');
  assert.ok(!targetViewIds.includes(sourceViewId), 'The source view cannot also be a target');
  const sourceView = input.scene.views.find(view => view.id === sourceViewId);
  assert.ok(sourceView, `Source view is missing: ${sourceViewId}`);
  const targetViews = targetViewIds.map(id => {
    const view = input.scene.views.find(view => view.id === id);
    assert.ok(view, `Target view is missing: ${id}`);
    return view;
  });
  const sources = readSources(input, sourceView);
  const protectedViews = input.scene.views.filter(view => !targetViewIds.includes(view.id));
  const document = clone(input);
  const manifest = {
    schemaVersion: 1, appearanceOnly: true, sourceViewId, targetViewIds: [...targetViewIds],
    sourceWidgetIds: Object.values(sources).map(widget => widget.id),
    sourceProtectedWidgetIds: input.widgets.filter(widget => isViewEligible(widget, sourceView)).map(widget => widget.id),
    totalWidgets: input.widgets.length, targetWidgets: 0, candidateWidgets: 0,
    changedWidgets: 0, unchangedWidgets: 0, outsideScopeWidgets: 0,
    changes: [], protected: [], skipped: [], unchanged: [],
  };
  for (const widget of document.widgets) {
    const viewIds = targetViews.filter(view => isViewEligible(widget, view)).map(view => view.id);
    if (!viewIds.length) { manifest.outsideScopeWidgets += 1; continue; }
    manifest.targetWidgets += 1;
    const protectedViewIds = protectedViews.filter(view => isViewEligible(widget, view)).map(view => view.id);
    if (protectedViewIds.length) {
      manifest.protected.push({ id: widget.id, viewIds, protectedViewIds, reason: 'shared-with-source-or-non-target-view' });
      continue;
    }
    manifest.candidateWidgets += 1;
    if (has(widget.style, 'viewOverrides')) validateViewOverrides(widget.style.viewOverrides, input.scene.views.map(view => view.id));
    const appearance = chooseAppearance(widget, sources, input, targetViews);
    if (!appearance) { manifest.skipped.push({ id: widget.id, viewIds, reason: 'unsupported-visual-role', type: widget.type }); continue; }
    const changedKeys = applyPatch(widget, appearance);
    const entry = { id: widget.id, viewIds, role: appearance.role, sourceWidgetId: appearance.source, changedKeys };
    if (changedKeys.length) manifest.changes.push(entry);
    else manifest.unchanged.push(entry);
  }
  manifest.changedWidgets = manifest.changes.length;
  manifest.unchangedWidgets = manifest.unchanged.length;
  return { document, manifest };
}

module.exports = {
  applyDescendantViewStyle, isViewEligible, textRole,
  validateViewOverrides, VIEW_OVERRIDE_STYLE_KEYS,
  DEFAULT_SOURCE_VIEW_ID, DEFAULT_TARGET_VIEW_IDS, SOURCE_WIDGETS,
  DEFAULT_SFC_ACCENT, DEFAULT_SFC_BACKDROP_FILTER,
  STYLE_KEYS, CONTENT_KEYS,
};
