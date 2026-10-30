'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { MysqlRuntime } = require('../../desktop/mysqlRuntime.cjs');
const { createSmokeEnvironment } = require('../../desktop/scripts/smoke-sandbox.cjs');
const { snapshotTree, verifyTree } = require('../../tools/package-resource-integrity.cjs');

const project = path.resolve(__dirname, '../..');
const directory = createRunDirectory('package-resource-isolation');
const checks = [];
const pathKeys = ['APP_DATA_DIR', 'UPLOADS_DIR', 'DB_BACKUP_DIR', 'DB_RECOVERY_DIR',
    'SITE_BACKUP_DIR', 'SITE_IMPORT_DIR', 'SITE_BACKUP_MIRROR_DIR', 'DATA_SOURCE_BACKUP_DIR', 'SQLITE_FILE'];

function fixture(name) {
    const root = path.join(directory, name), resources = path.join(root, 'resources');
    const backend = path.join(resources, 'backend');
    fs.mkdirSync(backend, { recursive: true });
    fs.cpSync(path.join(project, 'backend', 'db'), path.join(backend, 'db'), { recursive: true });
    fs.cpSync(path.join(project, 'backend', 'utils'), path.join(backend, 'utils'), { recursive: true });
    // Match the real package layout: database utilities import shared contracts
    // next to resources/backend, including the new device-tooltip schema.
    fs.cpSync(path.join(project, 'shared'), path.join(resources, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(backend, 'services'));
    fs.copyFileSync(path.join(project, 'backend', 'services', 'mysqlBackup.js'), path.join(backend, 'services', 'mysqlBackup.js'));
    const hostScript = path.join(backend, 'host.cjs');
    // Load the real database module; the durable budget write is the exact
    // side effect that exposed the production collector cold-start defect.
    fs.writeFileSync(hostScript, `
        require('./db/database');
        const paths = Object.fromEntries(${JSON.stringify(pathKeys)}.map(key => [key, process.env[key]]));
        if (process.connected) process.send({ type: 'ready', config: { paths } });
        process.on('message', value => { if (value.type === 'shutdown') process.exit(0); });
    `);
    return { root, resources, backend, hostScript, userData: path.join(root, 'user-data') };
}

async function assertRuntimeIsolation(name, stale) {
    const state = fixture(name), foreign = path.join(state.root, 'foreign-data');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'sentinel'), 'unchanged');
    const baseline = await snapshotTree(state.resources);
    const saved = Object.fromEntries(pathKeys.map(key => [key, process.env[key]]));
    for (const key of pathKeys) {
        if (stale) process.env[key] = foreign;
        else delete process.env[key];
    }
    const runtime = new MysqlRuntime({ root: state.userData, runtimeDir: path.join(state.resources, 'mysql'),
        nodeBinary: process.execPath, hostScript: state.hostScript, dependenciesDir: path.join(project, 'backend', 'node_modules'),
        templateFile: path.join(state.resources, 'template.db') });
    try {
        const ready = await runtime.start();
        assert.equal(ready.paths.APP_DATA_DIR, path.join(state.userData, 'data'));
        for (const key of pathKeys) {
            if (key === 'SITE_BACKUP_MIRROR_DIR') assert.equal(ready.paths[key], '');
            else assert.ok(path.relative(state.userData, ready.paths[key]) && !path.relative(state.userData, ready.paths[key]).startsWith('..'), key);
        }
        await runtime.stop();
        assert.ok(fs.existsSync(path.join(state.userData, 'data', 'backup-storage-database.json')));
        assert.deepEqual(fs.readdirSync(foreign), ['sentinel']);
        assert.equal(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8'), 'unchanged');
        checks.push({ name, paths: ready.paths, resourceIntegrity: await verifyTree(state.resources, baseline) });
    } finally {
        await runtime.stop();
        for (const key of pathKeys) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
    }
}

test('real MysqlRuntime child stores the database policy only in its owned userData when parent paths are absent',
    () => assertRuntimeIsolation('unset-parent', false));
test('real MysqlRuntime child overrides inherited writable paths without changing another instance',
    () => assertRuntimeIsolation('foreign-parent', true));

