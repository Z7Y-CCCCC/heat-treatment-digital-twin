// Real native GUI / current-user named-pipe navigation against one owned,
// off-screen fixture. No installed center, backend, database or SCM operations.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createServiceControl, collectorCenterArguments } = require('../desktop/serviceControl.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const directory = process.env.COLLECTOR_CENTER_NAVIGATION_OUTPUT ? path.resolve(process.env.COLLECTOR_CENTER_NAVIGATION_OUTPUT)
    : path.join(root, 'output', 'collector-center-navigation', `${Date.now()}-${process.pid}`);
const buildDirectory = process.env.DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR ? path.resolve(process.env.DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR) : path.join(directory, 'gui');
fs.mkdirSync(directory, { recursive: true });
let child;
const checks = [], pass = message => { checks.push(message); console.log('PASS ' + message); };
const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8').replace(/^\uFEFF/, ''));
const wait = async (predicate, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw Error('Owned native navigation fixture timed out'); };
(async () => {
    const build = spawnSync(process.execPath, [path.join(root, 'desktop/scripts/build-collector-center.cjs')], {
        cwd: root, env: { ...process.env, DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR: buildDirectory }, windowsHide: true, encoding: 'utf8', timeout: 120000
    });
    fs.writeFileSync(path.join(directory, 'build.log'), (build.stdout || '') + (build.stderr || ''));
    if (build.error) throw build.error; assert.equal(build.status, 0, build.stdout + build.stderr);
    const executable = path.join(buildDirectory, 'HeatTreatmentCollectorCenter.exe');
    for (const args of [['--view', '../quit'], ['--view', 'logs'], ['--unknown'], ['--view', 'points', 'TOKEN']]) {
        const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        if (result.error) throw result.error; assert.equal(result.status, 2); assert.equal(result.stdout.trim(), '');
    }
    pass('strict CLI rejects unknown tabs, path/command tricks and extra values before opening a GUI');
    child = spawn(executable, ['--navigation-smoke-test', directory], { cwd: root, windowsHide: true, stdio: 'ignore' });
    await wait(() => fs.existsSync(path.join(directory, 'navigation-ready.json')));
    const ready = read('navigation-ready.json'); assert.equal(ready.processId, child.pid); assert.equal(ready.selectedIndex, 3); assert.match(ready.caption, /数据服务/);
    pass('owned GUI starts the overview/API-database view without touching the real collector');
    let restartCalls = 0;
    const handle = createServiceControl({ restart: async () => { restartCalls++; }, openCenter: async ({ view }) => {
        const argv = collectorCenterArguments(view); assert.deepEqual(argv, ['--open-view', view]);
        const result = spawnSync(executable, ['--navigation-smoke-select', directory, argv[1]], { windowsHide: true, encoding: 'utf8', timeout: 12000 });
        if (result.error) throw result.error; assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), `COLLECTOR_CENTER_VIEW:${view}`);
        return { opened: true, view };
    } });
    for (const [pathname, view] of [['/service/collector-center/data', 'points'], ['/service/collector-center/runtime', 'overview'], ['/service/collector-center/data', 'points']]) {
        const reply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Native receipt not returned')), 14000);
            const response = { writeHead(status) { this.status = status; }, end(body) { clearTimeout(timer); resolve({ status: this.status, body: JSON.parse(body) }); } };
            assert.equal(handle({ method: 'POST' }, response, pathname), true);
        });
        assert.equal(reply.status, 200); assert.deepEqual(reply.body, { success: true, opened: true, view });
        await new Promise(resolve => setImmediate(resolve)); // allow the confirmed operation's finally to release its mutex
    }
    assert.equal(restartCalls, 0);
    await wait(() => fs.existsSync(path.join(directory, 'navigation-result.json')));
    const gui = read('navigation-result.json'); assert.equal(gui.success, true, gui.error); assert.equal(gui.processId, child.pid);
    assert.deepEqual(gui.views, ['points', 'overview', 'points']); assert.equal(gui.selectedIndex, 1); assert.match(gui.caption, /设备采集/); assert.match(gui.sharedServiceNote, /设备采集状态与点位/);
    assert.equal(gui.states.length, 5);
    for (const state of gui.states.filter(row => ['points', 'overview'].includes(row.view))) {
        const data = state.view === 'overview';
        assert.equal(state.workspace, state.view);
        assert.deepEqual(state.pages, data ? [3, 2] : [0, 1]);
        assert.deepEqual(state.navigation, data ? ['API / 数据库', '后台日志'] : ['采集状态', '采集点位']);
        assert.equal(state.serviceControlsVisible, data, 'whole-backend controls only belong to data services');
        if (data) {
            assert.equal(state.headline, '数据服务正常', 'PLC failures cannot label API/database as failed');
            assert.deepEqual(state.metrics.slice(0, 2), ['可达', '已连接']);
            assert.doesNotMatch(state.summary, /9 台设备异常/);
        } else assert.deepEqual(state.metrics, ['0', '9', '88.1 秒前']);
    }
    assert.equal(gui.states.find(row => row.view === 'database-error').headline, '数据库连接异常');
    assert.equal(gui.states.find(row => row.view === 'api-error').headline, '后台 API 不可达');
    pass('separate workspaces exercise real navigation buttons, isolate metrics and service controls, and distinguish PLC/database/API failure states');
    pass('production fixed routes obtain matching receipts only after the same GUI instance switches points/overview/points');
    await wait(() => child.exitCode !== null, 10000); assert.equal(child.exitCode, 0);
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, checks, gui, executable, installerBuilt: false, collectorServiceOperations: 0, fixtureOnly: true }, null, 2));
    console.log(JSON.stringify({ success: true, report: path.join(directory, 'report.json') }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => { await stopOwnedSmokeProcess(child); });
