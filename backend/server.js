const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const crypto = require('crypto');
const { validateUploadedModelFile, modelScale } = require('./utils/modelUploadValidation');
const {
    createCorsMiddleware,
    createOperationRateLimiter,
    adminSessionCookieName,
    isLoopbackAddress,
    isTrustedAdminOrigin,
    protectManagementWrites,
    securityHeaders
} = require('./middleware/security');
const { getAdminAuth } = require('./services/adminAuth');
const {
    getDb,
    closeDb,
    getDbStatus,
    reconnectDb,
    createDatabaseBackup,
    restoreDatabaseBackup,
    deleteDatabaseBackup,
    getDatabaseBackupStatus,
    saveDatabaseBackupPolicy,
    resolveDatabaseBackupPath,
    startDatabaseMaintenance,
    stopDatabaseMaintenance,
    loadDatabaseConfig,
    publicDatabaseConfig,
    saveDatabaseConfig,
    testDatabaseConfig
} = require('./db/database');
const { getBuiltinModels, mergeBuiltinModels } = require('./services/builtinModels');
const { stringifyModelMetadata } = require('./services/modelAssetMetadata');
const { getInspectionPresets } = require('./services/inspectionPresets');
const { publicProtocolDefinitions } = require('./services/plcProtocolConfig');
const {
    createSiteBackup,
    restoreSiteBackup,
    getSiteBackupStatus,
    loadSiteBackupConfig,
    saveSiteBackupConfig,
    startSiteBackupMaintenance,
    stopSiteBackupMaintenance,
    resolveSiteBackupPath,
    SITE_IMPORT_DIR
} = require('./services/siteBackup');
const {
    startDataSourceMaintenance,
    stopDataSourceMaintenance
} = require('./services/dataSources');
const { loadReleaseManifest } = require('./services/releaseManifest');
const { getLicenseStatus, isLicenseEnforced } = require('./services/license');
const { factoryContext } = require('./services/factoryContext');

const app = express();
let databaseOperationBusy = false;
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';

const uploadsRootDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, 'uploads');
const uploadsDir = path.join(uploadsRootDir, 'models');
const audioUploadsDir = path.join(uploadsRootDir, 'audio');
const assetsDir = path.join(__dirname, 'assets');
const assetModelsDir = path.join(assetsDir, 'models');
// Keep the standalone `node server.js` development entry point consistent
// with the packaged desktop launcher.  The desktop launcher supplies
// FRONTEND_DIST explicitly, but a native Unity/WebView host may start this
// server directly; in that case the sibling frontend build is still the
// authoritative UI instead of leaving /admin and /overlay as 404s.
const frontendDistDir = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : path.resolve(__dirname, '..', 'frontend', 'dist');
const deprecatedDashboardPage = path.join(__dirname, 'deprecated-dashboard.html');

