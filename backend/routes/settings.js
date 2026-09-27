const express = require('express');
const { getDb } = require('../db/database');

const MAX_DASHBOARD_CONFIG_BYTES = 256 * 1024;
const JSON_OBJECT_SETTING_LABELS = {
    native_dashboard_config: 'Unity 大屏组件配置',
    native_environment_config: 'Unity 场景与光效配置',
    factory_location: '工厂地理位置',
    factory_directory: '工厂登记簿',
    group_portal_config: '集团首页外观',
    site_scene_config: '工厂街道与建筑配置',
    loading_experience_config: '加载画面配置'
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
    'native_environment_config', 'native_dashboard_config', 'site_scene_config'
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
        const coordinate = (value, limit, label) => {
            if (value === undefined || value === null || value === '') return null;
            const number = Number(value);
            if (typeof value === 'object' || !Number.isFinite(number) || Math.abs(number) > limit) throw new Error(`${label}必须在 ${-limit} 到 ${limit} 之间`);
            return number;
        };
        const latitude = coordinate(parsed.latitude,90,'纬度');
        const longitude = coordinate(parsed.longitude,180,'经度');
        if ((latitude === null) !== (longitude === null)) throw new Error('工厂定位需要同时填写纬度和经度，或同时留空');
        return JSON.stringify({country,regionCode:adcode(parsed.regionCode),
            regionName:String(parsed.regionName || '').slice(0,100),cityCode:adcode(parsed.cityCode),city:String(parsed.city || '').slice(0,200),
            districtCode:adcode(parsed.districtCode),districtName:String(parsed.districtName || '').slice(0,100),
            latitude,longitude});
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
    if (key === 'site_scene_config') {
        const imageUrl = String(parsed.streetImageUrl || '').trim();
        if (imageUrl && !/^\/uploads\/appearance\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(imageUrl))
            throw new Error('街道背景图片必须通过设计器上传');
        const text = (field, fallback, maxLength) => String(parsed[field] ?? fallback).trim().slice(0, maxLength) || fallback;
        const visible = field => {
            if (parsed[field] === undefined) return true;
            if (typeof parsed[field] !== 'boolean') throw new Error(`${field} 必须为开关值`);
            return parsed[field];
        };
        const accent = String(parsed.accent ?? '#aebaff').trim().toLowerCase();
        if (!/^#[a-f0-9]{6}$/.test(accent)) throw new Error('街道与工厂强调色必须是六位十六进制颜色');
        const slots = {}, occupied = new Set();
        const entries = parsed.buildingSlots && typeof parsed.buildingSlots === 'object' && !Array.isArray(parsed.buildingSlots)
            ? Object.entries(parsed.buildingSlots) : [];
        if (entries.length > 40) throw new Error('车间建筑位最多 40 项');
        for (const [workshopId, rawSlot] of entries) {
            const slot = Number(rawSlot);
            if (!/^[\w-]{1,120}$/.test(workshopId) || !Number.isInteger(slot) || slot < 0 || slot >= 40 || occupied.has(slot))
                throw new Error('车间建筑位无效或重复');
            occupied.add(slot); slots[workshopId] = slot;
        }
        const legacyFactoryDescription = '点击已配置的车间建筑进入 Unity 车间模型；办公与公辅建筑仅作园区示意。';
        const defaultFactoryDescription = '点击厂区模型进入全厂总览，再从总览中选择具体车间。';
        const factoryDescription = text('factoryDescription', defaultFactoryDescription, 240);
        return JSON.stringify({version:1,streetImageUrl:imageUrl,buildingSlots:slots,
            streetTitle:text('streetTitle','生产运营 · 街道视角',80),factoryTitle:text('factoryTitle','生产运营 · 工厂总览',80),
            streetDescription:text('streetDescription','工厂园区包含车间、办公与公辅建筑。鼠标拖动可改变观察方向，点击园区继续下探。',240),
            factoryDescription:[legacyFactoryDescription, '240'].includes(factoryDescription) ? defaultFactoryDescription : factoryDescription,
            accent,showBrand:visible('showBrand'),showBreadcrumbs:visible('showBreadcrumbs'),
            showInfoPanel:visible('showInfoPanel'),showBeacon:visible('showBeacon'),showFooter:visible('showFooter')});
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
        const toggleKeys = ['showBrand', 'showFacts', 'showPanel', 'showDock', 'showHelp'];
        const titleKeys = ['brandTitle', 'brandSubtitle', 'panelTitle', 'factsTitle', 'dockNetworkTitle', 'dockLocationTitle', 'dockHierarchyTitle'];
        const validLogoUrl = url => !url || /^\/(?!\/)[\w/%.~+-]+$/.test(url) || /^https:\/\/[\w.-]+(?:\/[\w/%?&=.#~+-]*)?$/.test(url);
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
            for (const field of titleKeys) if (typeof source[field] === 'string' && source[field].trim()) override[field] = source[field].trim().slice(0, 80);
            if (source.logoUrl) {
                const levelLogoUrl = String(source.logoUrl).trim().slice(0, 400);
                if (!validLogoUrl(levelLogoUrl)) throw new Error(`${levelKey}.Logo 地址必须是站内路径或 HTTPS 图片地址`);
                override.logoUrl = levelLogoUrl;
            }
            if (source.mapZoom !== undefined) {
                const zoom = Number(source.mapZoom);
                if (!Number.isFinite(zoom) || zoom < 0.8 || zoom > 1.5) throw new Error(`${levelKey}.mapZoom 必须在 0.8–1.5 之间`);
                override.mapZoom = zoom;
            }
            if (source.layout && typeof source.layout === 'object' && !Array.isArray(source.layout)) {
                const layout = {};
                for (const key of ['brand', 'facts', 'panel', 'dock']) {
                    const item = source.layout[key];
                    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
                    const x = Number(item.x), y = Number(item.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 95 || y < 0 || y > 95)
                        throw new Error(`${levelKey}.${key} 布局位置无效`);
                    layout[key] = { x, y };
                }
                override.layout = layout;
            }
            levels[levelKey] = override;
        }
        const logoUrl = String(parsed.logoUrl || '').trim().slice(0, 400);
        if (!validLogoUrl(logoUrl)) throw new Error('大屏 Logo 地址必须是站内路径或 HTTPS 图片地址');
        return JSON.stringify({
            brandTitle: textField('brandTitle', '生产运营 · 集团总览', 60),
            brandSubtitle: textField('brandSubtitle', 'GLOBAL PRODUCTION MANAGEMENT', 80),
            panelTitle: textField('panelTitle', 'OPERATING NETWORK', 60),
            factsTitle: textField('factsTitle', '登记工厂', 60),
            dockNetworkTitle: textField('dockNetworkTitle', '站点网络', 60),
            dockLocationTitle: textField('dockLocationTitle', '行政区归属', 60),
            dockHierarchyTitle: textField('dockHierarchyTitle', '本机现场配置', 60),
            logoUrl,
            levels,
            showBrand: parsed.showBrand !== false,
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
    if (key === 'loading_experience_config') {
        const preset = String(parsed.preset || 'interactive');
        if (!['interactive', 'quiet'].includes(preset)) throw new Error('加载画面方案无效');
        const imageUrl = String(parsed.imageUrl || '').trim();
        if (imageUrl && !/^\/uploads\/appearance\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(imageUrl))
            throw new Error('加载图片必须通过设计器上传');
        const colors = {};
        for (const [field, fallback] of [['background', '#28282b'], ['accent', '#a8c3b1']]) {
            const color = String(parsed[field] || fallback).trim();
            if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`加载画面 ${field} 颜色无效`);
            colors[field] = color.toLowerCase();
        }
        return JSON.stringify({
            preset,
            title: String(parsed.title || '正在准备生产现场').trim().slice(0, 48),
            kicker: String(parsed.kicker || 'HEAT TREATMENT / DIGITAL TWIN').trim().slice(0, 72),
            imageUrl,
            ...colors
        });
    }
    return JSON.stringify(parsed);
}

module.exports = function createSettingsRouter(controller = {}) {
    const router = express.Router();

    router.get('/loading-experience', async (req, res) => {
        try {
            const db = await getDb();
            const row = await db.get('SELECT value FROM settings WHERE `key` = ?', ['loading_experience_config']);
            res.setHeader('Cache-Control', 'no-store');
            res.json({ config: JSON.parse(normalizeSettingValue('loading_experience_config', row?.value || {})) });
        } catch (error) {
            res.status(500).json({ error: '加载画面配置暂不可用' });
        }
    });

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
