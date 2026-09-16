const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { mergeBuiltinModels } = require('../services/builtinModels');
const { normalizeWorkshopLayout, normalizeLineLayout } = require('../utils/spatialLayout');
const {
    getProjectAndScene,
    loadPublishedDocument,
    runtimePlatformPayload
} = require('../services/dashboardDocuments');
const { normalizeProtocol, sanitizePlcOptions } = require('../services/plcProtocolConfig');
const { getHeatTreatmentTemplatePacks } = require('../services/heatTreatmentTemplates');

const LEGACY_WEB_SETTING_KEYS = new Set([
    'display_mode',
    'render_profile',
    'render_target_fps',
    'render_scale',
    'render_antialias',
    'render_label_fps'
]);

function safeJsonParse(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (e) {
        return fallback;
    }
}

function isAuxiliaryDevice(device) {
    const config = safeJsonParse(device?.instance_config, {});
    return device?.model_type === 'transfer_cart'
        || config.role === 'transfer_cart'
        || config.role === 'auxiliary'
        || config.sceneObject === true;
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();

        const settingsRows = await db.all('SELECT * FROM settings');
        const settings = {};
        settingsRows.forEach(r => {
            if (!LEGACY_WEB_SETTING_KEYS.has(r.key)) settings[r.key] = r.value;
        });

        const workshops = await db.all('SELECT * FROM workshops ORDER BY sort_order ASC');
        const lines = await db.all('SELECT * FROM `lines` ORDER BY sort_order ASC');
        const allDevices = (await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC')).map(device => ({
            ...device,
            plc_protocol: normalizeProtocol(device.plc_protocol || 'S7'),
            plc_options: sanitizePlcOptions(device.plc_protocol || 'S7', device.plc_options)
        }));
        const allPoints = await db.all('SELECT * FROM data_points ORDER BY device_id');

        const pointsByDevice = {};
        allPoints.forEach(p => {
            if (!pointsByDevice[p.device_id]) pointsByDevice[p.device_id] = [];
            pointsByDevice[p.device_id].push(p);
        });

        const normalizedLines = lines.map(line => {
            const layout = normalizeLineLayout(line.layout_json || line.layout);
            const devices = allDevices
                .filter(d => d.line_id === line.id && !isAuxiliaryDevice(d))
                .map(d => ({
                    ...d,
                    dataPoints: pointsByDevice[d.id] || []
                }));
            return { ...line, layout, layout_json: JSON.stringify(layout), devices };
        });
        const pendingLineIds = new Set(
            normalizedLines.filter(line => line.layout.placementPending).map(line => String(line.id))
        );
        const linesWithDevices = normalizedLines.filter(line => !line.layout.placementPending);

        const workshopsWithLines = workshops.map(ws => {
            const layout = normalizeWorkshopLayout(ws.layout_json || ws.layout);
            const wsLines = linesWithDevices.filter(l => l.workshop_id === ws.id);
            const wsLineIds = new Set(wsLines.map(line => line.id));
            const devices = allDevices
                .filter(d => {
                    if (!isAuxiliaryDevice(d)) return false;
                    const config = safeJsonParse(d.instance_config, {});
                    if (pendingLineIds.has(String(d.line_id || ''))
                        || pendingLineIds.has(String(config.laneLineId || ''))
                        || pendingLineIds.has(String(config.railLineId || ''))) return false;
                    return config.workshop_id === ws.id
                        || config.workshopId === ws.id
                        || (d.line_id && wsLineIds.has(d.line_id));
                })
                .map(d => ({
                    ...d,
                    dataPoints: pointsByDevice[d.id] || []
                }));
            return { ...ws, layout, layout_json: JSON.stringify(layout), lines: wsLines, devices };
        });

        const models = mergeBuiltinModels(await db.all('SELECT * FROM models'));
        const { project: activeProject, scene: activeScene } = await getProjectAndScene(db);
        const published = await loadPublishedDocument(db, activeProject, activeScene);
        const runtimeScene = published.document?.sceneId && published.document.sceneId !== activeScene?.id
            ? (await db.get('SELECT * FROM scenes WHERE id = ? AND project_id = ?', [published.document.sceneId, activeProject?.id]) || activeScene)
            : activeScene;

        res.json({
            settings,
            workshops: workshopsWithLines,
            models,
            templatePacks: getHeatTreatmentTemplatePacks(),
            platform: runtimePlatformPayload({
                project: activeProject,
                scene: runtimeScene,
                document: published.document,
                release: published.release
            })
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
