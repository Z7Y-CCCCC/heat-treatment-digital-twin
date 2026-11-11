const express = require('express');
const router = express.Router();
const { cleanupDashboardDeviceDeletion, broadcastDashboardCleanup } = require('../services/dashboardDeviceDeletion');
const { getDb, getDbStatus } = require('../db/database');
const { loadDeviceInspection, publicInspection, patchDeviceInspectionLayout,
    saveDeviceInspectionLayout, canonicalJson, exactJsonEquals } = require('../services/deviceInspection');
const { getBuiltinModels } = require('../services/builtinModels');
const { TRANSFORM_FIELDS, LAYOUT_CONFIG_FIELDS } = require('../../shared/deviceAuthoring.mjs');
const { normalizeDeviceGround } = require('../../shared/industrialGround.mjs');
const { loadDeviceAnimations, validateDeviceAnimations, publicDeviceAnimations } = require('../services/deviceAnimations');
const { assertMotionPositionOwnership } = require('../services/motionPositionOwnership');
const { validateMovementConfig, validateMovementSources } = require('../services/movementConfig');
const { assertDeviceLineUnits, loadDeviceLineContext } = require('../services/deviceLineUnits');
const { validateTransferSelection, publicTransferLink } = require('../services/transferLink');
const { validateEndpointSource, sourceFingerprint } = require('../services/deviceAnimations');
const { loadDeviceLoadingPorts, publicDeviceLoadingPorts, saveDeviceLoadingPorts, normalizeInstanceLoadingPorts } = require('../services/loadingPorts');
const { saveLoadingAlignment } = require('../services/deviceLoadingAlignment');

router.put('/loading-alignment', async (req, res) => {
    try {
        const db = await getDb();
        const devices = await db.transaction(tx => saveLoadingAlignment(tx, req.body, req.factoryId, getDbStatus().type));
        for (const device of devices) broadcastDeviceConfigurationChanged(device.id, device.instance_config);
        res.json({ success: true, devices: devices.map(publicDevice) });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message, code: error.code }); }
});

router.get('/:id/loading-ports', async (req, res) => {
    try {
        const loaded = await loadDeviceLoadingPorts(await getDb(), req.params.id, req.factoryId);
        res.setHeader('Cache-Control', 'no-store'); res.json(publicDeviceLoadingPorts(loaded, publicDevice));
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message, code: error.code }); }
});
router.put('/:id/loading-ports', async (req, res) => {
    try {
        const db = await getDb();
        const saved = await db.transaction(async tx => {
            const loaded = await loadDeviceLoadingPorts(tx, req.params.id, req.factoryId);
            return saveDeviceLoadingPorts(tx, loaded, req.body, req.factoryId, getDbStatus().type);
        });
        broadcastDeviceConfigurationChanged(saved.device.id, saved.instance);
        res.json(publicDeviceLoadingPorts(saved, publicDevice));
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message, code: error.code }); }
});

router.get('/:id/animations', async (req, res) => {
    try { res.json(publicDeviceAnimations(await loadDeviceAnimations(await getDb(), req.params.id, req.factoryId))); }
    catch (error) { res.status(error.statusCode || error.status || 400).json({ error: error.message }); }
});
router.put('/:id/animations', async (req, res) => {
    try {
        const db = await getDb();
        const saved = await db.transaction(async tx => {
            const loaded = await loadDeviceAnimations(tx, req.params.id, req.factoryId);
            const config = validateDeviceAnimations(loaded, req.body);
            // Re-resolve point ownership and model identity within the transaction.
            const instance = { ...loaded.instance, animationBindings: config };
            await assertDeviceLineUnits(tx, loaded.device, instance, req.factoryId);
            const dialect = getDbStatus().type;
            // MySQL returns native JSON objects; raw COALESCE(JSON, '') compares
            // unlike representations and can falsely reject an unchanged row.
            // Use the same semantic JSON CAS as inspection/loading-port saves;
            // textual engines retain their exact authored snapshot comparison.
            const previous = ['mysql', 'postgres'].includes(dialect)
                ? canonicalJson(loaded.device.instance_config) : loaded.device.instance_config ?? '';
            const result = await tx.run(`UPDATE devices SET instance_config=? WHERE id=? AND ${exactJsonEquals('instance_config', dialect)}`,
                [JSON.stringify(instance), loaded.device.id, previous]);
            if (!result.changes && !result.affectedRows) throw Object.assign(new Error('设备配置已更新，请重新读取后保存'), { statusCode:409 });
            return publicDeviceAnimations(await loadDeviceAnimations(tx, req.params.id, req.factoryId));
        });
        // The outer committed-write middleware emits one authoritative action
        // invalidation on finish; do not also emit a whole-device reload.
        res.locals.configurationResource = 'device-animations';
        res.locals.configurationDeviceId = req.params.id;
        res.json({ success: true, ...saved });
    } catch (error) { res.status(error.statusCode || error.status || 400).json({ error: error.message }); }
});