test('the pre-fix cold-start side effect is reproduced and the actual build command guard blocks publication', async () => {
    const state = fixture('negative-control');
    const baselineFile = path.join(state.root, 'baseline.json'), resultFile = path.join(state.root, 'verification.json');
    const before = await snapshotTree(state.resources);
    fs.writeFileSync(baselineFile, JSON.stringify(before));
    const env = { ...process.env, NODE_PATH: path.join(project, 'backend', 'node_modules') };
    for (const key of pathKeys) delete env[key];
    // The old collector used precisely this inherited, unbound child environment.
    const child = spawnSync(process.execPath, ['-e', "require('./db/database')"], {
        cwd: state.backend, env, windowsHide: true, encoding: 'utf8'
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(fs.existsSync(path.join(state.backend, 'data', 'backup-storage-database.json')));
    await assert.rejects(verifyTree(state.resources, before), error => error.code === 'PACKAGE_RESOURCE_MUTATED'
        && error.changes.some(value => value.includes('backend/data/backup-storage-database.json')));
    const marker = path.join(state.root, 'publication-would-run.txt');
    if (process.platform === 'win32') {
        const pipeline = path.join(state.root, 'guard-pipeline.ps1');
        fs.writeFileSync(pipeline, `
            $ErrorActionPreference = 'Stop'
            $buildStages = New-Object 'System.Collections.Generic.List[object]'
            $transcriptStarted = $false
            $buildLogPath = $env:GUARD_LOG
            $tokens = $null; $errors = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:RELEASE_SCRIPT, [ref]$tokens, [ref]$errors)
            $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-CheckedCommand' }, $true)
            Invoke-Expression $fn.Extent.Text
            try {
                Invoke-CheckedCommand -Label 'resource-guard-regression' -Executable $env:GUARD_NODE -ArgumentList @($env:GUARD_TOOL, '--verify', $env:GUARD_RESOURCES, $env:GUARD_BASELINE, $env:GUARD_RESULT)
                Set-Content -LiteralPath $env:GUARD_MARKER -Value 'Publication must never run'
                exit 0
            } catch { Write-Host $_.Exception.Message; exit 7 }
        `);
        const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', pipeline], {
            env: { ...env, RELEASE_SCRIPT: path.join(project, '生成安装包.ps1'), GUARD_NODE: process.execPath,
                GUARD_TOOL: path.join(project, 'tools', 'package-resource-integrity.cjs'), GUARD_RESOURCES: state.resources,
                GUARD_BASELINE: baselineFile, GUARD_RESULT: resultFile, GUARD_MARKER: marker,
                GUARD_LOG: path.join(state.root, 'guard.log') }, encoding: 'utf8', windowsHide: true
        });
        fs.writeFileSync(path.join(state.root, 'guard-pipeline.log'), `${run.stdout}\n${run.stderr}`);
        assert.equal(run.status, 7, run.stdout + run.stderr);
        assert.equal(fs.existsSync(marker), false, 'NSIS continuation must be unreachable after resource mutation');
        const failure = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.equal(failure.success, false); assert.equal(failure.code, 'PACKAGE_RESOURCE_MUTATED');
        checks.push({ name: 'old-defect-reproduced-and-publication-blocked', exitCode: run.status, failure });
    } else {
        checks.push({ name: 'old-defect-reproduced', guardRejected: true, windowsPipeline: 'not-run' });
    }
});

test('resource guard detects file edits, deletions and new empty directories', async () => {
    for (const mutation of ['edit', 'remove', 'empty-directory']) {
        const root = path.join(directory, `integrity-${mutation}`);
        fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'file'), 'before');
        const before = await snapshotTree(root);
        if (mutation === 'edit') fs.writeFileSync(path.join(root, 'file'), 'after');
        if (mutation === 'remove') fs.unlinkSync(path.join(root, 'file'));
        if (mutation === 'empty-directory') fs.mkdirSync(path.join(root, 'data'));
        await assert.rejects(verifyTree(root, before), { code: 'PACKAGE_RESOURCE_MUTATED' });
    }
    checks.push({ name: 'edit-delete-empty-directory-rejected', success: true });
});

test('all package smoke writable paths and machine identity ignore inherited production settings', () => {
    const inherited = { ...process.env };
    for (const key of [...pathKeys, 'APP_USER_DATA_DIR', 'LICENSE_FILE', 'LICENSE_PUBLIC_KEY_FILE', 'LICENSE_MACHINE_STATE_FILE',
        'DIGITAL_TWIN_COLLECTOR_CONFIG', 'DIGITAL_TWIN_DEPLOYMENT_FILE', 'NODE_OPTIONS', 'MYSQL_HOST', 'DB_HOST']) inherited[key] = 'foreign-business-state';
    const env = createSmokeEnvironment(directory, {}, inherited);
    for (const key of [...pathKeys, 'APP_USER_DATA_DIR', 'LICENSE_FILE']) {
        if (key === 'SQLITE_FILE') assert.equal(env[key], undefined);
        else if (key === 'SITE_BACKUP_MIRROR_DIR') assert.equal(env[key], '');
        else assert.ok(env[key] === directory || (path.relative(directory, env[key]) && !path.relative(directory, env[key]).startsWith('..')), key);
    }
    for (const key of ['LICENSE_PUBLIC_KEY_FILE', 'DIGITAL_TWIN_COLLECTOR_CONFIG', 'DIGITAL_TWIN_DEPLOYMENT_FILE', 'NODE_OPTIONS', 'MYSQL_HOST', 'DB_HOST']) assert.equal(env[key], undefined, key);
    assert.ok(env.LICENSE_MACHINE_STATE_FILE.startsWith(env.ProgramData + path.sep));
    checks.push({ name: 'smoke-environment-production-overrides-cleared', success: true });
});

after(() => {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: checks.length === 5, directory, checks }, null, 2));
    console.log(`Package isolation evidence: ${path.join(directory, 'result.json')}`);
});
