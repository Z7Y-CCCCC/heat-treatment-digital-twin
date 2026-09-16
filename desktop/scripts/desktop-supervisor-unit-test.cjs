const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const tick = () => new Promise(resolve => setImmediate(resolve));
const desktopDir = path.resolve(__dirname, '..');

class Child extends EventEmitter {
    pid = 12345;
    exitCode = null;
    signalCode = null;
    killed = false;
    killCalls = 0;
    kill() { this.killed = true; this.killCalls += 1; return true; }
    exit() { this.exitCode = 0; this.emit('exit', 0, null); }
}

function loadDesktop({ createLog } = {}) {
    const app = new EventEmitter();
    const timers = [];
    const exits = [];
    const logs = [];
    const logStreams = [];
    let spawnCalls = 0;
    app.commandLine = { appendSwitch() {} };
    app.requestSingleInstanceLock = () => true;
    app.whenReady = () => new Promise(() => {});
    app.quit = () => {};
    app.exit = code => exits.push(code);
    app.getPath = () => 'unused-unit-test-path';
    const context = vm.createContext({
        process: { env: {}, platform: 'win32', pid: 99, argv: [] },
        __dirname: desktopDir,
        console,
        URL,
        setImmediate,
        setTimeout: (callback, milliseconds) => {
            const timer = { callback, milliseconds, cleared: false, unref() {} };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => { if (timer) timer.cleared = true; },
        setInterval: () => ({ unref() {} }),
        clearInterval() {},
        require: name => {
            if (name === 'electron') return { app, dialog: { showErrorBox() {} } };
            if (name === 'child_process') return { spawn: () => { spawnCalls += 1; throw new Error('unexpected spawn'); } };
            if (name === './processLifecycle.cjs') return require('../processLifecycle.cjs');
            if (name === './logManager.cjs') return {
                cleanupLogArchives() {},
                createRotatingLogWriter: createLog || (async () => {
                    const stream = new EventEmitter();
                    stream.end = () => { stream.ended = true; };
                    logStreams.push(stream);
                    return stream;
                })
            };
            return require(name);
        },
        recordedLogs: logs
    });
    vm.runInContext(fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8'), context);
    vm.runInContext('logDesktopError = (kind, error) => recordedLogs.push({ kind, message: error.message });', context);
    return {
        app, timers, exits, logs, logStreams, context,
        run: source => vm.runInContext(source, context),
        get spawnCalls() { return spawnCalls; }
    };
}

test('a health-timeout recovery reaps the failed attempt before scheduling another', async () => {
    const desktop = loadDesktop();
    const child = new Child();
    desktop.context.child = child;
    desktop.run(`
        applicationOrigin = 'http://127.0.0.1:3001';
        startBackend = async () => child;
        waitForHealth = async () => { throw new Error('health timeout'); };
        scheduleBackendRestart({}, 3001, 'test crash');
    `);
    const recovery = desktop.timers.find(timer => timer.milliseconds === 1000).callback();
    await tick();
    assert.equal(child.killCalls, 1);
    assert.equal(desktop.logs.filter(log => log.kind === 'backend-restart-scheduled').length, 1);
    child.exit();
    await recovery;
    assert.equal(desktop.logs.filter(log => log.kind === 'backend-restart-scheduled').length, 2);
    assert.equal(desktop.run('backendRestartAttempts'), 2);
});

test('a new failure cancels the previous process stability reset', () => {
    const desktop = loadDesktop();
    desktop.run('backendRestartResetTimer = setTimeout(() => {}, 60000); scheduleBackendRestart({}, 3001, "test");');
    assert.equal(desktop.timers[0].cleared, true);
});

test('backend shutdown is idempotent and preserves tracking until actual exit', async () => {
    const desktop = loadDesktop();
    const child = new Child();
    child.killed = true;
    desktop.context.child = child;
    desktop.run('backendProcess = trackManagedProcess(child); requestBackendShutdown = async () => {};');
    const first = desktop.run('stopBackend()');
    const second = desktop.run('stopBackend()');
    assert.equal(first, second);
    assert.equal(desktop.run('managedProcesses.size'), 1);
    let completed = false;
    first.then(() => { completed = true; });
    await tick();
    assert.equal(completed, false);
    child.exit();
    await first;
    assert.equal(desktop.run('managedProcesses.size'), 0);
});

test('repeated before-quit does not bypass pending child cleanup', async () => {
    const desktop = loadDesktop();
    const child = new Child();
    desktop.context.child = child;
    desktop.run('nativeProcess = trackManagedProcess(child);');
    desktop.app.emit('before-quit', { preventDefault() {} });
    desktop.app.emit('before-quit', { preventDefault() {} });
    await tick();
    assert.deepEqual(desktop.exits, []);
    child.exit();
    await tick();
    assert.deepEqual(desktop.exits, [0]);
});

test('quitting during asynchronous log setup cannot spawn a late backend', async () => {
    const pending = [];
    const streams = [];
    const desktop = loadDesktop({ createLog: () => new Promise(resolve => pending.push(resolve)) });
    const starting = desktop.run('startBackend(3001, { logsDir: "unused-unit-test-path" })');
    desktop.run('isQuitting = true');
    for (const resolve of pending) {
        const stream = { ended: false, end() { this.ended = true; } };
        streams.push(stream);
        resolve(stream);
    }
    await assert.rejects(starting, /正在退出/);
    assert.equal(desktop.spawnCalls, 0);
    assert.equal(streams.every(stream => stream.ended), true);
});

test('an existing live backend prevents duplicate spawning', async () => {
    const desktop = loadDesktop();
    desktop.context.child = new Child();
    desktop.run('backendProcess = child');
    await assert.rejects(desktop.run('startBackend(3001, {})'), /旧数据服务仍在运行/);
    assert.equal(desktop.spawnCalls, 0);
});
