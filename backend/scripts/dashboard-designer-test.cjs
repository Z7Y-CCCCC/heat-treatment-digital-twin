const assert = require('node:assert/strict');
const {
    buildDocumentFromLegacy,
    normalizeDocument,
    validateDocument,
    isCanonicalDocument
} = require('../utils/dashboardDocument');

const baseUrl = String(process.env.TEST_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');

async function api(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(process.env.ADMIN_API_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_API_TOKEN } : {}),
            ...(options.headers || {})
        }
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

async function main() {
    const legacy = buildDocumentFromLegacy({
        project: { id: 'project_test' },
        scene: { id: 'scene_test', name: '测试', layout_json: JSON.stringify({ grid: { columns: 24, rows: 12 } }) },
        widgets: [
            { id: 'legacy_text', widget_type: 'text', title: '旧组件', x: 1, y: 2, w: 3, h: 4, config_json: '{}', binding_json: '{}' },
            { id: 'legacy_runtime', widget_type: 'value', title: '旧运行指标', x: 4, y: 2, w: 3, h: 4, config_json: '{}', binding_json: '{"mode":"runtime","path":"metrics.current_output"}' }
        ]
    });
    assert.equal(isCanonicalDocument(legacy), true);
    assert.equal(Math.round(legacy.widgets[0].frame.x), 80);
    assert.equal(Math.round(legacy.widgets[0].frame.y), 180);
    assert.equal(legacy.widgets[1].data.mode, 'static', '旧系统运行指标没有迁移为静态数据');
    assert.equal(legacy.widgets[1].data.path, '', '旧系统运行指标路径没有清理');
    validateDocument(legacy);

    const staleReferenceDocument = clone(legacy);
    staleReferenceDocument.scene.views[0].componentState.hide.push('widget_already_deleted');
    staleReferenceDocument.widgets[0].events.push({
        trigger: 'click', action: 'toggle_visibility', targetType: 'widget', targetId: 'widget_already_deleted'
    });
    const repairedDocument = normalizeDocument(staleReferenceDocument);
    assert.equal(repairedDocument.scene.views[0].componentState.hide.includes('widget_already_deleted'), false, '旧视角残留组件引用没有清理');
    assert.equal(repairedDocument.widgets[0].events.some(event => event.targetId === 'widget_already_deleted'), false, '旧事件残留组件引用没有清理');
    validateDocument(repairedDocument);

    const initial = await api('/api/platform/designer');
    assert.equal(initial.response.ok, true, initial.body.error);
    assert.ok(initial.body.currentRelease?.id, '当前发布版本不存在');
    const originalDocument = clone(initial.body.document);
    const originalReleaseId = initial.body.currentRelease.id;
    let currentRevision = Number(initial.body.revision || 0);
    let testReleaseId = '';
    const testWidgetId = `widget_designer_test_${Date.now()}`;

    try {
        const writeAttempt = clone(originalDocument);
        writeAttempt.widgets.push({
            id: `${testWidgetId}_write`, type: 'value', title: '禁止写入测试', visible: true, locked: false,
            zIndex: 999, runtimeTarget: 'overlay', groupId: '',
            frame: { x: 100, y: 100, width: 260, height: 140, rotation: 0 },
            content: {}, style: {},
            data: { mode: 'static', deviceId: '', pointId: '', path: '', unit: '', decimals: 1, readOnly: false },
            conditions: [], animation: { type: 'none', duration: 1, delay: 0, iteration: '1' }, events: []
        });
        const rejected = await api('/api/platform/designer/draft', {
            method: 'PUT',
            body: JSON.stringify({ sceneId: writeAttempt.sceneId, document: writeAttempt, expectedRevision: currentRevision })
        });
        assert.equal(rejected.response.status, 400, `PLC 写入意图没有被拒绝：${JSON.stringify(rejected.body)}`);
        assert.match(rejected.body.error || '', /写入/);

        const testDocument = clone(originalDocument);
        testDocument.widgets.push({
            id: testWidgetId, type: 'text', title: '发布隔离自动测试', visible: true, locked: false,
            zIndex: 999, runtimeTarget: 'overlay', groupId: '',
            frame: { x: 610, y: 430, width: 360, height: 120, rotation: 0 },
            content: { text: 'draft-only-until-published' },
            style: { background: 'rgba(10,24,38,.8)', color: '#fff', borderColor: '#42a5f5', borderRadius: 12 },
            data: { mode: 'static', deviceId: '', pointId: '', path: '', unit: '', decimals: 1, readOnly: true },
            conditions: [], animation: { type: 'none', duration: 1, delay: 0, iteration: '1' }, events: []
        });

        const saved = await api('/api/platform/designer/draft', {
            method: 'PUT',
            body: JSON.stringify({ sceneId: testDocument.sceneId, document: testDocument, expectedRevision: currentRevision })
        });
        assert.equal(saved.response.ok, true, saved.body.error);
        currentRevision = Number(saved.body.revision);

        const beforePublish = await api('/api/config');
        assert.equal(beforePublish.response.ok, true, beforePublish.body.error);
        assert.equal(beforePublish.body.platform.widgets.some(widget => widget.id === testWidgetId), false, '未发布草稿污染了运行时');
        assert.equal(JSON.stringify(beforePublish.body.platform).includes(testWidgetId), false, '运行时接口泄露了未发布草稿');
        assert.equal(Object.hasOwn(beforePublish.body.platform.activeScene || {}, 'draft_json'), false, '运行时场景不应暴露 draft_json');
        assert.equal(Object.hasOwn(beforePublish.body.platform.activeScene || {}, 'draft_revision'), false, '运行时场景不应暴露 draft_revision');
        assert.equal(beforePublish.body.platform.currentRelease.id, originalReleaseId);

        const published = await api('/api/platform/releases', {
            method: 'POST',
            body: JSON.stringify({ sceneId: testDocument.sceneId, notes: 'dashboard-designer-test' })
        });
        assert.equal(published.response.ok, true, published.body.error);
        testReleaseId = published.body.release.id;

        const afterPublish = await api('/api/config');
        assert.equal(afterPublish.response.ok, true, afterPublish.body.error);
        assert.equal(afterPublish.body.platform.widgets.some(widget => widget.id === testWidgetId), true, '发布后运行时没有读取新快照');
        assert.equal(afterPublish.body.platform.currentRelease.id, testReleaseId);

        const rolledBack = await api(`/api/platform/releases/${encodeURIComponent(originalReleaseId)}/activate`, { method: 'POST', body: '{}' });
        assert.equal(rolledBack.response.ok, true, rolledBack.body.error);

        const afterRollback = await api('/api/config');
        assert.equal(afterRollback.response.ok, true, afterRollback.body.error);
        assert.equal(afterRollback.body.platform.widgets.some(widget => widget.id === testWidgetId), false, '回滚后仍读取了新版本');
        assert.equal(afterRollback.body.platform.currentRelease.id, originalReleaseId);

        const restored = await api('/api/platform/designer/draft', {
            method: 'PUT',
            body: JSON.stringify({ sceneId: originalDocument.sceneId, document: originalDocument, expectedRevision: currentRevision })
        });
        assert.equal(restored.response.ok, true, restored.body.error);
        currentRevision = Number(restored.body.revision);

        const deleted = await api(`/api/platform/releases/${encodeURIComponent(testReleaseId)}`, { method: 'DELETE' });
        assert.equal(deleted.response.ok, true, deleted.body.error);
        testReleaseId = '';

        console.log(JSON.stringify({
            success: true,
            schemaMigration: true,
            writeGuard: true,
            draftIsolation: true,
            publish: true,
            rollback: true,
            restoredRevision: currentRevision
        }, null, 2));
    } finally {
        const state = await api('/api/platform/designer').catch(() => null);
        if (state?.body?.currentRelease?.id !== originalReleaseId) {
            await api(`/api/platform/releases/${encodeURIComponent(originalReleaseId)}/activate`, { method: 'POST', body: '{}' }).catch(() => {});
        }
        if (state?.body?.document?.widgets?.some(widget => widget.id === testWidgetId)) {
            await api('/api/platform/designer/draft', {
                method: 'PUT',
                body: JSON.stringify({
                    sceneId: originalDocument.sceneId,
                    document: originalDocument,
                    expectedRevision: Number(state.body.revision || currentRevision)
                })
            }).catch(() => {});
        }
        if (testReleaseId) {
            await api(`/api/platform/releases/${encodeURIComponent(testReleaseId)}`, { method: 'DELETE' }).catch(() => {});
        }
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
