'use strict';
const router = require('express').Router(), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const multer = require('multer'), { getDb } = require('../db/database');
const { configurationMutation } = require('../services/configurationSync');
const { createOperationRateLimiter } = require('../middleware/security');
const bundle = require('../services/modelAssetBundle');
const { assertModelPublishPermission } = require('../services/modelPublicationPermission');
const temp = path.join(os.tmpdir(), 'digital-twin-model-assets'); fs.mkdirSync(temp, { recursive: true });
const upload = multer({ dest: temp, limits: { fileSize: bundle.MAX_BYTES, files: 1, fields: 1, fieldSize: 128 } });
// This router shares /api/models with ordinary model editing routes. Apply the
// asset-transfer budget only to its own endpoints, never to fall-through reads
// or inspection saves handled by the model library router.
const assetTransferLimit = createOperationRateLimiter({ name: 'model-asset-bundle', limit: 20 });
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
            if (error) throw new Error(error.code === 'LIMIT_FILE_SIZE' ? '模型动作包超过 184 MB' : '模型动作包上传失败');
            if (!req.file) throw new Error('请选择模型资产 ZIP');
            const result = operation === 'inspect' ? await bundle.inspectAsset(req.file.path)
                : await bundle.importAsset(await getDb(), req.file.path, req.factoryId, req.body.inspectedSha256, metadata => assertModelPublishPermission(req, {}, metadata));
            res.status(operation === 'import' ? 201 : 200).json({ success: true, ...result });
        } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message }); }
        finally { if (req.file) fs.rmSync(req.file.path, { force: true }); }
    });
});
module.exports = router;
