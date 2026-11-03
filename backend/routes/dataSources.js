const express = require('express');
const multer = require('multer');
const { importDataFile } = require('../services/dataSourceTransports');
const { getDb } = require('../db/database');
const { isLoopbackAddress } = require('../middleware/security');
const {
    getProjectAndScene,
    loadPublishedDocument
} = require('../services/dashboardDocuments');
const {
    createConnectionBackup,
    deleteDataSource,
    getBackupStatus,
    listColumns,
    listDataSources,
    listTables,
    previewBinding,
    inspectHttpApiResponse,
    readHttpApiBinding,
    readRuntimeBindings,
    runSelectedBackups,
    saveBackupConfig,
    saveDataSource,
    testDataSource
} = require('../services/dataSources');

const router = express.Router();
const dataSets = require('../services/dataSets');
const { resolveParameters, datasetParameterDefinitions } = require('../../shared/dashboardParameters.mjs');
const dataFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1048576, files: 1, fields: 0 } }).single('dataFile');
const MAP_LEVELS = new Set(['world', 'country', 'province', 'city', 'district']);
const MAP_DATA_KEYS = new Set(['factsFactoryCount','factsLocalCount','factsDeviceCount','panelRegionRows','dockFactoryCount','dockLocalCount','dockAssignedCount','dockCoverage','dockWorkshops','dockLines','dockDevices']);

function localOnly(req, res, next) {
    if (isLoopbackAddress(req.socket.remoteAddress)) {
        next();
        return;
    }
    res.status(403).json({ success: false, error: '外部数据源、数据库结构与连接配置仅允许在现场电脑本机查看' });
}

function handleError(res, error, status = 400) {
    res.status(status).json({ success: false, error: error.message || String(error) });
}

router.get('/map-values', async (req, res) => {
    try {
        const level = String(req.query.level || 'world');
        if (!MAP_LEVELS.has(level)) return handleError(res, new Error('地图层级无效'));
        const db = await getDb();
        const row = await db.get('SELECT value FROM settings WHERE `key` = ?', ['group_portal_config']);
        let config = {};
        try { config = JSON.parse(row?.value || '{}'); } catch { /* Old configuration falls back to built-in data. */ }
        const bindings = config.levels?.[level]?.dataBindings || {};
        const widgets = Object.entries(bindings)
            .filter(([key, binding]) => MAP_DATA_KEYS.has(key) && binding?.mode === 'http_api')
            .map(([id, data]) => ({ id, data }));
        const values = {};
        const byFactory = new Map();
        for (const widget of widgets) {
            const factoryId = widget.data.factoryId || req.factoryId;
            if (!byFactory.has(factoryId)) byFactory.set(factoryId, []);
            byFactory.get(factoryId).push(widget);
        }
        await Promise.all([...byFactory].map(async ([factoryId, scopedWidgets]) => {
            Object.assign(values, await readRuntimeBindings(scopedWidgets, { factoryId }));
        }));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ success: true, level, values, timestamp: new Date().toISOString() });
    } catch (error) { handleError(res, error, 500); }
});

router.get('/runtime-values', async (req, res) => {
    try {
        const db = await getDb();
        const { project, scene } = await getProjectAndScene(db, String(req.query.scene_id || ''), req.factoryId);
        const { document, release } = await loadPublishedDocument(db, project, scene);
        let suppliedParameters = {};
        if (req.query.parameters) {
            if (typeof req.query.parameters !== 'string' || req.query.parameters.length > 8192) return res.status(400).json({error:'大屏参数过长'});
            try { suppliedParameters = JSON.parse(req.query.parameters); } catch { return res.status(400).json({error:'大屏参数格式无效'}); }
        }
        let parameters;
        try { parameters=resolveParameters(document.parameters || [],suppliedParameters); } catch(error) { return res.status(400).json({error:error.message}); }
        const viewId = String(req.query.view_id || '');
        const mapSurface = /^(?:map_(?:world|country|province|city|district)|site_(?:street|factory))$/.test(viewId);
        const mapView = mapSurface ? document.scene?.views?.find(view => view.id === viewId) : null;
        const boundWidgets = mapSurface
            ? (mapView ? (document.widgets || []).filter(widget => {
                const shown = mapView.componentState?.show || [];
                const hidden = mapView.componentState?.hide || [];
                const group = widget.groupId ? `group:${widget.groupId}` : '';
                return (shown.includes(widget.id) || (group && shown.includes(group)))
                    && !hidden.includes(widget.id) && !(group && hidden.includes(group));
            }) : [])
            : (document.widgets || []);
        let targets=boundWidgets;
        if(req.query.widget_ids){const ids=String(req.query.widget_ids).split(',');if(ids.length>20 || ids.some(id=>!(/^[\w-]{1,128}$/).test(id)))return res.status(400).json({error:'组件请求无效'});targets=targets.filter(w=>ids.includes(w.id));}
        const playbackAt=Number(req.query.playback_at || Date.now());
        if(!Number.isFinite(playbackAt) || Math.abs(playbackAt-Date.now())>60000)return res.status(400).json({error:'刷新时间无效'});
        const devices=await require('../services/widgetPlayback').playbackDevices(db,req.factoryId);
        const values = await readRuntimeBindings(targets, {
            playbackDevices:devices,playbackAt,viewMode:document.scene?.views?.find(v=>v.id===viewId)?.mode || '',
            factoryId: req.factoryId,
            parameters,
            viewId,
            workshopId: String(req.query.workshop_id || ''),
            lineId: String(req.query.line_id || ''),
            deviceId: String(req.query.device_id || ''),
            partId: String(req.query.part_id || '')
        });
        res.json({
            success: true,
            releaseId: release?.id || null,
            sceneId: document.sceneId,
            values,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        handleError(res, error, 500);
    }
});

router.get('/', localOnly, (req, res) => {
    try { res.json({ success: true, ...listDataSources(), backupStatus: getBackupStatus() }); }
    catch (error) { handleError(res, error, 500); }
});

router.get('/datasets', localOnly, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ success: true, datasets: await dataSets.listDataSets(req.factoryId) }); }
    catch (error) { handleError(res, error, error.status || 400); }
});
router.post('/datasets/preview', localOnly, async (req, res) => {
    try {
        // A saved definition may be previewed by a designer; arbitrary new
        // definitions require the same authority as editing the source page.
        let definition;
        if (req.body.datasetId) definition = (await dataSets.listDataSets(req.factoryId)).find(d => d.id === req.body.datasetId);
        else definition = req.body.definition;
        if (!definition) throw new Error('请选择数据集');
        const context = Object.fromEntries(dataSets.CONTEXT_KEYS.map(key => [key, String(req.body.context?.[key] ?? '').slice(0, 200)]));
        const supplied=req.body.context?.parameters ?? {};
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).length>32) throw new Error('参数值必须是键值对象');
        const used=datasetParameterDefinitions(definition);
        context.parameters=resolveParameters(used,Object.fromEntries(used.filter(p=>Object.hasOwn(supplied,p.key)).map(p=>[p.key,supplied[p.key]])));
        const result = await dataSets.readDefinition(definition, context, req.factoryId, true, req.body.inspect === true);
        res.json({ success: true, result: req.body.binding ? dataSets.bindingResult(result, req.body.binding) : result });
    } catch (error) { handleError(res, error, error.status || 400); }
});
router.post('/datasets', localOnly, async (req, res) => {
    try { res.json({ success: true, dataset: await dataSets.saveDataSet(req.body, req.factoryId) }); }
    catch (error) { handleError(res, error, error.status || 400); }
});
router.delete('/datasets/:id', localOnly, async (req, res) => {
    try { await dataSets.deleteDataSet(req.params.id, req.body?.revision, req.factoryId); res.json({ success: true }); }
    catch (error) { handleError(res, error, error.status || 400); }
});

