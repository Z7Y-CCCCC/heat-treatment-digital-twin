'use strict';
const router = require('express').Router();
const { getDb, getDbStatus } = require('../db/database');
const { collectorHealth } = require('../services/collectorHealth');
const { collectorAvailable } = require('../services/runtimeEngine');
async function configuredMode(db, factoryId) {
    const local = await db.get('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', [factoryId, 'data_mode']);
    const value = local?.value ?? (await db.get('SELECT value FROM settings WHERE `key`=?', ['data_mode']))?.value;
    if (!collectorAvailable() && value !== 'simulation') return 'external';
    return ['simulation', 'integrated_plc', 'external'].includes(value) ? value : 'simulation';
}
router.get('/status', async (req, res) => {
    try {
        const engine = global.dataEngine?.getStatus?.() || {};
        const factory = global.dataEngine?.getFactoryStatuses?.()?.[req.factoryId] || {};
        const health = collectorHealth(engine, { [req.factoryId]: factory }, { databaseReady: getDbStatus().connected === true });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ...health, pluginInstalled: collectorAvailable(), factoryId: req.factoryId, configuredMode: await configuredMode(await getDb(), req.factoryId) });
    } catch (error) { res.status(503).json({ error: '采集状态暂不可用' }); }
});
router.put('/mode', async (req, res) => {
    try {
        const body = req.body;
        if (!body || Object.keys(body).some(k => !['mode', 'expectedMode'].includes(k)) || !['simulation', 'integrated_plc', 'external'].includes(body.mode) || !['simulation', 'integrated_plc', 'external'].includes(body.expectedMode))
            return res.status(400).json({ error: '数据来源无效' });
        if (body.mode === 'integrated_plc' && !collectorAvailable()) return res.status(409).json({ error: '请先安装采集插件' });
        const db = await getDb();
        let changed = false;
        await db.transaction(async tx => {
            const current = await configuredMode(tx, req.factoryId);
            if (current !== body.expectedMode) throw Object.assign(new Error('数据来源已变更，请刷新后重试'), { statusCode: 409 });
            if (current === body.mode) return;
            changed = true;
            const row = await tx.get('SELECT 1 FROM factory_settings WHERE factory_id=? AND `key`=?', [req.factoryId, 'data_mode']);
            if (row) await tx.run('UPDATE factory_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE factory_id=? AND `key`=?', [body.mode, req.factoryId, 'data_mode']);
            else await tx.run('INSERT INTO factory_settings(factory_id, `key`, value) VALUES (?,?,?)', [req.factoryId, 'data_mode', body.mode]);
        });
        const observed = global.dataEngine?.getFactoryStatuses?.()?.[req.factoryId];
        let runtimeApplied = !changed && (observed?.mode === body.mode || observed?.collectorStatus?.status === 'stopped');
        try { if (!runtimeApplied && global.dataEngine?.setFactoryCollectionEnabled) { await global.dataEngine.setFactoryCollectionEnabled(req.factoryId); runtimeApplied = true; } }
        catch (error) { console.warn('[Collector] Factory source saved; worker not yet synchronized:', error.message); }
        if (changed) global.wsServer?.broadcast?.('configuration_changed', { factoryId: req.factoryId, keys: ['data_mode'], settings: { data_mode: body.mode }, timestamp: Date.now() });
        res.json({ success: true, mode: body.mode, runtimeApplied });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});
module.exports = router;
