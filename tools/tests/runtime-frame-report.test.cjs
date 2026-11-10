'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { INSTRUMENTATION_VERSION, ACTIVE_CAMERA_TRACKING, analyzeContent, analyzeFile, compareReports, parseArgs, parseJsonl, loadBaseline } = require('../runtime-frame-report.cjs');
const clone = value => structuredClone(value);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const script = path.resolve(__dirname, '../runtime-frame-report.cjs');

function fixture({ windows = 45, frames = 10, ms = 100, tag = 'baseline', session = 'session-baseline', durations } = {}) {
    const metadata = {
        type: 'frame-metrics-metadata', schemaVersion: 2, instrumentationVersion: INSTRUMENTATION_VERSION,
        sessionId: session, measurementTag: tag, assemblyModuleVersionId: 'build-' + tag,
        activeCameraTracking: ACTIVE_CAMERA_TRACKING,
        isEditor: false, batchmode: false, debugBuild: false, frameTimingFeatureEnabled: true,
        gpu: 'Fixture GPU', graphicsApi: 'Direct3D11', cpu: 'Fixture CPU', logicalProcessors: 8,
        systemMemoryMiB: 16384, graphicsMemoryMiB: 4096, unityVersion: '2022.3.34f1c1', runtimePlatform: 'WindowsPlayer'
    };
    const context = {
        sceneReady: true, factoryId: 'factory-a', sceneId: 'scene-a', viewId: 'factory_overview', devices: 5, fallbackDevices: 0, profile: 'balanced',
        renderScale: 1, effectiveRenderScale: 1, msaa: 4, shadowDistance: 80, shadowCascades: 2,
        width: 1920, height: 1080, targetFrameRate: 60, vSyncCount: 0, focused: true, runInBackground: true, batchmode: false,
        camera: { available: true, instanceId: 17, windowStartInstanceId: 17, position: [10, 10, 10], rotation: [0, 0, 0, 1], target: [0, 0, 0],
            fieldOfView: 47, aspect: 1920 / 1080, nearClip: .1, farClip: 500, orthographic: false, orthographicSize: 5,
            windowStartPosition: [10, 10, 10], windowStartRotation: [0, 0, 0, 1], windowStartTarget: [0, 0, 0] }
    };
    let clock = 0; const rows = [metadata];
    for (let index = 0; index < windows; index++) {
        const configuration = durations?.[index] || { frames, ms }, intervals = Array(configuration.frames).fill(configuration.ms);
        const elapsed = intervals.reduce((sum, value) => sum + value / 1000, 0), start = clock; clock += elapsed;
        rows.push({
            type: 'frame-metrics-window', schemaVersion: 2, instrumentationVersion: INSTRUMENTATION_VERSION,
            sessionId: session, measurementTag: tag, sequence: index + 1, windowStartRealtimeSeconds: start,
            realtimeSeconds: clock, elapsedSeconds: elapsed, partial: false, frames: intervals.length,
            fps: intervals.length / elapsed, medianMs: configuration.ms, p95Ms: configuration.ms, p99Ms: configuration.ms,
            frameIntervalsMs: intervals, contextStable: true, cameraStable: true, cameraSwitches: 0, context: clone(context),
            invalidSamples: 0, percentileOverflow: 0, droppedRecords: 0,
            nativeCounters: {
                triangles: { available: true, value: 100000, source: 'Triangles Count' },
                drawCalls: { available: true, value: 200, source: 'Draw Calls Count' },
                batches: { available: true, value: 100, source: 'Batches Count' },
                gcAllocatedBytes: { available: true, value: 0, source: 'GC Allocated In Frame' }
            },
            frameTiming: { available: true, cpuFrameMs: 16, cpuMainThreadMs: 6, cpuPresentWaitMs: null, cpuRenderThreadMs: 10, gpuFrameMs: 12 }
        });
    }
    return rows;
}
const jsonl = rows => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
const analyze = (rows, options = {}) => analyzeContent(jsonl(rows), options);

