// Bootstrap can only install a vendor-signed, machine-bound license on loopback.
// It never authenticates a user or grants access to business/configuration APIs.
const express = require('express');
const crypto = require('node:crypto');
const { getLicenseStatus, installLicense } = require('../services/license');
const { decodeActivationCode } = require('../../shared/activationCode.cjs');
module.exports = function activationRouter() {
    const router = express.Router(), token = crypto.randomBytes(32).toString('hex');
    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const remote = String(req.socket.remoteAddress || '');
        const host = String(req.get('host') || '');
        let origin;
        try { origin = new URL(`http://${host}`); } catch { }
        const local = origin && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
            && /^(?:127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+|::1)$/.test(remote);
        if (!local || (req.get('origin') && req.get('origin') !== origin.origin)
            || req.get('sec-fetch-site') === 'cross-site')
            return res.status(403).json({ success: false, error: '请在本机大屏程序中激活' });
        next();
    });
    router.get('/', (req, res) => {
        const status = getLicenseStatus();
        res.json({ success: true, required: status.enforce && !status.valid, valid: status.valid,
            machineId: status.activationMachineId || null, publicKeyConfigured: status.publicKeyConfigured,
            reason: status.reason, token: !status.valid ? token : null });
    });
    router.post('/', express.json({ limit: '20kb', strict: true }), (req, res) => {
        if (req.get('x-activation-token') !== token) return res.status(403).json({ success: false, error: '激活会话已失效，请重试' });
        if (getLicenseStatus().valid) return res.status(409).json({ success: false, error: '本机已激活，请在后台更新授权' });
        try {
            // Do not accept arbitrary JSON fields/history through this bootstrap.
            if (typeof req.body?.activationCode !== 'string') throw new Error('请粘贴激活码');
            const document = decodeActivationCode(req.body.activationCode);
            if (document.payload?.bindingVersion !== 2 || !document.payload.machineId
                || document.payload.machineId !== getLicenseStatus().activationMachineId)
                throw new Error('激活码未授权这台电脑，请将本机指纹发给厂商重新签发');
            const status = installLicense(document);
            // Initial collection was held at boot. Do not restart a running
            // collector on renewal; start() is idempotent and owns recovery.
            Promise.resolve().then(() => global.dataEngine?.start?.()).catch(error => console.error('[Activation] 采集启动失败:', error.message));
            res.json({ success: true, valid: status.valid });
        } catch (error) { res.status(400).json({ success: false, error: error.message }); }
    });
    return router;
};
