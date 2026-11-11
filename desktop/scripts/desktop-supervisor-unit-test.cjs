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
    assert.doesNotMatch(html, /loading-factory\.png|id="bar"|id="percent"/);
    // Activation deliberately has its own waiting indicator. It is hidden in
    // the compact pre-Unity state and must not invalidate supervision tests.
    assert.match(html, /<section[^>]*id="activationPanel"[^>]*hidden>/);
    for (const match of html.matchAll(/([^{}]+)\{([^{}]*\banimation\s*:[^{}]*)\}/g)) {
        assert.match(match[1], /activation-art|prefers-reduced-motion/);
    }
});

test('frameless startup can be dragged without swallowing activation, actions or copyable errors', () => {
    const html = fs.readFileSync(path.join(desktopDir, 'assets', 'startup.html'), 'utf8');
    assert.match(html, /body\s*\{[^}]*-webkit-app-region:\s*drag;/);
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const exclusions = css.match(/([^{}]+)\{[^{}]*-webkit-app-region:\s*no-drag;[^}]*\}/);
    assert.ok(exclusions, 'interactive areas must opt out of native window dragging');
    for (const selector of ['button', 'input', 'textarea', 'select', 'a', '#title', '#detail', '.failure', '#activationPanel']) {
        assert.ok(exclusions[1].split(',').map(value => value.trim()).includes(selector), selector);
    }
    const source = fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8');
    const startup = source.slice(source.indexOf('async function createStartupWindow()'), source.indexOf('function closeStartupWindow()'));
    assert.match(startup, /frame:\s*false/);
    assert.match(startup, /movable:\s*true/);
    assert.match(startup, /maximizable:\s*false/);
    assert.match(startup, /contextIsolation:\s*true/);
    assert.match(startup, /sandbox:\s*true/);
});

