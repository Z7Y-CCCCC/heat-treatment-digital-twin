const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('node:http');
const { Writable } = require('node:stream');
const { once } = require('events');
const { createRunDirectory, requireTestPath, findFreePort, startLoggedProcess, waitForOwnedBackend } = require('./integration-test-utils.cjs');

(async () => {
    const directory = createRunDirectory('test-isolation');
    assert.throws(() => createRunDirectory('../escape'));
    assert.throws(() => createRunDirectory('nested/path'));
    assert.throws(() => requireTestPath(path.join(directory, '..', '..', 'backend', 'data', 'factory.db')));
    assert.notEqual(createRunDirectory('unique-test-run'), createRunDirectory('unique-test-run'));
    // Reproduce SQLite removing a sidecar at the initial artifact guard,
    // before the recovery-specific realpath check can handle its absence.
    const sidecar = path.join(directory, 'factory.db-wal'), originalRealpath = fs.realpathSync;
    fs.writeFileSync(sidecar, 'owned transient sidecar');
    let raced = false;
    try {
        fs.realpathSync = function (filename, ...args) {
            if (filename === sidecar && !raced) { raced = true; fs.unlinkSync(sidecar); }
            return originalRealpath.call(this, filename, ...args);
        };
        assert.equal(requireTestPath(sidecar), sidecar);
        assert.equal(raced, true);
        assert.equal(fs.existsSync(sidecar), false);
    } finally { fs.realpathSync = originalRealpath; }
    fs.writeFileSync(sidecar, 'owned permission fixture');
    try {
        fs.realpathSync = function (filename, ...args) {
            if (filename === sidecar) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
            return originalRealpath.call(this, filename, ...args);
        };
        assert.throws(() => requireTestPath(sidecar), error => error.code === 'EACCES');
    } finally { fs.realpathSync = originalRealpath; }
    assert.equal(fs.readFileSync(sidecar, 'utf8'), 'owned permission fixture');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-twin-sandbox-target-'));
    const link = path.join(directory, 'outside-link');
    try {
        fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => requireTestPath(path.join(link, 'database.db')), /links outside/);
        assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
    } finally {
        // Remove only the exact junction/test directory created immediately above.
        fs.rmSync(link, { force: true, recursive: true });
        fs.rmSync(outside, { force: true, recursive: true });
    }
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { assert.notEqual(await findFreePort(server.address().port), server.address().port); }
    finally { await new Promise(resolve => server.close(resolve)); }
    // A free-port probe is not a reservation. Never authenticate or write a
    // configuration merely because some server happens to answer that port.
    let healthPid = process.pid + 1;
    const requests = [];
    const healthServer = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ components: { backend: { status: 'healthy', processId: healthPid } } }));
    });
    await new Promise(resolve => healthServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${healthServer.address().port}`;
    const owned = { pid: process.pid, exitCode: null, signalCode: null };
    try {
        await assert.rejects(waitForOwnedBackend(origin, owned), /identity mismatch/);
        healthPid = undefined;
        await assert.rejects(waitForOwnedBackend(origin, owned), /identity mismatch/);
        healthPid = process.pid;
        assert.equal((await waitForOwnedBackend(origin, owned)).components.backend.processId, process.pid);
        await assert.rejects(waitForOwnedBackend(origin, { ...owned, exitCode: 1 }), /exited/);
        await assert.rejects(waitForOwnedBackend('http://example.com', owned), /loopback/);
        assert.deepEqual(requests, Array(3).fill('GET /api/health'), 'mismatches never send login or configuration requests');
    } finally {
        healthServer.closeAllConnections();
        await new Promise(resolve => healthServer.close(resolve));
    }
    const logFile = path.join(directory, 'large-output.log');
    const child = startLoggedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(262144))"], { cwd: directory, logFile });
    await once(child, 'close');
    // Child close only ends the writer; it does not acknowledge disk flushing.
    await child.logFinished;
    assert.equal(fs.readFileSync(logFile, 'utf8').length, 262144);
    // Deterministically delay the log's final acknowledgement beyond child
    // close, rather than hoping a busy filesystem reproduces the race.
    const createWriteStream = fs.createWriteStream;
    let releaseLog, enterFinal;
    const finalEntered = new Promise(resolve => { enterFinal = resolve; });
    const logRelease = new Promise(resolve => { releaseLog = resolve; });
    let delayedChild, loggedBytes = 0;
    try {
        fs.createWriteStream = () => new Writable({
            write(chunk, encoding, done) { loggedBytes += chunk.length; done(); },
            final(done) { enterFinal(); logRelease.then(() => done()); }
        });
        delayedChild = startLoggedProcess(process.execPath, ['-e', "process.stdout.write('owned log')"], {
            cwd: directory, logFile: path.join(directory, 'delayed-output.log')
        });
    } finally { fs.createWriteStream = createWriteStream; }
    await once(delayedChild, 'close');
    await finalEntered;
    let logComplete = false;
    delayedChild.logFinished.then(() => { logComplete = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logComplete, false, 'child close must not stand in for the log flush acknowledgement');
    releaseLog();
    await delayedChild.logFinished;
    assert.equal(loggedBytes, Buffer.byteLength('owned log'));
    console.log(JSON.stringify({ success: true, checks: 20, artifacts: directory }, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