test('whole-segment p95 concatenates original frames; never averages one-second percentiles', () => {
    const durations = [...Array(15).fill({ frames: 100, ms: 10 }), ...Array(15).fill({ frames: 1, ms: 1000 })];
    const rows = fixture({ windows: 30, durations });
    for (const row of rows.slice(1)) row.p95Ms = 999999; // Intentionally do not trust cached aggregates.
    const report = analyze(rows, { warmupSeconds: 0 });
    assert.equal(report.valid, true); assert.equal(report.frameStatistics.samples, 1515);
    close(report.frameStatistics.fps, 50.5); close(report.frameStatistics.medianMs, 10);
    close(report.frameStatistics.p95Ms, 10); close(report.frameStatistics.p99Ms, 10);
    assert.equal(report.frameStatistics.over33Ms, 15); assert.equal(report.frameStatistics.over50Ms, 15);
    assert.equal(report.latestPerWindowSamples.frameTiming.gpuFrameMs.samples, 30);
    assert.match(report.latestPerWindowSamples.note, /NOT the full-frame p95/);
});

test('FPS uses total raw interval sum rather than averaging unequal window FPS', () => {
    const durations = [...Array(10).fill({ frames: 100, ms: 10 }), ...Array(10).fill({ frames: 2, ms: 1000 })];
    const report = analyze(fixture({ windows: 20, durations }), { warmupSeconds: 0 });
    assert.equal(report.valid, true); close(report.selection.elapsedSeconds, 30);
    close(report.frameStatistics.fps, 34); assert.notEqual(report.frameStatistics.fps, 50.5);
});

test('default warmup is anchored to the first ready segment and selects the first exact continuous prefix', () => {
    const rows = fixture({ windows: 55 });
    for (const row of rows.slice(1, 6)) row.context.sceneReady = false;
    const report = analyze(rows);
    assert.equal(report.valid, true); close(report.selection.readyAnchorRealtimeSeconds, 5);
    assert.equal(report.selection.firstSequence, 21); assert.equal(report.selection.lastSequence, 50);
    close(report.selection.elapsedSeconds, 30); close(report.frameStatistics.fps, 10);
    const transition = fixture({ windows: 46 }); transition[1].contextStable = false;
    const conservative = analyze(transition);
    assert.equal(conservative.valid, true); close(conservative.selection.readyAnchorRealtimeSeconds, 1);
    assert.equal(conservative.selection.firstSequence, 17);
});

test('a short first ready segment is not replaced by a later better segment or later session', () => {
    const rows = fixture({ windows: 70 }); rows[11].context.sceneReady = false;
    const report = analyze(rows); assert.equal(report.valid, false); assert.equal(report.frameStatistics, null);
    assert.equal(report.reason.code, 'first-ready-segment-ended');
    const first = fixture({ windows: 10 }), second = fixture({ windows: 45, session: 'second', tag: 'second' });
    assert.equal(analyze([...first, ...second]).valid, false);
    assert.equal(analyze([...first, ...second], { sessionId: 'second' }).valid, true);
});

test('bad post-warmup windows cannot be silently skipped to cherry-pick another thirty seconds', () => {
    for (const [field, value, code] of [
        ['partial', true, 'partial-window'], ['contextStable', false, 'unstable-context'], ['cameraStable', false, 'moving-camera'],
        ['invalidSamples', 1, 'invalid-frame-evidence'], ['percentileOverflow', 1, 'invalid-frame-evidence'], ['droppedRecords', 1, 'dropped-records']
    ]) {
        const rows = fixture({ windows: 80 }); rows[16][field] = value;
        const report = analyze(rows); assert.equal(report.valid, false, field); assert.equal(report.reason.code, code, field);
        assert.equal(report.frameStatistics, null, field); assert.equal(report.selection.windows, 0, field);
    }
    const missing = fixture(); missing[16].frameIntervalsMs.pop();
    assert.equal(analyze(missing).reason.code, 'missing-raw-frames');
    const clock = fixture(); clock[16].frameIntervalsMs[0] = 200;
    assert.equal(analyze(clock).reason.code, 'raw-clock-mismatch');
    const native = fixture(); native[16].nativeCounters.drawCalls.value = 'not-a-number';
    assert.equal(analyze(native).reason.code, 'invalid-native-metrics');
});

