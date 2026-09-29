const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { publishDirectory, retryFilesystem } = require('../directoryPublish.cjs');

function fixture(t, existing = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-publish-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staging = path.join(root, 'staging');
    const target = path.join(root, 'target');
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'version'), 'new');
    if (existing) { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'version'), 'old'); }
    return { root, staging, target };
}
const retryOptions = { attempts: 3, wait: async () => {} };

for (const existing of [false, true]) test(`publication retries transient Windows file locks (existing=${existing})`, async t => {
    const { staging, target, root } = fixture(t, existing);
    let locks = 2;
    const io = { ...fs.promises, rename: async (from, to) => {
        if (from === staging && locks-- > 0) throw Object.assign(new Error('Windows scanner lock'), { code: 'EPERM' });
        return fs.promises.rename(from, to);
    } };
    await publishDirectory(staging, target, { io, retryOptions });
    assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(root), ['target']);
});

test('persistent publication failure restores the previous complete directory', async t => {
    const { staging, target } = fixture(t);
    const io = { ...fs.promises, rename: async (from, to) => {
        if (from === staging) throw Object.assign(new Error('persistent lock'), { code: 'EPERM' });
        return fs.promises.rename(from, to);
    } };
    await assert.rejects(publishDirectory(staging, target, { io, retryOptions }), /persistent lock/);
    assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(staging, 'version'), 'utf8'), 'new');
});

test('failed rollback retains a recoverable previous directory', async t => {
    const { staging, target, root } = fixture(t);
    const io = { ...fs.promises, rename: async (from, to) => {
        if (to === target) throw Object.assign(new Error('persistent lock'), { code: 'EACCES' });
        return fs.promises.rename(from, to);
    } };
    await assert.rejects(publishDirectory(staging, target, { io, retryOptions }), /previous dependencies preserved/);
    const previous = fs.readdirSync(root).find(name => name.startsWith('target.previous-'));
    assert.equal(fs.readFileSync(path.join(root, previous, 'version'), 'utf8'), 'old');
});

test('non-transient filesystem errors do not retry', async () => {
    let calls = 0;
    await assert.rejects(retryFilesystem(async () => {
        calls++; throw Object.assign(new Error('bad path'), { code: 'EINVAL' });
    }, retryOptions), /bad path/);
    assert.equal(calls, 1);
});
