const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { hasProcessExited, terminateProcess } = require('../processLifecycle.cjs');

class Child extends EventEmitter {
    pid = 42;
    exitCode = null;
    signalCode = null;
    killed = false;
    killCalls = 0;
    kill() { this.killed = true; this.killCalls += 1; return true; }
    exit(code = 0) { this.exitCode = code; this.emit('exit', code, null); }
}

test('an already-signalled child is still awaited until its actual exit', async () => {
    const child = new Child();
    child.killed = true;
    assert.equal(hasProcessExited(child), false);
    let settled = false;
    const stopping = terminateProcess(child).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    child.exit();
    await stopping;
    assert.equal(settled, true);
    assert.equal(child.listenerCount('exit'), 0);
});

test('graceful shutdown waits for exit, not only HTTP acknowledgement', async () => {
    const child = new Child();
    let requested = false;
    let settled = false;
    const stopping = terminateProcess(child, {
        gracefulShutdown: async () => { requested = true; }
    }).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(requested, true);
    assert.equal(settled, false);
    assert.equal(child.killCalls, 0);
    child.exit();
    await stopping;
});

test('a failed graceful request forces termination but still waits for exit', async () => {
    const child = new Child();
    const stopping = terminateProcess(child, {
        gracefulShutdown: async () => { throw new Error('connection refused'); }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(child.killCalls, 1);
    child.exit();
    await stopping;
});

test('timeout cannot report success for a live unresponsive process', async () => {
    const child = new Child();
    await assert.rejects(terminateProcess(child, {
        gracefulShutdown: () => new Promise(() => {}),
        gracefulTimeoutMs: 5,
        forceTimeoutMs: 5
    }), /仍未退出/);
    assert.equal(child.killCalls, 1);
    assert.equal(child.listenerCount('exit'), 0);
});

test('already-exited children do not receive another signal', async () => {
    const child = new Child();
    child.exit(1);
    await terminateProcess(child);
    assert.equal(child.killCalls, 0);
});