router.post('/files', localOnly, (req, res) => {
    dataFileUpload(req, res, async error => {
        if (error) return res.status(400).json({ error: '请选择 1 MB 以内的 CSV / JSON / XLSX 文件' });
        try { res.json({ success: true, file: await importDataFile(req.file?.buffer, req.file?.originalname, req.factoryId) }); }
        catch (error) { handleError(res, error); }
    });
});

router.post('/test', localOnly, async (req, res) => {
    try { res.json(await testDataSource(req.body || {})); }
    catch (error) { handleError(res, error); }
});

router.post('/connections', localOnly, (req, res) => {
    try { res.json({ success: true, connection: saveDataSource(req.body || {}), ...listDataSources() }); }
    catch (error) { handleError(res, error); }
});

router.put('/connections/:id', localOnly, (req, res) => {
    try {
        const connection = saveDataSource({ ...(req.body || {}), id: req.params.id });
        res.json({ success: true, connection, ...listDataSources() });
    } catch (error) { handleError(res, error); }
});

router.delete('/connections/:id', localOnly, (req, res) => {
    try { res.json({ ...deleteDataSource(req.params.id), ...listDataSources() }); }
    catch (error) { handleError(res, error); }
});

router.get('/connections/:id/tables', localOnly, async (req, res) => {
    try { res.json({ success: true, tables: await listTables(req.params.id) }); }
    catch (error) { handleError(res, error); }
});

router.get('/connections/:id/columns', localOnly, async (req, res) => {
    try {
        res.json({
            success: true,
            columns: await listColumns(req.params.id, String(req.query.schema || ''), String(req.query.table || ''))
        });
    } catch (error) { handleError(res, error); }
});

router.post('/preview', localOnly, async (req, res) => {
    try { res.json({ success: true, result: await previewBinding(req.body || {}) }); }
    catch (error) { handleError(res, error); }
});

router.post('/preview-http', localOnly, async (req, res) => {
    try {
        const source=req.body || {};
        const result=source.context ? (await readRuntimeBindings([{id:'preview',data:{...source,mode:'http_api'}}],{...source.context,factoryId:req.factoryId})).preview : await readHttpApiBinding(source,req.factoryId);
        res.json({success:true,result});
    }
    catch (error) { handleError(res, error); }
});

router.post('/inspect-http', localOnly, async (req, res) => {
    try { res.json({ success: true, result: await inspectHttpApiResponse(req.body || {}, req.factoryId) }); }
    catch (error) { handleError(res, error); }
});

router.get('/backups/status', localOnly, (req, res) => {
    try { res.json({ success: true, status: getBackupStatus() }); }
    catch (error) { handleError(res, error, 500); }
});

router.put('/backups/config', localOnly, (req, res) => {
    try { res.json({ success: true, config: saveBackupConfig(req.body || {}), status: getBackupStatus() }); }
    catch (error) { handleError(res, error); }
});

router.post('/backups/run', localOnly, async (req, res) => {
    try {
        const connectionId = String(req.body?.connectionId || '');
        const results = connectionId
            ? [{ success: true, backup: await createConnectionBackup(connectionId, 'manual') }]
            : await runSelectedBackups('manual');
        res.json({ success: results.every(item => item.success), results, status: getBackupStatus() });
    } catch (error) { handleError(res, error); }
});

module.exports = router;
