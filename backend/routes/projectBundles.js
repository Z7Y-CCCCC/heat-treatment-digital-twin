const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const crypto = require('crypto');
const { factoryContext } = require('../services/factoryContext');
const { createOperationRateLimiter } = require('../middleware/security');
const { exportBundle, inspectBundle, importBundle, MAX_BYTES } = require('../services/projectBundle');

module.exports = function projectBundles(options = {}) {
    const router = express.Router();
    const temporary = path.join(os.tmpdir(), 'digital-twin-project-bundles');
    fs.mkdirSync(temporary, { recursive: true });
    const upload = multer({ dest: temporary, limits: { fileSize: MAX_BYTES + 16 * 1024 * 1024, files: 1, fields: 3, fieldSize: 1024 } });
    router.use(createOperationRateLimiter({ name: 'project-bundle', limit: 20 }));
    let busy = false;
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (busy) return res.status(409).json({ success: false, error: '正在处理项目迁移，请完成后重试' });
        next();
    });
    router.get('/export', factoryContext, async (req, res) => {
        busy = true;
        const filename = path.join(temporary, `${crypto.randomUUID()}.zip`);
        try {
            await exportBundle(req.factoryId, filename, options);
            res.download(filename, `factory-project-${req.factoryId}.zip`, () => { fs.rmSync(filename, { force: true }); busy = false; });
        } catch (error) {
            fs.rmSync(filename, { force: true }); busy = false;
            res.status(400).json({ success: false, error: error.message });
        }
    });
    for (const operation of ['inspect', 'import']) router.post(`/${operation}`, (req, res) => {
        busy = true;
        upload.single('file')(req, res, async uploadError => {
            try {
                if (uploadError) throw new Error(uploadError.code === 'LIMIT_FILE_SIZE' ? '迁移 ZIP 超过大小限制' : '迁移文件上传失败');
                if (!req.file) throw new Error('请选择项目迁移 ZIP');
                const result = operation === 'inspect'
                    ? await inspectBundle(req.file.path)
                    : await importBundle(req.file.path, req.body, options);
                const { sharedAppearanceSettings, ...publicResult } = result;
                if (result.appliedSharedAppearance) {
                    // Shared appearance affects every factory; omitting factoryId
                    // prevents subscribers from discarding this global update.
                    try { global.wsServer?.broadcast('configuration_changed', { keys: Object.keys(sharedAppearanceSettings), settings: sharedAppearanceSettings, timestamp: Date.now() }); }
                    catch (error) { console.warn('[ProjectBundle] 配置已保存，运行端通知失败:', error.message); }
                }
                res.status(operation === 'import' ? 201 : 200).json({ success: true, ...publicResult });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            } finally {
                if (req.file) fs.rmSync(req.file.path, { force: true });
                busy = false;
            }
        });
    });
    return router;
};