// Narrow authoring endpoints deliberately preserve model identity, PLC network
// configuration and inspection metadata. Never reuse the full device PUT for
// a user granted only scene placement or movement authoring.
function validateTransform(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => ![...TRANSFORM_FIELDS, 'layoutConfig', 'ground'].includes(key))) throw new Error('布局包含不可修改字段');
    if (body.ground !== undefined) {
        const g = body.ground;
        if (!g || Array.isArray(g) || typeof g.enabled !== 'boolean' || Object.keys(g).some(key => !['enabled', 'width', 'depth', 'clearance'].includes(key))
            || ['width', 'depth', 'clearance'].some(key => typeof g[key] !== 'number' || !Number.isFinite(g[key]) || g[key] < (key === 'clearance' ? 0 : .2) || g[key] > (key === 'clearance' ? 20 : 500))) throw new Error('设备地面尺寸无效');
    }
    const layout = body.layoutConfig || {};
    if (typeof layout !== 'object' || Array.isArray(layout) || Object.keys(layout).some(key => !LAYOUT_CONFIG_FIELDS.includes(key)
        || layout[key] !== null && !['string', 'number', 'boolean'].includes(typeof layout[key])
        || typeof layout[key] === 'string' && layout[key].length > 160
        || typeof layout[key] === 'number' && !Number.isFinite(layout[key]))) throw new Error('布局配置格式无效');
    for (const key of TRANSFORM_FIELDS.filter(k => !['line_id', 'coordinate_space'].includes(k))) {
        if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || Math.abs(body[key]) > 100000
            || key === 'scale' && (body[key] <= 0 || body[key] > 1000))) throw new Error('布局数值无效');
    }
    if (body.line_id !== undefined && body.line_id !== null && (typeof body.line_id !== 'string' || body.line_id.length > 120)) throw new Error('产线 ID 无效');
    if (body.coordinate_space !== undefined && !['line_local', 'workshop_local'].includes(body.coordinate_space)) throw new Error('坐标空间无效');
}
async function applyTransform(tx, id, body, factoryId) {
    const device = await tx.get('SELECT * FROM devices WHERE id = ?', [id]);
    if (!await deviceBelongsToFactory(tx, device, factoryId)) throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
    const lineId = body.line_id === undefined ? device.line_id : body.line_id;
    if (!await lineBelongsToFactory(tx, lineId, factoryId) || !lineId && !isAuxiliaryDevice(device.model_type, device.instance_config)) throw new Error('产线不属于当前工厂');
    const config = parseJson(device.instance_config);
    if (body.ground !== undefined) config.ground = normalizeDeviceGround(body.ground);
    for (const [key, value] of Object.entries(body.layoutConfig || {})) { if (value === null) delete config[key]; else config[key] = value; }
    for (const key of ['workshop_id', 'workshopId']) if (config[key] && !await tx.get('SELECT id FROM workshops WHERE id = ? AND factory_id = ?', [config[key], factoryId])) throw new Error('车间不属于当前工厂');
    for (const key of ['laneLineId', 'railLineId']) if (config[key] && !await lineBelongsToFactory(tx, config[key], factoryId)) throw new Error('绑定产线不属于当前工厂');
    await assertDeviceLineUnits(tx, { ...device, line_id: lineId }, config, factoryId);
    const fields = TRANSFORM_FIELDS.filter(key => body[key] !== undefined);
    await tx.run(`UPDATE devices SET ${fields.map(key => `${key}=?`).concat('instance_config=?').join(',')} WHERE id=?`,
        [...fields.map(key => body[key]), JSON.stringify(config), id]);
    return { id, ...Object.fromEntries(TRANSFORM_FIELDS.map(key => [key, body[key] === undefined ? device[key] : body[key]])), instance_config: JSON.stringify(config) };
}
router.put('/transforms', async (req, res) => {
    try {
        const body = req.body;
        if (!body || Object.keys(body).some(key => key !== 'devices') || !Array.isArray(body.devices) || !body.devices.length || body.devices.length > 200) throw new Error('请选择 1–200 台设备');
        const ids = new Set();
        for (const row of body.devices) {
            if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 120 || ids.has(row.id)) throw new Error('设备 ID 无效或重复');
            ids.add(row.id);
            const { id, ...patch } = row; validateTransform(patch);
        }
        const db = await getDb();
        const saved = await db.transaction(async tx => {
            const rows = [];
            for (const { id, ...patch } of body.devices) rows.push(await applyTransform(tx, id, patch, req.factoryId));
            return rows;
        });
        for (const row of saved) broadcastDeviceConfigurationChanged(row.id, row.instance_config);
        res.json({ success: true, devices: saved });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});
