const {
    SCHEMA_VERSION,
    safeJsonParse,
    objectValue,
    createEmptyDocument,
    normalizeDocument,
    buildDocumentFromLegacy,
    validateDocument,
    documentToLegacyWidgets,
    documentToRuntimeWidgets,
    isCanonicalDocument,
    assertNoForbiddenWriteIntent
} = require('../utils/dashboardDocument');
const { resolveConnection } = require('./dataSources');
const { orderedReleases, orderedRows } = require('../utils/orderedReleases');

function releaseTimestamp(row) {
    const publishedAt = safeJsonParse(row?.snapshot_json, {})?.metadata?.publishedAt;
    return Date.parse(publishedAt) || Date.parse(row?.created_at) || 0;
}

function sortReleasesNewestFirst(releases) {
    return releases.map(row => ({ row, timestamp: releaseTimestamp(row) }))
        .sort((a, b) => b.timestamp - a.timestamp || String(b.row.id).localeCompare(String(a.row.id)))
        .map(item => item.row);
}

function releasePayload(row) {
    if (!row) return null;
    return {
        ...row,
        is_current: !!row.is_current,
        snapshot: safeJsonParse(row.snapshot_json, {})
    };
}

function scenePayload(row) {
    if (!row) return null;
    return {
        ...row,
        layout: safeJsonParse(row.layout_json, {}),
        camera: safeJsonParse(row.camera_json, {}),
        theme: safeJsonParse(row.theme_json, {}),
        draft: safeJsonParse(row.draft_json, null)
    };
}

async function getProjectAndScene(db, sceneId = '', factoryId = '') {
    const scoped = String(factoryId || '').trim();
    let scene = sceneId
        ? await db.get(scoped
            ? 'SELECT s.* FROM scenes s JOIN projects p ON p.id = s.project_id WHERE s.id = ? AND p.factory_id = ?'
            : 'SELECT * FROM scenes WHERE id = ?', scoped ? [sceneId, scoped] : [sceneId])
        : null;
    if (sceneId && !scene) return { project: null, scene: null };
    let project = scene
        ? await db.get('SELECT * FROM projects WHERE id = ?', [scene.project_id])
        : null;
    if (sceneId && !project) return { project: null, scene };
    if (!project) {
        project = scoped
            ? (await orderedRows(db, 'projects', 'SELECT id FROM projects WHERE factory_id = ? ORDER BY is_active DESC, created_at ASC LIMIT 1', [scoped]))[0]
            : (await orderedRows(db, 'projects', 'SELECT id FROM projects WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1'))[0]
                || (await orderedRows(db, 'projects', 'SELECT id FROM projects ORDER BY created_at ASC LIMIT 1'))[0];
    }
    if (!scene && project) {
        scene = (await orderedRows(db, 'scenes', 'SELECT id FROM scenes WHERE project_id = ? AND is_active = 1 ORDER BY sort_order ASC LIMIT 1', [project.id]))[0]
            || (await orderedRows(db, 'scenes', 'SELECT id FROM scenes WHERE project_id = ? ORDER BY sort_order ASC LIMIT 1', [project.id]))[0];
    }
    return { project, scene };
}

async function buildLegacyDocument(db, project, scene) {
    if (!project || !scene) return createEmptyDocument({ project, scene });
    const widgets = await orderedRows(db, 'widgets', 'SELECT id FROM widgets WHERE scene_id = ? ORDER BY sort_order ASC', [scene.id]);
    return buildDocumentFromLegacy({ project, scene, widgets });
}

async function loadDraftDocument(db, project, scene) {
    if (!project || !scene) return createEmptyDocument({ project, scene });
    const stored = safeJsonParse(scene.draft_json, null);
    if (isCanonicalDocument(stored)) {
        return normalizeDocument(stored, { project, scene, source: 'draft' });
    }
    return buildLegacyDocument(db, project, scene);
}

