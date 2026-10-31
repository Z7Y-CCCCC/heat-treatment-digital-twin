const express = require('express');
const router = express.Router();
const { getDb, getDbStatus } = require('../db/database');
const { safeObject, normalizeWorkshopLayout } = require('../utils/spatialLayout');
const { createHash } = require('crypto');
const { normalizeGround, validateGround } = require('../../shared/industrialGround.mjs');
const groundRevision = layout => createHash('sha256').update(JSON.stringify(normalizeGround(layout.ground))).digest('hex');
function layoutComparison(value) {
    if (value === undefined || value === null) return { sql: 'layout_json IS NULL', params: [] };
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    // mysql2 returns native JSON objects; binding those directly is not
    // supported by older bundled MySQL servers. Compare typed JSON instead.
    return { sql: getDbStatus().type === 'mysql' ? 'layout_json = CAST(? AS JSON)' : 'layout_json = ?', params: [json] };
}
const {
    assertDeletionConfirmation,
    getWorkshopDeletionImpact,
    publicDeletionImpact
} = require('../services/deletionImpact');

function normalizeWorkshopRow(row) {
    const layout = normalizeWorkshopLayout(row?.layout_json || row?.layout);
    return { ...row, layout, layout_json: JSON.stringify(layout), groundRevision: groundRevision(layout) };
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const workshops = await db.all('SELECT * FROM workshops WHERE factory_id = ? ORDER BY sort_order ASC', [req.factoryId]);
        res.json(workshops.map(normalizeWorkshopRow));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/deletion-impact', async (req, res) => {
    try {
        const db = await getDb();
        const owned = await db.get('SELECT id FROM workshops WHERE id = ? AND factory_id = ?', [req.params.id, req.factoryId]);
        if (!owned) return res.status(404).json({ error: '车间不存在，可能已经被删除或 ID 未正确编码' });
        const impact = await getWorkshopDeletionImpact(db, req.params.id, req.factoryId);
        if (!impact) return res.status(404).json({ error: '车间不存在，可能已经被删除或 ID 未正确编码' });
        res.json(publicDeletionImpact(impact));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const { id, name, sort_order, layout_json, layout } = req.body;
    if (!id || !name) {
        return res.status(400).json({ error: '车间ID和名称不能为空' });
    }
    try {
        const db = await getDb();
        const nextLayout = normalizeWorkshopLayout(layout_json || layout);
        if (nextLayout.ground !== undefined) throw new Error('地面请在现场编排器中单独保存');
        await db.run(
            'INSERT INTO workshops (id, factory_id, name, sort_order, layout_json) VALUES (?, ?, ?, ?, ?)',
            [id, req.factoryId, name, sort_order || 0, JSON.stringify(nextLayout)]
        );
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id/ground', async (req, res) => {
    try {
        if (!req.body || Object.keys(req.body).some(key => !['ground', 'expectedRevision'].includes(key)) || !/^[a-f0-9]{64}$/.test(req.body.expectedRevision || '')) throw new Error('地面保存请求无效，请重新载入车间后重试');
        const ground = validateGround(req.body.ground);
        const db = await getDb();
        const revision = await db.transaction(async tx => {
            const row = await tx.get('SELECT * FROM workshops WHERE id = ? AND factory_id = ?', [req.params.id, req.factoryId]);
            if (!row) throw Object.assign(new Error('车间不存在'), { statusCode: 404 });
            const layout = normalizeWorkshopLayout(row.layout_json);
            if (groundRevision(layout) !== req.body.expectedRevision) throw Object.assign(new Error('地面已被其他窗口修改；草稿保留，请重新载入后再保存'), { statusCode: 409 });
            layout.ground = ground;
            const next = JSON.stringify(layout);
            if (next !== row.layout_json) {
                const match = layoutComparison(row.layout_json);
                const written = await tx.run(`UPDATE workshops SET layout_json = ? WHERE id = ? AND factory_id = ? AND ${match.sql}`, [next, row.id, req.factoryId, ...match.params]);
                if (!written.changes) throw Object.assign(new Error('车间刚被其他窗口修改，草稿已保留，请重试'), { statusCode: 409 });
            }
            return groundRevision(layout);
        });
        res.json({ success: true, ground, revision });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});

router.put('/:id', async (req, res) => {
    const { name, sort_order, layout_json, layout } = req.body;
    try {
        const db = await getDb();
        const existing = await db.get('SELECT * FROM workshops WHERE id = ? AND factory_id = ?', [req.params.id, req.factoryId]);
        if (!existing) return res.status(404).json({ error: '车间不存在，可能已经被删除或 ID 未正确编码' });

        const nextLayout = normalizeWorkshopLayout(layout_json ?? layout ?? existing.layout_json);
        // Geometry editors, including older clients, cannot replace ground data.
        if (safeObject(existing.layout_json).ground !== undefined) nextLayout.ground = normalizeGround(safeObject(existing.layout_json).ground);
        else delete nextLayout.ground;
        const match = layoutComparison(existing.layout_json);
        const result = await db.run(`UPDATE workshops SET name = ?, sort_order = ?, layout_json = ? WHERE id = ? AND factory_id = ? AND ${match.sql}`, [
            name ?? existing.name,
            sort_order ?? existing.sort_order ?? 0,
            JSON.stringify(nextLayout),
            req.params.id,
            req.factoryId,
            ...match.params
        ]);
        if (!result.changes) return res.status(409).json({ error: '车间刚被其他窗口修改，请重新载入后保存' });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const deletedImpact = await db.transaction(async (tx) => {
            const owned = await tx.get('SELECT id FROM workshops WHERE id = ? AND factory_id = ?', [req.params.id, req.factoryId]);
            if (!owned) {
                const error = new Error('车间不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            const impact = await getWorkshopDeletionImpact(tx, req.params.id, req.factoryId);
            if (!impact) {
                const error = new Error('车间不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            assertDeletionConfirmation(req.body, impact.name);
            if (impact.deviceIds.length) {
                const placeholders = impact.deviceIds.map(() => '?').join(',');
                await tx.run(`DELETE FROM data_points WHERE device_id IN (${placeholders})`, impact.deviceIds);
                await tx.run(`DELETE FROM devices WHERE id IN (${placeholders})`, impact.deviceIds);
            }
            if (impact.lineIds.length) {
                const placeholders = impact.lineIds.map(() => '?').join(',');
                await tx.run(`DELETE FROM \`lines\` WHERE id IN (${placeholders})`, impact.lineIds);
            }
            const environmentRow = await tx.get('SELECT value FROM factory_settings WHERE factory_id = ? AND `key` = ?', [req.factoryId, 'native_environment_config']);
            const environment = safeObject(environmentRow?.value);
            if (Array.isArray(environment.walls)) {
                environment.walls = environment.walls.filter(wall => (
                    String(wall?.workshopId || wall?.workshop_id || '') !== String(req.params.id)
                ));
                await tx.run('UPDATE factory_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE factory_id = ? AND `key` = ?', [
                    JSON.stringify(environment),
                    req.factoryId,
                    'native_environment_config'
                ]);
            }
            await tx.run('DELETE FROM workshops WHERE id = ? AND factory_id = ?', [req.params.id, req.factoryId]);
            return impact;
        });
        res.json({ success: true, impact: publicDeletionImpact(deletedImpact) });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
