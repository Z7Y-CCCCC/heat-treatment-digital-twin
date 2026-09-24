const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { normalizeSettingValue } = require('./settings');
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
            if (LEGACY_WEB_SETTING_KEYS.has(r.key) || r.key === 'factory_directory') return;
            settings[r.key] = ['factory_location','factory_directory'].includes(r.key)
                ? normalizeSettingValue(r.key, r.value)
                : r.value;
        });
        const factory = await db.get('SELECT id, name, location_json FROM factories WHERE id = ?', [req.factoryId]);
        const factorySettings = await db.all('SELECT `key`, value FROM factory_settings WHERE factory_id = ?', [req.factoryId]);
        factorySettings.forEach(row => { settings[row.key] = row.value; });
        if (factory) {
            settings.factory_name = factory.name;
            settings.factory_location = normalizeSettingValue('factory_location', factory.location_json || '{}');
        }

        const workshops = await db.all('SELECT * FROM workshops WHERE factory_id = ? ORDER BY sort_order ASC', [req.factoryId]);
        const workshopIds = new Set(workshops.map(row => String(row.id)));
        const lines = await db.all(`SELECT l.* FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id
            WHERE w.factory_id = ? ORDER BY l.sort_order ASC`, [req.factoryId]);
        const lineIds = new Set(lines.map(row => String(row.id)));
        const allDevices = (await db.all('SELECT * FROM devices ORDER BY line_id, sort_order ASC')).filter(device => {
            if (lineIds.has(String(device.line_id || ''))) return true;
            if (!isAuxiliaryDevice(device)) return false;
            const config = safeJsonParse(device.instance_config, {});
            return workshopIds.has(String(config.workshop_id || config.workshopId || ''));
        }).map(device => ({
            ...device,
            plc_protocol: normalizeProtocol(device.plc_protocol || 'S7'),
            plc_options: sanitizePlcOptions(device.plc_protocol || 'S7', device.plc_options)
        }));
        const deviceIds = allDevices.map(device => String(device.id));
        const allPoints = deviceIds.length
            ? await db.all(`SELECT * FROM data_points WHERE device_id IN (${deviceIds.map(() => '?').join(',')}) ORDER BY device_id`, deviceIds)
            : [];

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
        const { project: activeProject, scene: activeScene } = await getProjectAndScene(db, '', req.factoryId);
        const published = await loadPublishedDocument(db, activeProject, activeScene);
        const runtimeScene = published.document?.sceneId && published.document.sceneId !== activeScene?.id
            ? (await db.get('SELECT * FROM scenes WHERE id = ? AND project_id = ?', [published.document.sceneId, activeProject?.id]) || activeScene)
            : activeScene;

        res.json({
            settings,
            workshops: workshopsWithLines,
            factoryId: req.factoryId,
            factories: await loadFactorySummaries(db),
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
        console.error('[Config] 加载配置失败:', e.stack || e.message);
        res.status(500).json({ error: e.message });
    }
});

async function loadFactorySummaries(db) {
    const rows = await db.all(`SELECT f.id, f.name, f.location_json, f.is_enabled, f.sort_order,
        COUNT(DISTINCT w.id) AS workshop_count,
        COUNT(DISTINCT l.id) AS line_count,
        COUNT(DISTINCT d.id) AS device_count
        FROM factories f
        LEFT JOIN workshops w ON w.factory_id = f.id
        LEFT JOIN \`lines\` l ON l.workshop_id = w.id
        LEFT JOIN devices d ON d.line_id = l.id
        GROUP BY f.id, f.name, f.location_json, f.is_enabled, f.sort_order
        ORDER BY f.sort_order ASC, f.name ASC`);
    return rows.map(row => ({
        id: String(row.id), name: String(row.name || ''), location: safeJsonParse(row.location_json, {}),
        enabled: Number(row.is_enabled) !== 0,
        workshopCount: Number(row.workshop_count || 0), lineCount: Number(row.line_count || 0), deviceCount: Number(row.device_count || 0)
    }));
}

module.exports = router;
