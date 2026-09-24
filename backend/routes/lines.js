const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { normalizeLineLayout } = require('../utils/spatialLayout');
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
        const impact = await getLineDeletionImpact(db, req.params.id);
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
    const { name, workshop_id, sort_order, layout_json, layout } = req.body;
    try {
        const db = await getDb();
        const current = await db.get(`SELECT l.* FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
            WHERE l.id = ? AND w.factory_id = ?`, [req.params.id, req.factoryId]);
        if (!current) return res.status(404).json({ error: '产线不存在' });
        const nextWorkshopId = workshop_id ?? current.workshop_id;
        const workshop = await db.get('SELECT id FROM workshops WHERE id = ? AND factory_id = ?', [nextWorkshopId, req.factoryId]);
        if (!workshop) return res.status(400).json({ error: '所选车间不属于当前工厂' });

        const nextLayout = normalizeLineLayout(layout_json ?? layout ?? current.layout_json);
        await db.run(
            'UPDATE `lines` SET name = ?, workshop_id = ?, layout_json = ?, sort_order = ? WHERE id = ?',
            [
                name ?? current.name,
                nextWorkshopId,
                JSON.stringify(nextLayout),
                sort_order ?? current.sort_order ?? 0,
                req.params.id
            ]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const deletedImpact = await db.transaction(async (tx) => {
            const owned = await tx.get(`SELECT l.id FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
                WHERE l.id = ? AND w.factory_id = ?`, [req.params.id, req.factoryId]);
            if (!owned) {
                const error = new Error('产线不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            const impact = await getLineDeletionImpact(tx, req.params.id);
            if (!impact) {
                const error = new Error('产线不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            assertDeletionConfirmation(req.body, impact.name);
            if (impact.deviceIds.length) {
                const placeholders = impact.deviceIds.map(() => '?').join(',');
                await tx.run(`DELETE FROM data_points WHERE device_id IN (${placeholders})`, impact.deviceIds);
                await tx.run(`DELETE FROM devices WHERE id IN (${placeholders})`, impact.deviceIds);
            }
            await tx.run('DELETE FROM `lines` WHERE id = ?', [req.params.id]);
            return impact;
        });
        res.json({ success: true, impact: publicDeletionImpact(deletedImpact) });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
