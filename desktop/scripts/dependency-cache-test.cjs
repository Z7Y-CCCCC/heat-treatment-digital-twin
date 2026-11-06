const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('node:child_process');
const tar = require('tar');
const { prepareDependencyArchive } = require('./dependency-archive.cjs');
const { dependenciesCurrent, recordDependencies } = require('./dependency-state.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-cache-'));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"example":"1.0.0"}}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock-v1');
    fs.writeFileSync(path.join(root, 'node_modules', 'example.js'), 'module.exports=1');
    return root;
}

test('shipping UTF-8 extractor preserves binary, Chinese, emoji and long PAX names without system tar', async t => {
    const root = fixture(t), source = path.join(root, 'node_modules');
    const build = path.join(root, 'extractor');
    const project = path.resolve(__dirname, '../../tools/dependency-archive-tests/DependencyArchiveTests.csproj');
    execFileSync('dotnet', ['build', project, '-c', 'Release', '--nologo', '-o', build],
        { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    const run = (archive, directory) => spawnSync('dotnet', [path.join(build, 'DependencyArchiveTests.dll'),
        '--extract-dependencies', archive, directory], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    const bytes = Buffer.from(Array.from({ length: 128 * 1024 }, (_, index) => index % 256));
    const names = ['中文依赖.bin', 'emoji-😀.bin', 'café-ü.bin', `${'长目录'.repeat(18)}/nested-设备.bin`];
    for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
        fs.writeFileSync(path.join(source, name), bytes);
    }
    const output = path.join(root, 'default.tar');
    await prepareDependencyArchive(source, path.join(root, 'cache'), output);
    // Destination and archive filenames are Unicode too, not only entry names.
    const unicodeArchive = path.join(root, '依赖包-😀.tar'); fs.copyFileSync(output, unicodeArchive);
    const extracted = path.join(root, '解压目录-😀'); fs.mkdirSync(extracted);
    const result = run(unicodeArchive, extracted);
    assert.equal(result.status, 0, result.stderr || String(result.error || ''));
    for (const name of names) assert.deepEqual(fs.readFileSync(path.join(extracted, name)), bytes);
    assert.equal(fs.readFileSync(path.join(extracted, 'example.js'), 'utf8'), 'module.exports=1');

    const refusal = run(unicodeArchive, extracted);
    assert.equal(refusal.status, 1, 'existing dependencies cannot be overwritten');
    assert.match(refusal.stderr, /nonempty/);
    for (const name of names) assert.deepEqual(fs.readFileSync(path.join(extracted, name)), bytes);

    const escaping = path.join(root, 'escaping.tar');
    const header = new tar.Header({ path: '../escaped.bin', type: 'File', mode: 0o644, size: 1 });
    header.encode(); fs.writeFileSync(escaping, Buffer.concat([header.block, Buffer.alloc(512, 42), Buffer.alloc(1024)]));
    const safe = path.join(root, 'safe'); fs.mkdirSync(safe);
    assert.equal(run(escaping, safe).status, 1, 'path traversal must be rejected');
    assert.equal(fs.existsSync(path.join(root, 'escaped.bin')), false);
    const broken = path.join(root, 'broken.tar'); fs.writeFileSync(broken, 'not an archive');
    assert.equal(run(broken, safe).status, 1, 'corrupt archives must fail closed');
    assert.equal(run(path.join(root, 'missing.tar'), safe).status, 1);
});

test('desktop and collector both use the bundled headless extractor before UI/service startup', () => {
    const read = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    for (const file of ['desktop/main.cjs', 'collector-service/worker.cjs']) {
        const source = read(file);
        assert.match(source, /--extract-dependencies/);
        assert.doesNotMatch(source, /spawn\('tar'|System32', 'tar\.exe'/);
    }
    const native = read('native-admin-host/Program.cs');
    assert.ok(native.indexOf('DependencyArchive.TryRun') < native.indexOf('EnablePerMonitorDpiAwareness();'));
    const collector = read('collector-service/Program.cs');
    assert.ok(collector.indexOf('DependencyArchive.TryRun') < collector.indexOf('Console.OutputEncoding'));
    assert.match(read('desktop/scripts/build-native-admin-host.cjs'), /visit\(path.join\(projectDir, 'shared', 'DependencyArchive.cs'\)\)/);
});

test('dependency install state invalidates package, lock, installed lock and missing state changes', t => {
    const root = fixture(t);
    assert.equal(dependenciesCurrent(root), false);
    for (const name of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json']) {
        recordDependencies(root);
        assert.equal(dependenciesCurrent(root), true);
        fs.appendFileSync(path.join(root, name), 'changed');
        assert.equal(dependenciesCurrent(root), false);
    }
    recordDependencies(root);
    fs.unlinkSync(path.join(root, 'node_modules', '.codex-dependency-state.json'));
    assert.equal(dependenciesCurrent(root), false);
});

test('archive reuses valid cache and rebuilds for edits, deletions, lock changes or archive corruption', async t => {
    const root = fixture(t);
    const source = path.join(root, 'node_modules');
    const cache = path.join(root, 'cache');
    const output = path.join(root, 'output.tar');
    let builds = 0;
    const build = filename => { builds++; fs.writeFileSync(filename, `archive-${builds}`); };
    const run = () => prepareDependencyArchive(source, cache, output, build);
    assert.equal((await run()).reused, false);
    assert.equal((await run()).reused, true);
    fs.writeFileSync(path.join(source, 'example.js'), 'module.exports=2');
    assert.equal((await run()).reused, false);
    fs.unlinkSync(path.join(source, 'example.js'));
    assert.equal((await run()).reused, false);
    fs.appendFileSync(path.join(root, 'package-lock.json'), '-v2');
    assert.equal((await run()).reused, false);
    fs.writeFileSync(path.join(cache, 'backend-dependencies.tar'), 'corrupted');
    assert.equal((await run()).reused, false);
    assert.equal(builds, 5);
});

test('archive refuses source changes during build and preserves previous cache', async t => {
    const root = fixture(t);
    const source = path.join(root, 'node_modules');
    const cache = path.join(root, 'cache');
    const output = path.join(root, 'output.tar');
    await prepareDependencyArchive(source, cache, output, filename => fs.writeFileSync(filename, 'stable'));
    fs.writeFileSync(path.join(source, 'example.js'), 'new input');
    await assert.rejects(prepareDependencyArchive(source, cache, output, filename => {
        fs.writeFileSync(filename, 'unstable');
        fs.writeFileSync(path.join(source, 'example.js'), 'changed during tar');
    }), /归档过程中发生变化/);
    assert.equal(fs.readFileSync(path.join(cache, 'backend-dependencies.tar'), 'utf8'), 'stable');
});
