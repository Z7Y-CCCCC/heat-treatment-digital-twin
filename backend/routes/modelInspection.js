const router = require('express').Router();
const { getDb, getDbStatus } = require('../db/database');
const { publicInspection } = require('../services/deviceInspection');
const { loadModelInspection, patchModelInspectionLayout, saveModelInspectionLayout } = require('../services/modelInspection');
const { configurationMutation } = require('../services/configurationSync');

router.get('/:id/inspection', async (req, res) => {
    try {
        const loaded = await loadModelInspection(await getDb(), req.params.id, req.factoryId);
        res.setHeader('Cache-Control', 'no-store'); res.json(publicInspection(loaded));
    } catch (error) { res.status(error.statusCode || 500).json({ error: error.message, code: error.code }); }
});

router.put('/:id/inspection', configurationMutation('models'), async (req, res) => {
    try {
        const db = await getDb();
        const saved = await db.transaction(async tx => {
            const loaded = await loadModelInspection(tx, req.params.id, req.factoryId);
            const next = patchModelInspectionLayout(loaded, req.body);
            return saveModelInspectionLayout(tx, loaded, next, req.factoryId, getDbStatus().type);
        });
        global.wsServer?.broadcastToRole?.('model_metadata_changed', { modelId: req.params.id, timestamp: Date.now() }, 'unity');
        res.json({ success: true, ...publicInspection(saved), model: saved.model });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message, code: error.code }); }
});
module.exports = router;
