'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
function files(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(directory, e.name)) : [path.join(directory, e.name)]);
}
function verify(resources) {
    const defaultTemplate = require('./verify-default-dashboard-template.cjs').verifyPackagedDefaultTemplate(resources);
    const Database = require('../../backend/node_modules/better-sqlite3');
    const db = new Database(path.join(resources, 'templates/factory-template.db'), { readonly: true, fileMustExist: true });
    const counts = {};
    try {
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
            if (name === 'settings') continue;
            counts[name] = db.prepare('SELECT COUNT(*) AS n FROM `' + name + '`').get().n;
            assert.equal(counts[name], 0, 'Installer business table must be empty: ' + name);
        }
        assert.equal(db.prepare("SELECT value FROM settings WHERE `key`='install_content_policy'").get().value, 'empty-v1');
        assert.equal(db.prepare("SELECT value FROM settings WHERE `key`='active_factory_id'").get().value, '');
    } finally { db.close(); }
    for (const relative of ['backend/assets/models', 'backend/assets/motions']) assert.equal(files(path.join(resources, relative)).length, 0, relative);
    for (const relative of ['templates/uploads', 'templates/data', 'backend/data', '导入文件']) assert.equal(fs.existsSync(path.join(resources, relative)), false, relative);
    const models = files(path.join(resources, 'native-client')).filter(f => /\.(glb|gltf|blend\d*|zip)$/i.test(f)); assert.deepEqual(models, []);
    const registry = JSON.parse(fs.readFileSync(path.join(resources, 'shared/motionPackages.json'))); assert.deepEqual(registry.models, {});
    const policy = JSON.parse(fs.readFileSync(path.join(resources, 'backend/distribution.json'))); assert.equal(policy.contentPolicy, 'empty-v1');
    return { contentPolicy: 'empty-v1', defaultTemplate, counts, packagedModels: 0, packagedMotions: 0, nativeModelFiles: 0, siteConfigurationIncluded: false };
}
if (require.main === module) console.log(JSON.stringify(verify(path.resolve(process.argv[2])), null, 2));
module.exports = { verify };
