const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { normalizeSettingValue } = require('./settings');

const router = express.Router();

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
        sortOrder: Number(row.sort_order || 0),
        workshopCount: Number(row.workshop_count || 0),
        lineCount: Number(row.line_count || 0),
        deviceCount: Number(row.device_count || 0)
    };
}

router.get('/', async (req, res) => {
    try {
        const db = await getDb();
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
        const active = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
        res.json({ factories: rows.map(publicFactory), activeFactoryId: String(active?.value || 'factory_default') });
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
        const active = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
        const enabled = req.body?.enabled === undefined ? Number(current.is_enabled) !== 0 : req.body.enabled === true;
        if (!enabled && (String(req.params.id) === 'factory_default' || String(active?.value) === String(req.params.id))) {
            return res.status(409).json({ error: '默认工厂或当前运行工厂不能停用，请先切换运行工厂' });
        }
        await db.run('UPDATE factories SET name = ?, location_json = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [name, location, enabled ? 1 : 0, req.params.id]);
        res.json({ success: true, factory: publicFactory({ ...current, name, location_json: location, is_enabled: enabled ? 1 : 0 }) });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

router.post('/:id/activate', async (req, res) => {
    try {
        const db = await getDb();
        const factory = await db.get('SELECT id, name FROM factories WHERE id = ? AND is_enabled <> 0', [req.params.id]);
        if (!factory) return res.status(404).json({ error: '工厂不存在或已停用' });
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
