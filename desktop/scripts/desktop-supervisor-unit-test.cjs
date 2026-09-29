const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const tick = () => new Promise(resolve => setImmediate(resolve));
const desktopDir = path.resolve(__dirname, '..');

test('pre-Unity status is compact and has no competing loading artwork or progress bar', () => {
    const html = fs.readFileSync(path.join(desktopDir, 'assets', 'startup.html'), 'utf8');
    assert.match(html, /<body class="launch-status">/);
    assert.match(html, /id="title"/);
    assert.match(html, /id="elapsed"/);
    assert.match(html, /body\.launch-status\s*\{\s*padding:\s*0;/);
    assert.match(html, /body\.launch-status \.shell\s*\{[^}]*border-radius:\s*0;/);
    assert.doesNotMatch(html, /loading-factory\.png|id="bar"|id="percent"|@keyframes/);
});

class Child extends EventEmitter {
    pid = 12345;
    exitCode = null;
    signalCode = null;
    killed = false;
    killCalls = 0;
    kill() { this.killed = true; this.killCalls += 1; return true; }
    exit() { this.exitCode = 0; this.emit('exit', 0, null); }
}

function loadDesktop({ createLog, spawnProcess, userDataPath } = {}) {
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
    app.getPath = () => userDataPath || 'unused-unit-test-path';
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
            if (name === 'child_process') return { spawn: (...args) => {
                spawnCalls += 1;
                if (spawnProcess) return spawnProcess(...args);
                throw new Error('unexpected spawn');
            } };
            if (name === './processLifecycle.cjs') return require('../processLifecycle.cjs');
            if (name === './mysqlRuntime.cjs') return require('../mysqlRuntime.cjs');
            if (name === './directoryPublish.cjs') return require('../directoryPublish.cjs');
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

test('first-run dependency extraction yields to the event loop', async () => {
    const outputDir = path.resolve(desktopDir, '..', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const userDataPath = fs.mkdtempSync(path.join(outputDir, 'async-dependencies-test-'));
    const tarFile = path.join(userDataPath, 'backend-dependencies.tar');
    fs.writeFileSync(tarFile, 'test archive');
    let extractor;
    try {
        const desktop = loadDesktop({
            userDataPath,
            spawnProcess: () => {
                extractor = new EventEmitter();
                return extractor;
            }
        });
        desktop.context.testResourcePath = name => path.join(userDataPath, name);
        desktop.run('resourcePath = testResourcePath; backendDependenciesReady = () => true; updateStartupProgress = () => {};');
        const pending = desktop.run('ensureBackendDependencies()');
        let earlyFailure;
        pending.catch(error => { earlyFailure = error; });
        const deadline = Date.now() + 10000;
        while (!extractor && !earlyFailure && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (earlyFailure) throw earlyFailure;
        assert.ok(extractor, 'the asynchronous extractor must start');
        let eventLoopTurned = false;
        setImmediate(() => { eventLoopTurned = true; });
        await tick();
        assert.equal(eventLoopTurned, true);
        let settled = false;
        pending.then(() => { settled = true; });
        await tick();
        assert.equal(settled, false, 'extraction must not block the UI thread');
        extractor.emit('exit', 0, null);
        await tick();
        assert.equal(settled, false, 'publication must wait for extractor handles to close');
        extractor.emit('close', 0, null);
        assert.equal(await pending, path.join(userDataPath, 'backend-dependencies'));
    } finally {
        fs.rmSync(userDataPath, { recursive: true, force: true });
    }
});

test('normal startup shows an immediate status window before service initialization', async () => {
    const desktop = loadDesktop();
    desktop.run(`
        testSplashCreations = 0;
        createStartupWindow = async () => { testSplashCreations += 1; };
        process.env.DESKTOP_SMOKE_FORCE_STARTUP_ERROR = 'startup probe';
    `);
    await assert.rejects(desktop.run('launchApplication()'), /startup probe/);
    assert.equal(desktop.run('testSplashCreations'), 1);
});

test('static startup status yields to Unity before waiting for the embedded admin host', async () => {
    const desktop = loadDesktop();
    desktop.run(`
        startupOrder = [];
        createStartupWindow = async () => { startupOrder.push('status'); };
        initializeWritableData = () => ({ logsDir: 'unit-test-logs' });
        guardLogStream = stream => stream;
        startLogMaintenance = () => {};
        findAvailablePort = async () => 3001;
        startDesktopControlServer = async () => {};
        startBackend = async () => { startupOrder.push('backend'); return {}; };
        waitForHealth = async () => {};
        refreshStartupAppearanceWhenReady = async () => {};
        startDesktopSettingsSync = async () => {};
        createTray = () => {};
        startNativeClient = async () => ({ ready: Promise.resolve() });
        closeStartupWindow = () => { startupOrder.push('handoff'); };
        waitForNativeHostReady = async () => { startupOrder.push('host'); };
        scheduleSmokeTimers = () => {};
    `);
    await desktop.run('launchApplication()');
    assert.deepEqual(Array.from(desktop.run('startupOrder')), ['status', 'backend', 'handoff', 'host', 'handoff']);
});

test('startup failures restore an actionable, enlarged status window after handoff', async () => {
    const desktop = loadDesktop();
    desktop.run(`
        failureWindowEvents = [];
        persistStartupFailure = () => 'test-startup-error.log';
        createStartupWindow = async () => {
            startupWindow = {
                isDestroyed: () => false,
                webContents: { isLoading: () => false, executeJavaScript: async () => {} },
                setSize: (width, height) => failureWindowEvents.push(['size', width, height]),
                center: () => failureWindowEvents.push(['center']),
                setSkipTaskbar: value => failureWindowEvents.push(['taskbar', value]),
                show: () => failureWindowEvents.push(['show']),
                focus: () => failureWindowEvents.push(['focus'])
            };
        };
    `);
    await desktop.run('showStartupFailure(new Error("backend unavailable"))');
    assert.equal(desktop.run('startupState.status'), 'error');
    assert.equal(desktop.run('startupState.error'), 'backend unavailable');
    assert.deepEqual(Array.from(desktop.run('failureWindowEvents')).map(event => Array.from(event)), [
        ['size', 620, 360], ['center'], ['taskbar', false], ['show'], ['focus']
    ]);
});

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

test('before-quit starts Unity and backend shutdown concurrently and waits for both', async () => {
    const desktop = loadDesktop();
    desktop.run(`
        shutdownStarted = [];
        let finishNative, finishBackend;
        stopNativeClient = () => { shutdownStarted.push('native'); return new Promise(resolve => { finishNative = resolve; }); };
        stopBackend = () => { shutdownStarted.push('backend'); return new Promise(resolve => { finishBackend = resolve; }); };
        stopDesktopControlServer = () => Promise.resolve();
    `);
    desktop.app.emit('before-quit', { preventDefault() {} });
    assert.deepEqual(Array.from(desktop.run('shutdownStarted')), ['native', 'backend']);
    desktop.run('finishNative()');
    await tick();
    assert.deepEqual(desktop.exits, []);
    desktop.run('finishBackend()');
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
