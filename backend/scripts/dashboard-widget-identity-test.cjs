'use strict';
// Real HTTP/SQL regression. All writes are confined to the shared isolated
// fixture; historical documents are readable without an ID migration.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createLinkageFixture } = require('./realtime-linkage-fixture.cjs');
const { normalizeDocument } = require('../utils/dashboardDocument');
const { renameDashboardWidget, dashboardWidgetIdentityIssues } = require('../../shared/dashboardWidgetIdentity.mjs');
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
let fixture;
const passed = name => { checks.push(name); console.log('PASS ' + name); };

(async () => {
    fixture = await createLinkageFixture('dashboard-widget-identity');
    const { sql, ok, request, cartId, points } = fixture;
    const state = await ok('/api/platform/designer');
    const sceneId = state.scene.id;
    const storage = () => ({
        scenes: sql.prepare('SELECT * FROM scenes ORDER BY id').all(),
        releases: sql.prepare('SELECT * FROM releases ORDER BY id').all(),
        widgets: sql.prepare('SELECT * FROM widgets ORDER BY id').all(),
        bindings: sql.prepare('SELECT * FROM bindings ORDER BY id').all()
    });
    const draft = normalizeDocument({ ...clone(state.document), widgets: [
        { id: 'identity_original', type: 'value', title: '真实位置', groupId: 'identity_group',
          frame: { x: 10, y: 10, width: 300, height: 170 }, content: { label: '独立位置来源', fallback: '--' },
          data: { mode: 'plc', deviceScope: 'fixed', deviceId: cartId, pointId: points.position, pointKey: 'mechanisms.actual_position' } },
        { id: 'identity_second', type: 'value', title: '送料进度', groupId: 'identity_group',
          frame: { x: 330, y: 10, width: 300, height: 170 }, content: { label: '独立送料来源', fallback: '等待真实值' },
          data: { mode: 'plc', deviceScope: 'fixed', deviceId: cartId, pointId: points.feed, pointKey: 'mechanisms.motion_feed' } }
    ] }, { project: state.project, scene: state.scene });
    draft.scene.views[0].componentState.show = ['identity_original', 'identity_second', 'system:navigation'];
    draft.scene.views[0].componentState.hide = ['group:identity_group'];
    draft.scene.views[1].componentState.hide = ['identity_original', 'identity_second'];
    const write = document => request('/api/platform/designer/draft', 'PUT', { sceneId, document, expectedRevision: state.revision });
    const initial = storage();
    const duplicate = clone(draft);
    duplicate.widgets.find(widget => widget.id === 'identity_second').id = 'identity_original';
    const beforeInput = clone(duplicate);
    const rejectedDuplicate = await write(duplicate);
    assert.equal(rejectedDuplicate.status, 400);
    assert.equal(rejectedDuplicate.data.code, 'DASHBOARD_WIDGET_IDENTITY_INVALID');
    assert.ok(rejectedDuplicate.data.errors.some(message => /组件标识重复.*组件标识/.test(message)));
    assert.deepEqual(duplicate, beforeInput);
    assert.deepEqual(storage(), initial);
    passed('duplicate save is rejected at the normal component identity field without any document or SQL mutation');
    for (const invalid of ['', ' invalid ', 'invalid/name', 42, 'x'.repeat(129)]) {
        const candidate = clone(draft);
        candidate.widgets[0].id = invalid;
        const response = await write(candidate);
        assert.equal(response.status, 400, String(invalid));
        assert.equal(response.data.code, 'DASHBOARD_WIDGET_IDENTITY_INVALID');
        assert.ok(response.data.errors.some(message => /组件标识不合法/.test(message)));
        assert.deepEqual(storage(), initial);
    }
    passed('empty, padded, illegal, non-string and oversized raw identities cannot be silently normalized on save');

    // Install one historical malformed draft in this fixture only. GET must
    // leave the stored bytes, revision, release pointer and component count.
    const historical = clone(duplicate);
    historical.scene.views[0].componentState.show = ['identity_original', 'system:navigation'];
    historical.scene.views[1].componentState.hide = ['identity_original'];
    const historicalJson = JSON.stringify(historical);
    sql.prepare('UPDATE scenes SET draft_json=? WHERE id=?').run(historicalJson, sceneId);
    const historicalStorage = storage();
    const loaded = await ok('/api/platform/designer?scene_id=' + encodeURIComponent(sceneId));
    assert.equal(loaded.document.widgets.filter(widget => widget.id === 'identity_original').length, 2);
    assert.equal(loaded.document.widgets.length, historical.widgets.length);
    assert.equal(loaded.revision, state.revision);
    assert.deepEqual(storage(), historicalStorage);
    assert.equal(sql.prepare('SELECT draft_json FROM scenes WHERE id=?').get(sceneId).draft_json, historicalJson);
    passed('historical duplicate GET remains readable and keeps every instance and stored byte without repair');

    const badPublish = await request('/api/platform/releases', 'POST', { sceneId, version: '97.1.1' });
    assert.equal(badPublish.status, 400);
    assert.ok(badPublish.data.errors.some(message => /组件标识重复/.test(message)));
    assert.deepEqual(storage(), historicalStorage);
    passed('publication cannot convert an unfixed historical duplicate into a runtime release');

    // The human edits exactly one instance. Do not rename the other instance
    // or infer sources from its shared old ID.
    const explicit = clone(historical);
    const first = explicit.widgets.filter(widget => widget.id === 'identity_original')[0];
    const second = explicit.widgets.filter(widget => widget.id === 'identity_original')[1];
    explicit.scene.views[0].componentState.overrides = { identity_original: { opacity: .7, nested: { marker: 'preserve' } } };
    const secondBefore = clone(second);
    const renamed = renameDashboardWidget(explicit, first, 'identity_user_position');
    assert.equal(renamed.oldIdStillUsed, true);
    assert.deepEqual(second, secondBefore);
    assert.ok(explicit.scene.views[0].componentState.show.includes('identity_original'));
    assert.ok(explicit.scene.views[0].componentState.show.includes('identity_user_position'));
    assert.ok(explicit.scene.views[1].componentState.hide.includes('identity_original'));
    assert.ok(explicit.scene.views[1].componentState.hide.includes('identity_user_position'));
    assert.deepEqual(explicit.scene.views[0].componentState.overrides.identity_user_position,
        explicit.scene.views[0].componentState.overrides.identity_original);
    assert.notEqual(explicit.scene.views[0].componentState.overrides.identity_user_position.nested,
        explicit.scene.views[0].componentState.overrides.identity_original.nested);
    assert.deepEqual(dashboardWidgetIdentityIssues(explicit), []);
    // Appearance uses widget.style.viewOverrides in the application. The
    // helper's optional componentState overrides are independently preserved
    // by rename above, not invented as an unsupported backend setting.
    delete explicit.scene.views[0].componentState.overrides;
    const saved = await ok('/api/platform/designer/draft', 'PUT', { sceneId, document: explicit, expectedRevision: state.revision });
    const reopened = await ok('/api/platform/designer?scene_id=' + encodeURIComponent(sceneId));
    assert.equal(saved.revision, state.revision + 1);
    for (const [id, expected] of [['identity_user_position', first], ['identity_original', second]]) {
        const widget = reopened.document.widgets.find(item => item.id === id);
        assert.ok(widget, id);
        assert.deepEqual(widget.data, expected.data);
        assert.deepEqual(widget.content, expected.content);
        assert.deepEqual(widget.frame, expected.frame);
        assert.equal(widget.groupId, 'identity_group');
        const row = sql.prepare('SELECT binding_json,config_json FROM widgets WHERE id=?').get(id);
        assert.deepEqual(JSON.parse(row.binding_json), expected.data);
        assert.equal(JSON.parse(row.config_json).label, expected.content.label);
    }
    assert.deepEqual(reopened.document.scene.views[0].componentState, explicit.scene.views[0].componentState);
    assert.deepEqual(reopened.document.scene.views[1].componentState, explicit.scene.views[1].componentState);
    passed('explicit one-instance rename preserves shared references, independent source/content/frame and actual API SQL reopen');

    const goodRelease = await ok('/api/platform/releases', 'POST', { sceneId, version: '97.1.2' });
    const badReleaseId = 'identity_historical_release';
    sql.prepare('INSERT INTO releases (id,project_id,scene_id,version,snapshot_json,is_current,schema_version,draft_revision) VALUES (?,?,?,?,?,?,?,?)')
        .run(badReleaseId, state.project.id, sceneId, '97.1.0', historicalJson, 0, 3, state.revision);
    const beforeActivation = storage();
    const badActivation = await request('/api/platform/releases/' + badReleaseId + '/activate', 'POST', {});
    assert.equal(badActivation.status, 400);
    assert.ok(badActivation.data.errors.some(message => /组件标识重复/.test(message)));
    assert.deepEqual(storage(), beforeActivation);
    const goodActivation = await ok('/api/platform/releases/' + goodRelease.release.id + '/activate', 'POST', {});
    assert.equal(goodActivation.release.id, goodRelease.release.id);
    assert.deepEqual(dashboardWidgetIdentityIssues(goodActivation.document), []);
    assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM releases WHERE is_current=1 AND project_id=?').get(state.project.id).count, 1);
    assert.equal(sql.prepare('SELECT snapshot_json FROM releases WHERE id=?').get(badReleaseId).snapshot_json, historicalJson);
    passed('activation rejects malformed historical snapshots atomically while valid explicit identities publish and activate');

    const result = { success: true, checks, isolatedDirectory: fixture.directory, browserOperations: 0, liveConfigurationWrites: 0 };
    fs.writeFileSync(path.join(fixture.directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (fixture) await fixture.close(); });
