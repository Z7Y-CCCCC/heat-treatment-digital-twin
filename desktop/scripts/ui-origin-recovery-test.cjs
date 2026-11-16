'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { verifyUiOriginRecoveryResources, writeUiOriginRecoveryMarker } = require('../uiOriginRecovery.cjs');
const desktop = path.resolve(__dirname, '..'), root = path.dirname(desktop);
test('migration requires a matching build-generated native capability, rejects missing/stale/tampered resources', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-origin-marker-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.throws(() => verifyUiOriginRecoveryResources(dir));
    fs.writeFileSync(path.join(dir, 'HeatTreatmentAdminHost.exe'), 'fixture exe');
    fs.writeFileSync(path.join(dir, 'HeatTreatmentAdminHost.dll'), 'fixture assembly');
    writeUiOriginRecoveryMarker(dir);assert.doesNotThrow(() => verifyUiOriginRecoveryResources(dir));
    fs.writeFileSync(path.join(dir, 'HeatTreatmentAdminHost.dll'), 'stale assembly');
    assert.throws(() => verifyUiOriginRecoveryResources(dir), /迁移能力/);
    writeUiOriginRecoveryMarker(dir);assert.doesNotThrow(() => verifyUiOriginRecoveryResources(dir));
    const file = path.join(dir, 'ui-origin-migration.json'), marker = JSON.parse(fs.readFileSync(file));marker.version = 0;
    fs.writeFileSync(file, JSON.stringify(marker));assert.throws(() => verifyUiOriginRecoveryResources(dir));
});
test('installer file list and native embedded resources include the EXACT production migration scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json')));
    assert.ok(pkg.build.files.includes('uiOriginRecovery.cjs'));assert.ok(pkg.build.files.includes('ui-origin/*.js'));
    const project = fs.readFileSync(path.join(root, 'native-admin-host/HeatTreatmentAdminHost.csproj'), 'utf8');
    for (const name of ['snapshot.js', 'transfer.js']) {
        assert.ok(project.includes(`..\\desktop\\ui-origin\\${name}`));
        assert.ok(fs.statSync(path.join(desktop, 'ui-origin', name)).size > 0);
    }
    const builder = fs.readFileSync(path.join(__dirname, 'build-native-admin-host.cjs'), 'utf8');
    assert.match(builder, /visit\(path.join\(desktopDir, 'ui-origin'\)\)/);
    assert.match(builder, /visit\(path.join\(desktopDir, 'uiOriginRecovery.cjs'\)\)/);
    assert.ok(builder.indexOf('writeUiOriginRecoveryMarker(outputDirectory)') < builder.lastIndexOf('createTreeManifest('));
    assert.match(fs.readFileSync(path.join(__dirname, 'prepare-resources.cjs'), 'utf8'), /verifyUiOriginRecoveryResources\(path.join\(nativeClientSourceDir, 'AdminHost'\)\)/);
});
test('startup awaits both profile recovery and journal commit BEFORE health, licensing or Unity navigation', () => {
    const source = fs.readFileSync(path.join(desktop, 'main.cjs'), 'utf8');
    const start = source.indexOf('displayGateway = await'), recover = source.indexOf('await require(\'./uiOriginRecovery.cjs\').recoverUiOrigin', start);
    const commit = source.indexOf('await displayGateway.completeOriginMigration()', start), ready = source.indexOf('applicationOrigin = origin', start);
    assert.ok(start > 0 && recover > start && commit > recover && ready > commit);
    const program = fs.readFileSync(path.join(root, 'native-admin-host/Program.cs'), 'utf8');
    assert.ok(program.indexOf('UiOriginStorageMigration.TryRun(args)') < program.indexOf('var options = HostOptions.Parse(args)'));
    const native = fs.readFileSync(path.join(root, 'native-admin-host/UiOriginStorageMigration.cs'), 'utf8');
    assert.match(native, /#if !DEBUG\s+if \(request.SelfTest\) throw/);
});