router.put('/:id/transform', async (req, res) => {
    try {
        validateTransform(req.body);
        const db = await getDb();
        const row = await db.transaction(tx => applyTransform(tx, req.params.id, req.body, req.factoryId));
        broadcastDeviceConfigurationChanged(row.id, row.instance_config);
        res.json({ success: true });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});

router.put('/:id/movement', async (req, res) => {
    try {
        const body = req.body;
        if (!body || Array.isArray(body) || Object.keys(body).some(key => !['movement', 'pointIds', 'expectedMovement'].includes(key))
            || !body.movement || typeof body.movement !== 'object' || Array.isArray(body.movement)
            || Buffer.byteLength(JSON.stringify(body.movement)) > 32768) throw new Error('设备运动配置格式无效');
        validateMovementConfig(body.movement);
        if (body.expectedMovement !== undefined && body.expectedMovement !== null
            && (typeof body.expectedMovement !== 'object' || Array.isArray(body.expectedMovement)
                || Buffer.byteLength(JSON.stringify(body.expectedMovement)) > 32768)) throw new Error('运动配置比较快照无效');
        const ids = body.pointIds || [];
        if (!Array.isArray(ids) || ids.length > 3 || ids.some(id => !['string', 'number'].includes(typeof id) || String(id).length > 120)) throw new Error('运动点位无效');
        const db = await getDb();
        const config = await db.transaction(async tx => {
            const device = await tx.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
            if (!await deviceBelongsToFactory(tx, device, req.factoryId)) throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
            const previous = parseJson(device.instance_config);
            if (body.expectedMovement !== undefined && canonicalJson(previous.movement ?? null) !== canonicalJson(body.expectedMovement)) throw Object.assign(new Error('移动配置或导轨间距已更新，请重新读取后保存'), { statusCode:409 });
            await validateMovementSources(tx, device, body.movement, req.factoryId, deviceBelongsToFactory);
            const config = { ...previous, movement: body.movement };
            await assertDeviceLineUnits(tx, device, config, req.factoryId);
            if (body.movement.enabled === true || config.animationBindings?.transferLink?.enabled === true) {
                const hasTransfer = config.animationBindings?.transferLink?.enabled === true;
                const animations = await loadDeviceAnimations(tx, device.id, req.factoryId, { includeTransferTargets:hasTransfer, includePositionOwnership:body.movement.enabled === true });
                assertMotionPositionOwnership(animations, config.animationBindings?.bindings, body.movement);
                if (hasTransfer) validateTransferSelection({ ...animations, instance:config }, publicTransferLink(config.animationBindings.transferLink), config.animationBindings.bindings || [], validateEndpointSource, sourceFingerprint);
            }
            for (const id of new Set(ids.map(String))) {
                if (!await tx.get('SELECT id FROM data_points WHERE id = ? AND device_id = ?', [id, device.id])) throw new Error('运动点位不属于此设备');
                await tx.run('UPDATE data_points SET sample_interval_ms = ? WHERE id = ? AND device_id = ?', [100, id, device.id]);
            }
            await tx.run('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify(config), device.id]);
            return config;
        });
        if (ids.length) restartDataEngineSoon('update movement sampling', req.factoryId);
        broadcastDeviceConfigurationChanged(req.params.id, config);
        res.json({ success: true });
    } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
});
const {
    defaultPortForProtocol,
    getProtocolDefinition,
    normalizePlcOptions,
    normalizeProtocol,
    sanitizePlcOptions
} = require('../services/plcProtocolConfig');
const {
    assertDeletionConfirmation,
    getDeviceDeletionImpact,
    publicDeletionImpact
} = require('../services/deletionImpact');

function numberWithDefault(value, defaultValue) {
    return value === undefined || value === null || value === '' ? defaultValue : Number(value);
}

function boolWithDefault(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    const text = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(text) ? 1 : 0;
}

function stringifyJson(value) {
    return JSON.stringify(normalizeInstanceLoadingPorts(value));
}

function parseJson(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return {};
    }
}

async function deviceBelongsToFactory(db, device, factoryId) {
    if (!device) return false;
    if (device.line_id) {
        return Boolean(await db.get(`SELECT 1 FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
            WHERE l.id = ? AND w.factory_id = ?`, [device.line_id, factoryId]));
    }
    const config = parseJson(device.instance_config);
    const workshopId = config.workshop_id || config.workshopId;
    return Boolean(workshopId && await db.get('SELECT 1 FROM workshops WHERE id = ? AND factory_id = ?', [workshopId, factoryId]));
}

async function lineBelongsToFactory(db, lineId, factoryId) {
    return !lineId || Boolean(await db.get(`SELECT 1 FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
        WHERE l.id = ? AND w.factory_id = ?`, [lineId, factoryId]));
}

async function modelAvailableToFactory(db, modelType, modelFile, factoryId) {
    if (getBuiltinModels().some(item => (item.id === modelType || (modelFile && item.file_path === modelFile)) && item.placement_level !== 'device')) return false;
    const matches = [];
    if (modelType) matches.push(await db.get('SELECT factory_id, placement_level FROM models WHERE id = ?', [modelType]));
    if (modelFile) matches.push(await db.get('SELECT factory_id, placement_level FROM models WHERE file_path = ? LIMIT 1', [modelFile]));
    if (require('../services/installContentPolicy').emptyInstallation() && (!modelType || !matches[0] || matches.some(model => !model))) return false;
    return matches.every(model => !model || ((model.factory_id === null || model.factory_id === factoryId) && (model.placement_level || 'device') === 'device'));
}

function normalizeProtocolValue(value) {
    const protocol = normalizeProtocol(value || 'S7');
    if (!getProtocolDefinition(protocol)) throw new Error(`不支持的 PLC 协议：${protocol}`);
    return protocol;
}

function normalizePlcOptionsValue(protocol, value, existingValue = {}) {
    return JSON.stringify(normalizePlcOptions(protocol, value, existingValue));
}

function publicDevice(device) {
    if (!device) return device;
    const protocol = normalizeProtocol(device.plc_protocol || 'S7');
    return {
        ...device,
        plc_protocol: protocol,
        plc_options: sanitizePlcOptions(protocol, device.plc_options)
    };
}

function isAuxiliaryDevice(modelType, instanceConfig) {
    const config = parseJson(instanceConfig);
    return modelType === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true;
}

const { reloadCollectorSoon } = require('../utils/collectorReload');
function restartDataEngineSoon(reason, factoryId) { reloadCollectorSoon(factoryId, reason); }

// 设备实例配置（尤其是移动设备的路径配置）保存后，直接推送给 Unity。
// 这样不需要等待下一次配置轮询，也不需要重建整套场景。
function broadcastDeviceConfigurationChanged(deviceId, instanceConfig) {
    if (!global.wsServer?.broadcast || !deviceId) return;
    global.wsServer.broadcast('device_configuration_changed', {
        deviceId: String(deviceId),
        instanceConfig: parseJson(instanceConfig),
        timestamp: Date.now()
    });
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const { line_id } = req.query;
        if (line_id && !await lineBelongsToFactory(db, line_id, req.factoryId)) return res.json([]);
        const rows = await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC');
        const owned = [];
        for (const device of rows) {
            if (line_id && String(device.line_id || '') !== String(line_id)) continue;
            if (await deviceBelongsToFactory(db, device, req.factoryId)) owned.push(device);
        }
        res.json(owned.map(publicDevice));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/deletion-impact', async (req, res) => {
    try {
        const db = await getDb();
        const device = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!await deviceBelongsToFactory(db, device, req.factoryId)) return res.status(404).json({ error: '设备不存在，可能已经被删除或 ID 未正确编码' });
        const impact = await getDeviceDeletionImpact(db, req.params.id, req.factoryId);
        if (!impact) return res.status(404).json({ error: '设备不存在，可能已经被删除或 ID 未正确编码' });
        res.json(publicDeletionImpact(impact));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/inspection', async (req, res) => {
    try {
        const db = await getDb();
        const device = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!await deviceBelongsToFactory(db, device, req.factoryId)) return res.status(404).json({ error: '设备不存在' });
        res.setHeader('Cache-Control', 'no-store');
        res.json(publicInspection(await loadDeviceInspection(db, device, req.factoryId)));
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
    }
});

