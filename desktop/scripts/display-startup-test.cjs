'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { assertDisplayStartupSupported } = require('../displayStartup.cjs');
const root = path.resolve(__dirname, '../..');
test('reachable legacy collectors fail explicitly before creating a native zero-percent cover', () => {
    for (const health of [undefined, {}, { status: 'ok', db: { connected: true } },
        { capabilities: { displayStartup: { version: 1, passwordRequired: true, readOnly: true } } },
        { capabilities: { displayStartup: { version: 1, passwordRequired: false, readOnly: false } } },
        { capabilities: { displayStartup: { version: 2, passwordRequired: false, readOnly: true } } }]) {
        assert.throws(() => assertDisplayStartupSupported(health), { code: 'DISPLAY_STARTUP_UPDATE_REQUIRED' });
    }
    assert.doesNotThrow(() => assertDisplayStartupSupported({ capabilities: {
        displayStartup: { version: 1, passwordRequired: false, readOnly: true } } }));
    const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
    const launch = main.slice(main.indexOf('async function launchApplication()'));
    assert.ok(launch.indexOf('assertDisplayStartupSupported(startupHealth)') < launch.indexOf('await startNativeClient('));
    assert.match(main, /finish\(null, health\)/);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json')));
    assert.ok(pkg.build.files.includes('displayStartup.cjs'), 'installed client must carry the same protocol gate');
});
test('CMD checks frontend, Unity and native host source, but never upgrades or starts a second collector', () => {
    const cmd = fs.readFileSync(path.join(root, '启动大屏.cmd'), 'utf8');
    for (const script of ['ensure-workspace-frontend.cjs', 'build-unity-client.cjs', 'build-native-admin-host.cjs'])
        assert.ok(cmd.includes(script), script);
    for (const name of ['ENSURE_FRONTEND', 'ENSURE_UNITY', 'ENSURE_HOST']) {
        const at = cmd.indexOf('"%NODE_EXE%" "%'+name+'%"');
        assert.ok(at > 0 && at < cmd.indexOf('start "" "%APP_EXE%"'));
    }
    assert.doesNotMatch(cmd, /build-collector-runtime|build-release|Stop-Service|Start-Service|backend\\server/);
});
