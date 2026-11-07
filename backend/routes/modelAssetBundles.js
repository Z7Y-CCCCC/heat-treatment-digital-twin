'use strict';
const router = require('express').Router(), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const multer = require('multer'), { getDb } = require('../db/database');
const { configurationMutation } = require('../services/configurationSync');
const { createOperationRateLimiter } = require('../middleware/security');
const bundle = require('../services/modelAssetBundle');
const collection = require('../services/modelAssetCollection');
const { assertModelPublishPermission } = require('../services/modelPublicationPermission');
const temp = path.join(os.tmpdir(), 'digital-twin-model-assets'); fs.mkdirSync(temp, { recursive: true });
const upload = multer({ dest: temp, limits: { fileSize: collection.MAX_BYTES, files: 1, fields: 2, fieldSize: 32768 } });
// This router shares /api/models with ordinary model editing routes. Apply the
// asset-transfer budget only to its own endpoints, never to fall-through reads
// or inspection saves handled by the model library router.
// One bounded UI batch can inspect/import/export 32 files sequentially. Keep a
// rate budget, without rejecting the second half of a normal user selection.
const assetTransferLimit = createOperationRateLimiter({ name: 'model-asset-bundle', limit: 120, windowMs: 60 * 1000 });
router.post('/asset-export', assetTransferLimit, async (req, res) => {
    const file = path.join(temp, crypto.randomUUID() + '.zip'), cleanup = () => fs.rmSync(file, { force: true });
    res.once('close', cleanup);
    try {
        await collection.exportCollection(await getDb(), req.body.modelIds, req.factoryId, file);
        if (res.destroyed) { cleanup(); return; }
        res.download(file, 'motion-packages.zip', cleanup);
    } catch (error) { cleanup(); if (!res.destroyed) res.status(error.statusCode || 400).json({ error: error.message }); }
});
router.get('/:id/asset-export', assetTransferLimit, async (req, res) => {
    const file = path.join(temp, crypto.randomUUID() + '.zip');
    try {
        await bundle.exportAsset(await getDb(), req.params.id, req.factoryId, file);
        res.download(file, 'model-asset-' + req.params.id + '.zip', () => fs.rmSync(file, { force: true }));
    } catch (error) { fs.rmSync(file, { force: true }); res.status(error.statusCode || 400).json({ error: error.message }); }
});
for (const operation of ['inspect', 'import']) router.post('/asset-' + operation, assetTransferLimit, ...(operation === 'import' ? [configurationMutation('models')] : []), (req, res) => {
    upload.single('file')(req, res, async error => {
        try {
            if (error) throw new Error(error.code === 'LIMIT_FILE_SIZE' ? '动作包超过 512 MB' : '模型动作包上传失败');
            if (!req.file) throw new Error('请选择模型资产 ZIP');
            const db = await getDb();
            const plan = req.body.importPlan ? JSON.parse(req.body.importPlan) : null;
            const result = operation === 'inspect' ? await collection.inspectPackage(req.file.path, db, req.factoryId)
                : await collection.importPackage(db, req.file.path, req.factoryId, req.body.inspectedSha256, metadata => assertModelPublishPermission(req, {}, metadata), req.get('x-asset-request-id') || '', plan);
            if (operation === 'import') {
                const outcomes = result.outcomes || [{ id: result.model.id, outcome: result.outcome }];
                const updatedIds = new Set(outcomes.filter(item => item.outcome === 'update_actions').map(item => item.id));
                const updated = (result.models || [result.model]).filter(model => updatedIds.has(model.id));
                if (updated.length) res.once('finish', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) return;
                    for (const model of updated) global.wsServer?.broadcastToRole?.('model_metadata_changed', { modelId: model.id, timestamp: Date.now() }, 'unity');
                    // Shared model changes affect already-open screens in other
                    // factories too; a factory-local invalidation is insufficient.
                    if (updated.some(model => model.factory_id == null)) global.wsServer?.broadcast?.('configuration_changed', { resource: 'models', reloadRequired: true, timestamp: Date.now() });
                });
            }
            res.status(operation === 'import' ? 201 : 200).json({ success: true, ...result });
        } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message, ...(e.code ? { code: e.code } : {}) }); }
        finally { if (req.file) fs.rmSync(req.file.path, { force: true }); }
    });
});
module.exports = router;