for (const dir of [uploadsDir, audioUploadsDir, assetModelsDir]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

app.use(securityHeaders);
if (process.env.ENABLE_CORS !== 'false') app.use(createCorsMiddleware());
// Authentication has its own local-only, CSRF and password-attempt checks.
// Mount it before write protection so a locked engineer can still sign in.
app.use('/api/admin-auth', express.json({ limit: '2kb', strict: true }), require('./routes/adminAuth')(), (error, req, res, next) => {
    // Parser errors can contain fragments of the password body. Do not echo or
    // log them through the generic HTTP error handler.
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({
        success: false, code: 'ADMIN_INVALID_REQUEST', error: '后台安全请求格式不正确或内容过长，请重试'
    });
});
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb', strict: true }));
app.use(protectManagementWrites);
app.use((req, res, next) => {
    // During a DB switch/restore no concurrent configuration, upload or external
    // source backup may start. Reads, the display, authentication and shutdown
    // remain available; an interrupted HTTP client does not release this guard.
    if (databaseOperationBusy && req.path.toLowerCase().startsWith('/api/')
        && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        && req.path.toLowerCase() !== '/api/internal/shutdown') {
        res.status(409).json({ success: false, code: 'DATABASE_OPERATION_BUSY', error: '数据库或备份维护中，请完成后再保存或操作' });
        return;
    }
    next();
});
async function ensureModelFilesRecovered(req, res, next) {
    try { await recoverPendingModelDeletions(await getDb()); next(); }
    catch (error) { next(error); }
}
app.use('/uploads/models', ensureModelFilesRecovered);
app.use('/uploads', express.static(uploadsRootDir, { dotfiles: 'deny', index: false }));
app.use('/assets', express.static(assetsDir, { dotfiles: 'deny', index: false }));

app.use('/api/factories', require('./routes/factories'));
app.use('/api/config', factoryContext, ensureModelFilesRecovered, require('./routes/config'));
app.use('/api/workshops', factoryContext, require('./routes/workshops'));
app.use('/api/lines', factoryContext, require('./routes/lines'));
app.use('/api/devices', factoryContext, require('./routes/devices'));
app.use('/api/datapoints', factoryContext, require('./routes/datapoints'));
app.use('/api/voice', require('./routes/voice'));
const settingsController = { wsServer: null };
app.use('/api/settings', factoryContext, require('./routes/settings')(settingsController));
const nativePreviewController = { wsServer: null };
app.use('/api/native-preview', factoryContext, require('./routes/nativePreview')(nativePreviewController));
app.use('/api/platform', factoryContext, require('./routes/platform'));
app.use('/api/data-sources', factoryContext, require('./routes/dataSources'));
// 外部排产/生产数据库只读适配层：供数字孪生大屏读取批次、工艺和统计数据。
app.use('/api/business-data', factoryContext, require('./routes/businessData'));
// 热处理行业模板、点位包、报警规则和部件绑定清单（只读蓝图）。
app.use('/api/template-library', require('./routes/templateLibrary'));
app.use('/api/acceptance-report', require('./routes/acceptanceReport'));
app.use('/api/license', require('./routes/license'));
app.use('/api/release', require('./routes/release'));
// 受控的本机 MCP 接口：让设计/验收 agent 通过 JSON-RPC 操作现场配置。
app.use('/api/mcp', factoryContext, require('./routes/mcp')({ port: PORT }));

app.get('/api/version', (req, res) => {
    res.json({ success: true, readOnly: true, ...loadReleaseManifest(), license: getLicenseStatus() });
});

// 仅供 Electron 本机管理“登录后自启”和局域网投屏，路由内部会拒绝非回环请求。
const runtimeController = { lanDisplay: null };
app.use('/api/system/runtime', require('./routes/runtime')(runtimeController));

// 局域网电视发现（SSDP）与 DLNA 一键投屏，同样只对本机开放。
const castController = { discovery: null, screenCast: null };
app.use('/api/system/cast', require('./routes/cast')(castController));

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname || '').toLowerCase();
        const uniqueName = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.glb', '.gltf'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('仅支持 .glb 和 .gltf 格式的 3D 模型文件'));
        }
    },
    limits: { fileSize: 100 * 1024 * 1024 }
});

fs.mkdirSync(SITE_IMPORT_DIR, { recursive: true });
const backupOperationLimiter = createOperationRateLimiter({ name: 'backup-operation', limit: 20 });
function runDatabaseOperation(action) {
    return async (req, res, next) => {
        if (databaseOperationBusy) {
            if (req.file?.path) {
                try { fs.rmSync(req.file.path, { force: true }); } catch { /* preserve the in-progress operation */ }
            }
            res.status(409).json({ success: false, code: 'DATABASE_OPERATION_BUSY', error: '另一个数据库或备份操作正在进行，请完成后重试' });
            return;
        }
        databaseOperationBusy = true;
        try { await action(req, res, next); }
        catch (error) { next(error); }
        finally { databaseOperationBusy = false; }
    };
}
async function stopMaintenanceForDatabaseChange(reason, { backup = true } = {}) {
    await stopSiteBackupMaintenance();
    await stopDataSourceMaintenance({ backup: false });
    await stopDatabaseMaintenance({ backup, reason });
}
async function resumeMaintenanceAfterDatabaseChange() {
    await startDatabaseMaintenance();
    const activeFactory = await getDb().then(db => db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']));
    await startDataSourceMaintenance(activeFactory?.value || 'factory_default');
    await startSiteBackupMaintenance(uploadsRootDir);
}
const siteBackupUpload = multer({
    dest: SITE_IMPORT_DIR,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(ext === '.zip' ? null : new Error('仅支持系统导出的 .zip 整站备份包'), ext === '.zip');
    },
    limits: { fileSize: 1024 * 1024 * 1024, files: 1 }
});

function receiveSiteBackup(req, res, next) {
    siteBackupUpload.single('backup')(req, res, error => {
        if (!error) {
            next();
            return;
        }
        if (req.file?.path) fs.rmSync(req.file.path, { force: true });
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? '整站备份包不能超过 1 GB'
            : error.message;
        res.status(400).json({ success: false, error: message });
    });
}

function resolveModelFileDeletePlan(modelFilePath) {
    if (!modelFilePath) return null;

    const relativePath = modelFilePath.replace(/^[/\\]+/, '');
    const fullPath = relativePath.startsWith('uploads/')
        ? path.resolve(uploadsRootDir, relativePath.slice('uploads/'.length))
        : path.resolve(__dirname, relativePath);
    const uploadRoot = path.resolve(uploadsDir);
    const assetRoot = path.resolve(assetModelsDir);

    if (fullPath.startsWith(uploadRoot + path.sep)) {
        return { fullPath, deleteFile: true };
    }
    if (fullPath.startsWith(assetRoot + path.sep)) {
        return { fullPath, deleteFile: false };
    }

    throw new Error('模型文件路径不合法');
}

