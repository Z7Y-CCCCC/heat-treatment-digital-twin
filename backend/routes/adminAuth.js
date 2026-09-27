const express = require('express');
const { getAdminAuth } = require('../services/adminAuth');
const DISPLAY_COOKIE_MS = 30 * 24 * 60 * 60 * 1000;
const {
    activeAdminAccountSlot,
    adminAccountCookieName,
    adminActiveAccountCookieName,
    adminSessionCookieName,
    adminWebSocketCookieName,
    isLoopbackAddress,
    isTrustedAdminOrigin,
    suppliedAdminAccounts,
    suppliedAdminSession,
    suppliedAdminSessionForSlot
} = require('../middleware/security');

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

    // The dashboard socket is served at /ws, outside the /api cookie path.
    // Mirror only the currently active session token to that narrow path so
    // authenticated browser views can receive Unity scene acknowledgements.
    function socketCookieOptions(req) {
        return { ...cookieOptions(req), path: '/ws' };
    }

    function syncSocketCookie(req, res, token, status) {
        if (token && status?.displayAuthenticated && status.permissions?.view === true)
            res.cookie(adminWebSocketCookieName(), token, { ...socketCookieOptions(req), maxAge: DISPLAY_COOKIE_MS });
        else res.clearCookie(adminWebSocketCookieName(), socketCookieOptions(req));
    }

    function sendSession(req, res, result, slotId = 'main') {
        const options = { ...cookieOptions(req), maxAge: DISPLAY_COOKIE_MS };
        const sessionCookie = slotId === 'main' ? adminSessionCookieName() : adminAccountCookieName(slotId);
        res.cookie(sessionCookie, result.token, options);
        syncSocketCookie(req, res, result.token, result.status);
        if (slotId === 'main') res.clearCookie(adminActiveAccountCookieName(), cookieOptions(req));
        else res.cookie(adminActiveAccountCookieName(), slotId, options);
        res.json({ ...result.status, accountSlotId: slotId });
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

    router.get('/session', handle((req, res, service) => {
        const token = suppliedAdminSession(req), status = service.status(token);
        syncSocketCookie(req, res, token, status);
        res.json({ ...status, accountSlotId: activeAdminAccountSlot(req) });
    }));
    router.get('/accounts', handle((req, res, service) => res.json({
        success: true,
        activeSlotId: activeAdminAccountSlot(req),
        accounts: suppliedAdminAccounts(req, service)
    })));
    router.post('/accounts/login', handle(async (req, res, service) => {
        const slotId = String(req.body?.slotId || '');
        if (!adminAccountCookieName(slotId)) {
            res.status(400).json({ success: false, code: 'ADMIN_ACCOUNT_SLOT_INVALID', error: '账户会话标识无效' });
            return;
        }
        if (suppliedAdminAccounts(req, service).length >= 8) {
            res.status(409).json({ success: false, code: 'ADMIN_ACCOUNT_LIMIT', error: '本机最多保留 8 个已登录账户' });
            return;
        }
        if (suppliedAdminSessionForSlot(req, slotId)) {
            res.status(409).json({ success: false, code: 'ADMIN_ACCOUNT_SLOT_EXISTS', error: '该账户切换位置已被占用，请重试' });
            return;
        }
        const result = await service.login(req.body?.password, req.socket.remoteAddress, '', req.body?.username);
        sendSession(req, res, result, slotId);
    }));
    router.post('/accounts/activate', handle((req, res, service) => {
        const slotId = String(req.body?.slotId || '');
        if (slotId !== 'main' && !adminAccountCookieName(slotId)) {
            res.status(400).json({ success: false, code: 'ADMIN_ACCOUNT_SLOT_INVALID', error: '账户会话标识无效' });
            return;
        }
        const token = suppliedAdminSessionForSlot(req, slotId);
        service.requireSession(token, req.get('x-csrf-token'));
        const options = { ...cookieOptions(req), maxAge: DISPLAY_COOKIE_MS };
        res.cookie(adminActiveAccountCookieName(), slotId, options);
        const status = service.status(token);
        syncSocketCookie(req, res, token, status);
        res.json({ ...status, accountSlotId: slotId });
    }));
    router.post('/accounts/logout', handle((req, res, service) => {
        const slotId = activeAdminAccountSlot(req);
        if (slotId === 'none') {
            res.status(401).json({ success: false, code: 'ADMIN_AUTH_REQUIRED', error: '当前没有已登录账户' });
            return;
        }
        const token = suppliedAdminSession(req);
        service.logout(token, req.get('x-csrf-token'));
        const sessionCookie = slotId === 'main' ? adminSessionCookieName() : adminAccountCookieName(slotId);
        res.clearCookie(sessionCookie, cookieOptions(req));
        syncSocketCookie(req, res, '', null);
        res.cookie(adminActiveAccountCookieName(), 'none', { ...cookieOptions(req), maxAge: DISPLAY_COOKIE_MS });
        res.json({ ...service.status(''), accountSlotId: 'none' });
    }));
    router.post('/native-ticket', handle((req, res, service) => {
        res.json({ success: true, ...service.createNativeTicket(suppliedAdminSession(req), req.get('x-csrf-token')) });
    }));
    router.post('/native-exchange', handle((req, res, service) => {
        sendSession(req, res, service.exchangeNativeTicket(req.body?.ticket));
    }));
    router.post('/setup', handle(async (req, res, service) => {
        const result = await service.setup(req.body?.password, req.socket.remoteAddress, suppliedAdminSessionForSlot(req, 'main'));
        sendSession(req, res, result);
    }));
    router.post('/login', handle(async (req, res, service) => {
        const result = await service.login(req.body?.password, req.socket.remoteAddress, suppliedAdminSessionForSlot(req, 'main'), req.body?.username);
        sendSession(req, res, result);
    }));
    router.post('/touch', handle((req, res, service) => {
        res.json(service.touch(suppliedAdminSession(req), req.get('x-csrf-token')));
    }));
    router.post('/lock', handle((req, res, service) => {
        const token = suppliedAdminSession(req);
        const result = service.lock(token, req.get('x-csrf-token'));
        syncSocketCookie(req, res, token, result);
        res.json({ ...result, accountSlotId: activeAdminAccountSlot(req) });
    }));
    router.put('/settings', handle((req, res, service) => {
        res.json(service.updateSettings(suppliedAdminSession(req), req.get('x-csrf-token'), req.body?.idleTimeoutMinutes));
    }));
    router.put('/password', handle(async (req, res, service) => {
        const slotId = activeAdminAccountSlot(req);
        const current = service.status(suppliedAdminSession(req));
        const accountSessions = suppliedAdminAccounts(req, service);
        const result = await service.changePassword(suppliedAdminSession(req), req.get('x-csrf-token'),
            req.body?.currentPassword, req.body?.newPassword, req.socket.remoteAddress);
        if (current.user?.role === 'owner') {
            for (const account of accountSessions) {
                const name = account.slotId === 'main' ? adminSessionCookieName() : adminAccountCookieName(account.slotId);
                res.clearCookie(name, cookieOptions(req));
            }
            sendSession(req, res, result);
        } else sendSession(req, res, result, slotId);
    }));
    router.get('/users', handle((req, res, service) => {
        res.json({ success: true, users: service.listUsers(suppliedAdminSession(req), req.get('x-csrf-token')) });
    }));
    router.post('/users', handle(async (req, res, service) => {
        res.status(201).json({ success: true, user: await service.createUser(suppliedAdminSession(req), req.get('x-csrf-token'), req.body) });
    }));
    router.put('/users/:id', handle(async (req, res, service) => {
        res.json({ success: true, user: await service.updateUser(suppliedAdminSession(req), req.get('x-csrf-token'), req.params.id, req.body) });
    }));
    router.delete('/users/:id', handle((req, res, service) => {
        res.json(service.deleteUser(suppliedAdminSession(req), req.get('x-csrf-token'), req.params.id));
    }));

    return router;
};