test('blue-white loading avoids timed fake progress, layout animations and modal overlay flicker', () => {
    const read = file => fs.readFileSync(path.resolve(desktopDir, '..', file), 'utf8');
    const html = read('desktop/assets/startup.html');
    assert.match(html, /color-scheme:\s*light/);
    assert.match(html, /--startup-background,#f5f7fb/);
    assert.match(html, /background:\s*#2563eb/);
    const native = read('native-admin-host/DashboardLoadingExperience.cs');
    assert.doesNotMatch(native, /setInterval|transition:(?:width|left)|filter:drop-shadow/);
    assert.match(native, /progressFrame = requestAnimationFrame/);
    assert.match(native, /window\.removeEventListener\('digital-twin-loading-progress', onProgress\)/);
    assert.match(native, /transition:transform \.18s/);
    const form = read('native-admin-host/AdminPanelForm.cs');
    const close = form.slice(form.indexOf('private async void HandleCloseRequest()'), form.indexOf('private void ShowDetachedDashboardChrome()'));
    assert.doesNotMatch(close, /HideOverlay/);
    assert.match(form, /if \(_closeChoiceOpen\) return;[\s\S]*?TryResolveParentWindow\(parentAlreadyChecked/);
    assert.match(form, /if \(overlayWasEnabled\) NativeMethods.EnableWindow\(overlayHandle, false\)/);
    const dialog = read('native-admin-host/CloseChoiceDialog.cs');
    assert.match(dialog, /SuspendLayout\(\)/);
    assert.match(dialog, /ResumeLayout\(true\)/);
    assert.match(dialog, /SetStyle\(ControlStyles.StandardClick \| ControlStyles.StandardDoubleClick, false\)/);
    assert.match(dialog, /_roundedSize == Size && _roundedDpi == DeviceDpi/);
});

test('desktop remembers either theme and honors explicit choices over old cached colors', () => {
    const desktop = loadDesktop();
    assert.equal(desktop.run("normalizeStartupAppearance({}).theme"), 'light');
    assert.equal(desktop.run("normalizeStartupAppearance({background:'#28282b',accent:'#a8c3b1'}).theme"), 'dark');
    assert.equal(desktop.run("normalizeStartupAppearance({theme:'light',background:'#28282b'}).background"), '#f5f7fb');
    assert.equal(desktop.run("normalizeStartupAppearance({theme:'dark'}).background"), '#28282b');
    const source = fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8');
    const launch = source.slice(source.indexOf('async function launchApplication()'));
    assert.ok(launch.indexOf('await applyStartupAppearance(await readStartupAppearance(port), true)') < launch.indexOf('await startNativeClient('), 'authoritative theme precedes the Unity/AdminHost environment snapshot, including remote-client mode');
    const control = source.slice(source.indexOf('function startDesktopControlServer()'), source.indexOf('function nativeHostPipePath()'));
    assert.ok(control.indexOf('suppliedToken !== desktopControlToken') < control.indexOf("'/appearance/light'"));
    assert.match(control, /applyStartupAppearance\([\s\S]*?true\)/);
});

class Child extends EventEmitter {
    pid = 12345;
    exitCode = null;
    signalCode = null;
    killed = false;
    killCalls = 0;
    kill() { this.killed = true; this.killCalls += 1; return true; }
    exit(code = 0, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal); }
}

function loadDesktop({ createLog, spawnProcess, userDataPath, deploymentConfig, fileSystem, electron = {} } = {}) {
    const app = new EventEmitter();
    const timers = [];
    const intervals = [];
    const exits = [];
    const logs = [];
    const logStreams = [];
    const gateway = { origin:'http://127.0.0.1:34123', options:null, closed:false, async close(){this.closed=true;} };
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
        setInterval: (callback, milliseconds) => { const timer={callback,milliseconds,unref(){}}; intervals.push(timer); return timer; },
        clearInterval() {},
        require: name => {
            if (name === 'electron') return { app, dialog: { showErrorBox() {} }, ...electron };
            if (name === 'fs' && fileSystem) return fileSystem;
            if (name === 'child_process') return { spawn: (...args) => {
                spawnCalls += 1;
                if (spawnProcess) return spawnProcess(...args);
                throw new Error('unexpected spawn');
            } };
            if (name === './processLifecycle.cjs') return require('../processLifecycle.cjs');
            if (name === './mysqlRuntime.cjs') return require('../mysqlRuntime.cjs');
            if (name === './directoryPublish.cjs') return require('../directoryPublish.cjs');
            // Native path resolution has its own real-junction regression.
            // This supervisor VM uses nonexistent paths and a fake filesystem.
            if (name === './nativeClientPath.cjs') return { resolveNativeClientPath: dir => dir, validateNativeClientFiles() {} };
            // This VM tests supervision with fake paths/filesystems. Template
            // seeding has dedicated tests and must not touch the real disk here.
            if (name === './templateData.cjs') return { seedTemplateConfiguration: async () => {} };
            if (name === './deployment.cjs') return { ...require('../deployment.cjs'),
                ...(deploymentConfig ? { resolveDeployment: () => deploymentConfig } : {}) };
            // Activation IPC/network has dedicated integration tests. A VM
            // supervision unit must never contact a real local installation.
            if (name === './activation.cjs') return { runStartupActivation: async () => {} };
            if (name === './displayGateway.cjs') return {startDisplayGateway:async options=>{gateway.options=options;return gateway;}};
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
        app, timers, intervals, exits, logs, logStreams, context, gateway,
        run: source => vm.runInContext(source, context),
        get spawnCalls() { return spawnCalls; }
    };
}

function downloadWindowFixture() {
    const session = new EventEmitter(), windows = [], saves = [];
    class Window extends EventEmitter {
        destroyed = false;
        webContents = Object.assign(new EventEmitter(), { session, setWindowOpenHandler() {} });
        constructor() { super(); windows.push(this); }
        isDestroyed() { return this.destroyed; }
        loadURL() {}
        destroy() { this.destroyed = true; this.emit('closed'); }
    }
    const desktop = loadDesktop({ electron: {
        BrowserWindow: Window,
        dialog: { showErrorBox() {}, showSaveDialog(owner) {
            const save = { owner };
            save.promise = new Promise(resolve => { save.resolve = resolve; });
            saves.push(save);
            return save.promise;
        } }
    } });
    const item = () => ({ paused: 0, resumed: 0, cancelled: 0,
        pause() { this.paused++; }, resume() { this.resumed++; }, cancel() { this.cancelled++; },
        getFilename: () => 'backup.zip', setSavePath() {} });
    return { desktop, session, windows, saves, item };
}

test('collector-center compatibility entry hands off to native UI without database, backend, power request or Unity', async () => {
    const desktop = loadDesktop();
    desktop.run(`
        process.argv = ['--collector-center'];
        centerOpened = false;
        showCollectorCenter = async () => { centerOpened = true; };
        initializeWritableData = () => { throw new Error('must not initialize data'); };
        startBackend = () => { throw new Error('must not spawn backend'); };
        startNativeClient = () => { throw new Error('must not spawn Unity'); };
    `);
    await desktop.run('launchApplication()');
    assert.equal(desktop.run('centerOpened'), true);
    assert.equal(desktop.run('displayPowerRequest'), null);
    assert.equal(desktop.spawnCalls, 0);
});

test('recreating admin windows releases the shared-session download listener', async () => {
    const { desktop, windows, session, saves, item } = downloadWindowFixture();
    for (let index = 0; index < 25; index++) {
        desktop.run("createMainWindow('http://127.0.0.1:3001')");
        assert.equal(session.listenerCount('will-download'), 1);
        windows.at(-1).destroy();
        assert.equal(session.listenerCount('will-download'), 0);
    }
    desktop.run("createMainWindow('http://127.0.0.1:3001')");
    const download = item();
    session.emit('will-download', {}, download, windows.at(-1).webContents);
    assert.equal(saves.length, 1);
    saves[0].resolve({ filePath: 'selected.zip' });
    await tick();
    assert.equal(download.resumed, 1);
    windows.at(-1).destroy();
});

test('pending download dialogs cannot resume a closed window download in its replacement', async () => {
    const { desktop, windows, session, saves, item } = downloadWindowFixture();
    desktop.run("createMainWindow('http://127.0.0.1:3001')");
    const original = windows[0], download = item();
    session.emit('will-download', {}, download, original.webContents);
    original.destroy();
    desktop.run("createMainWindow('http://127.0.0.1:3001')");
    saves[0].resolve({ filePath: 'selected.zip' });
    await tick();
    assert.equal(saves[0].owner, original);
    assert.equal(download.resumed, 0);
    assert.equal(download.cancelled, 1);
    windows.at(-1).destroy();
});

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
        desktop.app.isPackaged = true;
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

test('workspace startup reuses source dependencies, but installed startup cannot borrow them', async () => {
    const desktop = loadDesktop();
    desktop.run(`
        app.isPackaged = false;
        backendDependenciesReady = directory => directory.endsWith('node_modules');
        resourcePath = () => { throw new Error('archive path reached'); };
    `);
    assert.equal(await desktop.run('ensureBackendDependencies()'), path.resolve(desktopDir,'../backend/node_modules'));
    desktop.app.isPackaged = true;
    await assert.rejects(desktop.run('ensureBackendDependencies()'), /archive path reached/);
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

for (const lostNative of [false, true]) test('parallel runtime settings preserve activation/readiness gates' + (lostNative ? ' and reject a native exit while waiting' : ''), async () => {
    const desktop = loadDesktop();
    const nativeChild = new Child();
    desktop.context.unitNativeChild = nativeChild;
    desktop.run(`
        startupOrder = [];
        activationGate = new Promise(resolve => { finishActivation = resolve; });
        settingsGate = new Promise(resolve => { finishSettings = resolve; });
        createStartupWindow = async () => {};
        initializeWritableData = () => ({ logsDir: 'unit-test-logs' });
        guardLogStream = stream => stream; startLogMaintenance = () => {};
        findAvailablePort = async () => 3001; startDesktopControlServer = async () => {};
        startBackend = async () => ({}); waitForHealth = async () => {};
        waitForStartupActivation = async () => { startupOrder.push('activation'); await activationGate; };
        readStartupAppearance = async () => ({theme:'light'});
        applyStartupAppearance = async () => {};
        refreshStartupAppearanceWhenReady = async () => {};
        startDesktopSettingsSync = () => { startupOrder.push('settings'); return settingsGate; };
        createTray = () => {};
        startNativeClient = async () => { startupOrder.push('native'); nativeProcess = unitNativeChild; return { process: unitNativeChild, ready: Promise.resolve() }; };
        waitForNativeHostReady = async () => { startupOrder.push('host'); };
        closeStartupWindow = () => {}; scheduleSmokeTimers = () => {};
    `);
    const startup = desktop.run('launchApplication()');
    await tick();
    assert.deepEqual(Array.from(desktop.run('startupOrder')), ['activation']);
    desktop.run('finishActivation()'); await tick();
    assert.deepEqual(Array.from(desktop.run('startupOrder')), ['activation','settings','native','host']);
    assert.equal(desktop.run('applicationReadyForInteraction'), false);
    if (lostNative) nativeChild.exit(1);
    desktop.run('finishSettings()');
    if (lostNative) {
        await assert.rejects(startup, /三维大屏在启动完成前退出/);
        assert.equal(desktop.run('applicationReadyForInteraction'), false);
    } else {
        await startup; assert.equal(desktop.run('applicationReadyForInteraction'), true);
    }
});

test('slow runtime settings polling is single-flight, not repeated every timer tick', async () => {
    const desktop = loadDesktop();
    desktop.run(`
        backendPort = 3001; reads = 0;
        runtimeGate = new Promise(resolve => { finishRuntimeRead = resolve; });
        readRuntimeSettings = () => { reads += 1; return runtimeGate; };
    `);
    const first = desktop.run('syncDesktopSettings()'), second = desktop.run('syncDesktopSettings()');
    assert.equal(first,second);
    assert.equal(desktop.run('reads'),1);
    desktop.run('finishRuntimeRead({})');await first;
    await desktop.run('syncDesktopSettings()');assert.equal(desktop.run('reads'),2);
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

test('service-connected Unity startup and exit never own or stop the collector', async () => {
    const desktop = loadDesktop({ deploymentConfig: { mode: 'client', backendOrigin: 'http://127.0.0.1:3901' } });
    desktop.run(`
        createStartupWindow = async () => {};
        initializeWritableData = () => ({ logsDir: 'unit-test-logs' });
        guardLogStream = stream => stream;
        startLogMaintenance = () => {};
        configureAutoStart = () => {};
        readStartupAppearance = async () => ({});
        applyStartupAppearance = async () => {};
        startDesktopControlServer = async () => {};
        createTray = () => {};
        startBackend = () => { throw new Error('client must not collect'); };
        findAvailablePort = () => { throw new Error('client must not allocate backend ports'); };
        startDesktopSettingsSync = () => { throw new Error('client must not supervise server'); };
        waitForHealth = async url => { remoteHealthUrl = url; };
        startNativeClient = async origin => { remoteNativeOrigin = origin; return { ready: Promise.resolve() }; };
        waitForNativeHostReady = async () => {};
        closeStartupWindow = () => {};
        scheduleSmokeTimers = () => {};
        requestBackendShutdown = () => { throw new Error('client must never shut down remote collector'); };
    `);
    await desktop.run('launchApplication()');
    assert.equal(desktop.run('remoteNativeOrigin'), desktop.gateway.origin);
    assert.equal(desktop.run('remoteHealthUrl'), desktop.gateway.origin+'/api/health');
    assert.equal(desktop.gateway.options.backendOrigin,'http://127.0.0.1:3901');
    assert.ok(desktop.gateway.options.portFile.endsWith('ui-gateway.json'));
    await desktop.run('stopBackend()');
    await desktop.run('displayGateway.close()');assert.equal(desktop.gateway.closed,true);
    assert.equal(desktop.spawnCalls, 0);
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

async function nativeExitFixture({ ready = true } = {}) {
    const child = new Child();
    const events = [];
    const desktop = loadDesktop({
        fileSystem: { ...fs, existsSync: () => true },
        spawnProcess: () => {
            setImmediate(() => child.emit('spawn'));
            return child;
        },
        electron: { dialog: { showErrorBox(title, message) {
            events.push(['error', message]);
            assert.equal(desktop.run('isQuitting'), true, 'shutdown must begin before the modal error');
        } } }
    });
    desktop.app.quit = () => {
        events.push(['quit']);
        desktop.app.emit('before-quit', { preventDefault() {} });
    };
    desktop.context.lifecycleEvents = events;
    desktop.run(`
        applicationOrigin = 'http://127.0.0.1:3001';
        writablePaths = { logsDir: 'unit-test-logs' };
        applicationReadyForInteraction = ${ready};
        updateTrayMenu = () => {};
        createMainWindow = () => lifecycleEvents.push(['create-admin']);
        mainWindow = { isDestroyed: () => false, hide: () => lifecycleEvents.push(['hide-admin']) };
        stopBackend = () => Promise.resolve();
        stopDesktopControlServer = () => Promise.resolve();
    `);
    await desktop.run('startNativeClient(applicationOrigin, writablePaths)');
    return { desktop, child, events };
}

test('forced Unity exit closes the client before its error dialog and never opens standalone admin', async () => {
    const { desktop, child, events } = await nativeExitFixture();
    child.exit(1);
    assert.deepEqual(events.map(([name]) => name), ['quit', 'hide-admin', 'error']);
    assert.match(events[2][1], /Unity 原生大屏异常退出（代码 1）/);
    assert.match(events[2][1], /native-client-error\.log/);
    assert.equal(desktop.run('nativeProcess'), null);
    assert.equal(desktop.run('nativeHostReady'), false);
    assert.equal(desktop.logStreams.every(stream => stream.ended), true);
    // A tray click, delayed ready-to-show, pipe request or queued restart may
    // arrive while the modal is up / child cleanup is still pending.
    desktop.run('showAdminWindow(); showNativeAdminPanel(); showNativeDashboard();');
    await desktop.run('restartNativeClient()');
    await tick();
    assert.equal(desktop.spawnCalls, 1);
    assert.equal(events.some(([name]) => name === 'create-admin'), false);
    assert.deepEqual(desktop.exits, [0]);
});

test('normal Unity exit also closes the client without an error or standalone admin', async () => {
    const { desktop, child, events } = await nativeExitFixture();
    child.exit(0);
    await tick();
    assert.deepEqual(events.map(([name]) => name), ['quit', 'hide-admin']);
    assert.deepEqual(desktop.exits, [0]);
});

test('signal termination reports the signal rather than an empty exit code', async () => {
    const { desktop, child, events } = await nativeExitFixture();
    child.exit(null, 'SIGTERM');
    await tick();
    assert.match(events.find(([name]) => name === 'error')[1], /代码 SIGTERM/);
    assert.deepEqual(desktop.exits, [0]);
});

test('controlled Unity stop does not quit the client or create a fallback admin window', async () => {
    const { desktop, child, events } = await nativeExitFixture();
    const stopping = desktop.run('stopNativeClient()');
    child.exit(1);
    await stopping;
    assert.deepEqual(events, []);
    assert.equal(desktop.run('isQuitting'), false);
    assert.deepEqual(desktop.exits, []);
});

test('Unity exit during startup remains owned by the startup failure UI', async () => {
    const { desktop, child, events } = await nativeExitFixture({ ready: false });
    child.exit(1);
    await tick();
    assert.deepEqual(events, []);
    assert.equal(desktop.run('isQuitting'), false);
    assert.deepEqual(desktop.exits, []);
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


test('exhausted backend recovery reports an actionable error without quitting the live Unity scene',async()=>{
    const desktop=loadDesktop();let quits=0;desktop.app.quit=()=>{quits++};
    desktop.context.liveUnity=new Child();
    desktop.run("nativeProcess=liveUnity;backendRestartAttempts=BACKEND_RESTART_DELAYS_MS.length;showRuntimeFailure=async message=>recordedLogs.push({kind:'runtime-ui',message})");
    desktop.run("scheduleBackendRestart({},3001,'fixture failure')");await Promise.resolve();
    assert.equal(quits,0);assert.equal(desktop.run('nativeProcess'),desktop.context.liveUnity);assert.ok(desktop.logs.some(log=>log.kind==='runtime-ui'));
});
test('missing native host is relaunched without restarting Unity or API, with bounded attempts',async()=>{
    const desktop=loadDesktop();desktop.context.liveUnity=new Child();
    desktop.run("nativeProcess=liveUnity;applicationReadyForInteraction=true;sendNativeHostCommand=async()=>false;launchNativeAdminHost=()=>recordedLogs.push({kind:'restore-host'});showRuntimeFailure=async message=>recordedLogs.push({kind:'runtime-ui',message});startNativeHostMonitor()");
    const tick=desktop.intervals.at(-1).callback;
    for(let i=0;i<8;i++)await tick();
    assert.equal(desktop.logs.filter(log=>log.kind==='restore-host').length,3);assert.equal(desktop.run('nativeProcess'),desktop.context.liveUnity);assert.ok(desktop.logs.some(log=>log.kind==='runtime-ui'));
    desktop.run('isQuitting=true');await tick();assert.equal(desktop.logs.filter(log=>log.kind==='restore-host').length,3);
});
