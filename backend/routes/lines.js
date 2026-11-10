const express = require('express');
const router = express.Router();
const { cleanupDashboardDeviceDeletion, broadcastDashboardCleanup } = require('../services/dashboardDeviceDeletion');
const { getDb } = require('../db/database');
const { normalizeLineLayout } = require('../utils/spatialLayout');
const { saveLineLayout } = require('../services/lineLayoutSave');

router.put('/:id/placement', async (req, res) => {
    try {
        const body = req.body;
        if (!body || Array.isArray(body) || Object.keys(body).some(key => !['transform', 'placementPending'].includes(key))
            || typeof body.placementPending !== 'boolean' || !body.transform || typeof body.transform !== 'object'
            || Array.isArray(body.transform) || Object.keys(body.transform).some(key => !['x', 'y', 'z', 'rotationY'].includes(key)
                || typeof body.transform[key] !== 'number' || !Number.isFinite(body.transform[key]))) throw new Error('产线位置格式无效');
        const db = await getDb();
        await db.transaction(async tx => {
            const line = await tx.get('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [req.params.id, req.factoryId]);
            if (!line) throw Object.assign(new Error('产线不存在'), { statusCode: 404 });
            const layout = normalizeLineLayout({ ...normalizeLineLayout(line.layout_json), ...body });
            await tx.run('UPDATE `lines` SET layout_json=? WHERE id=?', [JSON.stringify(layout), line.id]);
        });
        res.json({ success: true });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});
const {
    assertDeletionConfirmation,
    getLineDeletionImpact,
    publicDeletionImpact
} = require('../services/deletionImpact');

function normalizeLineRow(row) {
    const layout = normalizeLineLayout(row.layout_json || row.layout);
    return {
        ...row,
        layout,
        layout_json: JSON.stringify(layout)
    };
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const lines = await db.all(`SELECT l.* FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
            WHERE w.factory_id = ? ORDER BY l.sort_order ASC`, [req.factoryId]);
        res.json(lines.map(normalizeLineRow));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/deletion-impact', async (req, res) => {
    try {
        const db = await getDb();
        const owned = await db.get(`SELECT l.id FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
            WHERE l.id = ? AND w.factory_id = ?`, [req.params.id, req.factoryId]);
        if (!owned) return res.status(404).json({ error: '产线不存在，可能已经被删除或 ID 未正确编码' });
        const impact = await getLineDeletionImpact(db, req.params.id, req.factoryId);
        if (!impact) return res.status(404).json({ error: '产线不存在，可能已经被删除或 ID 未正确编码' });
        res.json(publicDeletionImpact(impact));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const { id, name, workshop_id, sort_order, layout_json, layout } = req.body;
    if (!id || !name || !workshop_id) {
        return res.status(400).json({ error: '产线ID、名称和所属车间不能为空' });
    }
    try {
        const db = await getDb();
        const workshop = await db.get('SELECT id FROM workshops WHERE id = ? AND factory_id = ?', [workshop_id, req.factoryId]);
        if (!workshop) return res.status(400).json({ error: '所选车间不属于当前工厂' });
        const nextLayout = normalizeLineLayout(layout_json || layout);
        await db.run(
            'INSERT INTO `lines` (id, name, workshop_id, layout_json, sort_order) VALUES (?, ?, ?, ?, ?)',
            [id, name, workshop_id, JSON.stringify(nextLayout), sort_order || 0]
        );
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const db = await getDb();
        res.json(await db.transaction(tx => saveLineLayout(tx, req.params.id, req.factoryId, req.body || {})));
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const deletion = await db.transaction(async (tx) => {
            // Acquire the lifecycle lock before any snapshot-producing reads.
            await tx.run('UPDATE factories SET id=id WHERE id=?', [req.factoryId]);
            const owned = await tx.get(`SELECT l.id FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
                WHERE l.id = ? AND w.factory_id = ?`, [req.params.id, req.factoryId]);
            if (!owned) {
                const error = new Error('产线不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            const impact = await getLineDeletionImpact(tx, req.params.id, req.factoryId);
            if (!impact) {
                const error = new Error('产线不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            assertDeletionConfirmation(req.body, impact.name);
            const dashboardCleanup = await cleanupDashboardDeviceDeletion(tx, { factoryId: req.factoryId, deviceIds: impact.deviceIds });
            if (impact.deviceIds.length) {
                const placeholders = impact.deviceIds.map(() => '?').join(',');
                await tx.run(`DELETE FROM data_points WHERE device_id IN (${placeholders})`, impact.deviceIds);
                await tx.run(`DELETE FROM devices WHERE id IN (${placeholders})`, impact.deviceIds);
            }
            await tx.run('DELETE FROM `lines` WHERE id = ?', [req.params.id]);
            return { impact, dashboardCleanup };
        });
        broadcastDashboardCleanup(deletion.dashboardCleanup);
        res.json({ success: true, impact: publicDeletionImpact(deletion.impact), dashboardCleanup: deletion.dashboardCleanup });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
