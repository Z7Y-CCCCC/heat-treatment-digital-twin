#!/usr/bin/env node
'use strict';

// Offline analysis of the opt-in real-player JSONL. No player, browser, account
// or application database is opened. A live tail is ignored only by explicit opt-in.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const INSTRUMENTATION_VERSION = 'wall-frames-v3-active-camera-raw';
const ACTIVE_CAMERA_TRACKING = 'Camera.main every sampled LateUpdate and before URP camera rendering';
const SUPPORTED_INSTRUMENTATION_VERSIONS = new Set(['wall-frames-v2-camera-raw', INSTRUMENTATION_VERSION]);
const MAX_BYTES = 128 * 1024 * 1024;
const TIME_EPSILON = 1e-6;
const DEFAULTS = Object.freeze({ warmupSeconds: 15, minimumSeconds: 30, liveSnapshot: false });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

class ReportError extends Error {
    constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}

function optionsFor(options = {}) {
    const result = { ...DEFAULTS, ...options };
    if (!finite(result.warmupSeconds) || result.warmupSeconds < 0 || result.warmupSeconds > 3600)
        throw new ReportError('invalid-option', 'warmupSeconds must be between 0 and 3600.');
    if (!finite(result.minimumSeconds) || result.minimumSeconds < 30 || result.minimumSeconds > 3600)
        throw new ReportError('invalid-option', 'minimumSeconds must be between 30 and 3600; shorter captures cannot pass.');
    if (typeof result.liveSnapshot !== 'boolean') throw new ReportError('invalid-option', 'liveSnapshot must be boolean.');
    return result;
}

function parseJsonl(content, { liveSnapshot = false } = {}) {
    const lines = String(content).replace(/^\uFEFF/, '').split('\n');
    const endedWithNewline = String(content).endsWith('\n');
    const records = []; let ignoredTrailingLine = null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim(); if (!line) continue;
        let value;
        try { value = JSON.parse(line); }
        catch (error) {
            if (liveSnapshot && index === lines.length - 1 && !endedWithNewline) {
                ignoredTrailingLine = { line: index + 1, reason: 'explicit live snapshot: malformed, non-newline-terminated last line ignored' };
                continue;
            }
            throw new ReportError('invalid-jsonl', `Malformed JSON at line ${index + 1}; use --live-snapshot only while a writer is active.`, { line: index + 1 });
        }
        if (!object(value) || !['frame-metrics-metadata', 'frame-metrics-window'].includes(value.type))
            throw new ReportError('unknown-record', `Unrecognized frame-metric record at line ${index + 1}.`, { line: index + 1 });
        if (value.schemaVersion !== 2 || !SUPPORTED_INSTRUMENTATION_VERSIONS.has(value.instrumentationVersion))
            throw new ReportError('instrumentation-mismatch', `Unsupported schema/instrumentation at line ${index + 1}.`, { line: index + 1 });
        if (typeof value.sessionId !== 'string' || !value.sessionId || typeof value.measurementTag !== 'string')
            throw new ReportError('missing-record-identity', `Session ID and measurement tag must be present at line ${index + 1}.`, { line: index + 1 });
        records.push({ value, line: index + 1 });
    }
    const sessions = new Map();
    for (const record of records) {
        const row = record.value;
        if (row.type === 'frame-metrics-metadata') {
            if (sessions.has(row.sessionId)) throw new ReportError('duplicate-session', `Duplicate metadata for session ${row.sessionId}.`, { line: record.line });
            sessions.set(row.sessionId, { metadata: row, windows: [], metadataLine: record.line });
        } else {
            const session = sessions.get(row.sessionId);
            if (!session) throw new ReportError('missing-metadata', 'A window precedes its session metadata.', { line: record.line });
            if (row.measurementTag !== session.metadata.measurementTag)
                throw new ReportError('tag-mismatch', 'A window tag disagrees with its session metadata.', { line: record.line });
            if (row.instrumentationVersion !== session.metadata.instrumentationVersion)
                throw new ReportError('instrumentation-mismatch', 'A window disagrees with its session instrumentation version.', { line: record.line });
            if (!integer(row.sequence) || row.sequence < 1 || !finite(row.windowStartRealtimeSeconds) || !finite(row.realtimeSeconds)
                || row.windowStartRealtimeSeconds < 0 || row.realtimeSeconds <= row.windowStartRealtimeSeconds)
                throw new ReportError('invalid-window-clock', 'Window sequence and wall-clock endpoints must be valid.', { line: record.line });
            const prior = session.windows.at(-1)?.value;
            if (prior && (row.sequence <= prior.sequence || row.windowStartRealtimeSeconds + TIME_EPSILON < prior.realtimeSeconds))
                throw new ReportError('reordered-window', 'Windows must be in increasing sequence/time order.', { line: record.line });
            session.windows.push(record);
        }
    }
    return { sessions: [...sessions.values()], ignoredTrailingLine, records: records.length };
}

