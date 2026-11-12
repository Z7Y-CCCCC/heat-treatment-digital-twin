'use strict';
// Deterministic fixture-lifetime boundaries only: memory child events and
// explicitly owned output SQLite/files. No server, UI or commissioned data.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRunDirectory, requireTestPath, forceStop, sleep } = require('./integration-test-utils.cjs');
const { trackRecoveryProcess, trackRecoveryWorker, recoveryProcessSnapshot, waitForRecoveryProcessClose, stopRecoveryProcess,
    recoveryArtifactPath, removeClosedRecoverySidecars, openRecoveryDatabase, closeRecoveryDatabase } = require('./power-recovery-test.cjs');

const directory = createRunDirectory('power-recovery-lifetime');
const observations = [];
after(() => fs.writeFileSync(path.join(directory, 'boundary-proof.json'), JSON.stringify({
    directory, deterministic: true, uiUsed: false, productionWrites: false, observations
}, null, 2)));

function fakeChild({ exitOnKill = true } = {}) {
    const child = new EventEmitter();
    Object.assign(child, { pid: 10000001, exitCode: null, signalCode: null, killed: false, killCalls: 0 });
    child.kill = () => {
        child.killed = true; child.killCalls++;
        if (exitOnKill) { child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); }
        return true;
    };
    trackRecoveryProcess(child);
    return child;
}
async function closedChild() {
    const child = fakeChild(); child.kill(); child.emit('close', null, 'SIGKILL');
    await waitForRecoveryProcessClose(child);
    return child;
}
function fixture(name, { database = true } = {}) {
    const fixtureDirectory = requireTestPath(path.join(directory, name)), dataDir = path.join(fixtureDirectory, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const databaseFile = path.join(dataDir, 'factory.db');
    if (database) fs.writeFileSync(databaseFile, 'owned boundary fixture');
    return { fixtureDirectory, dataDir, databaseFile };
}

test('before-fix chain deterministically resolves old forceStop at exit while delayed close still makes WAL unlink busy', async () => {
    const child = fakeChild();
    await forceStop(child);
    const atUnlink = recoveryProcessSnapshot(child);
    assert.equal(atUnlink.exitObserved, true); assert.equal(atUnlink.closeObserved, false);
    const oldUnlink = () => { if (!recoveryProcessSnapshot(child).closeObserved) throw Object.assign(new Error('delayed owned close keeps WAL busy'), { code: 'EBUSY' }); };
    assert.throws(oldUnlink, error => error.code === 'EBUSY');
    child.emit('close', null, 'SIGKILL'); await waitForRecoveryProcessClose(child);
    observations.push({ name: 'old-boundary-reproduced', atUnlink, reproducedError: 'EBUSY' });
});

test('strict owned stop stays pending after exit until the actual captured close event', async () => {
    const child = fakeChild(); let resolved = false;
    const pending = stopRecoveryProcess(child).then(proof => { resolved = true; return proof; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false); assert.equal(recoveryProcessSnapshot(child).closeObserved, false);
    child.emit('close', null, 'SIGKILL');
    const proof = await pending;
    assert.equal(proof.exitObserved, true); assert.equal(proof.closeObserved, true);
    assert.ok(proof.confirmedAt >= proof.closeAt); assert.equal(child.killCalls, 1);
    observations.push({ name: 'new-boundary-waits-for-close', proof });
});

test('closed API owner cannot authorize WAL cleanup while its captured collector worker is still alive', async () => {
    const child = fakeChild(), files = fixture('live-worker');
    trackRecoveryWorker(child, 10000003);
    child.kill(); child.emit('close', null, 'SIGKILL');
    let workerAlive = true, resolved = false, attempts = 0;
    const pending = waitForRecoveryProcessClose(child, { workerExited: pid => {
        assert.equal(pid, 10000003); return !workerAlive;
    } }).then(proof => { resolved = true; return proof; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false);
    await assert.rejects(removeClosedRecoverySidecars(files.databaseFile, files.fixtureDirectory, child,
        { remove: () => { attempts++; } }), /before owned backend exit\/close/);
    assert.equal(attempts, 0);
    workerAlive = false;
    const proof = await pending;
    assert.equal(proof.workerExitObserved, true);
    observations.push({ name: 'collector-worker-release-boundary', attempts, proof });
});

test('a stuck captured collector times out rather than permitting corruption of an open database', async () => {
    const child = fakeChild(); trackRecoveryWorker(child, 10000004);
    child.kill(); child.emit('close', null, 'SIGKILL');
    await assert.rejects(waitForRecoveryProcessClose(child, { timeoutMs: 10, workerExited: () => false }),
        error => error.code === 'RECOVERY_PROCESS_LIFETIME_TIMEOUT');
    assert.equal(recoveryProcessSnapshot(child).confirmedAt, null);
    await waitForRecoveryProcessClose(child, { workerExited: () => true });
});

test('killed-but-live owners time out explicitly and never authorize WAL deletion or lose their handle', async () => {
    const child = fakeChild({ exitOnKill: false }), files = fixture('live-owner'); let attempts = 0;
    await assert.rejects(stopRecoveryProcess(child, { timeoutMs: 10 }), error => error.code === 'RECOVERY_PROCESS_LIFETIME_TIMEOUT');
    assert.equal(child.killed, true); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    await assert.rejects(removeClosedRecoverySidecars(files.databaseFile, files.fixtureDirectory, child,
        { remove: () => { attempts++; } }), /before owned backend exit\/close/);
    assert.equal(attempts, 0); assert.equal(child.killCalls, 1);
    observations.push({ name: 'live-owner-not-swallowed', attempts, proof: recoveryProcessSnapshot(child) });
    child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    await waitForRecoveryProcessClose(child);
});

test('an exited owner without close cannot use the post-close lock wait as a shortcut', async () => {
    const child = fakeChild(), files = fixture('missing-close'); let attempts = 0;
    child.kill();
    await assert.rejects(removeClosedRecoverySidecars(files.databaseFile, files.fixtureDirectory, child,
        { remove: () => { attempts++; } }), /before owned backend exit\/close/);
    await assert.rejects(waitForRecoveryProcessClose(child, { timeoutMs: 10 }), error => error.code === 'RECOVERY_PROCESS_LIFETIME_TIMEOUT');
    assert.equal(attempts, 0);
    child.emit('close', null, 'SIGKILL'); await waitForRecoveryProcessClose(child);
});

test('closed backend ownership does not permit unlink while an actual local SQLite WAL connection remains open', async t => {
    const child = await closedChild(), files = fixture('local-sqlite-owner', { database: false });
    const db = openRecoveryDatabase(files.databaseFile); let attempts = 0;
    t.after(() => { if (db.open) closeRecoveryDatabase(db); });
    db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE owned(value INTEGER); INSERT INTO owned VALUES (1)');
    assert.equal(fs.existsSync(`${files.databaseFile}-wal`), true);
    await assert.rejects(removeClosedRecoverySidecars(files.databaseFile, files.fixtureDirectory, child,
        { remove: () => { attempts++; } }), /open local SQLite handle/);
    assert.equal(attempts, 0);
    closeRecoveryDatabase(db);
    const proof = await removeClosedRecoverySidecars(files.databaseFile, files.fixtureDirectory, child);
    assert.equal(proof.owner.localDatabaseHandles, 0);
    observations.push({ name: 'actual-local-SQLite-handle-guard', attemptsBeforeClose: attempts, proof });
});

test('a bounded residual EBUSY wait is recorded only after confirmed exit close and zero SQLite handles', async () => {
    const child = await closedChild(), files = fixture('closed-residual-lock'); let calls = 0, pauses = 0;
    fs.writeFileSync(`${files.databaseFile}-wal`, 'owned residual WAL');
    fs.writeFileSync(`${files.databaseFile}-shm`, 'owned residual SHM');
    const proof = await removeClosedRecoverySidecars(files.databaseFile, files.fixtureDirectory, child, {
        remove: filename => { calls++; if (calls === 1) throw Object.assign(new Error('owned closed-file residual lock'), { code: 'EBUSY' }); fs.rmSync(filename, { force: true }); },
        pause: async () => { pauses++; assert.equal(recoveryProcessSnapshot(child).closeObserved, true); await sleep(1); }
    });
    assert.equal(pauses, 1); assert.equal(proof.files[0].attempts.length, 2);
    assert.equal(proof.files[0].attempts[0].code, 'EBUSY');
    assert.equal(fs.existsSync(`${files.databaseFile}-wal`), false);
    assert.equal(fs.existsSync(`${files.databaseFile}-shm`), false);
    observations.push({ name: 'bounded-post-close-lock-wait', proof });
});

test('permanent post-close lock errors fail with diagnostics rather than becoming successful cleanup', async () => {
    const child = await closedChild(), files = fixture('permanent-closed-lock'); let calls = 0;
    await assert.rejects(removeClosedRecoverySidecars(files.databaseFile, files.fixtureDirectory, child, {
        timeoutMs: 0, remove: () => { calls++; throw Object.assign(new Error('fixture WAL remains locked'), { code: 'EBUSY' }); }
    }), error => error.code === 'EBUSY' && /closed-owner WAL cleanup/.test(error.message));
    assert.equal(calls, 1);
});

test('sidecar paths cannot escape the current output fixture lexically or through a sibling junction', async () => {
    const child = await closedChild(), files = fixture('path-guard'), other = fixture('path-other'); let attempts = 0;
    assert.throws(() => recoveryArtifactPath(other.databaseFile, files.fixtureDirectory), /exact fixture/);
    const link = path.join(files.fixtureDirectory, 'linked-other-data');
    fs.symlinkSync(other.dataDir, link, 'junction');
    await assert.rejects(removeClosedRecoverySidecars(path.join(link, 'factory.db'), files.fixtureDirectory, child,
        { remove: () => { attempts++; } }), /resolves outside this exact fixture/);
    assert.equal(attempts, 0); assert.equal(fs.existsSync(other.databaseFile), true);
    observations.push({ name: 'fixture-realpath-guard', attempts, preservedOtherFixture: other.databaseFile });
});

test('the local lifetime helper cannot terminate an unowned process handle', async () => {
    const child = new EventEmitter(); let kills = 0;
    Object.assign(child, { pid: 10000002, exitCode: null, signalCode: null, kill() { kills++; } });
    await assert.rejects(stopRecoveryProcess(child), /unowned recovery process/);
    assert.equal(kills, 0);
});

test('sidecar disappearance during realpath resolution still verifies the exact fixture parent', () => {
    const files = fixture('sidecar-realpath-race'), sidecar = `${files.databaseFile}-shm`;
    fs.writeFileSync(sidecar, 'transient SQLite sidecar');
    let raced = false;
    const resolved = recoveryArtifactPath(sidecar, files.fixtureDirectory, filename => {
        if (filename === sidecar && !raced) { raced = true; fs.unlinkSync(sidecar); }
        return fs.realpathSync(filename);
    });
    assert.equal(raced, true);
    assert.equal(resolved, sidecar);
    assert.equal(fs.existsSync(sidecar), false);
    observations.push({ name: 'disappearing-sidecar-realpath', raced, resolved });
});

test('sidecar realpath errors other than absence are never treated as successful cleanup', () => {
    const files = fixture('sidecar-realpath-denied');
    assert.throws(() => recoveryArtifactPath(`${files.databaseFile}-shm`, files.fixtureDirectory,
        () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), error => error.code === 'EACCES');
});