let modelRecoveryPromise;
function recoverPendingModelDeletions(db) {
    modelRecoveryPromise ||= (async () => {
        for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const match = /^(.*)\.pending-delete-[a-f0-9]{16}$/.exec(entry.name);
            if (!match) continue;
            const original = path.join(uploadsDir, match[1]);
            const temporary = path.join(uploadsDir, entry.name);
            const reference = await db.get('SELECT COUNT(*) AS cnt FROM models WHERE file_path = ?', [`/uploads/models/${match[1]}`]);
            if (Number(reference?.cnt || 0) > 0) {
                if (!fs.existsSync(original)) fs.renameSync(temporary, original);
            } else {
                fs.unlinkSync(temporary);
            }
        }
    })().catch(error => { modelRecoveryPromise = null; throw error; });
    return modelRecoveryPromise;
}

app.post('/api/models/upload', upload.single('modelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '未收到文件' });
    }

    const { id, name, asset_type, tags, metadata, default_scale } = req.body;
    const filePath = `/uploads/models/${req.file.filename}`;
    const modelName = name || req.file.originalname;

    try {
        if (databaseOperationBusy) throw Object.assign(new Error('数据库或备份维护中，请完成后重新上传模型'), { statusCode: 409 });
        validateUploadedModelFile(req.file);
        const db = await getDb();
        if (databaseOperationBusy) throw Object.assign(new Error('数据库或备份维护中，请完成后重新上传模型'), { statusCode: 409 });
        const normalizedMetadata = stringifyModelMetadata(metadata || '{}', { name: modelName });
        await db.upsert('models', {
            id: id || req.file.filename.replace(/\.[^.]+$/, ''),
            name: modelName,
            file_path: filePath,
            asset_type: asset_type || 'model',
            tags: tags || '[]',
            thumbnail: null,
            default_scale: modelScale(default_scale),
            metadata: normalizedMetadata
        }, 'id');
        res.json({ success: true, filePath });
    } catch (e) {
        if (req.file?.path) fs.rmSync(req.file.path, { force: true });
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const db = await getDb();
        await recoverPendingModelDeletions(db);
        const models = await db.all('SELECT * FROM models');
        res.json(mergeBuiltinModels(models));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/models/inspection-presets', (req, res) => {
    res.json({ presets: getInspectionPresets() });
});

