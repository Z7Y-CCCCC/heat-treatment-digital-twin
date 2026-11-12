'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { verifyDefaultDashboardTemplate } = require('../../backend/services/defaultDashboardTemplate');
function verifyPackagedDefaultTemplate(resources) {
    const manifest = 'shared/defaultDashboardTemplate.mjs';
    if (fs.readFileSync(path.join(resources, manifest), 'utf8') !== fs.readFileSync(path.resolve(__dirname, '../..', manifest), 'utf8')) throw new Error('安装资源的默认模板身份文件与仓库不一致');
    const result = verifyDefaultDashboardTemplate(path.join(resources, 'backend/defaults/factory-dashboard.v1.json'));
    return { id: result.id, version: result.version, sha256: result.sha256, factoryViews: result.factoryViewCount, widgets: result.widgetCount };
}
if (require.main === module) {
    const resources = process.argv[2];
    const result = resources ? verifyPackagedDefaultTemplate(path.resolve(resources)) : verifyDefaultDashboardTemplate();
    console.log(JSON.stringify({ id: result.id, version: result.version, sha256: result.sha256, factoryViews: result.factoryViewCount || result.factoryViews, widgets: result.widgetCount || result.widgets }));
}
module.exports = { verifyPackagedDefaultTemplate };