async function loadPublishedDocument(db, project, scene) {
    if (!project) return { document: createEmptyDocument({ project, scene, source: 'unpublished' }), release: null };
    let release = (await orderedReleases(db, project.id, { currentOnly: true, limit: 1 }))[0];
    if (!release && scene?.published_release_id) {
        release = await db.get('SELECT * FROM releases WHERE id = ? AND project_id = ?', [scene.published_release_id, project.id]);
    }
    const snapshot = safeJsonParse(release?.snapshot_json, null);
    if (release && isCanonicalDocument(snapshot)) {
        return {
            document: normalizeDocument(snapshot, { project, scene, source: 'release' }),
            release: releasePayload(release)
        };
    }
    const empty = createEmptyDocument({ project, scene, source: 'unpublished' });
    empty.metadata = { ...empty.metadata, unpublished: true };
    return { document: empty, release: null };
}

async function validatePlcBindings(db, document) {
    validateDocument(document);
    const databaseConnectionIds = [...new Set(document.widgets
        .filter(widget => ['database', 'business', 'http_api'].includes(widget.data?.mode))
        .flatMap(widget => (widget.data.mode === 'database' && Array.isArray(widget.data.datasets) && widget.data.datasets.length
            ? widget.data.datasets
            : [widget.data]))
        .map(binding => String(binding.connectionId || ''))
        .filter(Boolean))];
    for (const connectionId of databaseConnectionIds) {
        const connection = resolveConnection(connectionId);
        if (connection.sourceType === 'http_api' || connection.type === 'http_api') {
            const usedForHttp = document.widgets.some(widget => widget.data?.mode === 'http_api' && widget.data.connectionId === connectionId);
            const usedForDatabase = document.widgets.some(widget => ['database', 'business'].includes(widget.data?.mode)
                && (widget.data.connectionId === connectionId || widget.data.datasets?.some(dataset => dataset.connectionId === connectionId)));
            if (usedForHttp && !usedForDatabase) continue;
            throw new Error('数据库和业务数据组件不能绑定 HTTP API，请改用 HTTP 接口组件或数据库连接');
        }
        if (document.widgets.some(widget => widget.data?.mode === 'http_api' && widget.data.connectionId === connectionId))
            throw new Error('HTTP 接口组件必须选择 HTTP API 数据源');
    }
    const bindings = document.widgets
        .filter(widget => widget.data?.mode === 'plc')
        .map(widget => ({
            widgetId: widget.id,
            deviceScope: widget.data.deviceScope === 'current' ? 'current' : 'fixed',
            deviceId: String(widget.data.deviceId || ''),
            pointId: String(widget.data.pointId || '')
        }));
    if (!bindings.length) return;

    const ids = [...new Set(bindings.map(item => item.pointId))];
    const placeholders = ids.map(() => '?').join(',');
    const points = await db.all(`SELECT id, device_id, access_type FROM data_points WHERE id IN (${placeholders})`, ids);
    const pointsById = new Map(points.map(point => [String(point.id), point]));
    const errors = [];
    for (const binding of bindings) {
        const point = pointsById.get(binding.pointId);
        if (!point) {
            errors.push(`组件 ${binding.widgetId} 绑定的点位不存在：${binding.pointId}`);
            continue;
        }
        if (binding.deviceScope !== 'current' && String(point.device_id) !== binding.deviceId) {
            errors.push(`组件 ${binding.widgetId} 的设备与点位不匹配`);
        }
        if (String(point.access_type || 'READ').toUpperCase() !== 'READ') {
            errors.push(`组件 ${binding.widgetId} 只能绑定 READ 只读点位`);
        }
    }
    if (errors.length) {
        const error = new Error(errors.join('；'));
        error.validationErrors = errors;
        throw error;
    }
}

