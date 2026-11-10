'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test, after } = require('node:test');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const directory = createRunDirectory('atomic-rename');
const helperPath = require.resolve('../utils/atomicRename');
const helperSource = fs.readFileSync(helperPath, 'utf8');
const helperHash = crypto.createHash('sha256').update(helperSource).digest('hex');
const actual = require(helperPath);
const results = [];
function check(name, callback, options = {}) {
    if (options.skip) results.push({ name, passed: true, skipped: true, reason: options.skip });
    test(name, { concurrency: false, ...options }, async () => {
        try { await callback(); results.push({ name, passed: true }); }
        catch (error) { results.push({ name, passed: false, error: error.stack || String(error) }); throw error; }
    });
}

// Execute the real helper source in a private module context. The virtual FS
// makes injected attempt counts deterministic and rejects all mutation APIs
// except rename; real Windows sharing behavior is checked separately below.
function fixture({ failCount = 0, code = 'EPERM', asynchronous = false, realDelay = false } = {}) {
    const source = path.join(directory, 'virtual-new.tmp'), target = path.join(directory, 'virtual-old.json');
    const files = new Map([[source, 'complete new bytes'], [target, 'complete old bytes']]);
    const originalError = Object.assign(new Error(`injected ${code}`), { code });
    const calls = [], waits = [];
    const rename = (from, to) => {
        assert.equal(from, source); assert.equal(to, target);
        assert.equal(files.get(source), 'complete new bytes');
        assert.equal(files.get(target), 'complete old bytes', 'previous target cannot disappear before atomic replace');
        calls.push([from, to]);
        if (calls.length <= failCount) throw originalError;
        files.set(target, files.get(source)); files.delete(source);
    };
    const unexpected = name => () => { throw new Error(`rename helper attempted forbidden filesystem mutation: ${name}`); };
    const io = new Proxy({ renameSync: rename, promises: new Proxy({ rename: async (from, to) => rename(from, to) },
        { get: (object, name) => name in object ? object[name] : unexpected(`promises.${String(name)}`) }) },
        { get: (object, name) => name in object ? object[name] : unexpected(String(name)) });
    const module = { exports: {} };
    const sandbox = {
        module, exports: module.exports, Int32Array, SharedArrayBuffer,
        Atomics: { wait: (_array, _index, _expected, milliseconds) => {
            assert.equal(asynchronous, false, 'async rename may not block with Atomics.wait');
            waits.push(milliseconds); return 'timed-out';
        } },
        require: name => {
            if (name === 'node:fs' || name === 'fs') return io;
            if (name === 'node:timers/promises' || name === 'timers/promises') return { setTimeout: milliseconds => {
                waits.push(milliseconds); return delay(realDelay ? milliseconds : 0);
            } };
            throw new Error(`Unexpected helper dependency: ${name}`);
        }
    };
    vm.runInNewContext(helperSource, sandbox, { filename: helperPath, timeout: 1000 });
    return { helper: module.exports, source, target, files, originalError, calls, waits };
}