test('sequence gaps and actual camera/raster drift break the deterministic selected segment', () => {
    const gap = fixture({ windows: 80 }); for (const row of gap.slice(16)) row.sequence++;
    assert.equal(analyze(gap).reason.code, 'non-contiguous-windows');
    for (const change of [c => c.width = 1280, c => c.profile = 'integrated_gpu', c => c.shadowDistance = 48,
        c => { c.camera.position[0] = 20; c.camera.windowStartPosition[0] = 20; },
        c => { c.camera.target[0] = 2; c.camera.windowStartTarget[0] = 2; }, c => c.camera.fieldOfView = 60]) {
        const rows = fixture({ windows: 80 }); change(rows[17].context);
        const report = analyze(rows); assert.equal(report.valid, false); assert.equal(report.reason.code, 'context-drift');
    }
    const inconsistent = fixture(); inconsistent[16].context.camera.position[0] += 1;
    assert.equal(analyze(inconsistent).reason.code, 'camera-evidence-mismatch');
});

test('editor/batchmode and unverifiable metadata/tag/geometry cannot become a normal-player success', () => {
    for (const field of ['isEditor', 'batchmode']) {
        const rows = fixture(); rows[0][field] = true; assert.equal(analyze(rows).reason.code, 'not-real-player');
    }
    const badVersion = fixture(); badVersion[0].instrumentationVersion = 'different';
    assert.equal(analyze(badVersion).status, 'invalid-log');
    const badTag = fixture(); badTag[16].measurementTag = 'different';
    assert.equal(analyze(badTag).reason.code, 'tag-mismatch');
    assert.equal(analyze(fixture(), { expectedTag: 'wrong' }).reason.code, 'unexpected-tag');
    const placeholders = fixture(); for (const row of placeholders.slice(1)) row.context.fallbackDevices = 1;
    assert.equal(analyze(placeholders).reason.code, 'fallback-or-invalid-scene');
    assert.throws(() => parseArgs(['--input', 'sample.jsonl', '--minimum-seconds', '29']), /30/);
});

test('current instrumentation follows actual main identity and cannot hide an out-and-back camera switch', () => {
    const switched = fixture(); switched[16].cameraSwitches = 2;
    assert.equal(analyze(switched).reason.code, 'active-camera-switched');
    const differentMain = fixture(); differentMain[16].context.camera.instanceId = 29;
    assert.equal(analyze(differentMain).reason.code, 'active-camera-identity-mismatch');
    const missingTracking = fixture(); delete missingTracking[0].activeCameraTracking;
    assert.equal(analyze(missingTracking).reason.code, 'missing-active-camera-tracking');
});

test('legacy v2 remains readable but mismatched instrument versions and mixed-version sessions refuse comparison', () => {
    const oldRows = fixture();
    for (const row of oldRows) {
        row.instrumentationVersion = 'wall-frames-v2-camera-raw'; delete row.activeCameraTracking;
        if (row.context) { delete row.cameraSwitches; delete row.context.camera.windowStartInstanceId; delete row.context.factoryId; delete row.context.sceneId; }
    }
    const old = analyze(oldRows), current = analyze(fixture());
    assert.equal(old.valid, true); assert.equal(current.valid, true); assert.ok(old.notes.some(value => value.includes('Legacy v2')));
    const comparison = compareReports(current, old);
    assert.equal(comparison.comparable, false); assert.equal(comparison.observedDeltas, null);
    assert.ok(comparison.mismatches.some(value => value.field === 'metadata.instrumentationVersion'));
    assert.equal(compareReports(old, old).comparable, false); // Unknown legacy scope is never equal known scope.
    const mixed = fixture(); mixed[16].instrumentationVersion = 'wall-frames-v2-camera-raw';
    assert.equal(analyze(mixed).reason.code, 'instrumentation-mismatch');
});

