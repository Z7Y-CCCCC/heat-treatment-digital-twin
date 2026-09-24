const { evaluateVariableExpression } = require('./mathExpression');

const SCHEMA_VERSION = 3;
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2, 3]);
const DEFAULT_CANVAS = Object.freeze({
    width: 1920,
    height: 1080,
    gridSize: 10,
    background: 'transparent',
    safeArea: 24
});

const ALLOWED_WIDGET_TYPES = new Set([
    'text', 'value', 'status', 'trend', 'alarm_list', 'device_list', 'image',
    'container', 'metrics', 'marquee', 'navigation', 'return_button', 'device_label',
    'diagnostics', 'line_overview_cards', 'business_summary', 'hud_kpi_panel',
    'hud_device_status', 'hud_alarm_panel', 'hud_chart_dock'
]);
const UNITY_WIDGET_TYPES = new Set(['navigation', 'return_button', 'device_label', 'diagnostics', 'line_overview_cards']);
const SYSTEM_VIEW_COMPONENT_IDS = new Set([
    'widget_navigation', 'widget_return_button', 'widget_device_label', 'widget_diagnostics', 'widget_line_overview_cards',
    'navigation', 'return_button', 'device_label', 'diagnostics', 'line_overview_cards'
]);
const ALLOWED_EVENT_ACTIONS = new Set([
    'enter_device', 'focus_factory', 'focus_line', 'focus_workshop',
    'play_voice', 'open_link', 'switch_scene', 'switch_view', 'set_visibility', 'toggle_visibility'
]);
const ALLOWED_EVENT_TRIGGERS = new Set(['click', 'doubleClick']);
const FORBIDDEN_WRITE_KEYS = new Set([
    'write', 'writevalue', 'setvalue', 'command', 'plcwrite', 'writetoplc',
    'outputvalue', 'coilvalue', 'registervalue'
]);

