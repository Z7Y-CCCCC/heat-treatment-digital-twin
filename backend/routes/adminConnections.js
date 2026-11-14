'use strict';
const { adminConnectionStatus } = require('../services/adminConnectionStatus');
const { getDb, getDbStatus } = require('../db/database');
const { resolveFactoryId } = require('../services/factoryContext');
const { getAdminAuth } = require('../services/adminAuth');
const { suppliedAdminSession } = require('../middleware/security');
const { apiPermission } = require('../../shared/apiPermissions.cjs');
const { collectorAvailable, runtimeIdentity } = require('../services/runtimeEngine');
const { siteRecoveryStatus } = require('../services/siteRecoveryIntent');

module.exports = function createAdminConnectionsRouter(dependencies = {}) {
    const router = require('express').Router();
    const deps = { getDb, getDbStatus, resolveFactoryId, getAdminAuth, collectorAvailable, runtimeIdentity,
        siteRecoveryStatus, getEngine: () => global.dataEngine, getWsServer: () => global.wsServer, now: Date.now, ...dependencies };
    router.get('/status', async (req, res) => {
        try {
            const auth = deps.getAdminAuth(), token = suppliedAdminSession(req);
            let sessionStatus;
            try { sessionStatus = auth.status(token); }
            catch { return res.status(503).json({ success: false, code: 'ADMIN_AUTH_ERROR', error: '登录状态检测失败' }); }
            let collectionAllowed = req.managementAutomationAuthorized === true;
            if (!collectionAllowed) {
                try { auth.requireSession(token, '', { checkCsrf: false, permission: apiPermission('/api/engine/status', 'GET') }); collectionAllowed = true; }
                catch (error) { if (error.statusCode !== 403) return res.status(error.statusCode || 503).json({ success: false, code: error.code || 'ADMIN_AUTH_ERROR', error: '登录状态检测失败' }); }
            }
            // A disconnected database cannot resolve the factory, but the
            // explicitly requested context must still be echoed. Otherwise the
            // client would reject the diagnostic as a cross-factory response
            // and hide the useful API-up/database-down state.
            const requestedFactoryId = String(req.get('x-factory-id') || req.query.factory_id || '').trim();
            let databaseConnected = false, factoryId = requestedFactoryId.slice(0, 128), configuredMode = null;
            try { databaseConnected = deps.getDbStatus().connected === true; } catch { /* report failed DB without initializing it */ }
            const pluginInstalled = deps.collectorAvailable();
            // Never call getDb when disconnected: a diagnostic must not reconnect,
            // initialize, change configuration, or suppress the DB failure summary.
            if (databaseConnected) {
                try {
                    const db = await deps.getDb();
                    try { factoryId = await deps.resolveFactoryId(db, requestedFactoryId); }
                    catch (error) { if (error.code !== 'FACTORY_CONTEXT_MISSING') throw error; factoryId = ''; }
                    if (collectionAllowed && factoryId) {
                        const local = await db.get('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', [factoryId, 'data_mode']);
                        const value = local?.value ?? (await db.get('SELECT value FROM settings WHERE `key`=?', ['data_mode']))?.value;
                        configuredMode = !pluginInstalled && value !== 'simulation' ? 'external'
                            : ['simulation', 'integrated_plc', 'external'].includes(value) ? value : 'simulation';
                    }
                } catch (error) {
                    if (error.code === 'FACTORY_CONTEXT_NOT_FOUND') return res.status(404).json({ success: false, code: error.code, error: '所选工厂不存在' });
                    databaseConnected = false;
                }
            }
            const engine = deps.getEngine();
            const status = adminConnectionStatus({ now: deps.now(), factoryId,
                factory: factoryId && collectionAllowed ? engine?.getFactoryStatuses?.()?.[factoryId] || null : null,
                engine: collectionAllowed ? engine?.getStatus?.() || {} : {}, configuredMode, pluginInstalled, databaseConnected,
                recoveryPending: deps.siteRecoveryStatus().pending === true, unityHealth: deps.getWsServer()?.connectionHealth?.('unity', deps.now()) || {},
                runtime: deps.runtimeIdentity(), sessionStatus, automationAuthorized: req.managementAutomationAuthorized === true, collectionAllowed });
            res.setHeader('Cache-Control', 'no-store');
            res.json(status);
        } catch {
            res.status(503).json({ success: false, code: 'CONNECTION_STATUS_UNAVAILABLE', error: '服务连接状态检测失败' });
        }
    });
    return router;
};
