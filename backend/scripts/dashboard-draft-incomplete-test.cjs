// Draft completeness regression. Every database write uses a freshly seeded,
// containment-checked output fixture; no installed database or published site
// is read or modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');

const clone = value => JSON.parse(JSON.stringify(value));

async function main() {
    const directory = createRunDirectory('dashboard-draft-incomplete');
    const filename = path.join(directory, 'factory.db');
    await createTestDatabase(filename);
    Object.assign(process.env, {
        APP_DATA_DIR: directory,
        DB_TYPE: 'sqlite',
        SQLITE_FILE: filename,
        DB_BACKUP_DIR: path.join(directory, 'backups'),
        DB_RECOVERY_DIR: path.join(directory, 'recovery'),
        DATA_SOURCE_BACKUP_DIR: path.join(directory, 'data-source-backups')
    });
    fs.writeFileSync(path.join(directory, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename }));

    const database = require('../db/database');
    const documents = require('../services/dashboardDocuments');
    const { normalizeDocument } = require('../utils/dashboardDocument');
    const checks = [];
    try {
        const db = await database.getDb();
        const initial = await documents.loadDesignerState(db);
        assert.ok(initial.scene?.id, 'the isolated fixture has a designer scene');
        const initialReleaseRows = await db.all('SELECT id, snapshot_json, is_current FROM releases ORDER BY id');
        const draft = clone(initial.document);
        const originalWidgetCount = draft.widgets.length;
        const filters = ['A', 'B', 'C'].map((suffix, index) => ({
            id: `unfinished_filter_${suffix}`,
            type: 'filter',
            title: `未配置参数筛选 ${suffix}`,
            frame: { x: 60 + index * 40, y: 80, width: 300, height: 100 },
            content: { parameterKey: '', control: 'select', options: [] },
            data: { mode: 'static', readOnly: true }
        }));
        const business = {
            id: 'unfinished_business',
            type: 'business_summary',
            title: '未配置业务摘要',
            frame: { x: 200, y: 260, width: 480, height: 300 },
            content: { section: 'batches' },
            data: { mode: 'business', connectionId: '', readOnly: true }
        };
        draft.widgets.push(...filters, business);
        const partTemplate = draft.tooltipTemplates.templates.find(template => template.kind === 'part');
        const titleWidget = partTemplate.widgets.find(widget => widget.id.endsWith('_title'));
        assert.ok(titleWidget, 'the fixture includes independent tooltip text widgets');
        titleWidget.content.text = '未完成主画布绑定不应阻止保存此提示修改';

        const saved = await documents.saveDraft(db, {
            sceneId: initial.scene.id,
            document: draft,
            expectedRevision: initial.revision
        });
        assert.equal(saved.revision, initial.revision + 1);
        assert.equal(saved.document.widgets.length, originalWidgetCount + 4, 'saving must not silently delete incomplete widgets');
        for (const filter of filters) {
            const actual = saved.document.widgets.find(widget => widget.id === filter.id);
            assert.equal(actual.type, 'filter');
            assert.equal(actual.content.parameterKey, '', 'saving must not fabricate a parameter');
        }
        assert.equal(saved.document.widgets.find(widget => widget.id === business.id).data.mode, 'business', 'saving must not silently change binding mode');
        assert.equal(saved.document.widgets.find(widget => widget.id === business.id).data.connectionId, '');
        checks.push('three blank filters and a blank business binding save without deleting widgets or fabricating bindings');

        const reopened = await documents.loadDesignerState(db, initial.scene.id);
        assert.equal(reopened.revision, saved.revision);
        assert.equal(reopened.document.widgets.length, originalWidgetCount + 4);
        assert.equal(reopened.document.tooltipTemplates.templates.find(template => template.id === partTemplate.id).widgets.find(widget => widget.id === titleWidget.id).content.text, titleWidget.content.text);
        assert.deepEqual(await db.all('SELECT id, snapshot_json, is_current FROM releases ORDER BY id'), initialReleaseRows);
        const runtime = await documents.loadPublishedDocument(db, initial.project, reopened.scene);
        assert.equal(runtime.release?.id, initial.currentRelease?.id);
        assert.equal(runtime.document.widgets.some(widget => widget.id === business.id), false);
        assert.equal(JSON.stringify(runtime.document.tooltipTemplates).includes(titleWidget.content.text), false);
        checks.push('reopening retains tooltip edits and incomplete bindings while the published runtime remains unchanged');

        await assert.rejects(documents.publishDraft(db, { sceneId: initial.scene.id }), error => {
            assert.match(error.message, /请选择已定义的大屏参数/);
            assert.match(error.message, /必须选择外部数据库连接/);
            for (const widget of [...filters, business]) assert.ok(error.message.includes(widget.title), `publish error should identify ${widget.title}`);
            return true;
        });
        assert.deepEqual(await db.all('SELECT id, snapshot_json, is_current FROM releases ORDER BY id'), initialReleaseRows);
        assert.equal((await documents.loadDesignerState(db, initial.scene.id)).revision, saved.revision);
        checks.push('publishing stays strict, identifies the unfinished widgets by name, and leaves the active release intact');

        async function rejectWithoutWriting(input, pattern) {
            const before = await db.get('SELECT draft_json, draft_revision FROM scenes WHERE id = ?', [initial.scene.id]);
            await assert.rejects(documents.saveDraft(db, {
                sceneId: initial.scene.id,
                document: input,
                expectedRevision: saved.revision
            }), pattern);
            assert.deepEqual(await db.get('SELECT draft_json, draft_revision FROM scenes WHERE id = ?', [initial.scene.id]), before);
        }
        const badParameter = clone(saved.document);
        badParameter.widgets.find(widget => widget.id === filters[0].id).content.parameterKey = 'parameter_not_defined';
        await rejectWithoutWriting(badParameter, /请选择已定义的大屏参数/);
        const badOptions = clone(saved.document);
        badOptions.widgets.find(widget => widget.id === filters[0].id).content.options = [{ label: 'x'.repeat(81), value: '' }];
        await rejectWithoutWriting(badOptions, /筛选选项名称无效/);
        const writeAttempt = clone(saved.document);
        writeAttempt.widgets.find(widget => widget.id === business.id).data.readOnly = false;
        await rejectWithoutWriting(writeAttempt, /写入/);
        await assert.rejects(documents.saveDraft(db, {
            sceneId: initial.scene.id,
            document: saved.document,
            expectedRevision: initial.revision
        }), error => error.code === 'DRAFT_CONFLICT' && error.status === 409);
        assert.equal((await documents.loadDesignerState(db, initial.scene.id)).revision, saved.revision);
        checks.push('specified-but-missing parameters, malformed options, PLC write intent, and stale revisions still cannot overwrite the draft');

        const completed = clone(saved.document);
        completed.parameters = [...completed.parameters, ...filters.map((filter, index) => ({
            key: `filter_value_${index + 1}`, label: filter.title, type: 'string', defaultValue: ''
        }))];
        for (const [index, filter] of filters.entries()) completed.widgets.find(widget => widget.id === filter.id).content.parameterKey = `filter_value_${index + 1}`;
        // This is an explicit user edit, not an automatic save-time repair.
        completed.widgets.find(widget => widget.id === business.id).data.mode = 'static';
        const completedSave = await documents.saveDraft(db, {
            sceneId: initial.scene.id,
            document: normalizeDocument(completed),
            expectedRevision: saved.revision
        });
        const published = await documents.publishDraft(db, { sceneId: initial.scene.id });
        assert.equal(published.document.widgets.length, originalWidgetCount + 4);
        assert.equal(published.document.tooltipTemplates.templates.find(template => template.id === partTemplate.id).widgets.find(widget => widget.id === titleWidget.id).content.text, titleWidget.content.text);
        assert.equal(completedSave.revision, saved.revision + 1);
        assert.equal((await documents.loadPublishedDocument(db, initial.project, initial.scene)).release.id, published.release.id);
        checks.push('after explicit binding completion the same complete layout and tooltip edits publish successfully');

        const report = { success: true, checks, directory };
        fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await database.closeDb();
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