function quantile(sorted, fraction) {
    if (!sorted.length) return null;
    const rank = (sorted.length - 1) * fraction, lower = Math.floor(rank), upper = Math.ceil(rank);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

function summarize(values, note, unit) {
    const sorted = values.slice().sort((a, b) => a - b);
    let sum = 0; for (const value of values) sum += value;
    return {
        available: values.length > 0, samples: values.length, unit, sampleScope: note,
        min: sorted[0] ?? null, median: quantile(sorted, .5), sampleP95: quantile(sorted, .95),
        max: sorted.at(-1) ?? null, mean: values.length ? sum / values.length : null
    };
}

function vector(value, length) { return Array.isArray(value) && value.length === length && value.every(finite); }
function close(a, b, tolerance = .0001) { return finite(a) && finite(b) && Math.abs(a - b) <= tolerance; }
function vectorsEqual(a, b, tolerance = .0001) { return vector(a, b?.length) && vector(b, a.length) && a.every((value, index) => close(value, b[index], tolerance)); }
function quaternionEqual(a, b) {
    if (!vector(a, 4) || !vector(b, 4)) return false;
    const an = Math.hypot(...a), bn = Math.hypot(...b);
    if (an < .999 || an > 1.001 || bn < .999 || bn > 1.001) return false;
    let dot = 0; for (let index = 0; index < 4; index++) dot += a[index] * b[index];
    return Math.abs(dot / an / bn) >= .9999999;
}

function metadataIssue(metadata, options) {
    if (metadata.isEditor !== false || metadata.batchmode !== false)
        return { code: 'not-real-player', message: 'Editor/batchmode results cannot pass as a normal real-player capture.' };
    for (const key of ['gpu', 'graphicsApi', 'cpu', 'unityVersion', 'runtimePlatform', 'assemblyModuleVersionId'])
        if (typeof metadata[key] !== 'string' || !metadata[key]) return { code: 'missing-metadata', message: `Required metadata ${key} is unavailable.` };
    for (const key of ['logicalProcessors', 'systemMemoryMiB', 'graphicsMemoryMiB'])
        if (!integer(metadata[key]) || metadata[key] < 1) return { code: 'missing-metadata', message: `Required hardware metadata ${key} is unavailable.` };
    if (typeof metadata.debugBuild !== 'boolean' || typeof metadata.frameTimingFeatureEnabled !== 'boolean')
        return { code: 'missing-metadata', message: 'Build/timing availability metadata must be explicit.' };
    if (metadata.instrumentationVersion === INSTRUMENTATION_VERSION && metadata.activeCameraTracking !== ACTIVE_CAMERA_TRACKING)
        return { code: 'missing-active-camera-tracking', message: 'Current instrumentation must explicitly identify per-frame active-main tracking.' };
    if (options.expectedTag != null && metadata.measurementTag !== options.expectedTag)
        return { code: 'unexpected-tag', message: `Expected tag ${options.expectedTag}, observed ${metadata.measurementTag}.` };
    return null;
}

const CONTEXT_FIELDS = [
    'viewId', 'devices', 'fallbackDevices', 'profile', 'renderScale', 'effectiveRenderScale', 'msaa',
    'shadowDistance', 'shadowCascades', 'width', 'height', 'targetFrameRate', 'vSyncCount',
    'focused', 'runInBackground', 'batchmode'
];
const CAMERA_NUMBERS = ['fieldOfView', 'aspect', 'nearClip', 'farClip', 'orthographicSize'];

function contextChecks(baseline, current, requireScope = true) {
    const checks = [];
    for (const field of ['factoryId', 'sceneId']) {
        const a = baseline?.[field], b = current?.[field];
        const known = typeof a === 'string' && a.trim() && typeof b === 'string' && b.trim();
        checks.push({ field, baseline: a ?? null, current: b ?? null, matches: requireScope ? Boolean(known) && a === b : a === b });
    }
    for (const field of CONTEXT_FIELDS) {
        const a = baseline?.[field], b = current?.[field];
        checks.push({ field, baseline: a ?? null, current: b ?? null, matches: typeof a === 'number' ? close(a, b) : a === b });
    }
    const a = baseline?.camera, b = current?.camera;
    for (const field of ['position', 'target'])
        checks.push({ field: `camera.${field}`, baseline: a?.[field] ?? null, current: b?.[field] ?? null, matches: vectorsEqual(a?.[field], b?.[field]) });
    checks.push({ field: 'camera.rotation', baseline: a?.rotation ?? null, current: b?.rotation ?? null, matches: quaternionEqual(a?.rotation, b?.rotation) });
    for (const field of CAMERA_NUMBERS)
        checks.push({ field: `camera.${field}`, baseline: a?.[field] ?? null, current: b?.[field] ?? null, matches: close(a?.[field], b?.[field]) });
    checks.push({ field: 'camera.orthographic', baseline: a?.orthographic ?? null, current: b?.orthographic ?? null, matches: a?.orthographic === b?.orthographic });
    return checks;
}

function windowIssue(row) {
    if (row.partial !== false) return { code: 'partial-window', message: 'A partial shutdown window cannot enter a passing capture.' };
    if (row.contextStable !== true) return { code: 'unstable-context', message: 'A sampling window changed scene/view/quality/focus context.' };
    if (row.cameraStable !== true) return { code: 'moving-camera', message: 'The real camera moved during a sampling window.' };
    if (row.instrumentationVersion === INSTRUMENTATION_VERSION && row.cameraSwitches !== 0)
        return { code: 'active-camera-switched', message: 'The current instrument must prove zero active-main switches in each selected window.' };
    for (const flag of ['invalidSamples', 'percentileOverflow', 'droppedRecords'])
        if (row[flag] !== 0) return { code: flag === 'droppedRecords' ? 'dropped-records' : 'invalid-frame-evidence', message: `${flag} must be explicitly zero.` };
    if (!integer(row.frames) || row.frames < 1 || row.frames > 4096 || !finite(row.elapsedSeconds) || row.elapsedSeconds <= 0
        || Math.abs(row.realtimeSeconds - row.windowStartRealtimeSeconds - row.elapsedSeconds) > TIME_EPSILON)
        return { code: 'invalid-frame-evidence', message: 'Frame count and the actual window wall-clock interval disagree.' };
    if (!Array.isArray(row.frameIntervalsMs) || row.frameIntervalsMs.length !== row.frames
        || row.frameIntervalsMs.some(value => !finite(value) || value <= 0))
        return { code: 'missing-raw-frames', message: 'Every counted frame needs one finite positive original frame interval.' };
    let sum = 0; for (const value of row.frameIntervalsMs) sum += value / 1000;
    if (Math.abs(sum - row.elapsedSeconds) > Math.max(TIME_EPSILON, row.elapsedSeconds * 1e-6))
        return { code: 'raw-clock-mismatch', message: 'Raw frame intervals do not cover the reported wall-clock duration.' };
    const c = row.context;
    if (!object(c) || c.sceneReady !== true || c.batchmode !== false || typeof c.focused !== 'boolean' || typeof c.runInBackground !== 'boolean')
        return { code: 'invalid-context', message: 'The selected window lacks a ready, normal-player/focus context.' };
    if (row.instrumentationVersion === INSTRUMENTATION_VERSION)
        for (const field of ['factoryId', 'sceneId']) if (typeof c[field] !== 'string' || !c[field].trim())
            return { code: 'missing-scene-scope', message: `Current instrumentation requires explicit ${field}; same view/camera/count is not scope identity.` };
    for (const field of ['viewId', 'profile']) if (typeof c[field] !== 'string' || !c[field])
        return { code: 'invalid-context', message: `Required context ${field} is missing.` };
    for (const field of ['devices', 'fallbackDevices', 'msaa', 'shadowCascades', 'width', 'height', 'targetFrameRate', 'vSyncCount'])
        if (!integer(c[field])) return { code: 'invalid-context', message: `Required numeric context ${field} is missing.` };
    for (const field of ['renderScale', 'effectiveRenderScale', 'shadowDistance'])
        if (!finite(c[field]) || c[field] < 0) return { code: 'invalid-context', message: `Required raster context ${field} is missing.` };
    if (c.width < 1 || c.height < 1 || c.devices < 0 || c.fallbackDevices !== 0 || c.renderScale <= 0 || c.effectiveRenderScale <= 0)
        return { code: 'fallback-or-invalid-scene', message: 'Missing models/placeholders or invalid resolution/scale cannot establish a real-scene performance result.' };
    const camera = c.camera;
    if (!object(camera) || camera.available !== true || !vector(camera.position, 3) || !vector(camera.target, 3)
        || !quaternionEqual(camera.rotation, camera.rotation) || typeof camera.orthographic !== 'boolean'
        || CAMERA_NUMBERS.some(field => !finite(camera[field])) || camera.fieldOfView <= 0 || camera.aspect <= 0
        || camera.nearClip <= 0 || camera.farClip <= camera.nearClip || camera.orthographicSize <= 0)
        return { code: 'missing-camera-evidence', message: 'Actual camera pose, orbit target and projection must be available.' };
    if (!vectorsEqual(camera.windowStartPosition, camera.position) || !vectorsEqual(camera.windowStartTarget, camera.target)
        || !quaternionEqual(camera.windowStartRotation, camera.rotation))
        return { code: 'camera-evidence-mismatch', message: 'A claimed stable camera has different beginning/end pose evidence.' };
    if (row.instrumentationVersion === INSTRUMENTATION_VERSION
        && (!integer(camera.instanceId) || !integer(camera.windowStartInstanceId) || camera.instanceId !== camera.windowStartInstanceId))
        return { code: 'active-camera-identity-mismatch', message: 'Beginning/end active-main camera identity must match in current instrumentation.' };
    if (!object(row.nativeCounters) || !object(row.frameTiming) || typeof row.frameTiming.available !== 'boolean')
        return { code: 'invalid-native-metrics', message: 'Sparse native metric availability must be explicit.' };
    for (const counter of Object.values(row.nativeCounters)) {
        if (!object(counter) || typeof counter.available !== 'boolean' || typeof counter.source !== 'string'
            || (counter.available ? !finite(counter.value) || counter.value < 0 : counter.value !== null))
            return { code: 'invalid-native-metrics', message: 'A sparse native counter has invalid value/availability evidence.' };
    }
    for (const key of ['cpuFrameMs', 'cpuMainThreadMs', 'cpuPresentWaitMs', 'cpuRenderThreadMs', 'gpuFrameMs']) {
        const value = row.frameTiming[key];
        if (value !== null && (!finite(value) || value < 0 || row.frameTiming.available !== true))
            return { code: 'invalid-native-metrics', message: `Sparse native ${key} must be an available numeric sample or explicit null.` };
    }
    return null;
}

function firstReadySegment(windows) {
    const start = windows.findIndex(record => record.value.context?.sceneReady === true);
    if (start < 0) return { rows: [], stop: { code: 'no-ready-scene', message: 'No sceneReady window was recorded.' } };
    const rows = []; let stop = null;
    for (let index = start; index < windows.length; index++) {
        const record = windows[index], row = record.value, prior = rows.at(-1)?.value;
        if (row.context?.sceneReady !== true) { stop = { code: 'first-ready-segment-ended', message: 'The first ready segment ended; later segments are never silently substituted.' }; break; }
        if (prior && (row.sequence !== prior.sequence + 1 || Math.abs(row.windowStartRealtimeSeconds - prior.realtimeSeconds) > TIME_EPSILON)) {
            stop = { code: 'non-contiguous-windows', message: 'The first ready segment contains a sequence/time gap.', line: record.line }; break;
        }
        rows.push(record);
    }
    return { rows, stop };
}

function sampledNativeMetrics(selected) {
    const counterKeys = new Set();
    for (const { value } of selected) for (const key of Object.keys(value.nativeCounters || {})) counterKeys.add(key);
    const nativeCounters = {};
    for (const key of [...counterKeys].sort()) {
        const values = []; const sources = new Set();
        for (const { value } of selected) {
            const sample = value.nativeCounters?.[key];
            if (sample?.available === true && finite(sample.value) && sample.value >= 0) values.push(sample.value);
            if (typeof sample?.source === 'string') sources.add(sample.source);
        }
        nativeCounters[key] = { ...summarize(values, 'one last-completed-frame sample per selected window; not all frames', key.endsWith('Nanoseconds') ? 'ns' : key.endsWith('Bytes') ? 'bytes' : 'count'),
            unavailableWindows: selected.length - values.length, sources: [...sources] };
    }
    const frameTiming = {};
    for (const key of ['cpuFrameMs', 'cpuMainThreadMs', 'cpuPresentWaitMs', 'cpuRenderThreadMs', 'gpuFrameMs']) {
        const values = [];
        for (const { value } of selected) {
            const sample = value.frameTiming?.[key];
            if (value.frameTiming?.available === true && finite(sample) && sample >= 0) values.push(sample);
        }
        frameTiming[key] = { ...summarize(values, 'one latest-captured-frame sample per selected window; GPU may lag; not full-frame percentiles', 'ms'),
            unavailableWindows: selected.length - values.length };
    }
    return { note: 'These are sparse latest-per-window observations. Their sampleP95 is NOT the full-frame p95 above.', nativeCounters, frameTiming };
}

function emptyReport(options, source) {
    return { kind: 'runtime-frame-report', reportSchemaVersion: 1, algorithm: 'first-ready-contiguous-raw-v1', valid: false,
        status: 'insufficient', reason: null, source, options: {
            warmupSeconds: options.warmupSeconds, minimumSeconds: options.minimumSeconds, liveSnapshot: options.liveSnapshot,
            sessionId: options.sessionId ?? null, expectedTag: options.expectedTag ?? null
        }, metadata: null, selection: null, frameStatistics: null, latestPerWindowSamples: null, comparison: null,
        scope: 'Normal Unity player callback frame intervals, not physical display scan-out. No image fidelity or causal/statistical significance claim is implied.' };
}

function analyzeContent(content, options = {}, source = null) {
    options = optionsFor(options); const report = emptyReport(options, source);
    let parsed;
    try { parsed = parseJsonl(content, options); }
    catch (error) { report.status = 'invalid-log'; report.reason = { code: error.code || 'parse-error', message: error.message, ...error.details }; return report; }
    report.parsing = { records: parsed.records, sessions: parsed.sessions.length, ignoredTrailingLine: parsed.ignoredTrailingLine };
    const session = options.sessionId ? parsed.sessions.find(value => value.metadata.sessionId === options.sessionId) : parsed.sessions[0];
    if (!session) { report.reason = { code: options.sessionId ? 'unknown-session' : 'missing-metadata', message: 'No selected session metadata is available.' }; return report; }
    report.metadata = session.metadata;
    const issue = metadataIssue(session.metadata, options);
    if (issue) { report.status = 'invalid-metadata'; report.reason = issue; return report; }
    const segment = firstReadySegment(session.windows);
    if (!segment.rows.length) { report.reason = segment.stop; return report; }
    const first = segment.rows[0].value;
    // Stable ready=true means the entire first window is known ready. Otherwise
    // readiness is known only at its end, so warmup starts conservatively there.
    const readyAnchor = first.contextStable === true ? first.windowStartRealtimeSeconds : first.realtimeSeconds;
    const warmupEnd = readyAnchor + options.warmupSeconds;
    const selected = []; let duration = 0, rejected = null;
    for (const record of segment.rows) {
        const row = record.value;
        if (row.windowStartRealtimeSeconds + TIME_EPSILON < warmupEnd) continue;
        const invalid = windowIssue(row);
        if (invalid) { rejected = { ...invalid, line: record.line, sequence: row.sequence }; break; }
        if (selected.length) {
            const differences = contextChecks(selected[0].value.context, row.context, row.instrumentationVersion === INSTRUMENTATION_VERSION).filter(value => !value.matches);
            if (differences.length) { rejected = { code: 'context-drift', message: 'Selected windows do not retain the same scene/camera/raster context.', line: record.line, differences }; break; }
        }
        selected.push(record); duration += row.elapsedSeconds;
        if (duration + TIME_EPSILON >= options.minimumSeconds) break;
    }
    report.selection = {
        rule: 'first selected session; first continuous sceneReady segment; first whole window after warmup; shortest continuous prefix reaching minimum duration; no cherry-picking',
        readyAnchorRealtimeSeconds: readyAnchor, warmupEndsRealtimeSeconds: warmupEnd,
        windows: selected.length, elapsedSeconds: duration,
        firstSequence: selected[0]?.value.sequence ?? null, lastSequence: selected.at(-1)?.value.sequence ?? null,
        firstWindowStartRealtimeSeconds: selected[0]?.value.windowStartRealtimeSeconds ?? null,
        lastWindowEndRealtimeSeconds: selected.at(-1)?.value.realtimeSeconds ?? null,
        rejectedWindow: rejected, firstReadySegmentStop: segment.stop
    };
    if (duration + TIME_EPSILON < options.minimumSeconds) {
        report.reason = rejected || segment.stop || { code: 'insufficient-contiguous-duration', message: `Only ${duration.toFixed(3)} eligible seconds; ${options.minimumSeconds} consecutive seconds are required after warmup.` };
        return report;
    }
    const intervals = []; let sumMs = 0, over33 = 0, over50 = 0;
    for (const { value } of selected) for (const ms of value.frameIntervalsMs) {
        intervals.push(ms); sumMs += ms; if (ms > 33) over33++; if (ms > 50) over50++;
    }
    const sorted = intervals.slice().sort((a, b) => a - b);
    report.frameStatistics = {
        source: 'every original frame interval in the selected contiguous windows; no averaging of window FPS/percentiles',
        percentileMethod: 'linear interpolation at (N-1)*p', samples: intervals.length, intervalSumSeconds: sumMs / 1000,
        fps: intervals.length * 1000 / sumMs, meanMs: sumMs / intervals.length,
        medianMs: quantile(sorted, .5), p95Ms: quantile(sorted, .95), p99Ms: quantile(sorted, .99),
        minMs: sorted[0], maxMs: sorted.at(-1), over33Ms: over33, over50Ms: over50,
        over33Percent: over33 * 100 / intervals.length, over50Percent: over50 * 100 / intervals.length
    };
    report.measuredContext = selected[0].value.context;
    report.latestPerWindowSamples = sampledNativeMetrics(selected);
    report.valid = true; report.status = 'measured';
    report.notes = [];
    if (session.metadata.instrumentationVersion !== INSTRUMENTATION_VERSION)
        report.notes.push('Legacy v2 is readable, but its camera could stay bound to a still-live former main and factory/scene scope was not recorded. Missing scope cannot establish a same-scope comparison; different instrumentation versions cannot be compared.');
    if (!session.metadata.measurementTag) report.notes.push('No external measurement tag was supplied; the session ID and instrumentation version were still checked.');
    if (report.measuredContext.focused === false) report.notes.push('The measured normal player was not keyboard-focused; comparisons must retain that same focus/run-in-background context.');
    if (parsed.sessions.length > 1) report.notes.push('Additional sessions were ignored deterministically; use --session-id explicitly to select another one.');
    return report;
}

function analyzeFile(filename, options = {}) {
    const absolute = path.resolve(filename);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new ReportError('invalid-input-file', 'Input must be a regular JSONL file no larger than 128 MiB.');
    const bytes = fs.readFileSync(absolute);
    return analyzeContent(bytes.toString('utf8'), options, { path: absolute, snapshotBytes: bytes.length, sha256: digest(bytes) });
}

function compareReports(current, baseline) {
    if (!current.valid || !baseline.valid) return { comparable: false, reason: { code: 'invalid-measurement', message: 'Both independently selected captures must pass before speed can be compared.' }, observedDeltas: null };
    const checks = contextChecks(baseline.measuredContext, current.measuredContext);
    for (const field of ['instrumentationVersion', 'activeCameraTracking', 'schemaVersion', 'gpu', 'graphicsApi', 'cpu', 'logicalProcessors', 'systemMemoryMiB', 'graphicsMemoryMiB', 'unityVersion', 'runtimePlatform', 'debugBuild', 'frameTimingFeatureEnabled'])
        checks.push({ field: `metadata.${field}`, baseline: baseline.metadata[field] ?? null, current: current.metadata[field] ?? null, matches: baseline.metadata[field] === current.metadata[field] });
    for (const field of ['warmupSeconds', 'minimumSeconds'])
        checks.push({ field: `options.${field}`, baseline: baseline.options[field], current: current.options[field], matches: baseline.options[field] === current.options[field] });
    const beforeTriangles = baseline.latestPerWindowSamples.nativeCounters.triangles;
    const afterTriangles = current.latestPerWindowSamples.nativeCounters.triangles;
    const trianglesKnown = beforeTriangles?.available === true && afterTriangles?.available === true;
    const triangleAvailabilityMatches = Boolean(beforeTriangles?.available) === Boolean(afterTriangles?.available);
    checks.push({ field: 'drawContext.triangleCounterAvailability', baseline: Boolean(beforeTriangles?.available), current: Boolean(afterTriangles?.available), matches: triangleAvailabilityMatches });
    if (trianglesKnown) checks.push({ field: 'drawContext.latestTriangleMedian', baseline: beforeTriangles.median, current: afterTriangles.median,
        matches: close(beforeTriangles.median, afterTriangles.median, Math.max(1, Math.abs(beforeTriangles.median) * 1e-6)) });
    const mismatches = checks.filter(value => !value.matches);
    const result = {
        comparable: mismatches.length === 0, conditionChecks: checks, mismatches,
        reason: mismatches.length ? { code: 'different-measurement-conditions', message: 'Camera, scene, raster, hardware or sampled draw context differs; no speedup is reported.' } : null,
        drawContext: {
            trianglesAvailable: trianglesKnown,
            note: 'Triangles/draw calls/batches are sparse latest-frame observations, not a full geometry inventory. Reduced draw calls/batches may be a legitimate batching optimization; they are not required to match.',
            baselineDrawCalls: baseline.latestPerWindowSamples.nativeCounters.drawCalls ?? null,
            currentDrawCalls: current.latestPerWindowSamples.nativeCounters.drawCalls ?? null,
            baselineBatches: baseline.latestPerWindowSamples.nativeCounters.batches ?? null,
            currentBatches: current.latestPerWindowSamples.nativeCounters.batches ?? null
        }, observedDeltas: null
    };
    if (result.comparable) {
        const before = baseline.frameStatistics, after = current.frameStatistics;
        result.observedDeltas = {
            baselineFps: before.fps, currentFps: after.fps, fpsDifference: after.fps - before.fps,
            fpsChangePercent: (after.fps / before.fps - 1) * 100,
            baselineP95Ms: before.p95Ms, currentP95Ms: after.p95Ms,
            p95ReductionPercent: (1 - after.p95Ms / before.p95Ms) * 100,
            baselineP99Ms: before.p99Ms, currentP99Ms: after.p99Ms,
            observedFpsAndP95Improvement: after.fps > before.fps && after.p95Ms < before.p95Ms,
            claimScope: 'Observed difference between two deterministic controlled samples; not a replicated significance test or display scan-out measurement.'
        };
    }
    return result;
}

function loadBaseline(filename, options) {
    const absolute = path.resolve(filename), stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new ReportError('invalid-input-file', 'Baseline must be a regular file no larger than 128 MiB.');
    const bytes = fs.readFileSync(absolute);
    let saved;
    try { saved = JSON.parse(bytes.toString('utf8')); } catch { /* Ordinary multi-record JSONL. */ }
    if (saved?.kind !== 'runtime-frame-report') return analyzeFile(absolute, options);
    if (saved.reportSchemaVersion !== 1 || saved.algorithm !== 'first-ready-contiguous-raw-v1' || !saved.valid || !saved.source?.path
        || !integer(saved.source.snapshotBytes) || saved.source.snapshotBytes < 1 || saved.source.snapshotBytes > MAX_BYTES || typeof saved.source.sha256 !== 'string')
        throw new ReportError('invalid-baseline-report', 'A saved baseline must be a valid tool report with its original source snapshot fingerprint.');
    const originalStat = fs.statSync(saved.source.path);
    if (!originalStat.isFile() || originalStat.size > MAX_BYTES) throw new ReportError('invalid-input-file', 'Original baseline source is not a bounded regular file.');
    const original = fs.readFileSync(saved.source.path);
    if (original.length < saved.source.snapshotBytes) throw new ReportError('baseline-source-changed', 'The baseline source snapshot was shortened.');
    const snapshot = original.subarray(0, saved.source.snapshotBytes);
    if (digest(snapshot) !== saved.source.sha256) throw new ReportError('baseline-source-changed', 'The original baseline source snapshot hash no longer matches.');
    const baseline = analyzeContent(snapshot.toString('utf8'), { ...options, expectedTag: undefined,
        liveSnapshot: saved.options?.liveSnapshot === true, sessionId: saved.metadata?.sessionId }, saved.source);
    baseline.loadedViaReport = absolute;
    return baseline;
}

function parseArgs(args) {
    const options = { ...DEFAULTS }; let input, output, compare;
    const names = new Map([['--input', 'input'], ['--out', 'output'], ['--compare', 'compare'], ['--warmup-seconds', 'warmupSeconds'],
        ['--minimum-seconds', 'minimumSeconds'], ['--session-id', 'sessionId'], ['--expected-tag', 'expectedTag']]);
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const key = args[index]; if (seen.has(key)) throw new ReportError('invalid-option', `Duplicate option ${key}.`); seen.add(key);
        if (key === '--help' || key === '-h') return { help: true };
        if (key === '--live-snapshot') { options.liveSnapshot = true; continue; }
        const name = names.get(key);
        if (!name || args[index + 1] == null || args[index + 1].startsWith('--')) throw new ReportError('invalid-option', `Unknown or missing option ${key}.`);
        const value = args[++index];
        if (name === 'input') input = value;
        else if (name === 'output') output = value;
        else if (name === 'compare') compare = value;
        else options[name] = name.endsWith('Seconds') ? Number(value) : value;
    }
    if (!input) throw new ReportError('invalid-option', '--input FILE is required.');
    if (output && [input, compare].filter(Boolean).some(file => path.resolve(file).toLowerCase() === path.resolve(output).toLowerCase()))
        throw new ReportError('output-is-input', 'Output must not overwrite the input or baseline evidence.');
    return { input, output, compare, options: optionsFor(options) };
}