function safeJsonParse(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function objectValue(value, fallback = {}) {
    const parsed = safeJsonParse(value, fallback);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

function arrayValue(value, fallback = []) {
    const parsed = safeJsonParse(value, fallback);
    return Array.isArray(parsed) ? parsed : fallback;
}

function finiteNumber(value, fallback, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
}

function integer(value, fallback, min, max) {
    return Math.round(finiteNumber(value, fallback, min, max));
}

function shortText(value, fallback = '', maxLength = 255) {
    const text = String(value ?? fallback).trim();
    return (text || fallback).slice(0, maxLength);
}

function booleanValue(value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    return !(value === false || value === 0 || value === '0' || value === 'false');
}

function cleanId(value, fallback) {
    const cleaned = shortText(value, fallback, 128).replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned || fallback;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function stripDesignerConfig(config) {
    const source = objectValue(config, {});
    const content = { ...source };
    delete content.style;
    delete content.conditions;
    delete content.animation;
    delete content.events;
    delete content.__designer;
    return content;
}

function normalizeCanvas(source, legacyLayout = {}) {
    const canvas = objectValue(source, {});
    const legacy = objectValue(legacyLayout, {});
    return {
        ...DEFAULT_CANVAS,
        ...canvas,
        width: integer(canvas.width, 1920, 320, 7680),
        height: integer(canvas.height, 1080, 180, 4320),
        gridSize: integer(canvas.gridSize, 10, 1, 200),
        background: shortText(canvas.background, 'transparent', 512),
        safeArea: integer(canvas.safeArea, 24, 0, 400),
        legacyGrid: {
            columns: integer(canvas.legacyGrid?.columns ?? legacy.grid?.columns, 24, 1, 200),
            rows: integer(canvas.legacyGrid?.rows ?? legacy.grid?.rows, 12, 1, 200)
        }
    };
}

function normalizeFrame(source, canvas, legacyWidget = null) {
    const frame = objectValue(source, {});
    if (legacyWidget && frame.x === undefined && frame.width === undefined) {
        const columns = canvas.legacyGrid?.columns || 24;
        const rows = canvas.legacyGrid?.rows || 12;
        return {
            x: finiteNumber(legacyWidget.x, 0) / columns * canvas.width,
            y: finiteNumber(legacyWidget.y, 0) / rows * canvas.height,
            width: Math.max(20, finiteNumber(legacyWidget.w, 4) / columns * canvas.width),
            height: Math.max(20, finiteNumber(legacyWidget.h, 2) / rows * canvas.height),
            rotation: finiteNumber(legacyWidget.rotation, 0, -360, 360)
        };
    }
    return {
        x: finiteNumber(frame.x, 0, -canvas.width, canvas.width * 2),
        y: finiteNumber(frame.y, 0, -canvas.height, canvas.height * 2),
        width: finiteNumber(frame.width ?? frame.w, 320, 20, canvas.width * 2),
        height: finiteNumber(frame.height ?? frame.h, 180, 20, canvas.height * 2),
        rotation: finiteNumber(frame.rotation, 0, -360, 360)
    };
}

function normalizeDatabaseDataset(source = {}, fallback = {}, index = 0) {
    const data = objectValue(source, {});
    const base = objectValue(fallback, {});
    const aliasFallback = String.fromCharCode(97 + Math.min(index, 25));
    const alias = shortText(data.alias, aliasFallback, 32).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() || aliasFallback;
    return {
        alias,
        label: shortText(data.label, `数据项 ${alias.toUpperCase()}`, 100),
        color: shortText(data.color, ['#55c7ff', '#45df9b', '#ffc45f', '#ff6b78'][index % 4], 64),
        connectionId: shortText(data.connectionId ?? data.connection_id ?? base.connectionId ?? base.connection_id, '', 80),
        schema: shortText(data.schema ?? base.schema, '', 255),
        table: shortText(data.table ?? base.table, '', 255),
        field: shortText(data.field ?? base.field, '', 255),
        timeField: shortText(data.timeField ?? base.timeField, '', 255),
        orderBy: shortText(data.orderBy ?? data.timeField ?? base.orderBy ?? base.timeField, '', 255),
        orderDirection: String(data.orderDirection ?? base.orderDirection ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
        valueMode: ['latest', 'first', 'list', 'count', 'sum', 'avg', 'min', 'max'].includes(data.valueMode ?? base.valueMode)
            ? (data.valueMode ?? base.valueMode)
            : 'latest',
        rowLimit: integer(data.rowLimit ?? base.rowLimit, 50, 1, 500),
        refreshMs: integer(data.refreshMs ?? base.refreshMs, 5000, 1000, 3600000),
        contextField: shortText(data.contextField, '', 255),
        contextKey: ['deviceId', 'lineId', 'workshopId', 'viewId', 'partId'].includes(data.contextKey) ? data.contextKey : ''
    };
}

function normalizeDataBinding(source, legacyBinding = {}) {
    const data = objectValue(source, {});
    const binding = objectValue(legacyBinding, {});
    let mode = shortText(data.mode, '', 32);
    if (!['static', 'plc', 'database', 'runtime', 'business'].includes(mode)) {
        mode = (data.connectionId || binding.connectionId || binding.connection_id)
            ? 'database'
            : (data.pointId || binding.pointId || binding.point_id)
            ? 'plc'
            : 'static';
    }
    const legacyDataset = normalizeDatabaseDataset(data, binding, 0);
    const rawDatasets = Array.isArray(data.datasets) && data.datasets.length ? data.datasets : [legacyDataset];
    const datasets = rawDatasets.slice(0, 12).map((item, index) => normalizeDatabaseDataset(item, legacyDataset, index));
    const rawDeviceId = data.deviceId ?? data.device_id ?? binding.deviceId ?? binding.device_id ?? '';
    const requestedDeviceScope = String(data.deviceScope ?? data.device_scope ?? binding.deviceScope ?? '').toLowerCase();
    const deviceScope = requestedDeviceScope === 'current' || requestedDeviceScope === 'fixed'
        ? requestedDeviceScope
        : (rawDeviceId ? 'fixed' : 'current');
    return {
        ...binding,
        ...data,
        mode,
        deviceScope,
        deviceId: shortText(rawDeviceId, '', 128),
        pointId: shortText(data.pointId ?? binding.pointId ?? binding.point_id, '', 128),
        pointKey: shortText(data.pointKey ?? data.point_key ?? binding.pointKey ?? binding.point_key, '', 255),
        path: mode === 'static' ? '' : shortText(data.path ?? binding.path, '', 255),
        source: mode === 'static' ? '' : shortText(data.source ?? binding.source, '', 128),
        connectionId: shortText(data.connectionId ?? binding.connectionId ?? binding.connection_id, '', 80),
        businessSection: ['batches', 'compliance', 'oee', 'energy', 'maintenance'].includes(String(data.businessSection ?? binding.businessSection))
            ? String(data.businessSection ?? binding.businessSection)
            : 'batches',
        schema: shortText(data.schema ?? binding.schema, '', 255),
        table: shortText(data.table ?? binding.table, '', 255),
        field: shortText(data.field ?? binding.field, '', 255),
        timeField: shortText(data.timeField ?? binding.timeField, '', 255),
        orderBy: shortText(data.orderBy ?? binding.orderBy ?? data.timeField ?? binding.timeField, '', 255),
        orderDirection: String(data.orderDirection ?? binding.orderDirection ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
        valueMode: ['latest', 'first', 'list', 'count', 'sum', 'avg', 'min', 'max'].includes(data.valueMode ?? binding.valueMode)
            ? (data.valueMode ?? binding.valueMode)
            : 'latest',
        rowLimit: integer(data.rowLimit ?? binding.rowLimit, 50, 1, 500),
        refreshMs: integer(data.refreshMs ?? binding.refreshMs, 5000, 1000, 3600000),
        datasets,
        formula: shortText(data.formula, '', 256),
        formulaLabel: shortText(data.formulaLabel, '计算结果', 100),
        formulaColor: shortText(data.formulaColor, '#45df9b', 64),
        unit: shortText(data.unit ?? binding.unit, '', 32),
        decimals: integer(data.decimals ?? binding.decimals, 1, 0, 8),
        readOnly: true
    };
}

function normalizeEvent(event) {
    const source = objectValue(event, {});
    const trigger = ALLOWED_EVENT_TRIGGERS.has(source.trigger) ? source.trigger : 'click';
    const action = ALLOWED_EVENT_ACTIONS.has(source.action) ? source.action : 'focus_factory';
    const result = { trigger, action };
    for (const [key, max] of Object.entries({
        deviceId: 128, lineId: 128, workshopId: 128, sceneId: 128,
        viewId: 128,
        url: 2048, audioUrl: 2048, text: 500,
        targetId: 128, targetType: 32, visibility: 16
    })) {
        const value = shortText(source[key], '', max);
        if (value) result[key] = value;
    }
    return result;
}

const DEFAULT_VIEW_DEFINITIONS = [
    { id: 'factory_overview', name: '全厂总览', mode: 'factory', targetType: 'factory', parentViewId: '', camera: { yaw: -39, pitch: 33, distanceScale: 1.08, transitionSeconds: 0.8 } },
    { id: 'workshop_overview', name: '车间视角', mode: 'workshop', targetType: 'workshop', parentViewId: 'factory_overview', camera: { yaw: -39, pitch: 36, distanceScale: 1.08, transitionSeconds: 0.7 } },
    { id: 'line_overview', name: '产线视角', mode: 'line', targetType: 'line', parentViewId: 'workshop_overview', camera: { yaw: -39, pitch: 33, distanceScale: 1.08, transitionSeconds: 0.65 } },
    { id: 'device_detail', name: '设备实体视角', mode: 'device', targetType: 'device', parentViewId: 'line_overview', camera: { yaw: 238, pitch: 19, distanceScale: 1.12, transitionSeconds: 0.55, relativeToTarget: true }, metadata: { inspectionStage: 'solid' } },
    { id: 'device_xray', name: '设备透视视角', mode: 'device', targetType: 'device', parentViewId: 'device_detail', camera: { yaw: 238, pitch: 19, distanceScale: 1.08, transitionSeconds: 0.65, relativeToTarget: true }, metadata: { inspectionStage: 'xray' } },
    { id: 'device_exploded', name: '设备拆解视角', mode: 'device', targetType: 'device', parentViewId: 'device_xray', camera: { yaw: 238, pitch: 22, distanceScale: 1.22, transitionSeconds: 0.7, relativeToTarget: true }, metadata: { inspectionStage: 'exploded' } },
    { id: 'device_part', name: '部件详情视角', mode: 'device', targetType: 'device_part', parentViewId: 'device_exploded', camera: { yaw: 238, pitch: 18, distanceScale: 1.35, transitionSeconds: 0.55, relativeToTarget: true }, metadata: { inspectionStage: 'part' } }
];

function defaultDashboardViews() {
    return clone(DEFAULT_VIEW_DEFINITIONS);
}

function normalizeDashboardView(source, index = 0) {
    const input = objectValue(source, {});
    const fallback = DEFAULT_VIEW_DEFINITIONS[index] || DEFAULT_VIEW_DEFINITIONS[0];
    const camera = objectValue(input.camera, {});
    const components = objectValue(input.componentState ?? input.components, {});
    const allowedModes = new Set(['factory', 'workshop', 'line', 'device', 'custom']);
    const mode = allowedModes.has(String(input.mode)) ? String(input.mode) : fallback.mode;
    const parentValue = input.parentViewId ?? input.parent_view_id;
    const returnValue = input.returnViewId ?? input.return_view_id;
    return {
        id: cleanId(input.id, fallback.id || `view_${index + 1}`),
        name: shortText(input.name, fallback.name || `视角 ${index + 1}`, 128),
        mode,
        targetType: shortText(input.targetType, fallback.targetType || mode, 32),
        targetId: shortText(input.targetId ?? input.target_id, '', 128),
        parentViewId: parentValue !== undefined
            ? shortText(parentValue, '', 128)
            : shortText(fallback.parentViewId || '', '', 128),
        returnViewId: returnValue !== undefined
            ? shortText(returnValue, '', 128)
            : shortText(parentValue !== undefined ? parentValue : fallback.parentViewId || '', '', 128),
        camera: {
            yaw: finiteNumber(camera.yaw, fallback.camera.yaw, -360, 360),
            pitch: finiteNumber(camera.pitch, fallback.camera.pitch, -89, 89),
            distanceScale: finiteNumber(camera.distanceScale, fallback.camera.distanceScale, 0.1, 10),
            transitionSeconds: finiteNumber(camera.transitionSeconds, fallback.camera.transitionSeconds, 0, 10),
            relativeToTarget: booleanValue(camera.relativeToTarget, fallback.camera.relativeToTarget || false),
            targetOffset: Array.isArray(camera.targetOffset)
                ? camera.targetOffset.slice(0, 3).map(value => finiteNumber(value, 0, -10000, 10000))
                : [0, 0, 0]
        },
        componentState: {
            show: arrayValue(components.show, []).map(value => cleanId(value, '')).filter(Boolean).slice(0, 500),
            hide: arrayValue(components.hide, []).map(value => cleanId(value, '')).filter(Boolean).slice(0, 500),
            hideNonTargetDevices: booleanValue(components.hideNonTargetDevices, false)
        },
        metadata: objectValue(input.metadata, {})
    };
}

function normalizeDashboardViews(scene) {
    const input = objectValue(scene, {});
    const raw = Array.isArray(input.views) && input.views.length ? input.views : defaultDashboardViews();
    const existingIds = new Set(raw.map(view => String(view?.id || '')));
    const inspectionDefaults = defaultDashboardViews().filter(view => view.id.startsWith('device_') && !existingIds.has(view.id));
    const views = [...raw, ...inspectionDefaults].slice(0, 50).map((view, index) => normalizeDashboardView(view, index));
    const ids = new Set(views.map(view => view.id));
    const defaultViewId = ids.has(String(input.defaultViewId || ''))
        ? String(input.defaultViewId)
        : (views[0]?.id || 'factory_overview');

    // Keep malformed custom view graphs navigable after a save/reopen. A
    // missing/self parent becomes a root; an invalid return edge falls back
    // to the repaired parent edge.
    views.forEach(view => {
        if (view.parentViewId === view.id || (view.parentViewId && !ids.has(view.parentViewId))) view.parentViewId = '';
        if (view.returnViewId === view.id || (view.returnViewId && !ids.has(view.returnViewId))) view.returnViewId = view.parentViewId || '';
    });
    views.forEach(start => {
        const visited = new Set();
        let cursor = start;
        while (cursor?.parentViewId) {
            if (visited.has(cursor.id)) {
                start.parentViewId = '';
                if (start.returnViewId === cursor.id) start.returnViewId = '';
                break;
            }
            visited.add(cursor.id);
            cursor = views.find(view => view.id === cursor.parentViewId);
            if (!cursor) break;
        }
    });
    return { views, defaultViewId };
}

function normalizeVisibility(value) {
    const source = objectValue(value, {});
    const allowedModes = new Set(['factory', 'workshop', 'line', 'device', 'custom']);
    return {
        viewModes: arrayValue(source.viewModes, []).map(item => shortText(item, '', 32)).filter(item => allowedModes.has(item)),
        viewIds: arrayValue(source.viewIds, []).map(item => cleanId(item, '')).filter(Boolean).slice(0, 100),
        matchBoundDevice: booleanValue(source.matchBoundDevice, false),
        ruleMode: source.ruleMode === 'any' ? 'any' : 'all',
        rules: arrayValue(source.rules, []).slice(0, 20).map(rule => {
            const item = objectValue(rule, {});
            return {
                source: item.source === 'data' ? 'data' : 'context',
                path: shortText(item.path, item.source === 'data' ? 'value' : 'viewMode', 128),
                operator: ['==', '!=', '>', '>=', '<', '<=', 'truthy', 'falsy', 'contains'].includes(item.operator) ? item.operator : '==',
                value: typeof item.value === 'number' || typeof item.value === 'boolean'
                    ? item.value
                    : shortText(item.value, '', 500)
            };
        })
    };
}

function navigationFrames(canvas = DEFAULT_CANVAS) {
    const width = Math.max(220, Math.min(600, Math.round(Number(canvas.width || 1920) * 0.32)));
    return {
        navigation: { x: Math.round((Number(canvas.width || 1920) - width) / 2), y: 18, width, height: 42, rotation: 0 },
        returnButton: { x: 20, y: 18, width: 42, height: 42, rotation: 0 }
    };
}

function defaultNavigationWidget(canvas = DEFAULT_CANVAS) {
    const frames = navigationFrames(canvas);
    return {
        id: 'widget_navigation',
        type: 'navigation',
        title: '顶部导航状态',
        frame: frames.navigation,
        content: {
            showTitle: false,
            projectLabel: '热处理车间项目 · 南区热处理车间智能监控大屏',
            statusText: '模拟数据正常'
        },
        style: { background: 'transparent', color: '#eef7ff', borderColor: 'transparent', borderRadius: 0 },
        runtimeTarget: 'unity',
        zIndex: 1000,
        visible: true
    };
}

function defaultReturnButtonWidget(canvas = DEFAULT_CANVAS) {
    return {
        id: 'widget_return_button',
        type: 'return_button',
        title: '返回键',
        frame: navigationFrames(canvas).returnButton,
        content: { showTitle: false },
        style: { background: 'transparent', color: '#eef7ff', borderColor: 'transparent', borderRadius: 0 },
        runtimeTarget: 'unity',
        zIndex: 1001,
        visible: true
    };
}

function ensureNavigationWidgets(rawWidgets, canvas) {
    const widgets = Array.isArray(rawWidgets) ? rawWidgets.slice(0, 500) : [];
    const frames = navigationFrames(canvas);
    let navigationIndex = widgets.findIndex(widget => String(objectValue(widget, {}).type ?? objectValue(widget, {}).widget_type ?? '').toLowerCase() === 'navigation');
    let returnIndex = widgets.findIndex(widget => String(objectValue(widget, {}).type ?? objectValue(widget, {}).widget_type ?? '').toLowerCase() === 'return_button');
    const missingCount = (navigationIndex < 0 ? 1 : 0) + (returnIndex < 0 ? 1 : 0);
    if (widgets.length + missingCount > 500) {
        let removeCount = widgets.length + missingCount - 500;
        for (let index = widgets.length - 1; index >= 0 && removeCount > 0; index -= 1) {
            const type = String(objectValue(widgets[index], {}).type ?? objectValue(widgets[index], {}).widget_type ?? '').toLowerCase();
            if (type === 'navigation' || type === 'return_button') continue;
            widgets.splice(index, 1);
            removeCount -= 1;
        }
        navigationIndex = widgets.findIndex(widget => String(objectValue(widget, {}).type ?? objectValue(widget, {}).widget_type ?? '').toLowerCase() === 'navigation');
        returnIndex = widgets.findIndex(widget => String(objectValue(widget, {}).type ?? objectValue(widget, {}).widget_type ?? '').toLowerCase() === 'return_button');
    }

    if (navigationIndex < 0) {
        widgets.push(defaultNavigationWidget(canvas));
    } else if (returnIndex < 0) {
        // The old navigation item represented both the status pill and the
        // return button. Once split, keep its content but use the status frame.
        widgets[navigationIndex] = { ...widgets[navigationIndex], type: 'navigation', frame: frames.navigation };
    }

    if (returnIndex < 0) {
        widgets.push(defaultReturnButtonWidget(canvas));
    }
    return widgets;
}

function normalizeWidget(source, canvas, index = 0) {
    const widget = objectValue(source, {});
    const legacyType = widget.widget_type;
    const requestedType = shortText(widget.type ?? legacyType, 'text', 64);
    const type = ALLOWED_WIDGET_TYPES.has(requestedType) ? requestedType : 'text';
    const config = objectValue(widget.config ?? widget.config_json, {});
    const binding = objectValue(widget.binding ?? widget.binding_json, {});
    const content = objectValue(widget.content, stripDesignerConfig(config));
    const style = objectValue(widget.style, objectValue(config.style, {}));
    const conditions = arrayValue(widget.conditions, arrayValue(config.conditions, []));
    const animation = objectValue(widget.animation, objectValue(config.animation, { type: 'none' }));
    const events = arrayValue(widget.events, arrayValue(config.events, [])).slice(0, 12).map(normalizeEvent);
    const visibility = normalizeVisibility(widget.visibility ?? config.visibility);
    const designer = objectValue(config.__designer, {});
    const hasCanonicalFrame = widget.frame && typeof widget.frame === 'object'
        && (widget.frame.width !== undefined || widget.frame.height !== undefined);
    const legacyNavigationSeed = type === 'navigation' && !hasCanonicalFrame
        && Number(widget.x || 0) === 0 && Number(widget.y || 0) === 0
        && Number(widget.w || 0) === 5 && Number(widget.h || 0) === 5;
    return {
        id: cleanId(widget.id, `widget_${type}_${index + 1}`),
        type,
        title: shortText(widget.title, content.title || '', 255),
        visible: booleanValue(widget.visible, true),
        locked: booleanValue(widget.locked ?? designer.locked, false),
        zIndex: integer(widget.zIndex ?? widget.sort_order ?? designer.zIndex, index, -1000, 10000),
        runtimeTarget: ['overlay', 'unity', 'both'].includes(widget.runtimeTarget)
            ? widget.runtimeTarget
            : (UNITY_WIDGET_TYPES.has(type) ? 'unity' : 'overlay'),
        groupId: cleanId(widget.groupId ?? designer.groupId, ''),
        frame: legacyNavigationSeed
            ? { x: 660, y: 18, width: 600, height: 42, rotation: 0 }
            : normalizeFrame(widget.frame, canvas, legacyType ? widget : null),
        content,
        style,
        data: normalizeDataBinding(widget.data, binding),
        visibility,
        conditions: conditions.slice(0, 20).map(item => objectValue(item, {})),
        animation: {
            type: shortText(animation.type, 'none', 32),
            duration: finiteNumber(animation.duration, 1.2, 0.1, 60),
            delay: finiteNumber(animation.delay, 0, 0, 60),
            iteration: shortText(animation.iteration, 'infinite', 32)
        },
        events
    };
}

function viewComponentTargetExists(target, widgets) {
    const id = shortText(target, '', 128);
    if (!id) return false;
    if (id.startsWith('system:') || SYSTEM_VIEW_COMPONENT_IDS.has(id)) return true;
    if (id.startsWith('group:')) {
        const groupId = id.slice('group:'.length);
        return widgets.some(widget => widget.groupId === groupId);
    }
    return widgets.some(widget => widget.id === id);
}

function pruneDocumentReferences(widgets, sceneViews) {
    const widgetIds = new Set(widgets.map(widget => widget.id));
    const groupIds = new Set(widgets.map(widget => widget.groupId).filter(Boolean));
    const viewIds = new Set(sceneViews.views.map(view => view.id));
    const fallbackViewId = sceneViews.defaultViewId || sceneViews.views[0]?.id || '';
    const cleanedWidgets = widgets.map(widget => ({
        ...widget,
        visibility: {
            ...widget.visibility,
            viewIds: (widget.visibility?.viewIds || []).filter(viewId => viewIds.has(String(viewId)))
        },
        events: (widget.events || []).map(event => {
            if (event?.action === 'switch_view' && event.viewId && !viewIds.has(String(event.viewId))) {
                return { ...event, viewId: fallbackViewId };
            }
            return event;
        }).filter(event => {
            if (!['set_visibility', 'toggle_visibility'].includes(event?.action)) return true;
            if (event.targetType === 'widget') return widgetIds.has(event.targetId);
            if (event.targetType === 'group') return groupIds.has(event.targetId);
            return false;
        })
    }));
    const cleanedViews = sceneViews.views.map(view => ({
        ...view,
        componentState: {
            ...view.componentState,
            show: (view.componentState?.show || []).filter(target => viewComponentTargetExists(target, cleanedWidgets)),
            hide: (view.componentState?.hide || []).filter(target => viewComponentTargetExists(target, cleanedWidgets))
        }
    }));
    return {
        widgets: cleanedWidgets,
        sceneViews: { ...sceneViews, views: cleanedViews }
    };
}

function createEmptyDocument(context = {}) {
    const project = objectValue(context.project, {});
    const scene = objectValue(context.scene, {});
    const legacyLayout = objectValue(scene.layout ?? scene.layout_json, {});
    const canvas = normalizeCanvas(context.canvas, legacyLayout);
    const sceneViews = normalizeDashboardViews(scene);
    return {
        schemaVersion: SCHEMA_VERSION,
        projectId: shortText(context.projectId ?? project.id, 'project_default', 128),
        sceneId: shortText(context.sceneId ?? scene.id, 'scene_factory_overview', 128),
        name: shortText(context.name ?? scene.name, '工厂总览', 255),
        canvas,
        theme: {
            preset: 'industrial_twin',
            fontFamily: 'Microsoft YaHei UI',
            accentColor: '#42a5f5',
            ...objectValue(context.theme ?? scene.theme ?? scene.theme_json, {})
        },
        scene: {
            id: shortText(scene.id, context.sceneId || 'scene_factory_overview', 128),
            name: shortText(scene.name, context.name || '工厂总览', 255),
            type: shortText(scene.scene_type ?? scene.type, 'factory_overview', 64),
            layout: legacyLayout,
            camera: objectValue(scene.camera ?? scene.camera_json, {}),
            theme: objectValue(scene.theme ?? scene.theme_json, {}),
            ...sceneViews
        },
        widgets: [defaultNavigationWidget(canvas), defaultReturnButtonWidget(canvas)],
        metadata: {
            updatedAt: new Date().toISOString(),
            source: shortText(context.source, 'designer', 64)
        }
    };
}

function normalizeDocument(input, context = {}) {
    const source = objectValue(input, {});
    const base = createEmptyDocument({ ...context, canvas: source.canvas, theme: source.theme });
    const rawWidgets = Array.isArray(source.widgets)
        ? source.widgets
        : (Array.isArray(context.widgets) ? context.widgets : []);
    const sceneSource = objectValue(source.scene, base.scene);
    const canvas = normalizeCanvas(source.canvas, sceneSource.layout || base.scene.layout);
    // Older drafts rendered the navigation bar and return control outside the
    // document, or stored both as one item. Migrate them into two authored
    // components so each can be positioned, hidden and locked independently.
    const widgets = ensureNavigationWidgets(rawWidgets, canvas);
    const normalizedWidgets = widgets.slice(0, 500).map((widget, index) => normalizeWidget(widget, canvas, index));
    const normalizedReferences = pruneDocumentReferences(normalizedWidgets, normalizeDashboardViews(sceneSource));
    const sceneViews = normalizedReferences.sceneViews;
    return {
        ...base,
        ...source,
        schemaVersion: SCHEMA_VERSION,
        projectId: shortText(source.projectId, base.projectId, 128),
        sceneId: shortText(source.sceneId, base.sceneId, 128),
        name: shortText(source.name, base.name, 255),
        canvas,
        theme: { ...base.theme, ...objectValue(source.theme, {}) },
        scene: {
            ...base.scene,
            ...sceneSource,
            id: shortText(sceneSource.id, base.scene.id, 128),
            name: shortText(sceneSource.name, base.scene.name, 255),
            type: shortText(sceneSource.type ?? sceneSource.scene_type, base.scene.type, 64),
            layout: objectValue(sceneSource.layout, base.scene.layout),
            camera: objectValue(sceneSource.camera, base.scene.camera),
            theme: objectValue(sceneSource.theme, base.scene.theme),
            ...sceneViews
        },
        widgets: normalizedReferences.widgets,
        metadata: {
            ...objectValue(source.metadata, {}),
            updatedAt: new Date().toISOString(),
            source: shortText(source.metadata?.source, context.source || 'designer', 64)
        }
    };
}

function buildDocumentFromLegacy({ project, scene, widgets }) {
    return normalizeDocument({ widgets }, { project, scene, widgets, source: 'legacy_migration' });
}

function validateDocument(document, options = {}) {
    const errors = [];
    const input = objectValue(document, {});
    if (!SUPPORTED_SCHEMA_VERSIONS.has(Number(input.schemaVersion))) errors.push(`仅支持 Schema v1-v${SCHEMA_VERSION}`);
    if (!shortText(input.projectId, '', 128)) errors.push('projectId 不能为空');
    if (!shortText(input.sceneId, '', 128)) errors.push('sceneId 不能为空');
    if (!Array.isArray(input.widgets)) errors.push('widgets 必须是数组');
    if (Array.isArray(input.widgets) && input.widgets.length > 500) errors.push('组件数量不能超过 500 个');

    const scene = objectValue(input.scene, {});
    const views = Array.isArray(scene.views) ? scene.views : [];
    const requiresViews = Number(input.schemaVersion) >= 3;
    if (requiresViews && !views.length) errors.push('至少需要配置一个视角');
    if (views.length > 50) errors.push('视角数量不能超过 50 个');
    const viewIds = new Set();
    for (const [index, view] of views.entries()) {
        const label = `第 ${index + 1} 个视角`;
        if (!view?.id || !/^[a-zA-Z0-9_-]+$/.test(String(view.id))) errors.push(`${label} ID 不合法`);
        if (viewIds.has(view?.id)) errors.push(`视角 ID 重复：${view.id}`);
        viewIds.add(view?.id);
        if (!view?.name) errors.push(`${label} 名称不能为空`);
        const camera = objectValue(view?.camera, {});
        if (!Number.isFinite(Number(camera.yaw)) || !Number.isFinite(Number(camera.pitch))) errors.push(`${label} 相机角度不合法`);
        if (view?.parentViewId && !views.some(item => item?.id === view.parentViewId)) errors.push(`${label} 返回视角不存在：${view.parentViewId}`);
        for (const target of [...(view?.componentState?.show || []), ...(view?.componentState?.hide || [])]) {
            if (target && !String(target).startsWith('group:') && !idsForValidation(input.widgets).has(String(target))) {
                // 允许未来的运行时系统组件 ID；普通组件仍检查拼写。
                if (!String(target).startsWith('system:') && !SYSTEM_VIEW_COMPONENT_IDS.has(String(target))) {
                    errors.push(`${label} 的组件状态目标不存在：${target}`);
                }
            }
        }
    }
    if (scene.defaultViewId && !viewIds.has(scene.defaultViewId)) errors.push(`默认视角不存在：${scene.defaultViewId}`);

    const ids = new Set();
    const groupIds = new Set((input.widgets || []).map(widget => shortText(widget?.groupId, '', 128)).filter(Boolean));
    for (const widget of (input.widgets || [])) {
        const widgetId = shortText(widget?.id, '', 128);
        if (widgetId) ids.add(widgetId);
    }
    const duplicateIds = new Set();
    const visitedIds = new Set();
    for (const [index, widget] of (input.widgets || []).entries()) {
        const label = `第 ${index + 1} 个组件`;
        if (!widget?.id || !/^[a-zA-Z0-9_-]+$/.test(widget.id)) errors.push(`${label} ID 不合法`);
        if (visitedIds.has(widget?.id) && !duplicateIds.has(widget?.id)) {
            errors.push(`组件 ID 重复：${widget.id}`);
            duplicateIds.add(widget?.id);
        }
        visitedIds.add(widget?.id);
        if (!ALLOWED_WIDGET_TYPES.has(widget?.type)) errors.push(`${label} 类型不支持：${widget?.type}`);
        if (!widget?.frame || Number(widget.frame.width) < 20 || Number(widget.frame.height) < 20) errors.push(`${label} 尺寸不合法`);
        if (widget?.data?.readOnly === false) errors.push(`${label} 禁止启用 PLC 写入`);
        if (widget?.data?.mode === 'plc') {
            const currentDeviceScope = widget.data.deviceScope === 'current';
            if ((!currentDeviceScope && !widget.data.deviceId) || !widget.data.pointId) {
                errors.push(`${label} 的 PLC 绑定必须选择点位${currentDeviceScope ? '' : '和设备'}`);
            }
        }
        if (widget?.data?.mode === 'business' && !widget.data.connectionId) {
            errors.push(`${label} 的业务只读组件必须选择外部数据库连接`);
        }
        if (widget?.data?.mode === 'database') {
            const datasets = Array.isArray(widget.data.datasets) && widget.data.datasets.length
                ? widget.data.datasets
                : [widget.data];
            const aliases = new Set();
            datasets.forEach((dataset, datasetIndex) => {
                const datasetLabel = `${label}的第 ${datasetIndex + 1} 个数据项`;
                if (!dataset.connectionId || !dataset.table || (dataset.valueMode !== 'count' && !dataset.field)) {
                    errors.push(`${datasetLabel}必须选择连接、表和字段`);
                }
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dataset.alias || '')) errors.push(`${datasetLabel}的公式别名不合法`);
                if (aliases.has(dataset.alias)) errors.push(`${label}的数据项别名重复：${dataset.alias}`);
                aliases.add(dataset.alias);
                if (dataset.contextKey && !dataset.contextField) errors.push(`${datasetLabel}启用了上下文过滤，但未选择表字段`);
            });
            if (widget.data.formula) {
                try {
                    evaluateVariableExpression(widget.data.formula, Object.fromEntries([...aliases].map(alias => [alias, 1])), '数据 ');
                } catch (error) {
                    errors.push(`${label}的${error.message}`);
                }
            }
        }
        for (const viewId of widget?.visibility?.viewIds || []) {
            if (viewIds.size && !viewIds.has(viewId)) errors.push(`${label} 指定的视角不存在：${viewId}`);
        }
        for (const event of widget?.events || []) {
            if (!ALLOWED_EVENT_ACTIONS.has(event?.action)) errors.push(`${label} 包含不允许的点击动作`);
            if (event?.action === 'switch_view' && (!event.viewId || !viewIds.has(event.viewId))) {
                errors.push(`${label} 的视角切换事件目标不存在：${event.viewId || '(空)'}`);
            }
            if (['set_visibility', 'toggle_visibility'].includes(event?.action)
                && (!event.targetId || !['group', 'widget'].includes(event.targetType))) {
                errors.push(`${label} 的显隐事件必须选择组件或分组目标`);
            } else if (['set_visibility', 'toggle_visibility'].includes(event?.action)
                && event.targetType === 'widget' && !ids.has(event.targetId)) {
                errors.push(`${label} 的显隐事件目标组件不存在：${event.targetId}`);
            } else if (['set_visibility', 'toggle_visibility'].includes(event?.action)
                && event.targetType === 'group' && !groupIds.has(event.targetId)) {
                errors.push(`${label} 的显隐事件目标分组不存在：${event.targetId}`);
            }
        }
        inspectForbiddenWriteIntent(widget, `${label}`, errors);
    }

    if (options.throwOnError !== false && errors.length) {
        const error = new Error(errors.join('；'));
        error.validationErrors = errors;
        throw error;
    }
    return errors;
}

function idsForValidation(widgets) {
    return new Set((widgets || []).map(widget => shortText(widget?.id, '', 128)).filter(Boolean));
}

function inspectForbiddenWriteIntent(value, path, errors, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => inspectForbiddenWriteIntent(item, `${path}[${index}]`, errors, seen));
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (normalizedKey === 'readonly' && child === false) {
            errors.push(`${path} 禁止启用 PLC 写入`);
        }
        if (FORBIDDEN_WRITE_KEYS.has(normalizedKey)) {
            errors.push(`${path} 包含禁止的 PLC 写入字段：${key}`);
        }
        if ((normalizedKey === 'action' || normalizedKey === 'method')
            && /write|setvalue|command|output/i.test(String(child || ''))) {
            errors.push(`${path} 包含禁止的 PLC 写入动作：${child}`);
        }
        inspectForbiddenWriteIntent(child, `${path}.${key}`, errors, seen);
    }
}

function assertNoForbiddenWriteIntent(value) {
    const errors = [];
    inspectForbiddenWriteIntent(value, '文档', errors);
    if (errors.length) {
        const error = new Error(errors.join('；'));
        error.validationErrors = errors;
        throw error;
    }
}

function documentWidgetToLegacy(widget, document, index = 0) {
    const canvas = document.canvas || DEFAULT_CANVAS;
    const columns = canvas.legacyGrid?.columns || 24;
    const rows = canvas.legacyGrid?.rows || 12;
    const frame = widget.frame || {};
    const config = {
        ...objectValue(widget.content, {}),
        style: objectValue(widget.style, {}),
        conditions: arrayValue(widget.conditions, []),
        animation: objectValue(widget.animation, { type: 'none' }),
        events: arrayValue(widget.events, []),
        visibility: normalizeVisibility(widget.visibility),
        __designer: {
            locked: !!widget.locked,
            zIndex: integer(widget.zIndex, index, -1000, 10000),
            runtimeTarget: widget.runtimeTarget || 'overlay',
            groupId: widget.groupId || '',
            frame: clone(frame)
        }
    };
    const data = normalizeDataBinding(widget.data, {});
    return {
        id: widget.id,
        scene_id: document.sceneId,
        widget_type: widget.type,
        title: widget.title || '',
        config_json: JSON.stringify(config),
        binding_json: JSON.stringify(data),
        x: finiteNumber(frame.x, 0) / canvas.width * columns,
        y: finiteNumber(frame.y, 0) / canvas.height * rows,
        w: finiteNumber(frame.width, 320) / canvas.width * columns,
        h: finiteNumber(frame.height, 180) / canvas.height * rows,
        sort_order: integer(widget.zIndex, index, -1000, 10000),
        visible: widget.visible === false ? 0 : 1
    };
}

function documentToLegacyWidgets(document) {
    return (document.widgets || []).map((widget, index) => documentWidgetToLegacy(widget, document, index));
}

function documentToRuntimeWidgets(document) {
    return documentToLegacyWidgets(document).map((row, index) => {
        const widget = document.widgets[index];
        return {
            ...row,
            config: safeJsonParse(row.config_json, {}),
            binding: safeJsonParse(row.binding_json, {}),
            type: widget.type,
            frame: clone(widget.frame),
            content: clone(widget.content),
            style: clone(widget.style),
            data: clone(widget.data),
            visibility: clone(widget.visibility),
            conditions: clone(widget.conditions),
            animation: clone(widget.animation),
            events: clone(widget.events),
            locked: widget.locked,
            zIndex: widget.zIndex,
            runtimeTarget: widget.runtimeTarget,
            groupId: widget.groupId || ''
        };
    });
}

function isCanonicalDocument(value) {
    const parsed = objectValue(value, {});
    return SUPPORTED_SCHEMA_VERSIONS.has(Number(parsed.schemaVersion))
        && Array.isArray(parsed.widgets)
        && parsed.canvas && typeof parsed.canvas === 'object';
}

module.exports = {
    SCHEMA_VERSION,
    DEFAULT_CANVAS,
    defaultDashboardViews,
    normalizeDashboardViews,
    ALLOWED_WIDGET_TYPES,
    ALLOWED_EVENT_ACTIONS,
    safeJsonParse,
    objectValue,
    createEmptyDocument,
    normalizeDocument,
    normalizeWidget,
    buildDocumentFromLegacy,
    validateDocument,
    documentToLegacyWidgets,
    documentToRuntimeWidgets,
    isCanonicalDocument,
    assertNoForbiddenWriteIntent
};
