const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { normalizeSettingValue } = require('./settings');
const { searchFactoryPlace } = require('../services/factoryGeocoder');
const { summarizeFactoryCollection } = require('../services/factoryCollectionSummary');

const router = express.Router();

router.post('/place-search', async (req, res) => {
    try {
        const results = await searchFactoryPlace(req.body?.countryCode, req.body?.query);
        res.json({ results, attribution: '© OpenStreetMap contributors' });
    } catch (error) {
        res.status(/请选择海外国家/.test(error.message) ? 400 : 502).json({ error: error.message || '地点查询失败' });
    }
});

function parseLocation(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return {}; }
}

function publicFactory(row) {
    return {
        id: String(row.id),
        name: String(row.name || ''),
        location: parseLocation(row.location_json),
        enabled: Number(row.is_enabled) !== 0,
        collectionEnabled: Number(row.collection_enabled ?? 1) !== 0,
        sortOrder: Number(row.sort_order || 0),
        workshopCount: Number(row.workshop_count || 0),
        lineCount: Number(row.line_count || 0),
        deviceCount: Number(row.device_count || 0)
    };
}

function notifyFactoryDirectory(factoryId, visibilityOnly = false, enabled = true) {
    global.wsServer?.broadcast?.('configuration_changed', {
        factoryId: String(factoryId), resource: 'factories', reloadRequired: !visibilityOnly,
        ...(visibilityOnly ? { visibilityOnly: true, enabled, settings: {} } : {}),
        keys: visibilityOnly ? ['factory_visibility'] : ['factory_name', 'factory_location'], timestamp: Date.now()
    });
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
        const rows = await db.all(`SELECT f.id, f.name, f.location_json, f.is_enabled, f.collection_enabled, f.sort_order,
            COUNT(DISTINCT w.id) AS workshop_count,
            COUNT(DISTINCT l.id) AS line_count,
            COUNT(DISTINCT d.id) AS device_count
            FROM factories f
            LEFT JOIN workshops w ON w.factory_id = f.id
            LEFT JOIN \`lines\` l ON l.workshop_id = w.id
            LEFT JOIN devices d ON d.line_id = l.id
            GROUP BY f.id, f.name, f.location_json, f.is_enabled, f.collection_enabled, f.sort_order
            ORDER BY f.sort_order ASC, f.name ASC`);
        const active = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
        res.json({ factories: rows.map(publicFactory), activeFactoryId: String(active?.value || 'factory_default') });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/collection-status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        const db = await getDb();
        const factories = await db.all(`SELECT f.id, f.collection_enabled,
            COALESCE(local_mode.value, global_mode.value, 'integrated_plc') AS mode,
            COALESCE(local_interval.value, global_interval.value, '2000') AS simulation_interval_ms
            FROM factories f
            LEFT JOIN factory_settings local_mode ON local_mode.factory_id=f.id AND local_mode.\`key\`='data_mode'
            LEFT JOIN settings global_mode ON global_mode.\`key\`='data_mode'
            LEFT JOIN factory_settings local_interval ON local_interval.factory_id=f.id AND local_interval.\`key\`='simulation_interval_ms'
            LEFT JOIN settings global_interval ON global_interval.\`key\`='simulation_interval_ms'
            ORDER BY f.sort_order ASC, f.name ASC`);
        const devices = await db.all(`SELECT d.id, d.plc_enabled, w.factory_id FROM devices d
            JOIN \`lines\` l ON l.id=d.line_id JOIN workshops w ON w.id=l.workshop_id`);
        const grouped = new Map();
        for (const device of devices) { const id = String(device.factory_id); if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(device); }
        const statuses = global.dataEngine?.getFactoryStatuses?.() || {}, processStatus = global.dataEngine?.getStatus?.().process?.status;
        const now = Date.now();
        res.json({ success: true, pluginInstalled: global.dataEngine?.getStatus?.().plugin?.installed !== false, timestamp: now, factories: factories.map(factory => summarizeFactoryCollection(factory, grouped.get(String(factory.id)) || [], statuses[factory.id], processStatus, now)) });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

router.get('/live-summaries', async (req, res) => {
    try {
        const db = await getDb();
        const factories = await db.all('SELECT id FROM factories WHERE is_enabled <> 0 ORDER BY sort_order ASC');
        const statuses = global.dataEngine?.getFactoryStatuses?.() || {};
        const now = Date.now();
        const summaries = factories.map(factory => {
            const factoryId = String(factory.id);
            const latest = statuses[factoryId]?.metricSummary || null;
            const collector = statuses[factoryId]?.collectorStatus || {};
            const frameAt = Number(collector.lastFrameAt) || 0;
            const savedAt = Number(statuses[factoryId]?.lastMetricSavedAt) || 0;
            const fresh = !!latest && collector.status === 'connected' && frameAt > 0 && savedAt > 0 && now - frameAt < 15000 && now - savedAt < 15000;
            return {
                factoryId,
                status: fresh ? 'live' : latest ? 'stale' : 'no_data',
                mode: statuses[factoryId]?.mode || '',
                updatedAt: fresh ? frameAt : null,
                runningDevices: fresh ? Number(latest.runningDevices || 0) : null,
                onlineDevices: fresh ? Number(latest.onlineDevices || 0) : null,
                alarmDevices: fresh ? Number(latest.alarmDevices || 0) : null,
                totalDevices: fresh ? Number(latest.totalDevices || 0) : null,
                overallOee: fresh ? Number(latest.overallOee || 0) : null
            };
        });
        res.json({ timestamp: now, summaries });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        if (!name || name.length > 120) return res.status(400).json({ error: '工厂名称不能为空且不能超过 120 个字符' });
        const location = normalizeSettingValue('factory_location', req.body?.location || {});
        const db = await getDb();
        const factoryId = `factory_${crypto.randomBytes(10).toString('hex')}`;
        const projectId = `${factoryId}_project`;
        const sceneId = `${factoryId}_scene`;
        const maxOrder = await db.get('SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM factories');
        await db.transaction(async tx => {
            await tx.run(`INSERT INTO factories (id, name, location_json, is_enabled, sort_order)
                VALUES (?, ?, ?, 1, ?)`, [factoryId, name, location, Number(maxOrder?.max_order ?? -1) + 1]);
            await tx.run(`INSERT INTO projects (id, factory_id, name, description, is_active)
                VALUES (?, ?, ?, ?, 1)`, [projectId, factoryId, `${name}数字孪生项目`, '按工厂独立维护的场景项目']);
            await tx.run(`INSERT INTO scenes (id, project_id, name, scene_type, layout_json, camera_json, theme_json, is_active, sort_order)
                VALUES (?, ?, ?, 'factory_overview', '{}', '{}', '{}', 1, 0)`, [sceneId, projectId, `${name}总览`]);
            const defaults = await tx.all('SELECT `key`, value FROM factory_settings WHERE factory_id = ?', ['factory_default']);
            for (const setting of defaults) {
                await tx.run('INSERT INTO factory_settings (factory_id, `key`, value) VALUES (?, ?, ?)', [factoryId, setting.key, setting.value]);
            }
        });
        notifyFactoryDirectory(factoryId);
        res.status(201).json({ success: true, factory: publicFactory({ id: factoryId, name, location_json: location, is_enabled: 1, sort_order: Number(maxOrder?.max_order ?? -1) + 1 }) });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const current = await db.get('SELECT * FROM factories WHERE id = ?', [req.params.id]);
        if (!current) return res.status(404).json({ error: '工厂不存在' });
        const name = req.body?.name === undefined ? current.name : String(req.body.name || '').trim();
        if (!name || name.length > 120) return res.status(400).json({ error: '工厂名称不能为空且不能超过 120 个字符' });
        const location = req.body?.location === undefined
            ? current.location_json
            : normalizeSettingValue('factory_location', req.body.location);
        if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: '大屏显示状态须为布尔值' });
        if (Object.hasOwn(req.body || {}, 'collectionEnabled')) return res.status(400).json({ error: '请在数据通路中设置采集开关' });
        const enabled = req.body?.enabled === undefined ? Number(current.is_enabled) !== 0 : req.body.enabled === true;
        await db.run('UPDATE factories SET name = ?, location_json = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [name, location, enabled ? 1 : 0, req.params.id]);
        notifyFactoryDirectory(req.params.id, Object.keys(req.body || {}).every(key => key === 'enabled'), enabled);
        res.json({ success: true, factory: publicFactory({ ...current, name, location_json: location, is_enabled: enabled ? 1 : 0 }) });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// This is deliberately a separate operation/permission from map visibility.
router.put('/:id/collection', async (req, res) => {
    try {
        if (typeof req.body?.enabled !== 'boolean' || Object.keys(req.body).some(key => key !== 'enabled')) {
            return res.status(400).json({ error: '请提供采集开关状态' });
        }
        const db = await getDb();
        const factory = await db.get('SELECT id FROM factories WHERE id = ?', [req.params.id]);
        if (!factory) return res.status(404).json({ error: '工厂不存在' });
        await db.run('UPDATE factories SET collection_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.body.enabled ? 1 : 0, factory.id]);
        let runtimeApplied = false;
        try {
            if (global.dataEngine?.setFactoryCollectionEnabled) {
                await global.dataEngine.setFactoryCollectionEnabled(String(factory.id));
                runtimeApplied = true;
            }
        } catch (error) { console.warn('[Factories] 采集开关已保存，等待采集进程恢复:', error.message); }
        // Not a scene change: do not reload Unity or restart other factories.
        global.wsServer?.broadcast?.('factory_collection_changed', { factoryId: String(factory.id), collectionEnabled: req.body.enabled, timestamp: Date.now() });
        res.json({ success: true, factoryId: String(factory.id), collectionEnabled: req.body.enabled, runtimeApplied });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

router.post('/:id/activate', async (req, res) => {
    try {
        const db = await getDb();
        const factory = await db.get('SELECT id, name FROM factories WHERE id = ? AND is_enabled <> 0', [req.params.id]);
        if (!factory) return res.status(404).json({ error: '工厂不存在或未在大屏显示' });
        const hierarchy = await db.get(`SELECT
            (SELECT COUNT(*) FROM workshops WHERE factory_id = ?) AS workshop_count,
            (SELECT COUNT(*) FROM \`lines\` l JOIN workshops w ON w.id = l.workshop_id WHERE w.factory_id = ?) AS line_count,
            (SELECT COUNT(*) FROM devices d JOIN \`lines\` l ON l.id = d.line_id JOIN workshops w ON w.id = l.workshop_id WHERE w.factory_id = ?) AS device_count`,
            [factory.id, factory.id, factory.id]);
        const missing = !Number(hierarchy?.workshop_count) ? '车间' : !Number(hierarchy?.line_count) ? '产线' : !Number(hierarchy?.device_count) ? '设备' : '';
        if (missing) return res.status(409).json({ error: `该工厂尚未配置${missing}，请先在后台完成配置，暂不能进入三维总览`, missingLevel: missing });
        const active = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
        if (String(active?.value || '') === String(factory.id)) {
            return res.json({ success: true, activeFactoryId: String(factory.id), factoryName: factory.name });
        }
        await db.upsert('settings', { key: 'active_factory_id', value: String(factory.id) }, 'key');
        require('../services/dataSources').reloadDataSourceConfiguration(String(factory.id));
        global.dataEngine?.restart?.().catch(error => console.warn('[Factories] 切换工厂后重启采集器失败:', error.message));
        global.wsServer?.broadcast?.('configuration_changed', {
            keys: ['active_factory_id', 'factory_name', 'factory_location'],
            activeFactoryId: String(factory.id),
            factoryName: factory.name,
            timestamp: Date.now()
        });
        res.json({ success: true, activeFactoryId: String(factory.id), factoryName: factory.name });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
