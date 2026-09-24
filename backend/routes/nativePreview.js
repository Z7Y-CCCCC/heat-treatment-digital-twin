const express = require('express');
const { normalizeWorkshopLayout, normalizeLineLayout } = require('../utils/spatialLayout');
const { normalizeInspection, validateInspection } = require('../../shared/inspectionConfig.cjs');

const MAX_DEVICES = 500;
const MAX_LINES = 120;
const MAX_WORKSHOPS = 40;

function finiteNumber(value, fallback = 0, min = -100000, max = 100000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function safeObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function shortText(value, maxLength = 160) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeDevice(device) {
    const instanceConfig = safeObject(device?.instance_config);
    return {
        id: shortText(device?.id, 120),
        name: shortText(device?.name || device?.id, 180),
        line_id: shortText(device?.line_id, 120),
        model_type: shortText(device?.model_type || 'builtin_furnace', 160),
        pos_x: finiteNumber(device?.pos_x, 0),
        pos_y: finiteNumber(device?.pos_y, 0),
        pos_z: finiteNumber(device?.pos_z, 0),
        rotation_y: finiteNumber(device?.rotation_y, 0, -100000, 100000),
        scale: finiteNumber(device?.scale, 1, 0.0001, 1000),
        coordinate_space: ['line_local', 'workshop_local'].includes(device?.coordinate_space)
            ? device.coordinate_space
            : 'line_local',
        instance_config: instanceConfig
    };
}

function normalizeFocus(value) {
    const source = safeObject(value);
    const mode = ['factory', 'workshop', 'line', 'device', 'custom'].includes(source.mode) ? source.mode : 'factory';
    return {
        mode,
        workshopId: shortText(source.workshopId, 120),
        lineId: shortText(source.lineId, 120),
        deviceId: shortText(source.deviceId, 120),
        inspectionStage: shortText(source.inspectionStage, 32),
        partId: shortText(source.partId, 128)
    };
}

function inspectionCommand(value) {
    const source = safeObject(value);
    const command = source.command;
    if (!['stage', 'select', 'clear', 'progress', 'isolate', 'labels', 'pause', 'resume'].includes(command)) {
        throw new Error('未知的拆解操作');
    }
    const result = { command };
    if (command === 'stage') {
        if (!['solid', 'xray', 'exploded'].includes(source.stage)) throw new Error('未知的拆解阶段');
        result.stage = source.stage;
    }
    if (command === 'select') {
        result.partId = shortText(source.partId, 128);
        if (!result.partId) throw new Error('请选择拆解部件');
    }
    if (command === 'progress') {
        if (typeof source.progress !== 'number' || !Number.isFinite(source.progress) || source.progress < 0 || source.progress > 1) throw new Error('拆解进度必须在 0 到 1 之间');
        result.progress = source.progress;
    }
    if (command === 'isolate' || command === 'labels') {
        if (typeof source.enabled !== 'boolean') throw new Error('拆解开关必须为布尔值');
        result.enabled = source.enabled;
    }
    return result;
}

module.exports = function createNativePreviewRouter(controller) {
    const router = express.Router();

    router.get('/status', (req, res) => {
        res.json({
            success: true,
            unityClients: controller.wsServer?.countClients?.('unity') || 0,
            timestamp: Date.now()
        });
    });

    // This endpoint only accepts runtime view commands. Authentication and the
    // launch permission are enforced by protectManagementWrites middleware.
    router.post('/navigate', (req, res) => {
        const action = req.body?.action;
        if (!['camera', 'focus', 'view', 'inspection_back', 'inspection'].includes(action)) {
            res.status(400).json({ success: false, error: '只允许大屏视角导航操作' });
            return;
        }
        let inspection;
        if (action === 'inspection') {
            try {
                if (!shortText(req.body?.focus?.deviceId, 120)) throw new Error('拆解操作需要设备 ID');
                inspection = inspectionCommand(req.body?.inspection);
            } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
        }
        const payload = {
            version: 2,
            action,
            source: 'dashboard_overlay',
            viewId: shortText(req.body?.viewId, 128),
            focus: normalizeFocus(req.body?.focus),
            ...(inspection ? { inspection } : {}),
            cameraAction: ['rotateLeft', 'rotateRight', 'zoomIn', 'zoomOut', 'fit'].includes(req.body?.cameraAction)
                ? req.body.cameraAction : '',
            timestamp: Date.now()
        };
        const sent = controller.wsServer?.broadcastToRole?.('native_scene_preview', payload, 'unity') || 0;
        res.json({ success: true, sent, unityClients: sent, timestamp: payload.timestamp });
    });

    router.post('/', (req, res) => {
        const action = req.body?.action || 'apply';
        if (!['apply', 'reset', 'reload', 'camera', 'focus', 'view', 'inspection_back', 'inspection_preview'].includes(action)) {
            return res.status(400).json({ success: false, error: '未知的原生预览操作' });
        }
        if (action === 'inspection_preview') {
            const focus = normalizeFocus(req.body?.focus);
            if (!req.body?.inspectionConfig || typeof req.body.inspectionConfig !== 'object' || Array.isArray(req.body.inspectionConfig)) return res.status(400).json({ success: false, error: '需要完整的拆解配置对象' });
            const validation = validateInspection(req.body?.inspectionConfig);
            if (focus.mode !== 'device' || !focus.deviceId) return res.status(400).json({ success: false, error: '请选择拆解预览设备' });
            if (!validation.valid) return res.status(400).json({ success: false, error: validation.errors.map(item => item.message).join('；'), issues: validation.errors });
            const payload = { version: 2, action, source: 'admin', focus, inspectionConfig: normalizeInspection(req.body.inspectionConfig), timestamp: Date.now() };
            const sent = controller.wsServer?.broadcastToRole?.('native_scene_preview', payload, 'unity') || 0;
            return res.json({ success: true, sent, unityClients: sent, timestamp: payload.timestamp });
        }
        const normalizedLines = (Array.isArray(req.body?.lines) ? req.body.lines : [])
            .slice(0, MAX_LINES)
            .map(line => ({
                id: shortText(line?.id, 120),
                workshop_id: shortText(line?.workshop_id, 120),
                layout_json: normalizeLineLayout(line?.layout_json ?? line?.layout)
            }))
            .filter(line => line.id);
        const pendingLineIds = new Set(
            normalizedLines.filter(line => line.layout_json.placementPending).map(line => String(line.id))
        );
        const lines = normalizedLines.filter(line => !line.layout_json.placementPending);
        const devices = (Array.isArray(req.body?.devices) ? req.body.devices : [])
            .slice(0, MAX_DEVICES)
            .map(normalizeDevice)
            .filter(device => {
                if (!device.id) return false;
                const config = safeObject(device.instance_config);
                return !pendingLineIds.has(String(device.line_id || ''))
                    && !pendingLineIds.has(String(config.laneLineId || ''))
                    && !pendingLineIds.has(String(config.railLineId || ''));
            });
        const workshops = (Array.isArray(req.body?.workshops) ? req.body.workshops : [])
            .slice(0, MAX_WORKSHOPS)
            .map(workshop => ({
                id: shortText(workshop?.id, 120),
                layout_json: normalizeWorkshopLayout(workshop?.layout_json ?? workshop?.layout)
            }))
            .filter(workshop => workshop.id);
        const payload = {
            version: 2,
            action,
            sessionId: shortText(req.body?.sessionId, 120),
            sequence: finiteNumber(req.body?.sequence, 0, 0, Number.MAX_SAFE_INTEGER),
            source: shortText(req.body?.source || 'admin', 80),
            viewId: shortText(req.body?.viewId, 128),
            view: safeObject(req.body?.view),
            includeLayout: !!req.body?.includeLayout,
            devices,
            lines,
            workshops,
            focus: normalizeFocus(req.body?.focus),
            cameraAction: ['rotateLeft', 'rotateRight', 'zoomIn', 'zoomOut', 'fit'].includes(req.body?.cameraAction)
                ? req.body.cameraAction
                : '',
            timestamp: Date.now()
        };
        const sent = controller.wsServer?.broadcastToRole?.('native_scene_preview', payload, 'unity') || 0;
        res.json({ success: true, sent, unityClients: sent, timestamp: payload.timestamp });
    });

    return router;
};