test('factory and scene identity are required even when view, camera, device count and geometry match', () => {
    for (const field of ['factoryId', 'sceneId']) {
        const missing = fixture(); delete missing[16].context[field];
        assert.equal(analyze(missing).reason.code, 'missing-scene-scope');
        const drift = fixture(); drift[17].context[field] = 'different';
        assert.equal(analyze(drift).reason.code, 'context-drift');
        const baseline = analyze(fixture()), after = clone(baseline); after.measuredContext[field] = 'different';
        assert.equal(compareReports(after, baseline).comparable, false);
        delete after.measuredContext[field];
        assert.equal(compareReports(after, baseline).comparable, false);
    }
});

test('native CPU/GPU/draw counters remain sparse samples, with missing values explicitly unavailable', () => {
    const rows = fixture();
    for (const row of rows.slice(1)) {
        row.nativeCounters.drawCalls.available = false; row.nativeCounters.drawCalls.value = null;
        row.frameTiming.gpuFrameMs = null;
    }
    const report = analyze(rows); assert.equal(report.valid, true);
    const draw = report.latestPerWindowSamples.nativeCounters.drawCalls, gpu = report.latestPerWindowSamples.frameTiming.gpuFrameMs;
    assert.equal(draw.available, false); assert.equal(draw.samples, 0); assert.equal(draw.median, null);
    assert.equal(gpu.available, false); assert.equal(gpu.sampleP95, null); assert.equal(gpu.unavailableWindows, 30);
    assert.equal(report.latestPerWindowSamples.nativeCounters.gcAllocatedBytes.median, 0); // Actual zero is not absence.
});

test('matching scene/camera/quality can report observed gains with legitimate draw-call reduction', () => {
    const baseline = analyze(fixture());
    const afterRows = fixture({ frames: 20, ms: 50, tag: 'optimized', session: 'optimized' });
    for (const row of afterRows.slice(1)) { row.nativeCounters.drawCalls.value = 100; row.nativeCounters.batches.value = 50; }
    const result = compareReports(analyze(afterRows), baseline);
    assert.equal(result.comparable, true); close(result.observedDeltas.fpsChangePercent, 100);
    close(result.observedDeltas.p95ReductionPercent, 50); assert.equal(result.observedDeltas.observedFpsAndP95Improvement, true);
    assert.equal(result.drawContext.trianglesAvailable, true);
});

test('different scene, camera, FOV, resolution, quality, shadow, hardware or triangle context refuses any speedup', () => {
    const baseline = analyze(fixture());
    for (const change of [
        r => r.measuredContext.profile = 'showcase', r => r.measuredContext.renderScale = .84,
        r => r.measuredContext.effectiveRenderScale = .84, r => r.measuredContext.width = 1280,
        r => r.measuredContext.shadowDistance = 40, r => r.measuredContext.shadowCascades = 1,
        r => r.measuredContext.camera.position[0] += 1, r => r.measuredContext.camera.target[0] += 1,
        r => r.measuredContext.camera.fieldOfView = 60, r => r.measuredContext.devices = 4,
        r => r.metadata.gpu = 'other GPU', r => r.metadata.debugBuild = true,
        r => r.latestPerWindowSamples.nativeCounters.triangles.median = 50000
    ]) {
        const after = clone(baseline); change(after);
        const result = compareReports(after, baseline);
        assert.equal(result.comparable, false); assert.equal(result.observedDeltas, null); assert.ok(result.mismatches.length);
    }
});

