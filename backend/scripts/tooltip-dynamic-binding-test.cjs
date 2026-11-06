// All persistence checks use a freshly seeded, owned output/ database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');

async function main() {
    const directory = createRunDirectory('tooltip-dynamic-binding');
    const filename = path.join(directory, 'factory.db');
    await createTestDatabase(filename);
    Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: filename,
        DB_BACKUP_DIR: path.join(directory, 'backups'), DB_RECOVERY_DIR: path.join(directory, 'recovery'),
        DATA_SOURCE_BACKUP_DIR: path.join(directory, 'data-source-backups') });
    fs.writeFileSync(path.join(directory, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename }));
    const database = require('../db/database');
    const documents = require('../services/dashboardDocuments');
    const copy = value => JSON.parse(JSON.stringify(value));
    const find = (doc, key) => doc.tooltipTemplates.templates[0].widgets.find(widget => widget.id === `tooltip_device_${key}`);
    const paths = { status_value: 'hover.device.status', workshop_value: 'hover.device.workshopName', line_value: 'hover.device.lineName' };
    try {
        const db = await database.getDb();
        const initial = await documents.loadDesignerState(db);
        const legacy = copy(initial.document);
        for (const [key] of Object.entries(paths)) {
            const widget = find(legacy, key);
            assert.ok(widget, `fixture metadata ${key}`);
            delete widget.dynamicBinding;
            delete widget.dynamicField;
            widget.data = { mode: 'static', readOnly: true };
            widget.content = { ...widget.content, text: '错误旧常量', lines: ['数据永远正常'], value: '旧数据',
                valueMap: [{ value: '数据异常 / 未连接', text: '数据正常' }] };
            widget.style.fontSize = 17;
            widget.frame.width = 128;
        }
        const label = find(legacy, 'status_label');
        label.content.text = '我编辑的状态标题';
        legacy.tooltipTemplates.templates[0].widgets.push({ ...copy(label), id: 'custom_static_caption',
            title: '固定说明', content: { text: '数据正常' } });
        // Seed the exact older saved representation, not an already-normalized
        // save, so this also verifies loading legacy drafts and releases.
        await db.run('UPDATE scenes SET draft_json=? WHERE id=?', [JSON.stringify(legacy), legacy.sceneId]);
        const loaded = await documents.loadDesignerState(db, legacy.sceneId);
        for (const [key, target] of Object.entries(paths)) {
            const widget = find(loaded.document, key);
            assert.equal(widget.data.mode, 'runtime');
            assert.equal(widget.data.path, target);
            assert.equal(widget.dynamicBinding.path, target);
            assert.equal(widget.dynamicField, target);
            assert.equal(widget.content.text, '{value}');
            assert.equal(widget.content.lines, undefined);
            assert.equal(widget.content.value, undefined);
            assert.equal(widget.content.valueMap, undefined);
            assert.equal(widget.style.fontSize, 17);
            assert.equal(widget.frame.width, 128);
        }
        assert.equal(find(loaded.document, 'status_label').content.text, '我编辑的状态标题');
        assert.equal(loaded.document.tooltipTemplates.templates[0].widgets.find(widget => widget.id === 'custom_static_caption').data.mode, 'static');
        const forged = copy(loaded.document);
        const state = find(forged, 'status_value');
        state.data = { mode: 'static', readOnly: true };
        state.content.text = '强制正常';
        const duplicate = copy(state);
        duplicate.id = 'copied_status_with_renamed_id'; duplicate.title = '改过图层名的连接状态';
        forged.tooltipTemplates.templates[0].widgets.push(duplicate);
        // Even a payload that clears the marker cannot erase the reserved
        // built-in field's meaning. Copies retain their saved source snapshot.
        delete state.dynamicBinding;
        delete state.dynamicField;
        const saved = await documents.saveDraft(db, { sceneId: forged.sceneId, document: forged, expectedRevision: loaded.revision });
        assert.equal(find(saved.document, 'status_value').data.path, 'hover.device.status');
        const copied = saved.document.tooltipTemplates.templates[0].widgets.find(widget => widget.id === duplicate.id);
        assert.equal(copied.data.path, 'hover.device.status');
        assert.equal(copied.dynamicField, 'hover.device.status');
        assert.equal(copied.content.text, '{value}');
        const published = await documents.publishDraft(db, { sceneId: forged.sceneId });
        const release = await db.get('SELECT snapshot_json FROM releases WHERE id=?', [published.release.id]);
        assert.equal(find(JSON.parse(release.snapshot_json), 'status_value').data.path, 'hover.device.status');
        const reread = await documents.loadDesignerState(db, forged.sceneId);
        assert.equal(find(reread.document, 'status_value').data.path, 'hover.device.status');
        assert.equal(reread.document.tooltipTemplates.templates[0].widgets.find(widget => widget.id === 'custom_static_caption').content.text, '数据正常');
        assert.ok(!(await db.all('SELECT id FROM widgets WHERE scene_id=?', [forged.sceneId])).some(row => row.id === duplicate.id), 'nested tooltip fields stay outside main-canvas widgets');
        const result = { success: true, directory, checks: [
            'legacy saved static status/workshop/line regain dynamic bindings on load',
            'fixed labels/literal captions and authored typography/frames preserved',
            'forged static save and renamed copies keep source provenance',
            'publish/reload persistence and main-canvas isolation'
        ] };
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    } finally { await database.closeDb(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
