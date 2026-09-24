const assert = require('node:assert/strict');
const { normalizeSettingValue } = require('../routes/settings');

const result = JSON.parse(normalizeSettingValue('group_portal_config', {
    brandTitle: '区域生产网络', showPanel: false, accent: '#AABBCC'
}));
assert.equal(result.brandTitle, '区域生产网络');
assert.equal(result.showPanel, false);
assert.equal(result.accent, '#aabbcc');
assert.equal(result.showDock, true);
assert.equal(result.markerPrimary, '#376ff0');
assert.equal(result.mapZoom, 1.12);
assert.throws(() => normalizeSettingValue('group_portal_config', { accent: 'url(javascript:bad)' }), /颜色/);
assert.throws(() => normalizeSettingValue('group_portal_config', { mapZoom: 2 }), /镜头倍率/);
console.log('Group portal appearance setting: 8 checks passed.');
