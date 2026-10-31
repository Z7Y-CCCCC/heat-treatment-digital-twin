const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { seedTemplateConfiguration, CONFIGURATION_FILES } = require('../templateData.cjs');

test('fresh installation clones portable settings, never machine credentials or queues', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-template-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const templates = path.join(root, 'templates'), target = path.join(root, 'data');
    fs.mkdirSync(path.join(templates, 'data'), { recursive: true });
    for (const name of [...CONFIGURATION_FILES, 'database-config.json', 'alarm-outbox.db', 'license.json'])
        fs.writeFileSync(path.join(templates, 'data', name), JSON.stringify({ name }));
    await seedTemplateConfiguration(templates, target);
    assert.deepEqual(fs.readdirSync(target).sort(), [...CONFIGURATION_FILES].sort());
    for (const name of CONFIGURATION_FILES)
        assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), JSON.stringify({ name }));
    fs.writeFileSync(path.join(target, 'admin-security.json'), 'local changes');
    await seedTemplateConfiguration(templates, target);
    assert.equal(fs.readFileSync(path.join(target, 'admin-security.json'), 'utf8'), 'local changes');
});

test('existing installations are not seeded again, including missing settings', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-template-existing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const templates = path.join(root, 'templates');
    fs.mkdirSync(path.join(templates, 'data'), { recursive: true });
    fs.writeFileSync(path.join(templates, 'data', 'admin-security.json'), 'development account');
    for (const marker of ['database-config.json', 'factory.db']) {
        const target = path.join(root, marker.replace('.', '-'));
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, marker), 'existing installation');
        await seedTemplateConfiguration(templates, target);
        assert.deepEqual(fs.readdirSync(target), [marker]);
    }
});
