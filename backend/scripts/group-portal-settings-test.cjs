const assert = require('node:assert/strict');
const { normalizeSettingValue } = require('../routes/settings');

const locatedFactory = JSON.parse(normalizeSettingValue('factory_location', { country: 'CHN', latitude: 39.123456, longitude: 117.123456 }));
assert.equal(locatedFactory.latitude, 39.123456);
assert.equal(locatedFactory.longitude, 117.123456);
assert.throws(() => normalizeSettingValue('factory_location', { latitude: 39.12 }), /同时填写/);
assert.throws(() => normalizeSettingValue('factory_location', { latitude: 91, longitude: 117 }), /纬度/);

const result = JSON.parse(normalizeSettingValue('group_portal_config', {
    brandTitle: '区域生产网络', showPanel: false, accent: '#AABBCC'
}));
assert.equal(result.brandTitle, '区域生产网络');
assert.equal(result.showPanel, false);
assert.equal(result.accent, '#aabbcc');
assert.equal(result.showDock, true);
assert.equal(result.showBrand, true);
assert.equal(result.markerPrimary, '#376ff0');
assert.equal(result.mapZoom, 1.12);
assert.throws(() => normalizeSettingValue('group_portal_config', { accent: 'url(javascript:bad)' }), /颜色/);
assert.throws(() => normalizeSettingValue('group_portal_config', { mapZoom: 2 }), /镜头倍率/);
const layered = JSON.parse(normalizeSettingValue('group_portal_config', {
    logoUrl: '/uploads/brand/logo.png', levels: { province: { showPanel: false, accent: '#ABCDEF', mapZoom: 1.3, factsTitle: '本省工厂', logoUrl: '/uploads/brand/province.png', layout: { panel: { x: 68.5, y: 12 } } } }
}));
assert.equal(layered.logoUrl, '/uploads/brand/logo.png');
assert.equal(layered.levels.province.showPanel, false);
assert.equal(layered.levels.province.accent, '#abcdef');
assert.equal(layered.levels.province.mapZoom, 1.3);
assert.equal(layered.levels.province.factsTitle, '本省工厂');
assert.equal(layered.levels.province.logoUrl, '/uploads/brand/province.png');
assert.throws(() => normalizeSettingValue('group_portal_config', { levels: { province: { logoUrl: 'javascript:alert(1)' } } }), /Logo/);
assert.equal(JSON.parse(normalizeSettingValue('group_portal_config', { levels: { world: { showBrand: false } } })).levels.world.showBrand, false);
assert.deepEqual(layered.levels.province.layout.panel, { x: 68.5, y: 12 });
const metricBinding = { mode:'http_api', connectionId:'erp_api', apiPath:'/metrics', jsonPath:'data.factoryCount', refreshMs:30000 };
const withBindings = JSON.parse(normalizeSettingValue('group_portal_config', { levels:{ province:{ dataBindings:{ factsFactoryCount:metricBinding } } } }));
assert.deepEqual(withBindings.levels.province.dataBindings.factsFactoryCount, { ...metricBinding, factoryId:'' });
assert.throws(() => normalizeSettingValue('group_portal_config', { levels:{ province:{ dataBindings:{ factsFactoryCount:{...metricBinding,apiPath:'../admin'} } } } }), /路径|无效/);
assert.throws(() => normalizeSettingValue('group_portal_config', { levels:{ province:{ dataBindings:{ unknown:metricBinding } } } }), /数据绑定无效/);
assert.throws(() => normalizeSettingValue('group_portal_config', { levels: { city: { layout: { panel: { x: 150, y: 12 } } } } }), /布局位置/);
assert.throws(() => normalizeSettingValue('group_portal_config', { logoUrl: 'javascript:alert(1)' }), /Logo/);
assert.throws(() => normalizeSettingValue('group_portal_config', { levels: { city: { accent: 'red' } } }), /颜色/);
const loading = JSON.parse(normalizeSettingValue('loading_experience_config', { preset: 'quiet', title: '加载地图', accent: '#ABCDEF' }));
assert.equal(loading.preset, 'quiet');
assert.equal(loading.accent, '#abcdef');
const imageUrl = `/uploads/appearance/${'a'.repeat(32)}.png`;
assert.equal(JSON.parse(normalizeSettingValue('loading_experience_config', { imageUrl })).imageUrl, imageUrl);
assert.throws(() => normalizeSettingValue('loading_experience_config', { imageUrl: '/uploads/../secret.png' }), /上传/);
assert.throws(() => normalizeSettingValue('loading_experience_config', { preset: 'untrusted' }), /方案/);
console.log('Group portal and loading appearance setting: checks passed.');
