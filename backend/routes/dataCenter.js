const express = require('express');
const center = require('../services/dataCenter');
const { getAdminAuth } = require('../services/adminAuth');
const { suppliedAdminSession } = require('../middleware/security');
const { apiPermission } = require('../../shared/apiPermissions.cjs');
const router = express.Router();
const fail = (res, e) => res.status(e.status || e.statusCode || 500).json({ success: false, ...(e.code ? { code: e.code } : {}), error: e.message || '数据中心操作失败' });
router.get('/catalog', async (req, res) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await center.buildCatalog(req.factoryId, String(req.query.device_id || '').trim(), null, String(req.query.preview_device_id || '').trim())); }
    catch (e) { fail(res, e); }
});
router.get('/tables/:id/records', async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const authorizeExternal = () => {
            if (req.managementAutomationAuthorized) return;
            getAdminAuth().requireSession(suppliedAdminSession(req), null, { checkCsrf: false, permission: apiPermission('/api/data-sources/datasets', 'GET') });
        };
        res.json(await require('../services/dataCenterBrowse').browseTable(req.factoryId, req.params.id, req.query, { authorizeExternal }));
    }
    catch (e) { fail(res, e); }
});
router.put('/categories', async (req, res) => {
    try { res.json(await center.saveCategory(req.body, req.factoryId)); } catch (e) { fail(res, e); }
});
router.delete('/categories/:id', async (req, res) => {
    try { res.json(await center.deleteCategory(req.params.id, req.body?.revision, req.factoryId)); } catch (e) { fail(res, e); }
});
router.put('/items/:id', async (req, res) => {
    try { res.json(await center.saveItem(req.params.id, req.body, req.factoryId)); } catch (e) { fail(res, e); }
});
module.exports = router;
