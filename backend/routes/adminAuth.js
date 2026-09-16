const express = require('express');
const { getAdminAuth, MAX_SESSION_MS } = require('../services/adminAuth');
const { isLoopbackAddress, isTrustedAdminOrigin, adminSessionCookieName, suppliedAdminSession } = require('../middleware/security');

module.exports = function createAdminAuthRouter(auth = getAdminAuth) {
    const router = express.Router();

    router.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
            res.status(403).json({ success: false, error: '请在现场电脑本机解锁和管理后台安全设置' });
            return;
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
            && (req.get('x-admin-request') !== '1' || !isTrustedAdminOrigin(req))) {
            res.status(403).json({ success: false, code: 'ADMIN_ORIGIN_INVALID', error: '拒绝跨站后台安全请求' });
            return;
        }
        next();
    });

    function cookieOptions(req) {
        return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/api' };
    }

    function sendSession(req, res, result) {
        res.cookie(adminSessionCookieName(), result.token, { ...cookieOptions(req), maxAge: MAX_SESSION_MS });
        res.json(result.status);
    }

    function handle(action) {
        return async (req, res) => {
            try { await action(req, res, auth()); }
            catch (error) {
                if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
                res.status(error.statusCode || 500).json({
                    success: false,
                    code: error.code || 'ADMIN_AUTH_ERROR',
                    error: error.statusCode ? error.message : '后台安全服务暂不可用，请稍后重试',
                    ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {})
                });
            }
        };
    }

    router.get('/session', handle((req, res, service) => res.json(service.status(suppliedAdminSession(req)))));
    router.post('/setup', handle(async (req, res, service) => {
        const result = await service.setup(req.body?.password, req.socket.remoteAddress, suppliedAdminSession(req));
        sendSession(req, res, result);
    }));
    router.post('/login', handle(async (req, res, service) => {
        const result = await service.login(req.body?.password, req.socket.remoteAddress, suppliedAdminSession(req));
        sendSession(req, res, result);
    }));
    router.post('/touch', handle((req, res, service) => {
        res.json(service.touch(suppliedAdminSession(req), req.get('x-csrf-token')));
    }));
    router.post('/lock', handle((req, res, service) => {
        const result = service.lock(suppliedAdminSession(req), req.get('x-csrf-token'));
        res.clearCookie(adminSessionCookieName(), cookieOptions(req));
        res.json(result);
    }));
    router.put('/settings', handle((req, res, service) => {
        res.json(service.updateSettings(suppliedAdminSession(req), req.get('x-csrf-token'), req.body?.idleTimeoutMinutes));
    }));
    router.put('/password', handle(async (req, res, service) => {
        const result = await service.changePassword(suppliedAdminSession(req), req.get('x-csrf-token'),
            req.body?.currentPassword, req.body?.newPassword, req.socket.remoteAddress);
        sendSession(req, res, result);
    }));

    return router;
};
