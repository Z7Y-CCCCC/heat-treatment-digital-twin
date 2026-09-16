const express = require('express');
const { getDb } = require('../db/database');

const MAX_DASHBOARD_CONFIG_BYTES = 256 * 1024;
const JSON_OBJECT_SETTING_LABELS = {
    native_dashboard_config: 'Unity 大屏组件配置',
    native_environment_config: 'Unity 场景与光效配置'
};
const NATIVE_QUALITY_PROFILES = new Set(['auto', 'integrated_gpu', 'balanced', 'showcase']);
const LEGACY_WEB_SETTING_KEYS = new Set([
    'display_mode',
    'render_profile',
    'render_target_fps',
    'render_scale',
    'render_antialias',
    'render_label_fps'
]);

function normalizeSettingValue(key, value) {
    if (key === 'simulation_interval_ms') {
        const interval = Number(value);
        if (!Number.isInteger(interval) || interval < 100 || interval > 60000) {
            throw new Error('模拟采样间隔必须是 100-60000 毫秒之间的整数');
        }
        return String(interval);
    }
    if (key === 'native_quality_profile') {
        const profile = String(value ?? '').trim().toLowerCase();
        if (!NATIVE_QUALITY_PROFILES.has(profile)) {
            throw new Error('Unity 画质档位无效，只能选择自动识别、核显稳定档、均衡专业档或展示高画质档');
        }
        return profile;
    }
    const label = JSON_OBJECT_SETTING_LABELS[key];
    if (!label) return String(value);

    const text = typeof value === 'string' ? value : JSON.stringify(value || {});
    if (Buffer.byteLength(text, 'utf8') > MAX_DASHBOARD_CONFIG_BYTES) {
        throw new Error(`${label}过大`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`${label}不是有效 JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label}必须是 JSON 对象`);
    }
    return JSON.stringify(parsed);
}

module.exports = function createSettingsRouter(controller = {}) {
    const router = express.Router();

    router.get('/', async (req, res) => {
        try {
            const db = await getDb();
            const rows = await db.all('SELECT * FROM settings');
            const settings = {};
            rows.forEach(r => {
                if (!LEGACY_WEB_SETTING_KEYS.has(r.key)) settings[r.key] = r.value;
            });
            res.json(settings);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.put('/', async (req, res) => {
        try {
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                throw new Error('设置内容必须是 JSON 对象');
            }
            const changed = Object.fromEntries(Object.entries(req.body)
                .filter(([key]) => !LEGACY_WEB_SETTING_KEYS.has(key))
                .map(([key, value]) => [key, normalizeSettingValue(key, value)]));
            const db = await getDb();
            await db.transaction(async tx => {
                for (const [key, value] of Object.entries(changed)) {
                    await tx.upsert('settings', { key, value }, 'key');
                }
            });
            controller.wsServer?.broadcast('configuration_changed', {
                keys: Object.keys(changed),
                settings: changed,
                timestamp: Date.now()
            });
            res.json({ success: true, changedKeys: Object.keys(changed) });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    return router;
};
