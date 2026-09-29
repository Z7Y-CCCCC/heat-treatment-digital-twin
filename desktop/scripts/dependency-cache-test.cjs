const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { prepareDependencyArchive } = require('./dependency-archive.cjs');
const { dependenciesCurrent, recordDependencies } = require('./dependency-state.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"example":"1.0.0"}}');
    fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock-v1');
    fs.writeFileSync(path.join(root, 'node_modules', 'example.js'), 'module.exports=1');
    return root;
}

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
