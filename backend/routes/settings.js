const express = require('express');
const { getDb } = require('../db/database');

const MAX_DASHBOARD_CONFIG_BYTES = 256 * 1024;
const JSON_OBJECT_SETTING_LABELS = {
    native_dashboard_config: 'Unity 大屏组件配置',
    native_environment_config: 'Unity 场景与光效配置',
    factory_location: '工厂地理位置',
    factory_directory: '工厂登记簿',
    group_portal_config: '集团首页外观'
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
const FACTORY_SETTING_KEYS = new Set([
    'data_mode', 'simulation_interval_ms', 'realtime_stale_ms', 'native_quality_profile',
    'native_environment_config', 'native_dashboard_config'
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
    if (key === 'factory_location') {
        const rawCountry = String(parsed.country || 'CHN').trim().toUpperCase();
        const country = rawCountry === 'CN' ? 'CHN' : rawCountry;
        if (!/^[A-Z]{3}$/.test(country)) throw new Error('国家代码必须是三个字母，例如 CHN');
        const adcode = value => /^\d{6}$/.test(String(value || '').trim()) ? String(value).trim() : '';
        return JSON.stringify({country,regionCode:adcode(parsed.regionCode),
            regionName:String(parsed.regionName || '').slice(0,100),cityCode:adcode(parsed.cityCode),city:String(parsed.city || '').slice(0,200),
            districtCode:adcode(parsed.districtCode),districtName:String(parsed.districtName || '').slice(0,100)});
    }
    if (key === 'factory_directory') {
        if (!Array.isArray(parsed.sites) || parsed.sites.length > 200) throw new Error('工厂登记簿必须包含 sites 数组，最多 200 项');
        const ids = new Set();
        const sites = parsed.sites.map((site, index) => {
            if (!site || typeof site !== 'object' || Array.isArray(site)) throw new Error(`第 ${index + 1} 项工厂登记无效`);
            const id = String(site.id || '');
            const name = String(site.name || '').trim();
            if (!/^site_[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('登记工厂 ID 必须以 site_ 开头，仅包含字母、数字、横线或下划线');
            if (ids.has(id)) throw new Error(`登记工厂 ID 重复：${id}`);
            if (!name || name.length > 120) throw new Error('工厂名称不能为空且不能超过 120 字');
            ids.add(id);
            // A directory entry is metadata, not an authenticated connection.
            // Never accept a caller-supplied runtime flag, URL or credentials.
            return { id, name, location: JSON.parse(normalizeSettingValue('factory_location', site.location || {})) };
        });
        return JSON.stringify({ version: 1, sites });
    }
    if (key === 'group_portal_config') {
        const textField = (name, fallback, limit) => String(parsed[name] ?? fallback).trim().slice(0, limit);
        const colorField = (name, fallback) => {
            const color = String(parsed[name] ?? fallback).trim();
            if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`${name} 必须是六位十六进制颜色`);
            return color.toLowerCase();
        };
        const levelKeys = ['world', 'country', 'province', 'city', 'district'];
        const colorKeys = ['background', 'panelSurface', 'accent', 'text', 'mapBase', 'mapMuted', 'markerPrimary', 'markerTip'];
        const toggleKeys = ['showFacts', 'showPanel', 'showDock', 'showHelp'];
        const levels = {};
        for (const levelKey of levelKeys) {
            const source = parsed.levels?.[levelKey];
            if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
            const override = {};
            for (const field of toggleKeys) if (typeof source[field] === 'boolean') override[field] = source[field];
            for (const field of colorKeys) {
                if (source[field] === undefined) continue;
                const color = String(source[field]).trim();
                if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`${levelKey}.${field} 必须是六位十六进制颜色`);
                override[field] = color.toLowerCase();
            }
            if (typeof source.panelTitle === 'string' && source.panelTitle.trim()) override.panelTitle = source.panelTitle.trim().slice(0, 60);
            if (source.mapZoom !== undefined) {
                const zoom = Number(source.mapZoom);
                if (!Number.isFinite(zoom) || zoom < 0.8 || zoom > 1.5) throw new Error(`${levelKey}.mapZoom 必须在 0.8–1.5 之间`);
                override.mapZoom = zoom;
            }
            levels[levelKey] = override;
        }
        const logoUrl = String(parsed.logoUrl || '').trim().slice(0, 400);
        if (logoUrl && !/^\/(?!\/)[\w/%.~+-]+$/.test(logoUrl)
            && !/^https:\/\/[\w.-]+(?:\/[\w/%?&=.#~+-]*)?$/.test(logoUrl)) throw new Error('大屏 Logo 地址必须是站内路径或 HTTPS 图片地址');
        return JSON.stringify({
            brandTitle: textField('brandTitle', '生产运营 · 集团总览', 60),
            brandSubtitle: textField('brandSubtitle', 'GLOBAL PRODUCTION MANAGEMENT', 80),
            panelTitle: textField('panelTitle', 'OPERATING NETWORK', 60),
            logoUrl,
            levels,
            showFacts: parsed.showFacts !== false,
            showPanel: parsed.showPanel !== false,
            showDock: parsed.showDock !== false,
            showHelp: parsed.showHelp !== false,
            background: colorField('background', '#303134'),
            panelSurface: colorField('panelSurface', '#3d3d40'),
            accent: colorField('accent', '#9caaff'),
            text: colorField('text', '#e5e3de'),
            mapBase: colorField('mapBase', '#747682'),
            mapMuted: colorField('mapMuted', '#494b52'),
            markerPrimary: colorField('markerPrimary', '#376ff0'),
            markerTip: colorField('markerTip', '#bbfff0'),
            mapZoom: (() => {
                const zoom = Number(parsed.mapZoom ?? 1.12);
                if (!Number.isFinite(zoom) || zoom < 0.8 || zoom > 1.5) throw new Error('地图初始镜头倍率必须在 0.8–1.5 之间');
                return zoom;
            })()
        });
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
                if (LEGACY_WEB_SETTING_KEYS.has(r.key) || r.key === 'factory_directory') return;
                settings[r.key] = ['factory_location','factory_directory'].includes(r.key)
                    ? normalizeSettingValue(r.key, r.value)
                    : r.value;
            });
            const factory = await db.get('SELECT name, location_json FROM factories WHERE id = ?', [req.factoryId]);
            const factoryRows = await db.all('SELECT `key`, value FROM factory_settings WHERE factory_id = ?', [req.factoryId]);
            factoryRows.forEach(row => {
                if (FACTORY_SETTING_KEYS.has(row.key)) settings[row.key] = row.value;
            });
            if (factory) {
                settings.factory_name = factory.name;
                settings.factory_location = normalizeSettingValue('factory_location', factory.location_json || '{}');
            }
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
            if (Object.hasOwn(changed, 'factory_directory')) throw new Error('工厂登记簿已升级为真实工厂管理，请在工厂管理中新增和维护工厂');
            const db = await getDb();
            await db.transaction(async tx => {
                for (const [key, value] of Object.entries(changed)) {
                    if (key === 'factory_name' || key === 'factory_location') {
                        const factory = await tx.get('SELECT id FROM factories WHERE id = ?', [req.factoryId]);
                        if (!factory) throw new Error('当前工厂不存在，请刷新工厂列表');
                        if (key === 'factory_name') {
                            const name = String(value || '').trim();
                            if (!name || name.length > 120) throw new Error('工厂名称不能为空且不能超过 120 个字符');
                            await tx.run('UPDATE factories SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [name, req.factoryId]);
                        } else {
                            await tx.run('UPDATE factories SET location_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [value, req.factoryId]);
                        }
                    } else if (FACTORY_SETTING_KEYS.has(key)) {
                        const existing = await tx.get('SELECT 1 FROM factory_settings WHERE factory_id = ? AND `key` = ?', [req.factoryId, key]);
                        if (existing) await tx.run('UPDATE factory_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE factory_id = ? AND `key` = ?', [value, req.factoryId, key]);
                        else await tx.run('INSERT INTO factory_settings (factory_id, `key`, value) VALUES (?, ?, ?)', [req.factoryId, key, value]);
                    } else {
                        await tx.upsert('settings', { key, value }, 'key');
                    }
                }
            });
            controller.wsServer?.broadcast('configuration_changed', {
                keys: Object.keys(changed),
                settings: changed,
                factoryId: req.factoryId,
                timestamp: Date.now()
            });
            res.json({ success: true, changedKeys: Object.keys(changed) });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    return router;
};

module.exports.normalizeSettingValue = normalizeSettingValue;
