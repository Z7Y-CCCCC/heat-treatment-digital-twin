const express = require('express');
const router = express.Router();
const { getDb, getDbStatus } = require('../db/database');
const {
    releasePayload,
    loadDraftDocument,
    loadDesignerState,
    saveDraft,
    publishDraft,
    activateRelease,
    activateLatestSceneRelease,
    deleteRelease,
    buildLegacyDocument
} = require('../services/dashboardDocuments');

function safeJsonParse(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function stringifyJson(value, fallback = {}) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value ?? fallback);
}

function numberOrDefault(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
}

function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.max(min, Math.min(max, next));
}

function clampInteger(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
}

function formatSqlDateTime(date) {
    // SQLite CURRENT_TIMESTAMP is UTC even when the desktop runs in UTC+08.
    // Other drivers keep their existing session/local-time representation.
    if (getDbStatus().type === 'sqlite') return date.toISOString().slice(0, 19).replace('T', ' ');
    const pad = value => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join('-') + ' ' + [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join(':');
}

function publicEvents(rows) {
    if (getDbStatus().type !== 'sqlite') return rows;
    return rows.map(row => {
        const value = row.occurred_at;
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return row;
        const parsed = new Date(`${value.replace(' ', 'T')}Z`);
        return Number.isNaN(parsed.getTime()) ? row : { ...row, occurred_at: parsed.toISOString() };
    });
}

async function loadPlatformSnapshot() {
    const db = await getDb();
    const projects = await db.all('SELECT * FROM projects ORDER BY is_active DESC, created_at ASC');
    const activeProject = projects.find(p => p.is_active) || projects[0] || null;
    const scenes = activeProject
        ? await db.all('SELECT * FROM scenes WHERE project_id = ? ORDER BY is_active DESC, sort_order ASC', [activeProject.id])
        : [];
    const activeScene = scenes.find(s => s.is_active) || scenes[0] || null;
    const widgets = activeScene
        ? await db.all('SELECT * FROM widgets WHERE scene_id = ? ORDER BY sort_order ASC', [activeScene.id])
        : [];
    const widgetIds = widgets.map(w => w.id);
    const bindings = widgetIds.length
        ? await db.all(`SELECT * FROM bindings WHERE widget_id IN (${widgetIds.map(() => '?').join(',')})`, widgetIds)
        : [];
    const releases = activeProject
        ? await db.all('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC', [activeProject.id])
        : [];
    const currentRelease = releases.find(r => r.is_current) || releases[0] || null;
    const draftDocument = activeScene
        ? await loadDraftDocument(db, activeProject, activeScene)
        : null;
    const assets = await db.all('SELECT * FROM models ORDER BY created_at DESC');
    const deviceTemplates = await db.all('SELECT * FROM device_templates ORDER BY created_at ASC');
    const datapointTemplates = await db.all('SELECT * FROM datapoint_templates ORDER BY device_template_id, sort_order ASC');
    const recentEvents = publicEvents(await db.all('SELECT * FROM event_logs ORDER BY occurred_at DESC, id DESC LIMIT 20'));
    const latestMetrics = await db.get('SELECT * FROM metric_snapshots ORDER BY snapshot_time DESC, id DESC LIMIT 1');

    return {
        projects,
        activeProject,
        scenes: scenes.map(scene => ({
            ...scene,
            layout: safeJsonParse(scene.layout_json, {}),
            camera: safeJsonParse(scene.camera_json, {}),
            theme: safeJsonParse(scene.theme_json, {})
        })),
        activeScene: activeScene ? {
            ...activeScene,
            layout: safeJsonParse(activeScene.layout_json, {}),
            camera: safeJsonParse(activeScene.camera_json, {}),
            theme: safeJsonParse(activeScene.theme_json, {})
        } : null,
        widgets: widgets.map(widget => ({
            ...widget,
            config: safeJsonParse(widget.config_json, {}),
            binding: safeJsonParse(widget.binding_json, {})
        })),
        bindings,
        assets: assets.map(asset => ({
            ...asset,
            tags: safeJsonParse(asset.tags, []),
            metadata: safeJsonParse(asset.metadata, {})
        })),
        deviceTemplates: deviceTemplates.map(template => ({
            ...template,
            default_config: safeJsonParse(template.default_config, {})
        })),
        datapointTemplates,
        releases: releases.map(release => ({
            ...release,
            snapshot: safeJsonParse(release.snapshot_json, {})
        })),
        currentRelease: currentRelease ? {
            ...currentRelease,
            snapshot: safeJsonParse(currentRelease.snapshot_json, {})
        } : null,
        document: draftDocument,
        draftRevision: Number(activeScene?.draft_revision || 0),
        recentEvents,
        latestMetrics: latestMetrics || null
    };
}

router.get('/', async (req, res) => {
    try {
        res.json(await loadPlatformSnapshot());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/designer', async (req, res) => {
    try {
        res.json(await loadDesignerState(await getDb(), String(req.query.scene_id || '')));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.put('/designer/draft', async (req, res) => {
    try {
        const result = await saveDraft(await getDb(), {
            sceneId: req.body?.sceneId || req.body?.scene_id,
            document: req.body?.document,
            expectedRevision: req.body?.expectedRevision ?? req.body?.expected_revision
        });
        res.json({ success: true, document: result.document, revision: result.revision });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message, code: e.code, errors: e.validationErrors || [] });
    }
});

router.post('/releases', async (req, res) => {
    try {
        const result = await publishDraft(await getDb(), {
            sceneId: req.body?.sceneId || req.body?.scene_id,
            version: req.body?.version,
            notes: req.body?.notes
        });
        global.wsServer?.broadcast?.('dashboard_release_changed', {
            releaseId: result.release.id,
            version: result.release.version,
            sceneId: result.document.sceneId,
            action: 'publish'
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message, errors: e.validationErrors || [] });
    }
});

router.post('/releases/:id/activate', async (req, res) => {
    try {
        const result = await activateRelease(await getDb(), req.params.id);
        global.wsServer?.broadcast?.('dashboard_release_changed', {
            releaseId: result.release.id,
            version: result.release.version,
            sceneId: result.document.sceneId,
            action: 'activate'
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message, errors: e.validationErrors || [] });
    }
});

router.post('/scenes/:id/activate-latest-release', async (req, res) => {
    try {
        const result = await activateLatestSceneRelease(await getDb(), req.params.id);
        global.wsServer?.broadcast?.('dashboard_release_changed', {
            releaseId: result.release.id,
            version: result.release.version,
            sceneId: result.document.sceneId,
            action: 'switch_scene'
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ error: e.message, errors: e.validationErrors || [] });
    }
});

router.delete('/releases/:id', async (req, res) => {
    try {
        res.json(await deleteRelease(await getDb(), req.params.id));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/scenes/:id', async (req, res) => {
    const { name, scene_type, layout, camera, theme, is_active, sort_order } = req.body;
    try {
        const db = await getDb();
        const scene = await db.get('SELECT * FROM scenes WHERE id = ?', [req.params.id]);
        if (!scene) return res.status(404).json({ error: '场景不存在' });

        await db.transaction(async (tx) => {
            const activeValue = is_active === undefined ? scene.is_active : (is_active ? 1 : 0);
            if (activeValue) {
                await tx.run('UPDATE scenes SET is_active = 0 WHERE project_id = ?', [scene.project_id]);
            }
            await tx.run(`UPDATE scenes SET
                name = ?, scene_type = ?, layout_json = ?, camera_json = ?, theme_json = ?,
                is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`, [
                name || scene.name,
                scene_type || scene.scene_type,
                stringifyJson(layout, safeJsonParse(scene.layout_json, {})),
                stringifyJson(camera, safeJsonParse(scene.camera_json, {})),
                stringifyJson(theme, safeJsonParse(scene.theme_json, {})),
                activeValue,
                numberOrDefault(sort_order, scene.sort_order),
                req.params.id
            ]);
        });
        const updatedScene = await db.get('SELECT * FROM scenes WHERE id = ?', [req.params.id]);
        const project = await db.get('SELECT * FROM projects WHERE id = ?', [updatedScene.project_id]);
        const draft = await loadDraftDocument(db, project, updatedScene);
        draft.name = updatedScene.name;
        draft.scene = {
            ...draft.scene,
            id: updatedScene.id,
            name: updatedScene.name,
            type: updatedScene.scene_type,
            layout: safeJsonParse(updatedScene.layout_json, {}),
            camera: safeJsonParse(updatedScene.camera_json, {}),
            theme: safeJsonParse(updatedScene.theme_json, {})
        };
        draft.theme = { ...draft.theme, ...safeJsonParse(updatedScene.theme_json, {}) };
        await saveDraft(db, {
            sceneId: updatedScene.id,
            document: draft,
            expectedRevision: Number(updatedScene.draft_revision || 0)
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/widgets/:id', async (req, res) => {
    const {
        widget_type, title, config, binding, x, y, w, h, sort_order, visible
    } = req.body;
    try {
        const db = await getDb();
        const widget = await db.get('SELECT * FROM widgets WHERE id = ?', [req.params.id]);
        if (!widget) return res.status(404).json({ error: '组件不存在' });

        await db.run(`UPDATE widgets SET
            widget_type = ?, title = ?, config_json = ?, binding_json = ?,
            x = ?, y = ?, w = ?, h = ?, sort_order = ?, visible = ?
            WHERE id = ?`, [
            widget_type || widget.widget_type,
            title ?? widget.title,
            stringifyJson(config, safeJsonParse(widget.config_json, {})),
            stringifyJson(binding, safeJsonParse(widget.binding_json, {})),
            numberOrDefault(x, widget.x),
            numberOrDefault(y, widget.y),
            numberOrDefault(w, widget.w),
            numberOrDefault(h, widget.h),
            numberOrDefault(sort_order, widget.sort_order),
            visible === undefined ? widget.visible : (visible === false || visible === 0 ? 0 : 1),
            req.params.id
        ]);

        await rebuildLegacySceneDraft(db, widget.scene_id);

        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/widgets', async (req, res) => {
    const {
        id, scene_id, widget_type, title, config, binding, x, y, w, h, sort_order, visible
    } = req.body;
    if (!id || !scene_id || !widget_type) {
        return res.status(400).json({ error: '组件 ID、场景 ID 和组件类型不能为空' });
    }

    try {
        const db = await getDb();
        const scene = await db.get('SELECT * FROM scenes WHERE id = ?', [scene_id]);
        if (!scene) return res.status(404).json({ error: '场景不存在' });

        await db.run(`INSERT INTO widgets (
            id, scene_id, widget_type, title, config_json, binding_json,
            x, y, w, h, sort_order, visible
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            scene_id,
            widget_type,
            title || '',
            stringifyJson(config, {}),
            stringifyJson(binding, {}),
            numberOrDefault(x, 0),
            numberOrDefault(y, 0),
            numberOrDefault(w, 4),
            numberOrDefault(h, 2),
            numberOrDefault(sort_order, 0),
            visible === false || visible === 0 ? 0 : 1
        ]);
        await rebuildLegacySceneDraft(db, scene_id);
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/widgets/:id', async (req, res) => {
    try {
        const db = await getDb();
        const widget = await db.get('SELECT id, scene_id FROM widgets WHERE id = ?', [req.params.id]);
        if (!widget) return res.status(404).json({ error: '组件不存在，可能已经被删除或 ID 未正确编码' });

        await db.run('DELETE FROM widgets WHERE id = ?', [req.params.id]);
        await rebuildLegacySceneDraft(db, widget.scene_id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

async function rebuildLegacySceneDraft(db, sceneId) {
    const scene = await db.get('SELECT * FROM scenes WHERE id = ?', [sceneId]);
    if (!scene) return;
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [scene.project_id]);
    const document = await buildLegacyDocument(db, project, scene);
    const revision = Number(scene.draft_revision || 0) + 1;
    document.metadata = { ...document.metadata, revision, source: 'legacy_editor' };
    await db.run(`UPDATE scenes SET draft_json = ?, draft_revision = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`, [JSON.stringify(document), revision, scene.id]);
}

router.post('/events', async (req, res) => {
    const { event_type, level, source_id, title, message, value, quality } = req.body;
    if (!title) return res.status(400).json({ error: '事件标题不能为空' });

    try {
        const db = await getDb();
        const result = await db.run(`INSERT INTO event_logs (
            event_type, level, source_id, title, message, value, quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            event_type || 'manual',
            level || 'info',
            source_id || '',
            title,
            message || '',
            value ?? '',
            quality || 'good'
        ]);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/events', async (req, res) => {
    try {
        const db = await getDb();
        const limit = clampInteger(req.query.limit, 1, 200, 50);
        const windowHours = clampNumber(req.query.window_hours ?? req.query.since_hours, 0, 87600, 0);
        const eventType = String(req.query.event_type || req.query.eventType || '').trim();
        const level = String(req.query.level || '').trim();

        const where = [];
        const params = [];
        if (windowHours > 0) {
            where.push('occurred_at >= ?');
            params.push(formatSqlDateTime(new Date(Date.now() - windowHours * 3600000)));
        }
        if (eventType) {
            where.push('event_type = ?');
            params.push(eventType);
        }
        if (level) {
            where.push('level = ?');
            params.push(level);
        }

        const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const rows = await db.all(`SELECT * FROM event_logs${whereSql} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`, params);
        res.json(publicEvents(rows));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/metrics/latest', async (req, res) => {
    try {
        const db = await getDb();
        const metrics = await db.get('SELECT * FROM metric_snapshots ORDER BY snapshot_time DESC, id DESC LIMIT 1');
        res.json(metrics || {});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
