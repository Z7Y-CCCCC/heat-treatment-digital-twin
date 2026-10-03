const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createContinuityClock } = require('./endurance-continuity.cjs');
const { createMemorySummaryReader } = require('./endurance-memory.cjs');
const { writeReportFile } = require('./endurance-report-io.cjs');
const WebSocket = require('ws');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, forceStop } = require('./integration-test-utils.cjs');

function argument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    const value = index < 0 ? fallback : Number(process.argv[index + 1]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --${name}`);
    return value;
}
function textArgument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
    return value;
}
const databaseType = textArgument('database-type', 'sqlite');
if (!['sqlite', 'mysql'].includes(databaseType)) throw new Error('--database-type must be sqlite or mysql');
const mysqlRuntimeDir = path.resolve(textArgument('mysql-runtime-dir', path.join(BACKEND_DIR, '..', 'desktop', 'resources', 'mysql')));
const durationMs = argument('duration-seconds', 72 * 3600) * 1000;
const intervalMs = argument('interval-seconds', 5) * 1000;
const restartIntervalMs = process.argv.includes('--restart-interval-seconds') ? argument('restart-interval-seconds', 0) * 1000 : null;
const restartPolicy = { mode: restartIntervalMs === null ? 'once' : 'repeated', firstAfterSeconds: Math.min(300, durationMs / 2000), repeatIntervalSeconds: restartIntervalMs === null ? null : restartIntervalMs / 1000 };
const limits = { requestP95Ms: argument('max-p95-ms', 2000), wsSilenceMs: argument('max-ws-silence-seconds', 15) * 1000, rssMb: argument('max-rss-mb', 1024), rssGrowthMb: argument('max-rss-growth-mb', 256) };
limits.mysqlRssMb = argument('max-mysql-rss-mb', 2048);
limits.mysqlRssGrowthMb = argument('max-mysql-rss-growth-mb', 512);
const directory = createRunDirectory('endurance');
const dataDir = path.join(directory, 'data');
const memoryFile = path.join(directory, 'memory.jsonl');
const memoryReader = createMemorySummaryReader(memoryFile);
const stopFile = path.join(directory, 'STOP');
const token = crypto.randomBytes(32).toString('hex');
const startedAt = Date.now();
let workloadStartedAt = null, backend, socket, baseUrl, stopped = false, stopReason = '', restarting = false;
let privateMysql;
let workloadFinishedAt = null;
let continuity, continuityTimer, finishedElapsedMs, finishing = false;
const monotonicNow = () => performance.now();
const runtimeBinding = { widgetId: 'endurance_primary_metric', connectionId: 'primary', table: 'endurance_metrics', field: 'actual', expectedValue: 42.25, checks: 0, freshFetches: 0, lastFetchedAt: null };
let revision = 0, document, publishedReleaseId = '', cycles = 0, restarts = 0, reconnects = 0, frames = 0, lastFrameAt = 0;
let requestCount = 0, requestErrors = 0, maxLatency = 0;
const latencyBins = new Array(1201).fill(0); // 10 ms buckets, bounded memory for 72 h.
const errors = [];
let eventWrites = Promise.resolve(), observationPhase = 'setup';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function log(type, detail = {}) {
    const line = JSON.stringify({ ...detail, timestamp: Date.now(), type }) + '\n';
    eventWrites = eventWrites.then(() => fs.promises.appendFile(path.join(directory, 'events.jsonl'), line)).catch(failure => {
        errors.push({ timestamp: Date.now(), reason: `Event log write failed: ${failure.message}` });
        stop('event log write failed');
    });
}
function error(reason, detail = {}) { errors.push({ timestamp: Date.now(), reason: String(reason), ...detail }); log('failure', { reason: String(reason), ...detail }); }
function stop(reason) { stopped = true; stopReason = reason; }
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

async function api(route, method = 'GET', body) {
    const start = performance.now();
    requestCount++;
    try {
        const response = await fetch(baseUrl + route, { method, headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(`${route}: ${response.status} ${result.error || ''}`);
        return result;
    } catch (failure) { requestErrors++; throw failure; }
    finally {
        const elapsed = performance.now() - start;
        latencyBins[Math.min(1200, Math.ceil(elapsed / 10))]++;
        maxLatency = Math.max(maxLatency, elapsed);
    }
}
function p95() {
    let cumulative = 0;
    for (let index = 0; index < latencyBins.length; index++) { cumulative += latencyBins[index]; if (cumulative >= requestCount * .95) return index * 10; }
    return 0;
}
async function report(final = false) {
    const preparationStarted = monotonicNow();
    observationPhase = 'report-backend-memory';
    try { await memoryReader.refresh({ final }); }
    catch (failure) { error(`Backend memory evidence failed: ${failure.message}`); }
    const memoryReadMs = monotonicNow() - preparationStarted;
    observationPhase = 'report-mysql-memory';
    if (!final) await privateMysql?.sampleMemory();
    await eventWrites;
    const databaseEngine = privateMysql?.summary();
    const reporting = { memoryReadMs, preparationMs: monotonicNow() - preparationStarted };
    const elapsedMs = finishedElapsedMs ?? continuity?.elapsedMs() ?? 0;
    const memory = memoryReader.summary();
    const mysqlMemory = databaseEngine?.memory;
    const checks = {
        durationCompleted: elapsedMs >= durationMs && !stopped,
        continuousObservation: continuity?.summary().continuous === true,
        noErrors: errors.length === 0 && requestErrors === 0,
        requestsWithinLimit: p95() <= limits.requestP95Ms,
        memoryWithinLimit: memory.samples > 0 && memory.peakRssMb <= limits.rssMb && memory.maxRssGrowthMb <= limits.rssGrowthMb,
        mysqlMemoryWithinLimit: databaseType !== 'mysql' || Boolean(mysqlMemory && mysqlMemory.samples > 0 && mysqlMemory.errors.length === 0 && mysqlMemory.peakRssMb <= limits.mysqlRssMb && mysqlMemory.maxRssGrowthMb <= limits.mysqlRssGrowthMb),
        simulatedFramesReceived: frames > 0,
        restartRecoveryVerified: restarts > 0,
        mysqlRecoveryVerified: databaseType !== 'mysql' || (privateMysql?.generations.length > 1 && privateMysql.verifiedSnapshots > 1),
        clientReconnectVerified: reconnects > 0,
        persistenceCyclesCompleted: cycles > 0,
        publishedDatabaseBindingVerified: runtimeBinding.checks > 1 && runtimeBinding.freshFetches > 1
    };
    const status = !final ? 'running' : stopped || !checks.durationCompleted ? 'incomplete' : Object.values(checks).every(Boolean) ? 'passed' : 'failed';
    const result = { status, startedAt: new Date(startedAt).toISOString(), workloadStartedAt, reportedAt: new Date().toISOString(), requestedSeconds: durationMs / 1000, actualSeconds: elapsedMs / 1000, qualifiesAs72Hours: status === 'passed' && elapsedMs >= 72 * 3600000, stopReason, runnerPid: process.pid, backendPid: backend?.pid, restartPolicy, databaseEngine: databaseEngine || { type: 'sqlite', filename: path.join(dataDir, 'factory.db') }, isolation: { database: databaseType === 'mysql' ? privateMysql?.database : path.join(dataDir, 'factory.db'), baseUrl, simulationOnly: true, physicalPlcEnabled: false }, thresholds: limits, checks, runtimeBinding, cycles, restarts, reconnects, frames, requests: { count: requestCount, errors: requestErrors, p95UpperBoundMs: p95(), maxMs: maxLatency }, memory, errors: errors.slice(-100), artifacts: { directory, stopFile, memoryFile } };
    result.reporting = reporting;
    result.continuity = continuity?.summary() || { continuous: false, samples: 0 };
    observationPhase = 'report-write';
    await writeReportFile(path.join(directory, 'report.json'), JSON.stringify(result, null, 2));
    await writeReportFile(path.join(directory, 'report.md'), `# 隔离耐久测试\n\n- 状态：${status}\n- 计划 / 实际：${durationMs / 1000} / ${(elapsedMs / 1000).toFixed(1)} 秒\n- 完整 72 小时：${result.qualifiesAs72Hours ? '是' : '否'}\n- 循环 / 重启恢复 / 客户端重连：${cycles} / ${restarts} / ${reconnects}\n- 重启策略：${restartPolicy.mode}；首次 ${restartPolicy.firstAfterSeconds} 秒；重复间隔 ${restartPolicy.repeatIntervalSeconds ?? '无'} 秒\n- 数据库引擎：${databaseType}${privateMysql?.version ? ` ${privateMysql.version}` : ''}\n- 已发布数据库字段检查：${runtimeBinding.checks} 次；新查询结果 ${runtimeBinding.freshFetches} 次；固定值 ${runtimeBinding.expectedValue}\n- 模拟实时帧：${frames}\n- HTTP：${requestCount} 次，错误 ${requestErrors}，p95 上界 ${p95()} ms\n- 内存峰值：${memory.peakRssMb.toFixed(1)} MB；单进程代内存增长：${memory.maxRssGrowthMb.toFixed(1)} MB\n- 停止原因：${stopReason || '无'}\n\n## 判定\n\n${Object.entries(checks).map(([key, value]) => `- ${key}: ${value}`).join('\n')}\n\n## 限定\n\n隔离 ${databaseType} 与模拟采集，不连接现场数据库或 PLC；没有启动 Unity/电视/浏览器渲染。本报告不能替代现场显卡、投屏、PLC、数据库兼容和 72 小时验收。内存增长按每次进程启动 60 秒后基线计算，不代表已经证明无内存泄漏。\n\n## 错误\n\n${errors.slice(-100).map(item => `- ${item.reason}`).join('\n') || '无记录'}\n`);
    observationPhase = final ? 'finished' : 'workload';
    return result;
}
async function connect() {
    socket?.terminate();
    const active = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', { headers: { 'X-Admin-Token': token } });
    socket = active;
    active.on('error', failure => { if (active === socket && !restarting && !stopped && !finishing) error(`WebSocket error: ${failure.message}`); });
    active.on('close', () => { if (active === socket && !restarting && !stopped && !finishing) error('Unexpected WebSocket close'); });
    active.on('message', raw => {
        try { const message = JSON.parse(raw); if (message.type === 'realtime_frame' && Array.isArray(message.payload?.devices) && message.payload.devices.length) { const now = monotonicNow(); if (continuity && !restarting && lastFrameAt && now - lastFrameAt > limits.wsSilenceMs) error('WebSocket frame gap exceeded limit before stream recovered', { gapMs: now - lastFrameAt, observationPhase }); frames++; lastFrameAt = now; } } catch (failure) { error(`Invalid WebSocket message: ${failure.message}`); }
    });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000); active.once('open', () => { clearTimeout(timer); active.send(JSON.stringify({ type: 'client_hello', role: 'web' })); resolve(); }); active.once('error', failure => { clearTimeout(timer); reject(failure); }); });
    const deadline = Date.now() + limits.wsSilenceMs;
    const previous = frames;
    while (frames === previous && Date.now() < deadline) await sleep(100);
    assert.ok(frames > previous, 'No simulated data after WebSocket connection');
}
async function launch(port) {
    backend = startLoggedProcess(process.execPath, ['--require', path.join(__dirname, 'endurance-telemetry.cjs'), path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR, allowExternalDatabase: databaseType === 'mysql', env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), APP_DATA_DIR: dataDir, ADMIN_API_TOKEN: token, ENDURANCE_METRICS_FILE: memoryFile }, logFile: path.join(directory, 'backend.log')
    });
    log('backend-started', { pid: backend.pid });
    await waitForHttp(baseUrl + '/api/health', 30000);
    const engineDeadline = Date.now() + 30000;
    let mode;
    do {
        mode = (await api('/api/engine/status')).mode;
        if (mode === 'simulation') break;
        if (mode) throw new Error(`Only simulation mode is allowed, received ${mode}`);
        await sleep(200);
    } while (Date.now() < engineDeadline);
    assert.equal(mode, 'simulation', 'Simulation engine did not become ready');
    await connect();
}
async function cycle() {
    const state = await api('/api/platform/designer');
    revision = state.revision;
    document = state.document;
    if (!document.widgets.some(widget => widget.id === runtimeBinding.widgetId)) {
        document.widgets.push({ id: runtimeBinding.widgetId, type: 'value', title: '耐久测试数据库数值', frame: { x: 20, y: 100, width: 240, height: 80 }, data: { mode: 'database', connectionId: 'primary', table: runtimeBinding.table, field: runtimeBinding.field, valueMode: 'latest', orderBy: 'id', refreshMs: 1000, readOnly: true } });
        document = require('../utils/dashboardDocument').normalizeDocument(document);
    }
    document.metadata = { ...document.metadata, enduranceCycle: cycles + 1 };
    const saved = await api('/api/platform/designer/draft', 'PUT', { sceneId: document.sceneId, document, expectedRevision: revision });
    revision = saved.revision;
    const published = await api('/api/platform/releases', 'POST', { sceneId: document.sceneId, notes: `isolated endurance ${cycles + 1}` });
    const previous = publishedReleaseId;
    publishedReleaseId = published.release.id;
    const runtime = await api('/api/config');
    assert.equal(runtime.platform.currentRelease.id, publishedReleaseId, 'Published release not visible at runtime');
    const reloaded = await api('/api/platform/designer');
    assert.equal(reloaded.document.metadata.enduranceCycle, cycles + 1, 'Draft read-back differs');
    if (previous) await api('/api/platform/releases/' + encodeURIComponent(previous), 'DELETE');
    cycles++;
    if (privateMysql) await privateMysql.verifySnapshot(document.sceneId, revision, cycles, publishedReleaseId);
}
async function verifyRuntimeBinding() {
    const result = await api('/api/data-sources/runtime-values?scene_id=' + encodeURIComponent(document.sceneId));
    assert.equal(result.releaseId, publishedReleaseId, 'Data runtime used a different published release');
    const value = result.values?.[runtimeBinding.widgetId];
    assert.ok(value, 'Published database widget missing from runtime values');
    assert.equal(value.quality, 'good', value.error || 'Published database query has bad quality');
    assert.equal(Number(value.value), runtimeBinding.expectedValue, 'Published primary database field returned wrong value');
    assert.ok(Number.isFinite(Date.parse(value.fetchedAt)), 'Runtime query timestamp missing');
    if (value.fetchedAt !== runtimeBinding.lastFetchedAt) runtimeBinding.freshFetches++;
    runtimeBinding.lastFetchedAt = value.fetchedAt;
    runtimeBinding.checks++;
}
async function main() {
    console.log(JSON.stringify({ directory, runnerPid: process.pid, requestedSeconds: durationMs / 1000, restartPolicy, stopFile }));
    await createTestDatabase(path.join(dataDir, 'factory.db'));
    const Database = require('better-sqlite3');
    const isolatedDb = new Database(path.join(dataDir, 'factory.db'));
    try {
        isolatedDb.prepare("UPDATE factory_settings SET value = 'simulation' WHERE key = 'data_mode'").run();
        isolatedDb.prepare('UPDATE devices SET plc_enabled = 0').run();
        if (databaseType === 'sqlite') {
            isolatedDb.exec('CREATE TABLE endurance_metrics (id INTEGER PRIMARY KEY, actual REAL NOT NULL)');
            isolatedDb.prepare('INSERT INTO endurance_metrics (id, actual) VALUES (?, ?)').run(1, runtimeBinding.expectedValue);
        }
    } finally { isolatedDb.close(); }
    if (databaseType === 'mysql') {
        const { EnduranceMysql } = require('./endurance-mysql.cjs');
        privateMysql = new EnduranceMysql(directory, mysqlRuntimeDir);
        await privateMysql.initialize(path.join(dataDir, 'factory.db'), path.join(dataDir, 'database-config.json'));
        await privateMysql.sampleMemory(true);
        log('private-mysql-ready', privateMysql.summary());
    }
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await launch(port);
    workloadStartedAt = Date.now();
    observationPhase = 'workload';
    continuity = createContinuityClock();
    continuityTimer = setInterval(() => continuity.sample(), 1000);
    console.log(JSON.stringify({ backendPid: backend.pid, baseUrl, workloadStartedAt }));
    let nextCycle = 0, nextReconnect = monotonicNow() + Math.min(120000, durationMs / 4), nextRestart = monotonicNow() + restartPolicy.firstAfterSeconds * 1000, nextReport = 0;
    while (!stopped && continuity.elapsedMs() < durationMs) {
        const stopRequested = await fs.promises.access(stopFile).then(() => true, failure => { if (failure.code === 'ENOENT') return false; throw failure; });
        if (stopRequested) { stop('STOP file'); break; }
        try {
            if (monotonicNow() >= nextRestart) {
                // Schedule before attempting: a failed one-shot restart must not
                // silently become repeated crashes that hide memory accumulation.
                nextRestart = restartIntervalMs === null ? Infinity : monotonicNow() + restartIntervalMs;
                restarting = true;
                socket?.terminate();
                await forceStop(backend);
                if (privateMysql) { await privateMysql.restart(); await privateMysql.sampleMemory(true); log('private-mysql-restarted', privateMysql.summary()); }
                await launch(port);
                const recovered = await api('/api/platform/designer');
                assert.equal(recovered.revision, revision, 'Revision lost after restart');
                assert.equal(recovered.document.metadata.enduranceCycle, cycles, 'Draft lost after restart');
                assert.equal((await api('/api/config')).platform.currentRelease.id, publishedReleaseId, 'Published release lost after restart');
                if (privateMysql) await privateMysql.verifySnapshot(document.sceneId, revision, cycles, publishedReleaseId);
                restarts++;
                restarting = false;
            }
            if (monotonicNow() >= nextReconnect) { await connect(); reconnects++; nextReconnect = monotonicNow() + 120000; }
            await Promise.all([api('/api/health'), api('/api/plc/points/realtime'), api('/api/data-sources')]);
            if (monotonicNow() >= nextCycle) { await cycle(); nextCycle = monotonicNow() + 30000; }
            await verifyRuntimeBinding();
            assert.ok(monotonicNow() - lastFrameAt <= limits.wsSilenceMs, 'WebSocket simulation stream stalled');
        } catch (failure) { restarting = false; error(failure.stack || failure.message); }
        if (monotonicNow() >= nextReport) { const current = await report(); console.log(JSON.stringify({ status: current.status, seconds: Math.round(current.actualSeconds), cycles, frames, errors: errors.length, backendPid: backend.pid })); nextReport = monotonicNow() + 60000; }
        await sleep(Math.min(intervalMs, Math.max(0, durationMs - continuity.elapsedMs())));
    }
}
main().catch(failure => { error(failure.stack || failure.message); stopReason = 'setup or fatal error'; }).finally(async () => {
    workloadFinishedAt = Date.now();
    continuity?.sample();
    finishedElapsedMs = continuity?.elapsedMs() || 0;
    clearInterval(continuityTimer);
    if (continuity && !restarting && monotonicNow() - lastFrameAt > limits.wsSilenceMs) error('WebSocket simulation stream stalled at test completion');
    finishing = true;
    await privateMysql?.sampleMemory(true);
    socket?.terminate();
    await forceStop(backend);
    if (backend && backend.exitCode === null && backend.signalCode === null) error('Owned backend process did not exit during cleanup');
    if (privateMysql) await privateMysql.stop().catch(failure => error(`Private MySQL cleanup: ${failure.message}`));
    await eventWrites;
    const result = await report(true);
    console.log(JSON.stringify({ status: result.status, actualSeconds: result.actualSeconds, report: path.join(directory, 'report.json') }));
    process.exitCode = result.status === 'passed' ? 0 : result.status === 'incomplete' ? 2 : 1;
});
