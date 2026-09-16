// Exercises real save/publish/activate code against an isolated, freshly seeded
// SQLite database. No HTTP server or commissioned external database is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');

async function main() {
    const root = createRunDirectory('data-source-designer');
    const filename = path.join(root, 'factory.db');
    await createTestDatabase(filename);
    process.env.APP_DATA_DIR = root;
    process.env.DB_TYPE = 'sqlite';
    process.env.SQLITE_FILE = filename;
    process.env.DB_BACKUP_DIR = path.join(root, 'backups');
    process.env.DB_RECOVERY_DIR = path.join(root, 'recovery');
    process.env.DATA_SOURCE_BACKUP_DIR = path.join(root, 'data-source-backups');
    fs.writeFileSync(path.join(root, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename }));
    // Deliberately omit sourceType from legacy entries to check old installations.
    fs.writeFileSync(path.join(root, 'data-sources.json'), JSON.stringify({
        version: 1,
        connections: [
            ...['sqlite', 'mysql', 'postgres', 'sqlserver'].map(type => ({
                id: `legacy_${type}`, name: `Legacy ${type}`, type, filename,
                host: '127.0.0.1', port: 1, user: 'fixture', database: 'fixture', enabled: true
            })),
            { id: 'api', name: 'Health only', sourceType: 'http_api', baseUrl: 'http://127.0.0.1:1', authType: 'none' },
            { id: 'api_type_only', name: 'Legacy API discriminator', type: 'http_api', baseUrl: 'http://127.0.0.1:1', authType: 'none' }
        ],
        backup: { autoEnabled: false, shutdownEnabled: false, selectedConnectionIds: [] }
    }));

    const database = require('../db/database');
    const { normalizeDocument } = require('../utils/dashboardDocument');
    const { loadDesignerState, validatePlcBindings, saveDraft, publishDraft, activateRelease } = require('../services/dashboardDocuments');
    const checks = [];
    try {
        const db = await database.getDb();
        const initial = await loadDesignerState(db);
        assert.ok(initial.scene?.id, 'isolated test scene exists');
        let revision = initial.revision;
        const makeDocument = (data, type = 'value') => normalizeDocument({
            ...initial.document,
            widgets: [{ id: 'source_binding_test', type, frame: { x: 0, y: 0, width: 240, height: 140 }, data }]
        });
        const binding = connectionId => ({ mode: 'database', connectionId, table: 'metrics', field: 'value', alias: 'a' });

        for (const type of ['sqlite', 'mysql', 'postgres', 'sqlserver']) {
            await validatePlcBindings(db, makeDocument(binding(`legacy_${type}`)));
            await validatePlcBindings(db, makeDocument({ mode: 'business', connectionId: `legacy_${type}` }, 'business_summary'));
        }
        checks.push('all four legacy database types remain valid without sourceType');

        const validDocument = makeDocument(binding('legacy_sqlite'));
        const saved = await saveDraft(db, { sceneId: initial.scene.id, document: validDocument, expectedRevision: revision });
        revision = saved.revision;
        const published = await publishDraft(db, { sceneId: initial.scene.id });
        assert.equal(published.document.widgets[0].data.connectionId, 'legacy_sqlite');
        checks.push('legacy database draft saves and publishes');

        const invalidDocuments = [
            ['database', makeDocument(binding('api'))],
            ['type-only API', makeDocument(binding('api_type_only'))],
            ['business', makeDocument({ mode: 'business', connectionId: 'api' }, 'business_summary')],
            ['second dataset', makeDocument({
                mode: 'database', datasets: [
                    { ...binding('legacy_sqlite'), alias: 'a' },
                    { ...binding('api'), alias: 'b' }
                ]
            })]
        ];
        for (const [name, document] of invalidDocuments) {
            await assert.rejects(saveDraft(db, { sceneId: initial.scene.id, document, expectedRevision: revision }), /HTTP API.*健康检查/);
            const state = await loadDesignerState(db, initial.scene.id);
            assert.equal(state.revision, revision, `${name}: rejected draft must not change revision`);
            assert.equal(state.document.widgets[0].data.connectionId, 'legacy_sqlite');
            checks.push(`${name} API binding is rejected before a draft write`);
        }

        const invalidDocument = invalidDocuments[0][1];
        await db.run('UPDATE scenes SET draft_json = ? WHERE id = ?', [JSON.stringify(invalidDocument), initial.scene.id]);
        const releaseCount = (await db.all('SELECT id FROM releases')).length;
        await assert.rejects(publishDraft(db, { sceneId: initial.scene.id }), /HTTP API.*健康检查/);
        assert.equal((await db.all('SELECT id FROM releases')).length, releaseCount);
        checks.push('a manually edited/imported invalid draft cannot publish');

        await db.run(`INSERT INTO releases (id, project_id, scene_id, version, snapshot_json, is_current, notes, schema_version, draft_revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            'invalid_api_release', initial.project.id, initial.scene.id, '99.0.0', JSON.stringify(invalidDocument), 0, '', 3, revision
        ]);
        await assert.rejects(activateRelease(db, 'invalid_api_release'), /HTTP API.*健康检查/);
        const active = await db.get('SELECT id FROM releases WHERE project_id = ? AND is_current = 1', [initial.project.id]);
        assert.equal(active.id, published.release.id);
        checks.push('an imported API-bound release cannot replace the active release');
        console.log(JSON.stringify({ success: true, checks }, null, 2));
    } finally {
        await database.closeDb();
        // root is created and containment-checked by createRunDirectory.
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
