'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DEFAULT_DASHBOARD_TEMPLATE: INFO } = require('../../shared/defaultDashboardTemplate.mjs');
const FILE = path.join(__dirname, '../defaults/factory-dashboard.v1.json');
const VIEW_IDS = ['factory_overview', 'workshop_overview', 'line_overview', 'device_detail', 'device_xray', 'device_exploded', 'device_part'];

function verifyDefaultDashboardTemplate(file = FILE) {
    const bytes = fs.readFileSync(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== INFO.sha256) throw new Error('内置默认模板校验失败；禁止从现场配置自动替换出厂模板，请先阅读打包必看.md');
    const template = JSON.parse(bytes);
    if (template.id !== INFO.id || template.version !== INFO.version
        || JSON.stringify(template.views.map(v => v.id)) !== JSON.stringify(VIEW_IDS)
        || template.widgets.length !== INFO.widgetCount) throw new Error('内置默认模板结构不匹配');
    for (const view of template.views) if (view.targetId || view.metadata?.deviceId || view.metadata?.ownerDeviceId) throw new Error('出厂模板不能指定现场目标；设备视角必须共享');
    for (const widget of template.widgets) {
        const data = widget.data;
        if (!data || data.deviceId || data.pointId || data.pointKey || data.connectionId || data.datasetId
            || data.deviceScope !== 'current' || data.readOnly !== true
            || data.rotationDeviceIds?.length || data.deviceBindings?.length) throw new Error('出厂模板不能包含现场数据绑定或设备白名单');
        if (widget.visibility?.rules?.some(rule => rule.path === 'deviceId' && !['truthy', 'falsy'].includes(rule.operator))) throw new Error('出厂组件不得按特定设备 ID 限制显隐；新增设备必须自动复用');
    }
    return { ...INFO, file, template };
}

function createDefaultDashboardDocument({ projectId, sceneId, name }) {
    if (!projectId || !sceneId) throw new Error('默认模板需要目标项目和场景');
    const { template } = verifyDefaultDashboardTemplate();
    const suffix = createHash('sha256').update(sceneId).digest('hex').slice(0, 16);
    const ids = new Map(template.widgets.map(widget => [widget.id, `${widget.id}_${suffix}`]));
    for (const widget of template.widgets) widget.id = ids.get(widget.id);
    for (const view of template.views) {
        for (const field of ['show', 'hide']) view.componentState[field] = view.componentState[field].map(id => ids.get(id));
    }
    return require('../utils/dashboardDocument').normalizeDocument({
        schemaVersion: 1, projectId, sceneId, name,
        canvas: template.canvas, theme: template.theme, parameters: [], widgets: template.widgets,
        scene: { id: sceneId, name, type: 'factory_overview', layout: {}, camera: {}, theme: {}, views: template.views, defaultViewId: 'factory_overview' },
        metadata: { source: 'builtin-default', revision: 1, defaultTemplate: { id: INFO.id, version: INFO.version, sha256: INFO.sha256 } }
    }, { projectId, sceneId });
}

// Only called inside explicit NEW factory creation. Never replace an existing
// draft/release at startup, upgrade, import, or package preparation.
async function initializeDefaultDashboard(tx, context) {
    const document = createDefaultDashboardDocument(context);
    const releaseId = `release_default_${context.sceneId}`;
    const snapshot = JSON.stringify(document);
    await tx.run('UPDATE scenes SET draft_json = ?, draft_revision = 1, published_release_id = ? WHERE id = ?', [snapshot, releaseId, context.sceneId]);
    await tx.run(`INSERT INTO releases (id, project_id, scene_id, version, snapshot_json, is_current, notes, schema_version, draft_revision)
        VALUES (?, ?, ?, '1.0.0', ?, 1, '内置默认模板（数据待配置）', 1, 1)`, [releaseId, context.projectId, context.sceneId, snapshot]);
}
module.exports = { verifyDefaultDashboardTemplate, createDefaultDashboardDocument, initializeDefaultDashboard, INFO, FILE, VIEW_IDS };