app.put('/api/models/:id', async (req, res) => {
    try {
        const db = await getDb();
        let existing = await db.get('SELECT * FROM models WHERE id = ?', [req.params.id]);
        if (!existing) {
            const builtin = getBuiltinModels().find(model => model.id === req.params.id);
            if (builtin?.file_path) {
                await db.upsert('models', {
                    id: builtin.id,
                    name: builtin.name,
                    file_path: builtin.file_path,
                    asset_type: builtin.asset_type || 'model',
                    tags: builtin.tags || '[]',
                    thumbnail: builtin.thumbnail || null,
                    default_scale: Number(builtin.default_scale || 1),
                    metadata: builtin.metadata || '{}'
                }, 'id');
                existing = await db.get('SELECT * FROM models WHERE id = ?', [req.params.id]);
            }
        }
        if (!existing) {
            return res.status(404).json({ error: '模型不存在或为不可编辑的内置模型' });
        }

        const nextName = req.body.name ?? existing.name;
        const nextTags = req.body.tags ?? existing.tags ?? '[]';
        const nextMetadata = req.body.metadata ?? existing.metadata ?? '{}';
        const nextScale = modelScale(req.body.default_scale, Number(existing.default_scale || 1));
        const normalizedMetadata = stringifyModelMetadata(nextMetadata, { name: nextName });

        await db.run(
            'UPDATE models SET name = ?, tags = ?, default_scale = ?, metadata = ? WHERE id = ?',
            [nextName, nextTags, nextScale, normalizedMetadata, req.params.id]
        );

        const updated = await db.get('SELECT * FROM models WHERE id = ?', [req.params.id]);
        // Model metadata (including inspection/explosion authoring) is read by
        // Unity when it builds the runtime scene. Notify only Unity clients so
        // a saved model configuration is not stranded in an already-running
        // player with the previous metadata snapshot.
        global.wsServer?.broadcastToRole?.('model_metadata_changed', {
            modelId: req.params.id,
            timestamp: Date.now()
        }, 'unity');
        res.json({ success: true, model: updated });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/models/:id', async (req, res) => {
    let stagedFile;
    try {
        const db = await getDb();
        await recoverPendingModelDeletions(db);
        await db.transaction(async tx => {
            const model = await tx.get('SELECT * FROM models WHERE id = ?', [req.params.id]);
            if (!model) throw Object.assign(new Error('模型不存在'), { statusCode: 404 });
            const usedByDevices = await tx.get('SELECT COUNT(*) AS cnt FROM devices WHERE model_type = ? OR model_file = ?', [req.params.id, model.file_path]);
            if (Number(usedByDevices?.cnt || 0) > 0) {
                throw Object.assign(new Error(`该模型正在被 ${usedByDevices.cnt} 台设备使用，先修改这些设备的模型后再删除`), { statusCode: 409 });
            }
            if (model.file_path) {
                const deletePlan = resolveModelFileDeletePlan(model.file_path);
                const shared = await tx.get('SELECT COUNT(*) AS cnt FROM models WHERE file_path = ? AND id <> ?', [model.file_path, req.params.id]);
                if (deletePlan?.deleteFile && !Number(shared?.cnt || 0) && fs.existsSync(deletePlan.fullPath)) {
                    if (!fs.lstatSync(deletePlan.fullPath).isFile()) throw new Error('模型文件路径不是普通文件，已拒绝删除');
                    const temporary = `${deletePlan.fullPath}.pending-delete-${crypto.randomBytes(8).toString('hex')}`;
                    fs.renameSync(deletePlan.fullPath, temporary);
                    stagedFile = { original: deletePlan.fullPath, temporary };
                }
            }
            await tx.run('DELETE FROM models WHERE id = ?', [req.params.id]);
            if (req.params.id === 'box_atmosphere_furnace') {
                await tx.upsert('settings', { key: 'deleted_seed_model_box_atmosphere_furnace', value: '1' }, 'key');
            }
        });
        let cleanupPending = false;
        if (stagedFile) {
            try { fs.unlinkSync(stagedFile.temporary); }
            catch (error) {
                cleanupPending = true;
                console.warn('[Models] 已删除模型记录，暂存文件待清理:', stagedFile.temporary, error.message);
            }
        }
        res.json({ success: true, fileDeleted: !!stagedFile && !cleanupPending, ...(cleanupPending ? { warning: '模型已删除，但暂存文件清理失败，请联系工程师清理' } : {}) });
    } catch (e) {
        if (stagedFile) {
            try { fs.renameSync(stagedFile.temporary, stagedFile.original); }
            catch (restoreError) { console.error('[Models] 删除失败，原模型文件保留在:', stagedFile.temporary, restoreError.message); }
        }
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

app.get('/api/engine/status', (req, res) => {
    if (global.dataEngine) {
        res.json(global.dataEngine.getStatus());
    } else {
        res.json({ mode: null, plcStatus: { status: 'not_started', message: '引擎未启动' } });
    }
});

app.get('/api/plc/protocols', (req, res) => {
    res.json({ protocols: publicProtocolDefinitions() });
});

app.use('/api/plc/points', factoryContext);
app.get('/api/plc/points/realtime', async (req, res) => {
    try {
        const deviceId = String(req.query.device_id || '').trim();

        const db = await getDb();
        const workshops = await db.all('SELECT id FROM workshops WHERE factory_id = ?', [req.factoryId]);
        const workshopIds = new Set(workshops.map(row => String(row.id)));
        const lines = await db.all(`SELECT l.id FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id WHERE w.factory_id = ?`, [req.factoryId]);
        const lineIds = new Set(lines.map(row => String(row.id)));
        const candidates = deviceId
            ? [await db.get('SELECT * FROM devices WHERE id = ?', [deviceId])].filter(Boolean)
            : await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC');
        const devices = candidates.filter(device => {
            if (lineIds.has(String(device.line_id || ''))) return true;
            if (device.line_id) return false;
            let config = {};
            try { config = typeof device.instance_config === 'object' ? device.instance_config : JSON.parse(device.instance_config || '{}'); } catch { /* invalid legacy configuration */ }
            return workshopIds.has(String(config.workshop_id || config.workshopId || ''));
        });

        if (deviceId && !devices.length) {
            return res.status(404).json({ error: '设备不存在' });
        }

        const scopedDeviceIds = devices.map(device => String(device.id));
        const allPoints = scopedDeviceIds.length
            ? await db.all(`SELECT * FROM data_points WHERE device_id IN (${scopedDeviceIds.map(() => '?').join(',')}) ORDER BY device_id, id ASC`, scopedDeviceIds)
            : [];
        const pointsByDevice = new Map();
        allPoints.forEach(point => {
            if (!pointsByDevice.has(point.device_id)) pointsByDevice.set(point.device_id, []);
            pointsByDevice.get(point.device_id).push(point);
        });

        const runtimeDevices = devices.filter(Boolean).map(device => {
            const points = pointsByDevice.get(device.id) || [];
            const runtime = global.dataEngine?.getPointRuntimeValues
                ? global.dataEngine.getPointRuntimeValues(device.id, points)
                : {
                    deviceStatus: null,
                    snapshotTimestamp: null,
                    points: points.map(point => ({ ...point, value: null, quality: 'bad' }))
                };
            return {
                device,
                deviceStatus: runtime.deviceStatus,
                snapshotTimestamp: runtime.snapshotTimestamp,
                points: runtime.points.map(point => ({
                    ...point,
                    device_id: device.id,
                    device_name: device.name,
                    device_status: runtime.deviceStatus?.status || null
                }))
            };
        });

        const latestSnapshot = runtimeDevices
            .map(item => Number(item.snapshotTimestamp || 0))
            .filter(Number.isFinite)
            .reduce((max, value) => Math.max(max, value), 0) || null;

        res.json({
            success: true,
            device: deviceId ? runtimeDevices[0]?.device : null,
            devices: runtimeDevices.map(item => item.device),
            deviceStatus: deviceId ? runtimeDevices[0]?.deviceStatus : null,
            deviceStatuses: runtimeDevices.map(item => item.deviceStatus).filter(Boolean),
            snapshotTimestamp: latestSnapshot,
            points: runtimeDevices.flatMap(item => item.points),
            timestamp: Date.now()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/engine/restart', async (req, res) => {
    if (!global.dataEngine) {
        return res.status(500).json({ error: '数据引擎未初始化' });
    }
    try {
        await global.dataEngine.restart();
        res.json({ success: true, message: '数据引擎正在重启...' });
    } catch (error) {
        res.status(503).json({ success: false, error: `数据引擎重启失败: ${error.message}` });
    }
});

app.get('/api/health', (req, res) => {
    const engineStatus = global.dataEngine ? global.dataEngine.getStatus() : null;
    const dbStatus = getDbStatus();
    const wsServer = global.wsServer;
    const unityClients = wsServer?.countClients?.('unity') || 0;
    const webClients = wsServer?.countClients?.('web') || 0;
    const collector = engineStatus?.collectorStatus || {};
    const license = getLicenseStatus();
    const collectorAgeMs = collector.lastFrameAt ? Math.max(0, Date.now() - Number(collector.lastFrameAt)) : null;
    const dataFresh = collectorAgeMs !== null && collectorAgeMs <= 15000;
    const databaseReady = dbStatus.connected === true;
    const engineReady = !!engineStatus?.mode && ['connected', 'simulating'].includes(String(collector.status || '').toLowerCase());
    const nativeSceneReady = unityClients > 0;
    const licenseReady = !license.enforce || license.valid;
    const readinessFailures = [];
    if (!databaseReady) readinessFailures.push('database');
    if (!engineReady) readinessFailures.push('data_engine');
    if (!dataFresh) readinessFailures.push('data_freshness');
    if (!nativeSceneReady) readinessFailures.push('unity');
    if (!licenseReady) readinessFailures.push('license');
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: { ...loadReleaseManifest(), license },
        db: dbStatus,
        engine: engineStatus,
        components: {
            backend: { status: 'healthy' },
            database: { status: databaseReady ? 'healthy' : 'error', connected: databaseReady, error: dbStatus.error || null },
            dataEngine: {
                status: engineReady ? 'healthy' : (engineStatus ? 'degraded' : 'error'),
                mode: engineStatus?.mode || null,
                collectorStatus: collector.status || 'not_started',
                lastFrameAt: collector.lastFrameAt || null,
                ageMs: collectorAgeMs,
                fresh: dataFresh
            },
            unity: { status: nativeSceneReady ? 'healthy' : 'offline', clients: unityClients },
            dashboard: { status: webClients > 0 ? 'healthy' : 'idle', clients: webClients },
            license: {
                status: licenseReady ? (license.valid ? 'healthy' : 'not_enforced') : 'error',
                enforce: license.enforce,
                configured: license.configured,
                valid: license.valid,
                expiresAt: license.expiresAt,
                reason: license.reason
            }
        },
        readiness: {
            status: readinessFailures.length ? 'degraded' : 'ready',
            displayReady: databaseReady && engineReady && dataFresh && nativeSceneReady && licenseReady,
            failures: readinessFailures
        }
    });
});

// The Three.js dashboard has been replaced by the Unity client. Keep the old
// HTTP entry point explicit and visible as deprecated, instead of allowing the
// browser to boot the legacy dashboard from a direct IP:port visit.
app.get(['/', '/index.html'], (req, res, next) => {
    if (!fs.existsSync(deprecatedDashboardPage)) return next();
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.status(410).sendFile(deprecatedDashboardPage);
});

if (frontendDistDir && fs.existsSync(path.join(frontendDistDir, 'index.html'))) {
    app.use(express.static(frontendDistDir));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/assets/') || req.path.startsWith('/uploads/') || req.path === '/ws') {
            return next();
        }
        return res.sendFile(path.join(frontendDistDir, 'index.html'));
    });
}

app.get('/api/database/config', (req, res) => {
    res.json(publicDatabaseConfig(loadDatabaseConfig()));
});

app.post('/api/database/test', backupOperationLimiter, async (req, res) => {
    try {
        await testDatabaseConfig(req.body || {});
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.put('/api/database/config', backupOperationLimiter, runDatabaseOperation(async (req, res) => {
    const previousConfig = loadDatabaseConfig();
    let saved = false;
    let stopped = false;
    try {
        await testDatabaseConfig(req.body || {});
        stopped = true;
        await global.dataEngine?.stop();
        await stopMaintenanceForDatabaseChange('before-config-change');
        const config = saveDatabaseConfig(req.body || {});
        saved = true;
        await reconnectDb();
        await resumeMaintenanceAfterDatabaseChange();
        if (global.dataEngine) {
            await global.dataEngine.start();
        }
        res.json({ success: true, config });
    } catch (e) {
        let rollbackError;
        if (stopped) {
            try {
                if (saved) {
                    saveDatabaseConfig(previousConfig);
                    await reconnectDb();
                }
                await resumeMaintenanceAfterDatabaseChange();
                await global.dataEngine?.start();
            } catch (error) { rollbackError = error; }
        }
        res.status(rollbackError ? 503 : 400).json({
            success: false,
            error: rollbackError ? `${e.message}；恢复原数据库连接失败: ${rollbackError.message}` : e.message,
            ...(saved ? { rolledBack: !rollbackError } : {})
        });
    }
}));

app.get('/api/database/backups', (req, res) => {
    try {
        res.json(getDatabaseBackupStatus());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/database/backups/config', backupOperationLimiter, runDatabaseOperation(async (req, res) => {
    try {
        const result = await saveDatabaseBackupPolicy(req.body || {});
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
}));

app.post('/api/database/backups', backupOperationLimiter, runDatabaseOperation(async (req, res) => {
    try {
        const backup = await createDatabaseBackup('manual');
        res.json({ success: true, backup, status: getDatabaseBackupStatus() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
}));

app.get('/api/database/backups/:filename/download', (req, res) => {
    try {
        const filename = resolveDatabaseBackupPath(req.params.filename);
        res.download(filename, path.basename(filename));
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

app.post('/api/database/backups/:filename/restore', backupOperationLimiter, runDatabaseOperation(async (req, res) => {
    const dataEngine = global.dataEngine;
    try {
        await dataEngine?.stop();
        // restoreDatabaseBackup protects its selected source before making a
        // rollback backup. An earlier backup could prune the selected source.
        await stopMaintenanceForDatabaseChange('before-database-restore', { backup: false });
        const result = await restoreDatabaseBackup(req.params.filename);
        await resumeMaintenanceAfterDatabaseChange();
        if (dataEngine) await dataEngine.start();
        res.json({ ...result, status: getDatabaseBackupStatus() });
    } catch (e) {
        try { await resumeMaintenanceAfterDatabaseChange(); } catch (restartError) { /* report original restore error */ }
        if (dataEngine) {
            try { await dataEngine.start(); } catch (restartError) { /* report original restore error */ }
        }
        res.status(400).json({ success: false, error: e.message });
    }
}));

app.delete('/api/database/backups/:filename', backupOperationLimiter, runDatabaseOperation(async (req, res) => {
    try {
        res.json(await deleteDatabaseBackup(req.params.filename));
    } catch (e) {
        res.status(e.message === '备份文件不存在' ? 404 : 400).json({ success: false, error: e.message });
    }
}));

app.get('/api/site-backups', (req, res) => {
    try {
        res.json(getSiteBackupStatus());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/site-backups/config', (req, res) => {
    try {
        res.json(loadSiteBackupConfig());
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/site-backups/config', backupOperationLimiter, runDatabaseOperation(async (req, res) => {
    try {
        const config = saveSiteBackupConfig(req.body || {});
        await startSiteBackupMaintenance(uploadsRootDir);
        res.json({ success: true, config, status: getSiteBackupStatus() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
}));

app.post('/api/site-backups/export', backupOperationLimiter, runDatabaseOperation(async (req, res) => {
    try {
        const backup = await createSiteBackup(uploadsRootDir);
        res.json({ success: true, backup, status: getSiteBackupStatus() });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
}));

app.get('/api/site-backups/:filename/download', (req, res) => {
    try {
        const filename = resolveSiteBackupPath(req.params.filename);
        res.download(filename, path.basename(filename));
    } catch (e) {
        res.status(404).json({ error: e.message });
    }
});

app.post('/api/site-backups/import', backupOperationLimiter, receiveSiteBackup, runDatabaseOperation(async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: '未收到整站备份文件' });

    const dataEngine = global.dataEngine;
    let result = null;
    let restoreError = null;
    try {
        await dataEngine?.stop();
        await stopMaintenanceForDatabaseChange('before-site-import');
        result = await restoreSiteBackup(req.file.path, uploadsRootDir);
    } catch (error) {
        restoreError = error;
    }

    try {
        await resumeMaintenanceAfterDatabaseChange();
    } catch (error) {
        restoreError ||= error;
    }
    if (dataEngine) {
        try { await dataEngine.start(); } catch (error) { restoreError ||= error; }
    }
    fs.rmSync(req.file.path, { force: true });

    if (restoreError) {
        res.status(400).json({ success: false, error: restoreError.message });
        return;
    }
    res.json({ ...result, status: getSiteBackupStatus(), databaseStatus: getDatabaseBackupStatus() });
}));

async function startServer() {
    const httpServer = http.createServer(app);
    httpServer.headersTimeout = Math.max(5000, Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 15000));
    httpServer.requestTimeout = Math.max(30000, Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 10 * 60 * 1000));
    httpServer.keepAliveTimeout = Math.max(1000, Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 5000));
    httpServer.maxHeadersCount = Math.max(32, Number(process.env.HTTP_MAX_HEADERS || 100));
    httpServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`\n后端端口 ${PORT} 已被占用。`);
            console.error(`请先关闭旧的后端进程，或用 PowerShell 临时换端口启动：$env:PORT=3002; npm start`);
            process.exit(1);
        }
        throw error;
    });

    const WsServer = require('./services/wsServer');
    const wsServer = new WsServer();
    wsServer.attach(httpServer, {
        verifyClient: (info, done) => {
            if (!isLicenseEnforced() || getLicenseStatus().valid) {
                const request = info?.req;
                const cookieName = `${adminSessionCookieName()}=`;
                const cookie = String(request?.headers?.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName));
                const token = cookie ? cookie.slice(cookieName.length) : '';
                const session = getAdminAuth().status(token);
                const authenticated = session.authenticated && session.permissions?.view === true;
                const castAuthorized = lanDisplay.isValidDisplaySocket(request);
                const hasBrowserOrigin = Boolean(request?.headers?.origin);
                const trustedOrigin = !hasBrowserOrigin || isTrustedAdminOrigin({
                    get: header => request?.headers?.[String(header || '').toLowerCase()]
                });
                const trustedNativeClient = !hasBrowserOrigin && isLoopbackAddress(request?.socket?.remoteAddress);
                if ((authenticated && trustedOrigin) || trustedNativeClient || castAuthorized) {
                    request.adminSessionToken = authenticated ? token : '';
                    request.castAuthorized = castAuthorized;
                    done(true);
                } else {
                    done(false, 401, 'Authentication required');
                }
                return;
            }
            done(false, 402, 'License required');
        }
    });
    global.wsServer = wsServer;
    settingsController.wsServer = wsServer;
    nativePreviewController.wsServer = wsServer;

    const LanDisplayService = require('./services/lanDisplay');
    const lanDisplay = new LanDisplayService({ app, wsServer, primaryPort: PORT });
    runtimeController.lanDisplay = lanDisplay;

    const CastDiscoveryService = require('./services/castDiscovery');
    const ScreenCastService = require('./services/screenCast');
    const castDiscovery = new CastDiscoveryService();
    const screenCast = new ScreenCastService({ port: Number(process.env.CAST_STREAM_PORT) || 8788 });
    castController.discovery = castDiscovery;
    castController.screenCast = screenCast;

    const DataEngine = require('./services/dataEngine');
    const dataEngine = new DataEngine(wsServer);
    global.dataEngine = dataEngine;

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        const forceExit = setTimeout(() => process.exit(1), 12000);
        forceExit.unref?.();
        try { await dataEngine.stop(); } catch (e) { /* ignore */ }
        try { await screenCast.close(); } catch (e) { /* ignore */ }
        try { await lanDisplay.stop(); } catch (e) { /* ignore */ }
        try { await stopSiteBackupMaintenance(); } catch (e) { /* ignore */ }
        try { await stopDataSourceMaintenance({ backup: true, reason: 'shutdown' }); } catch (e) {
            console.error('[Shutdown] 退出备份失败:', e.message);
        }
        try { wsServer.close(); } catch (e) { /* ignore */ }
        if (global.wsServer === wsServer) global.wsServer = null;
        httpServer.close();
        try {
            // 正常退出备份已由 dataSources 按用户勾选的数据库和触发规则统一执行，避免主库重复备份。
            await stopDatabaseMaintenance({ backup: false, reason: 'shutdown' });
            await closeDb();
            clearTimeout(forceExit);
            process.exit(0);
        } catch (error) {
            console.error('[Shutdown] 安全退出失败:', error.message);
            process.exit(1);
        }
    };

    const desktopShutdownToken = String(process.env.DESKTOP_SHUTDOWN_TOKEN || '');
    if (desktopShutdownToken) {
        app.post('/api/internal/shutdown', (req, res) => {
            const remoteAddress = String(req.socket.remoteAddress || '');
            const isLoopback = remoteAddress === '::1' || /^(::ffff:)?127\.0\.0\.1$/.test(remoteAddress);
            const suppliedToken = String(req.get('x-shutdown-token') || '');
            if (!isLoopback || suppliedToken !== desktopShutdownToken) {
                res.status(403).json({ success: false, error: '拒绝访问' });
                return;
            }

            res.status(202).json({ success: true, message: '正在安全退出' });
            res.once('finish', () => setImmediate(shutdown));
        });
    }
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    // 这些兜底处理必须在动态注册的本机安全退出路由之后，避免误吞掉该路由。
    app.use((req, res) => {
        if (req.path.startsWith('/api/')) {
            res.status(404).json({ success: false, error: '接口不存在' });
            return;
        }
        res.status(404).send('Not Found');
    });
    app.use((error, req, res, next) => {
        if (res.headersSent) {
            next(error);
            return;
        }
        const status = error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE'
            ? 413
            : (Number.isInteger(error?.statusCode) ? error.statusCode : 400);
        const message = status === 413
            ? '请求或上传文件超过大小限制'
            : (error?.type === 'entity.parse.failed' ? '请求正文不是有效的 JSON' : (error?.message || '请求处理失败'));
        // 只记录服务端日志，不把堆栈、绝对路径和数据库连接细节返回给客户端。
        console.error(`[HTTP ${status}] ${req.method} ${req.originalUrl}: ${message}`);
        res.status(status).json({ success: false, error: message });
    });

    httpServer.listen(PORT, HOST, () => {
        console.log(`\n数字孪生后端服务已启动: http://${HOST}:${PORT}`);
        const dbConfig = publicDatabaseConfig(loadDatabaseConfig());
        console.log(`   Database:    ${dbConfig.type} ${dbConfig.host || dbConfig.filename}:${dbConfig.port || ''}/${dbConfig.database || ''}`);
        console.log(`   配置 API:    http://${HOST}:${PORT}/api/config`);
        console.log(`   管理 API:    http://${HOST}:${PORT}/api/lines | devices | datapoints | settings`);
        console.log(`   MCP 接口:    http://${HOST}:${PORT}/api/mcp`);
        console.log(`   引擎状态:    http://${HOST}:${PORT}/api/engine/status`);
        console.log(`   WebSocket:   ws://${HOST}:${PORT}/ws\n`);

        setTimeout(() => {
            getDb()
                .then(db => recoverPendingModelDeletions(db))
                .then(() => startDatabaseMaintenance())
                .then(async () => {
                    const db = await getDb();
                    const activeFactory = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
                    return startDataSourceMaintenance(activeFactory?.value || 'factory_default');
                })
                .then(() => lanDisplay.loadFromSettings())
                .then(() => startSiteBackupMaintenance(uploadsRootDir))
                .then(() => dataEngine.start())
                .catch((error) => {
                    console.error('[DataEngine] 启动失败:', error.message);
                    console.error('[DataEngine] 可在后台“数据库连接”中修改并测试数据库配置。');
                });
            // 提前探测 ffmpeg 和局域网电视，后台页面一打开就能看到真实状态。
            screenCast.resolveFfmpeg()
                .then(found => {
                    if (found) console.log(`[投屏] 已找到屏幕编码器: ${found}`);
                    else console.log('[投屏] 未找到 ffmpeg，Unity 大屏的 DLNA 一键投屏暂不可用。');
                })
                .catch(() => {});
            castDiscovery.scan({ timeoutMs: 3500 }).catch(() => {});
        }, 1000);
    });
}

startServer().catch((error) => {
    console.error('\n后端启动失败:', error.message);
    process.exit(1);
});