check('only sharing/permission errno classes are retryable', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) assert.equal(actual.isTransientRenameError({ code }), true);
    for (const code of ['EIO', 'ENOSPC', 'ENOENT', 'EEXIST', 'EINVAL', 'eperm', undefined]) assert.equal(actual.isTransientRenameError({ code }), false);
    assert.equal(actual.isTransientRenameError(null), false); assert.equal(actual.isTransientRenameError(undefined), false);
});
for (const asynchronous of [false, true]) {
    const kind = asynchronous ? 'async' : 'sync';
    const invoke = f => asynchronous ? f.helper.renameAtomic(f.source, f.target) : f.helper.renameAtomicSync(f.source, f.target);
    check(`${kind} healthy rename attempts once and does not wait`, async () => {
        const f = fixture({ asynchronous }); await invoke(f);
        assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, []);
        assert.equal(f.files.get(f.target), 'complete new bytes'); assert.equal(f.files.has(f.source), false);
    });
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        check(`${kind} transient ${code} retains the old target until bounded atomic success`, async () => {
            const f = fixture({ asynchronous, code, failCount: 2 }); await invoke(f);
            assert.equal(f.calls.length, 3); assert.deepEqual(f.waits, [10, 20]);
            assert.equal(f.files.get(f.target), 'complete new bytes'); assert.equal(f.files.has(f.source), false);
        });
        check(`${kind} permanent ${code} fails after four attempts with the same original error and both files intact`, async () => {
            const f = fixture({ asynchronous, code, failCount: Infinity });
            if (asynchronous) await assert.rejects(invoke(f), error => error === f.originalError);
            else assert.throws(() => invoke(f), error => error === f.originalError);
            assert.equal(f.calls.length, 4); assert.deepEqual(f.waits, [10, 20, 40]);
            assert.equal(f.waits.reduce((sum, value) => sum + value, 0), 70);
            assert.equal(f.files.get(f.source), 'complete new bytes'); assert.equal(f.files.get(f.target), 'complete old bytes');
        });
    }
    for (const code of ['EIO', 'ENOSPC', 'ENOENT', 'EEXIST']) {
        check(`${kind} ${code} propagates once without waiting or destroying source/target`, async () => {
            const f = fixture({ asynchronous, code, failCount: Infinity });
            if (asynchronous) await assert.rejects(invoke(f), error => error === f.originalError);
            else assert.throws(() => invoke(f), error => error === f.originalError);
            assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, []);
            assert.equal(f.files.get(f.source), 'complete new bytes'); assert.equal(f.files.get(f.target), 'complete old bytes');
        });
    }
}
check('async retry yields to real event-loop timers throughout the exceptional delay', async () => {
    const f = fixture({ asynchronous: true, realDelay: true, failCount: 3 });
    let turns = 0; const timer = setInterval(() => { turns++; }, 1);
    try { await f.helper.renameAtomic(f.source, f.target); } finally { clearInterval(timer); }
    assert.deepEqual(f.waits, [10, 20, 40]); assert.equal(f.calls.length, 4);
    assert.ok(turns > 0, 'async exceptional retries must not starve the event loop');
});
check('actual sync and async atomic replacements publish complete bytes without deleting the destination first', async () => {
    const target = path.join(directory, 'real-target.json'), source = `${target}.tmp`;
    fs.writeFileSync(target, 'old complete bytes'); fs.writeFileSync(source, 'new complete bytes', { flag: 'wx' });
    actual.renameAtomicSync(source, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new complete bytes'); assert.equal(fs.existsSync(source), false);
    fs.writeFileSync(source, 'next complete bytes', { flag: 'wx' });
    await actual.renameAtomic(source, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'next complete bytes'); assert.equal(fs.existsSync(source), false);
});
check('real Windows non-delete-sharing handle produces bounded failures while preserving the previous snapshot', async () => {
    const target = path.join(directory, 'sharing-target.json'), source = `${target}.tmp`, release = path.join(directory, 'release-holder');
    fs.writeFileSync(target, 'old complete bytes'); fs.writeFileSync(source, 'new complete bytes', { flag: 'wx' });
    const quote = filename => filename.replace(/'/g, "''");
    const command = `$h = [System.IO.File]::Open('${quote(target)}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::Out.WriteLine('LOCKED'); $deadline = [DateTime]::UtcNow.AddSeconds(10); while (-not [System.IO.File]::Exists('${quote(release)}')) { if ([DateTime]::UtcNow -ge $deadline) { throw 'Owned sharing-lock release timed out' }; [Threading.Thread]::Sleep(10) } } finally { $h.Dispose() }`;
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    holder.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const closed = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('close', code => resolve(code)); });
    // Keep a handler attached even if startup fails before the close is awaited.
    closed.catch(() => {});
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { holder.kill(); reject(new Error('Owned sharing-lock holder did not become ready')); }, 10000);
        holder.stdout.on('data', bytes => { stdout += bytes.toString(); if (stdout.includes('LOCKED')) { clearTimeout(timer); resolve(); } });
        holder.once('error', error => { clearTimeout(timer); reject(error); });
        holder.once('close', code => { if (!stdout.includes('LOCKED')) { clearTimeout(timer); reject(new Error(`Owned holder exited ${code}: ${stderr}`)); } });
    });
    let failure;
    try {
        await ready;
        assert.throws(() => actual.renameAtomicSync(source, target), error => error.code === 'EPERM');
        assert.equal(fs.readFileSync(target, 'utf8'), 'old complete bytes'); assert.equal(fs.readFileSync(source, 'utf8'), 'new complete bytes');
        await assert.rejects(actual.renameAtomic(source, target), error => error.code === 'EPERM');
        assert.equal(fs.readFileSync(target, 'utf8'), 'old complete bytes'); assert.equal(fs.readFileSync(source, 'utf8'), 'new complete bytes');
    } catch (error) { failure = error; }
    finally { fs.writeFileSync(release, 'close only this owned fixture handle'); }
    const code = await closed;
    if (failure) throw failure;
    assert.equal(code, 0, stderr);
    await actual.renameAtomic(source, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new complete bytes'); assert.equal(fs.existsSync(source), false);
}, { skip: process.platform === 'win32' ? false : 'Windows handle sharing only' });
check('the helper source remained frozen throughout validation', () => {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex'), helperHash);
});
after(() => {
    const skipped = results.filter(row => row.skipped).length;
    const result = { success: results.every(row => row.passed), passed: results.filter(row => row.passed && !row.skipped).length,
        total: results.length, skipped, helperPath, helperSha256: helperHash, directory, results };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, results: undefined }));
});