router.put('/:id/inspection', async (req, res) => {
    try {
        const db = await getDb();
        const saved = await db.transaction(async tx => {
            const device = await tx.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
            if (!await deviceBelongsToFactory(tx, device, req.factoryId)) {
                throw Object.assign(new Error('设备不存在'), { statusCode: 404 });
            }
            const loaded = await loadDeviceInspection(tx, device, req.factoryId);
            const next = patchDeviceInspectionLayout(loaded, req.body);
            return saveDeviceInspectionLayout(tx, device, loaded, next, req.factoryId, getDbStatus().type);
        });
        // No PLC/data-engine restart: only this device's display authoring changed.
        // configurationMutation('devices') also emits a scoped scene invalidation
        // after the successful HTTP response, never for failed/stale drafts.
        broadcastDeviceConfigurationChanged(req.params.id, saved.instance);
        res.json({ success: true, ...publicInspection(saved) });
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message, code: error.code });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const device = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!await deviceBelongsToFactory(db, device, req.factoryId)) return res.status(404).json({ error: '设备不存在' });

        const dataPoints = await db.all('SELECT * FROM data_points WHERE device_id = ?', [req.params.id]);
        const line = await loadDeviceLineContext(db, device, parseJson(device.instance_config), req.factoryId);
        res.json({ ...publicDevice(device), dataPoints, ...(line ? { lineLayout: line.layout } : {}) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/', async (req, res) => {
    const {
        id, name, line_id, model_type, model_file, template_id, instance_config,
        pos_x, pos_y, pos_z, rotation_y, scale, coordinate_space, sort_order,
        plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
        plc_timeout, plc_retry_interval, plc_max_retries, plc_options
    } = req.body;
    const nextModelType = model_type || 'builtin_furnace';
    if (!id || !name) {
        return res.status(400).json({ error: '设备ID和名称不能为空' });
    }
    if (!isAuxiliaryDevice(nextModelType, instance_config) && !line_id) {
        return res.status(400).json({ error: '普通设备必须选择所属产线' });
    }
    try {
        const db = await getDb();
        if (!await lineBelongsToFactory(db, line_id, req.factoryId)) return res.status(400).json({ error: '所选产线不属于当前工厂' });
        if (!line_id) {
            const config = parseJson(instance_config);
            const workshopId = config.workshop_id || config.workshopId;
            if (!workshopId || !await db.get('SELECT 1 FROM workshops WHERE id = ? AND factory_id = ?', [workshopId, req.factoryId])) {
                return res.status(400).json({ error: '车间级设备必须选择当前工厂内的所属车间' });
            }
        }
        if (!await modelAvailableToFactory(db, nextModelType, model_file, req.factoryId)) {
            return res.status(400).json({ error: '所选模型不属于当前工厂，或不是设备级模型' });
        }
        const protocol = normalizeProtocolValue(plc_protocol || 'S7');
        const normalizedOptions = normalizePlcOptionsValue(protocol, plc_options);
        await db.transaction(async tx => {
        await assertDeviceLineUnits(tx, { id, name, line_id }, instance_config, req.factoryId);
        await tx.run(`INSERT INTO devices (
            id, name, line_id, model_type, model_file, template_id, instance_config,
            pos_x, pos_y, pos_z, rotation_y, scale, coordinate_space, sort_order,
            plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
            plc_timeout, plc_retry_interval, plc_max_retries, plc_options
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
        )`, [
            id,
            name,
            line_id || null,
            nextModelType,
            model_file || null,
            template_id || '',
            stringifyJson(instance_config),
            numberWithDefault(pos_x, 0),
            numberWithDefault(pos_y, 0),
            numberWithDefault(pos_z, 0),
            numberWithDefault(rotation_y, 0),
            numberWithDefault(scale, 1.0),
            ['line_local', 'workshop_local'].includes(coordinate_space)
                ? coordinate_space
                : (line_id ? 'line_local' : 'workshop_local'),
            numberWithDefault(sort_order, 0),
            boolWithDefault(plc_enabled, 0),
            protocol,
            plc_ip || '',
            numberWithDefault(plc_port, defaultPortForProtocol(protocol)),
            numberWithDefault(plc_rack, 0),
            numberWithDefault(plc_slot, 1),
            numberWithDefault(plc_timeout, 5000),
            numberWithDefault(plc_retry_interval, 10000),
            numberWithDefault(plc_max_retries, 0),
            normalizedOptions
        ]);
        });
        restartDataEngineSoon('create device', req.factoryId);
        broadcastDeviceConfigurationChanged(id, instance_config);
        res.json({ success: true, id });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    const {
        name, line_id, model_type, model_file, template_id, instance_config,
        pos_x, pos_y, pos_z, rotation_y, scale, coordinate_space, sort_order,
        plc_enabled, plc_protocol, plc_ip, plc_port, plc_rack, plc_slot,
        plc_timeout, plc_retry_interval, plc_max_retries, plc_options
    } = req.body;
    if (!name) return res.status(400).json({ error: '设备名称不能为空' });
    try {
        const db = await getDb();
        const existing = await db.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!await deviceBelongsToFactory(db, existing, req.factoryId)) return res.status(404).json({ error: '设备不存在，可能已经被删除或 ID 未正确编码' });
        const nextLineId = line_id === undefined ? existing.line_id : (line_id || null);
        const nextModelType = model_type ?? existing.model_type;
        const nextInstanceConfig = instance_config ?? existing.instance_config;
        const nextProtocol = normalizeProtocolValue(plc_protocol ?? existing.plc_protocol ?? 'S7');
        const nextPlcOptions = normalizePlcOptionsValue(
            nextProtocol,
            plc_options === undefined ? existing.plc_options : plc_options,
            existing.plc_options
        );
        if (!isAuxiliaryDevice(nextModelType, nextInstanceConfig) && !nextLineId) {
            return res.status(400).json({ error: '普通设备必须选择所属产线' });
        }
        if (!await lineBelongsToFactory(db, nextLineId, req.factoryId)) return res.status(400).json({ error: '所选产线不属于当前工厂' });
        if (!nextLineId) {
            const config = parseJson(nextInstanceConfig);
            const workshopId = config.workshop_id || config.workshopId;
            if (!workshopId || !await db.get('SELECT 1 FROM workshops WHERE id = ? AND factory_id = ?', [workshopId, req.factoryId])) {
                return res.status(400).json({ error: '车间级设备必须选择当前工厂内的所属车间' });
            }
        }
        if (!await modelAvailableToFactory(db, nextModelType, model_file ?? existing.model_file, req.factoryId)) {
            return res.status(400).json({ error: '所选模型不属于当前工厂，或不是设备级模型' });
        }
        const nextCoordinateSpace = ['line_local', 'workshop_local'].includes(coordinate_space)
            ? coordinate_space
            : (nextLineId ? 'line_local' : 'workshop_local');

        await db.transaction(async tx => {
        await assertDeviceLineUnits(tx, { ...existing, line_id: nextLineId, name }, nextInstanceConfig, req.factoryId);
        await tx.run(`UPDATE devices SET name=?, line_id=?, model_type=?, model_file=?,
            template_id=?, instance_config=?, pos_x=?, pos_y=?, pos_z=?,
            rotation_y=?, scale=?, coordinate_space=?, sort_order=?, plc_enabled=?, plc_protocol=?, plc_ip=?,
            plc_port=?, plc_options=?, plc_rack=?, plc_slot=?, plc_timeout=?, plc_retry_interval=?,
            plc_max_retries=? WHERE id=?`, [
            name,
            nextLineId,
            nextModelType,
            model_file,
            template_id || '',
            stringifyJson(nextInstanceConfig),
            numberWithDefault(pos_x, 0),
            numberWithDefault(pos_y, 0),
            numberWithDefault(pos_z, 0),
            numberWithDefault(rotation_y, 0),
            numberWithDefault(scale, 1.0),
            nextCoordinateSpace,
            numberWithDefault(sort_order, 0),
            boolWithDefault(plc_enabled, 0),
            nextProtocol,
            plc_ip ?? existing.plc_ip ?? '',
            numberWithDefault(plc_port, defaultPortForProtocol(nextProtocol)),
            nextPlcOptions,
            numberWithDefault(plc_rack, 0),
            numberWithDefault(plc_slot, 1),
            numberWithDefault(plc_timeout, 5000),
            numberWithDefault(plc_retry_interval, 10000),
            numberWithDefault(plc_max_retries, 0),
            req.params.id
        ]);
        });
        restartDataEngineSoon('update device', req.factoryId);
        broadcastDeviceConfigurationChanged(req.params.id, nextInstanceConfig);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const deletion = await db.transaction(async (tx) => {
            // Acquire the lifecycle lock before any snapshot-producing reads.
            await tx.run('UPDATE factories SET id=id WHERE id=?', [req.factoryId]);
            const device = await tx.get('SELECT * FROM devices WHERE id = ?', [req.params.id]);
            if (!await deviceBelongsToFactory(tx, device, req.factoryId)) {
                const error = new Error('设备不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            const impact = await getDeviceDeletionImpact(tx, req.params.id, req.factoryId);
            if (!impact) {
                const error = new Error('设备不存在，可能已经被删除或 ID 未正确编码');
                error.statusCode = 404;
                throw error;
            }
            assertDeletionConfirmation(req.body, impact.name);
            const dashboardCleanup = await cleanupDashboardDeviceDeletion(tx, { factoryId: req.factoryId, deviceIds: [String(req.params.id)] });
            await tx.run('DELETE FROM data_points WHERE device_id = ?', [req.params.id]);
            const result = await tx.run('DELETE FROM devices WHERE id = ?', [req.params.id]);
            if (!result?.affectedRows && !result?.changes) throw new Error('设备删除失败：没有删除到任何记录');
            return { impact, dashboardCleanup };
        });
        restartDataEngineSoon('delete device', req.factoryId);
        broadcastDashboardCleanup(deletion.dashboardCleanup);
        res.json({ success: true, impact: publicDeletionImpact(deletion.impact), dashboardCleanup: deletion.dashboardCleanup });
    } catch (e) {
        res.status(e.statusCode || 400).json({ error: e.message });
    }
});

module.exports = router;