async function syncLegacyWidgets(tx, document) {
    const rows = documentToLegacyWidgets(document);
    const owners = rows.length
        ? await tx.all(`SELECT id, scene_id FROM widgets WHERE id IN (${rows.map(() => '?').join(',')})`, rows.map(row => row.id))
        : [];
    const ownerById = new Map(owners.map(row => [String(row.id), String(row.scene_id)]));
    for (const row of rows) {
        const owner = ownerById.get(String(row.id));
        if (owner && owner !== String(document.sceneId)) throw new Error(`组件 ID ${row.id} 已属于其他场景，请为新组件使用不同 ID`);
    }
    const existing = await tx.all('SELECT id FROM widgets WHERE scene_id = ?', [document.sceneId]);
    const nextIds = new Set(rows.map(row => row.id));
    for (const row of existing) {
        if (!nextIds.has(String(row.id))) {
            await tx.run('DELETE FROM bindings WHERE widget_id = ?', [row.id]);
            await tx.run('DELETE FROM widgets WHERE id = ?', [row.id]);
        }
    }
    for (const row of rows) {
        const columns = Object.keys(row);
        if (ownerById.has(String(row.id))) {
            const updates = columns.filter(column => column !== 'id');
            const result = await tx.run(`UPDATE widgets SET ${updates.map(column => `${tx.q(column)} = ?`).join(', ')}
                WHERE id = ? AND scene_id = ?`, [...updates.map(column => row[column]), row.id, document.sceneId]);
            if (!Number(result.changes)) throw new Error(`组件 ${row.id} 已被其他操作更改，请刷新后重试`);
        } else {
            await tx.run(`INSERT INTO widgets (${columns.map(column => tx.q(column)).join(', ')})
                VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => row[column]));
        }
    }
}

async function saveDraft(db, { sceneId, document: input, expectedRevision, factoryId = '' }) {
    const { project, scene } = await getProjectAndScene(db, sceneId, factoryId);
    if (!project || !scene) throw new Error('场景不存在');
    const currentRevision = Number(scene.draft_revision || 0);
    if (expectedRevision !== undefined && expectedRevision !== null
        && Number(expectedRevision) !== currentRevision) {
        const error = new Error(`草稿已被其他工程师更新，请刷新后重试（当前修订 ${currentRevision}）`);
        error.code = 'DRAFT_CONFLICT';
        error.status = 409;
        throw error;
    }
    assertNoForbiddenWriteIntent(input);
    const document = normalizeDocument(input, { project, scene, source: 'designer' });
    // Normalize first so deleting a view can repair legacy visibility/event
    // references before validation instead of returning one error per widget.
    validateDocument(document);
    document.projectId = String(project.id);
    document.sceneId = String(scene.id);
    document.scene.id = String(scene.id);
    await validatePlcBindings(db, document);
    const nextRevision = currentRevision + 1;
    document.metadata = {
        ...objectValue(document.metadata, {}),
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
        source: 'designer'
    };

    await db.transaction(async (tx) => {
        const updated = await tx.run(`UPDATE scenes SET draft_json = ?, draft_revision = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND COALESCE(draft_revision, 0) = ?`, [JSON.stringify(document), nextRevision, scene.id, currentRevision]);
        if (!Number(updated.changes)) {
            const latest = await tx.get('SELECT draft_revision FROM scenes WHERE id = ?', [scene.id]);
            const error = new Error(`草稿已被其他工程师更新或删除，请刷新后重试（当前修订 ${latest?.draft_revision ?? '未知'}）`);
            error.code = 'DRAFT_CONFLICT';
            error.status = 409;
            throw error;
        }
        await syncLegacyWidgets(tx, document);
    });
    return { document, revision: nextRevision, project, scene: { ...scene, draft_revision: nextRevision } };
}

function parseSemver(value) {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
}

function nextVersion(releases) {
    const versions = releases.map(row => parseSemver(row.version)).filter(Boolean);
    if (!versions.length) return '1.0.0';
    versions.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]));
    const latest = versions[0];
    return `${latest[0]}.${latest[1]}.${latest[2] + 1}`;
}

function normalizeVersion(value, releases) {
    const requested = String(value || '').trim();
    if (!requested) return nextVersion(releases);
    if (!/^\d+\.\d+\.\d+$/.test(requested)) throw new Error('版本号格式必须为 X.Y.Z，例如 1.2.0');
    return requested;
}

function releaseId() {
    return `release_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function publishDraft(db, { sceneId, version, notes, factoryId = '' }) {
    const { project, scene } = await getProjectAndScene(db, sceneId, factoryId);
    if (!project || !scene) throw new Error('场景不存在');
    assertNoForbiddenWriteIntent(safeJsonParse(scene.draft_json, null));
    const document = await loadDraftDocument(db, project, scene);
    await validatePlcBindings(db, document);
    const id = releaseId();
    const snapshot = normalizeDocument(document, { project, scene, source: 'release' });
    snapshot.metadata = {
        ...objectValue(snapshot.metadata, {}),
        revision: Number(scene.draft_revision || 0),
        publishedAt: new Date().toISOString(),
        source: 'release'
    };

    await db.transaction(async (tx) => {
        // Lock the project before allocating a version, including on databases
        // that allow concurrent transactions (MySQL/Postgres/SQL Server).
        await tx.run('UPDATE projects SET is_active = is_active WHERE id = ?', [project.id]);
        await tx.run('UPDATE scenes SET draft_revision = draft_revision WHERE id = ?', [scene.id]);
        const latestScene = await tx.get('SELECT draft_revision FROM scenes WHERE id = ?', [scene.id]);
        if (!latestScene || Number(latestScene.draft_revision || 0) !== Number(scene.draft_revision || 0)) {
            const error = new Error('草稿已在发布过程中更新或删除，请刷新后重试');
            error.code = 'DRAFT_CONFLICT';
            error.status = 409;
            throw error;
        }
        const releases = await orderedReleases(tx, project.id);
        const normalizedVersion = normalizeVersion(version, releases);
        if (releases.some(item => String(item.version) === normalizedVersion)) {
            throw new Error(`版本 ${normalizedVersion} 已存在`);
        }
        snapshot.metadata.version = normalizedVersion;
        // SQL timestamp columns can round to whole seconds. Preserve a strict
        // publication order in the snapshot while holding the project lock.
        snapshot.metadata.publishedAt = new Date(releases.reduce((latest, row) => Math.max(latest, releaseTimestamp(row) + 1), Date.now())).toISOString();
        await tx.run('UPDATE releases SET is_current = 0 WHERE project_id = ?', [project.id]);
        await tx.run(`INSERT INTO releases (
            id, project_id, scene_id, version, snapshot_json, is_current,
            notes, schema_version, draft_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id, project.id, scene.id, normalizedVersion, JSON.stringify(snapshot), 1,
            String(notes || '').trim().slice(0, 1000), SCHEMA_VERSION, Number(scene.draft_revision || 0)
        ]);
        await tx.run('UPDATE scenes SET published_release_id = ? WHERE id = ?', [id, scene.id]);
    });
    const release = await db.get('SELECT * FROM releases WHERE id = ?', [id]);
    return { release: releasePayload(release), document: snapshot };
}

async function activateRelease(db, releaseIdValue, factoryId = '') {
    const release = await db.get(String(factoryId || '').trim()
        ? 'SELECT r.* FROM releases r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.factory_id = ?'
        : 'SELECT * FROM releases WHERE id = ?', String(factoryId || '').trim() ? [releaseIdValue, factoryId] : [releaseIdValue]);
    if (!release) throw new Error('发布版本不存在');
    const snapshot = safeJsonParse(release.snapshot_json, null);
    if (!isCanonicalDocument(snapshot)) throw new Error('该版本不是完整快照，无法恢复');
    assertNoForbiddenWriteIntent(snapshot);
    const { project, scene } = await getProjectAndScene(db, release.scene_id || snapshot.sceneId, factoryId);
    if (!project || !scene || String(project.id) !== String(release.project_id)) throw new Error('发布版本对应的场景不存在');
    const document = normalizeDocument(snapshot, { project, scene, source: 'release' });
    await validatePlcBindings(db, document);
    await db.transaction(async (tx) => {
        await tx.run('UPDATE projects SET is_active = is_active WHERE id = ?', [release.project_id]);
        await tx.run('UPDATE releases SET is_current = 0 WHERE project_id = ?', [release.project_id]);
        const activated = await tx.run('UPDATE releases SET is_current = 1 WHERE id = ?', [release.id]);
        if (!Number(activated.changes)) throw new Error('发布版本已被删除，无法切换');
        await tx.run('UPDATE scenes SET is_active = 0 WHERE project_id = ?', [release.project_id]);
        await tx.run('UPDATE scenes SET is_active = 1, published_release_id = ? WHERE id = ?', [release.id, scene.id]);
    });
    return { release: releasePayload({ ...release, is_current: 1 }), document };
}

async function activateLatestSceneRelease(db, sceneId, factoryId = '') {
    const releases = await db.all(String(factoryId || '').trim()
        ? 'SELECT r.* FROM releases r JOIN projects p ON p.id = r.project_id WHERE r.scene_id = ? AND p.factory_id = ?'
        : 'SELECT * FROM releases WHERE scene_id = ?',
    String(factoryId || '').trim() ? [sceneId, factoryId] : [sceneId]);
    const release = sortReleasesNewestFirst(releases)[0];
    if (!release) throw new Error('该场景还没有可运行的发布版本');
    return activateRelease(db, release.id, factoryId);
}

async function deleteRelease(db, releaseIdValue, factoryId = '') {
    const release = await db.get(String(factoryId || '').trim()
        ? 'SELECT r.* FROM releases r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.factory_id = ?'
        : 'SELECT * FROM releases WHERE id = ?',
    String(factoryId || '').trim() ? [releaseIdValue, factoryId] : [releaseIdValue]);
    if (!release) throw new Error('发布版本不存在');
    if (release.is_current) throw new Error('当前正在运行的版本不能删除');
    const deleted = await db.run('DELETE FROM releases WHERE id = ? AND is_current = 0', [release.id]);
    if (!Number(deleted.changes)) throw new Error('发布版本已被切换为当前版本或删除，请刷新后重试');
    return { success: true };
}

async function loadDesignerState(db, sceneId = '', factoryId = '') {
    const { project, scene } = await getProjectAndScene(db, sceneId, factoryId);
    const document = await loadDraftDocument(db, project, scene);
    const releases = project
        ? await orderedReleases(db, project.id)
        : [];
    const currentRelease = releases.find(row => !!row.is_current) || null;
    return {
        schemaVersion: SCHEMA_VERSION,
        project,
        scene: scenePayload(scene),
        revision: Number(scene?.draft_revision || 0),
        document,
        releases: sortReleasesNewestFirst(releases).map(releasePayload),
        currentRelease: releasePayload(currentRelease)
    };
}

function runtimePlatformPayload({ project, scene, document, release }) {
    // A factory created while the backend is already running has no published
    // release yet. Normalize its deliberately sparse empty document before
    // projecting widgets; raw seed widgets do not contain every runtime field.
    const runtimeDocument = normalizeDocument(document || createEmptyDocument({ project, scene }), {
        project,
        scene,
        source: release ? 'release' : 'runtime'
    });
    const publishedScene = objectValue(runtimeDocument.scene, {});
    const runtimeScene = scene ? {
        id: scene.id,
        project_id: scene.project_id,
        name: publishedScene.name || scene.name,
        scene_type: publishedScene.type || scene.scene_type,
        is_active: !!scene.is_active,
        sort_order: Number(scene.sort_order || 0),
        created_at: scene.created_at,
        updated_at: scene.updated_at,
        published_release_id: release?.id || scene.published_release_id || null,
        layout: objectValue(publishedScene.layout, {}),
        camera: objectValue(publishedScene.camera, {}),
        views: Array.isArray(publishedScene.views) ? publishedScene.views : [],
        defaultViewId: publishedScene.defaultViewId || publishedScene.views?.[0]?.id || 'factory_overview',
        theme: { ...objectValue(publishedScene.theme, {}), ...objectValue(runtimeDocument.theme, {}) }
    } : null;
    return {
        activeProject: project || null,
        activeScene: runtimeScene,
        canvas: runtimeDocument.canvas,
        theme: runtimeDocument.theme,
        document: runtimeDocument,
        widgets: documentToRuntimeWidgets(runtimeDocument),
        currentRelease: release
    };
}

module.exports = {
    sortReleasesNewestFirst,
    releasePayload,
    scenePayload,
    getProjectAndScene,
    buildLegacyDocument,
    loadDraftDocument,
    loadPublishedDocument,
    validatePlcBindings,
    syncLegacyWidgets,
    saveDraft,
    publishDraft,
    activateRelease,
    activateLatestSceneRelease,
    deleteRelease,
    loadDesignerState,
    runtimePlatformPayload
};
