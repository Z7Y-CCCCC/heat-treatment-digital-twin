const assert = require('node:assert/strict');
const { normalizeDocument, defaultDashboardViews } = require('../utils/dashboardDocument');

const mapIds = ['map_world', 'map_country', 'map_province', 'map_city', 'map_district', 'site_street', 'site_factory'];
const widget = {
    id: 'widget_map_test', type: 'value', title: '地图指标', runtimeTarget: 'overlay',
    frame: { x: 410, y: 290, width: 250, height: 100 },
    data: { mode: 'static', readOnly: true }
};
const legacy = normalizeDocument({
    scene: { defaultViewId: 'factory_overview', views: [defaultDashboardViews()[0]] },
    widgets: [widget]
});
assert.equal(legacy.scene.defaultViewId, 'factory_overview');
for (const id of mapIds) assert.ok(legacy.scene.views.some(view => view.id === id), `${id} missing`);
assert.equal(legacy.scene.views.find(view => view.id === 'site_street').name, '06 街道示意');
assert.equal(legacy.scene.views.find(view => view.id === 'site_factory').name, '07 工厂建筑');
const oldLabel = normalizeDocument({ scene: { views: [{ id: 'site_factory', name: '06 工厂建筑', mode: 'custom' }] } });
assert.equal(oldLabel.scene.views.find(view => view.id === 'site_factory').name, '07 工厂建筑');
const customLabel = normalizeDocument({ scene: { views: [{ id: 'site_factory', name: '自定义厂区', mode: 'custom' }] } });
assert.equal(customLabel.scene.views.find(view => view.id === 'site_factory').name, '自定义厂区');
legacy.scene.views.find(view => view.id === 'map_city').componentState.show.push(widget.id);
legacy.scene.views.find(view => view.id === 'map_district').componentState.hide.push(widget.id);
const saved = normalizeDocument(legacy);
assert.deepEqual(saved.scene.views.find(view => view.id === 'map_city').componentState.show, [widget.id]);
assert.deepEqual(saved.scene.views.find(view => view.id === 'map_district').componentState.hide, [widget.id]);
assert.equal(saved.widgets.find(item => item.id === widget.id).frame.x, 410);
console.log('map surface schema passed');