test('live snapshots may ignore only a malformed unterminated tail; complete or interior corruption always fails', () => {
    const good = jsonl(fixture()); const partial = good + '{"type":"frame-metrics-window"';
    assert.equal(analyzeContent(partial).status, 'invalid-log');
    const live = analyzeContent(partial, { liveSnapshot: true }); assert.equal(live.valid, true); assert.ok(live.parsing.ignoredTrailingLine);
    assert.equal(analyzeContent(partial + '\n', { liveSnapshot: true }).status, 'invalid-log');
    assert.equal(analyzeContent('{not-json}\n' + good, { liveSnapshot: true }).status, 'invalid-log');
    assert.equal(analyzeContent(good + '{}', { liveSnapshot: true }).status, 'invalid-log');
    assert.equal(parseJsonl(good.trimEnd()).ignoredTrailingLine, null); // Valid final JSON needs no newline.
});

test('CLI writes reports, returns nonzero for insufficient captures, and never overwrites its evidence input', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-frame-report-cli-'));
    const input = path.join(directory, 'input.jsonl'), output = path.join(directory, 'report.json'), baselineReport = path.join(directory, 'baseline.json');
    const afterFile = path.join(directory, 'after.jsonl'), afterReport = path.join(directory, 'after-report.json');
    try {
        fs.writeFileSync(input, jsonl(fixture()));
        const result = spawnSync(process.execPath, [script, '--input', input, '--out', output], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(saved.valid, true); assert.equal(saved.source.path, input); assert.ok(saved.source.sha256);
        fs.writeFileSync(baselineReport, JSON.stringify(saved));
        const baseline = loadBaseline(baselineReport, { warmupSeconds: 15, minimumSeconds: 30, liveSnapshot: false });
        assert.equal(baseline.valid, true); close(baseline.frameStatistics.fps, saved.frameStatistics.fps);
        fs.appendFileSync(input, '\n'); // Appended bytes do not invalidate the original captured prefix.
        assert.equal(loadBaseline(baselineReport, { warmupSeconds: 15, minimumSeconds: 30, liveSnapshot: false }).valid, true);
        fs.writeFileSync(afterFile, jsonl(fixture({ frames: 20, ms: 50, tag: 'optimized', session: 'optimized' })));
        const compared = spawnSync(process.execPath, [script, '--input', afterFile, '--compare', baselineReport, '--out', afterReport], { encoding: 'utf8' });
        assert.equal(compared.status, 0, compared.stderr);
        assert.equal(JSON.parse(fs.readFileSync(afterReport, 'utf8')).comparison.comparable, true);
        const before = fs.readFileSync(input, 'utf8');
        const unsafeBaseline = spawnSync(process.execPath, [script, '--input', afterFile, '--compare', baselineReport, '--out', input], { encoding: 'utf8' });
        assert.equal(unsafeBaseline.status, 1); assert.equal(fs.readFileSync(input, 'utf8'), before);
        const unsafe = spawnSync(process.execPath, [script, '--input', input, '--out', input], { encoding: 'utf8' });
        assert.equal(unsafe.status, 1); assert.equal(fs.readFileSync(input, 'utf8'), before);
        const changed = before.replace('Fixture GPU', 'Changed GPU'); fs.writeFileSync(input, changed);
        assert.throws(() => loadBaseline(baselineReport, { warmupSeconds: 15, minimumSeconds: 30, liveSnapshot: false }), /hash/);
        fs.writeFileSync(input, jsonl(fixture({ windows: 20 })));
        const short = spawnSync(process.execPath, [script, '--input', input, '--out', output], { encoding: 'utf8' });
        assert.equal(short.status, 2); assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).frameStatistics, null);
    } finally {
        // All literal outputs are children of this explicitly test-owned root.
        // Non-recursive cleanup never traverses an application/project directory.
        for (const file of [input, output, baselineReport, afterFile, afterReport]) if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});