function main(args = process.argv.slice(2)) {
    let config, report;
    try {
        config = parseArgs(args);
        if (config.help) {
            console.log('Usage: node tools/runtime-frame-report.cjs --input FILE --warmup-seconds 15 --minimum-seconds 30 [--out JSON] [--compare BASELINE_JSONL_OR_REPORT] [--live-snapshot] [--session-id ID] [--expected-tag TAG]');
            return 0;
        }
        report = analyzeFile(config.input, config.options);
        if (config.compare) {
            const baseline = loadBaseline(config.compare, { ...config.options, expectedTag: undefined, sessionId: undefined });
            if (config.output && baseline.source?.path && path.resolve(config.output).toLowerCase() === path.resolve(baseline.source.path).toLowerCase()) {
                config.output = undefined;
                throw new ReportError('output-is-baseline-source', 'Output must not overwrite the original JSONL referenced by a baseline report.');
            }
            report.comparison = compareReports(report, baseline);
            report.comparison.baselineSource = baseline.source;
            report.comparison.baselineReason = baseline.reason;
            if (!report.comparison.comparable) { report.valid = false; report.status = 'not-comparable'; report.reason = report.comparison.reason; }
        }
    } catch (error) {
        report = { kind: 'runtime-frame-report', reportSchemaVersion: 1, valid: false, status: 'error',
            reason: { code: error.code || 'input-error', message: error.message, ...error.details } };
    }
    let json = JSON.stringify(report, null, 2) + '\n';
    if (config?.output) {
        try { const filename = path.resolve(config.output); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, json); }
        catch (error) { report.valid = false; report.status = 'error'; report.reason = { code: 'output-error', message: error.message }; json = JSON.stringify(report, null, 2) + '\n'; }
    }
    process.stdout.write(json);
    return report.valid ? 0 : report.status === 'insufficient' ? 2 : report.status === 'not-comparable' ? 3 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { INSTRUMENTATION_VERSION, ACTIVE_CAMERA_TRACKING, DEFAULTS, parseJsonl, quantile, analyzeContent, analyzeFile, compareReports, loadBaseline, parseArgs, main };
