'use strict';

const { hasDeclaredMotionBoundary } = require('../../shared/motionSemanticPolicy.cjs');

const defaults = { maxMessageBytes: 4 * 1024 * 1024, maxBytes: 16 * 1024 * 1024,
    maxMessages: 256, highWaterBytes: 512 * 1024, stallMs: 15000, pollMs: 25 };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Empty/missing quality groups must not erase another PLC task's bad points.
function mergePatch(previous, patch) {
    const result = { ...previous };
    for (const [key, value] of Object.entries(patch)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        // Motion inputs are complete per-device source snapshots, not PLC-task
        // deltas. Unioning them resurrects removed/disabled actions and can
        // manufacture endpoint combinations that were never observed.
        result[key] = !['motionInputs', 'motionSemantics'].includes(key) && object(value) && object(result[key]) ? mergePatch(result[key], value) : value;
    }
    return result;
}
function hasFault(value) {
    if (object(value) || Array.isArray(value)) return Object.values(value).some(hasFault);
    return value === 'bad' || value === 'stale';
}
function hasMotionFault(inputs) {
    return object(inputs) && Object.values(inputs).some(input => hasFault(input?.quality)
        || object(input?.endpointFeedback) && Object.values(input.endpointFeedback).some(endpoint => hasFault(endpoint?.quality)));
}
function motionBoundary(previous, next) {
    if ((previous.motionInputOnly === true) !== (next.motionInputOnly === true)) return true;
    if (hasDeclaredMotionBoundary(previous, next)) return true;
    const a = previous.motionInputs, b = next.motionInputs;
    if (object(a) || object(b)) {
        if (!object(a) || !object(b) || JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(b).sort())) return true;
        for (const key of Object.keys(b)) {
            const before = a[key], after = b[key];
            if (before?.dataItemId !== after?.dataItemId || before?.stage !== after?.stage) return true;
            if ((typeof before?.value !== 'number' || typeof after?.value !== 'number') && before?.value !== after?.value) return true;
            for (const endpoint of ['extended', 'retracted']) {
                const old = before?.endpointFeedback?.[endpoint], current = after?.endpointFeedback?.[endpoint];
                if (old?.dataItemId !== current?.dataItemId || old?.value !== current?.value) return true;
            }
        }
    }
    // Legacy point bindings still read PLC groups directly. Retain discrete
    // actuator edges even when a render/network consumer is temporarily busy.
    // PLC categories are configurable. A motor/door/custom BOOL edge has the
    // same causal meaning as a status edge; never inspect protocol metadata
    // clocks as actuator values or guess discrete semantics for numeric WORDs.
    const protocolGroups = new Set(['pointMeta', 'quality', 'plc', 'motionInputs', 'motionSemantics']);
    for (const group of Object.keys(next).filter(key => !protocolGroups.has(key) && object(next[key]))) {
        if (!object(previous[group]) || !object(next[group])) continue;
        for (const key of Object.keys(next[group])) {
            if (!Object.prototype.hasOwnProperty.call(previous[group], key)) continue;
            const before = previous[group][key], after = next[group][key];
            if (object(before) || Array.isArray(before) || object(after) || Array.isArray(after)) continue;
            if ((typeof before !== 'number' || typeof after !== 'number') && before !== after) return true;
        }
    }
    return false;
}
function hasMotionBoundary(previous, next) {
    const scope = payload => payload?.factoryId ?? payload?.factory_id ?? '';
    if (scope(previous.payload) !== scope(next.payload)) return true;
    const byId = new Map(previous.payload.devices.map(device => [device.furnace_id, device]));
    return next.payload.devices.some(device => {
        const before = byId.get(device.furnace_id);
        return before && (scope(before) !== scope(device) || motionBoundary(before, device));
    });
}
function mergeRealtime(previous, next) {
    const devices = new Map();
    for (const device of [...previous.payload.devices, ...next.payload.devices]) {
        const id = device?.furnace_id;
        if (typeof id !== 'string' || !id) throw new Error('Invalid realtime device identity');
        devices.set(id, mergePatch(devices.get(id) || {}, device));
    }
    return { ...next, payload: { ...previous.payload, ...next.payload, devices: [...devices.values()] } };
}

class WsOutboundQueue {
    constructor(socket, options = {}) {
        this.socket = socket; this.options = { ...defaults, ...options };
        this.queue = []; this.bytes = 0; this.inflightBytes = 0; this.inflight = false;
        this.closed = false; this.timer = null; this.startedAt = 0;
        this.stats = { accepted: 0, sent: 0, merged: 0, errors: 0, overflows: 0 };
    }
    enqueue(message, serialized) {
        if (this.closed || this.socket.readyState !== 1) return false;
        try {
            // Broadcasts share their immutable wire snapshot across healthy peers;
            // only a slow peer's merged patch requires additional serialization.
            const text = serialized === undefined ? JSON.stringify(message) : serialized;
            const size = Buffer.byteLength(text);
            if (size > this.options.maxMessageBytes) return this.fail('message size limit', true);
            const kind = message.type === 'realtime_frame' && !message.payload.devices.some(d => hasFault(d.quality) || hasMotionFault(d.motionInputs))
                ? message.payload.devices.every(d => d.motionInputOnly === true) ? 'motion-input' : 'realtime'
                : message.type === 'scene_projection' ? 'projection'
                    : message.type === 'inspection_hover_changed' ? 'hover'
                        : message.type === 'device_hover_changed' ? 'device-hover' : 'reliable';
            const tail = this.queue[this.queue.length - 1];
            let entry = { message, text, size, kind };
            // Hover/projection are disposable display snapshots. Adjacent-only
            // replacement accumulates obsolete cursor positions whenever those
            // streams interleave with telemetry. Retain one latest snapshot of
            // each kind in the current reliable/navigation segment. Remove the
            // old sample and append the new one at its ARRIVAL position: never
            // hoist hover ahead of any control/fault/motion edge or reorder or
            // discard the reliable/realtime entries between the two samples.
            const latestSnapshot = ['projection', 'hover', 'device-hover'].includes(kind);
            let obsoleteIndex = -1;
            if (latestSnapshot) for (let index = this.queue.length - 1; index >= 0; index--) {
                if (this.queue[index].kind === 'reliable') break;
                if (this.queue[index].kind === kind) { obsoleteIndex = index; break; }
            }
            // Reliable entries are barriers: never move a patch across a control/fault event.
            const replacing = !latestSnapshot && kind !== 'reliable' && tail?.kind === kind
                && (!['realtime', 'motion-input'].includes(kind) || !hasMotionBoundary(tail.message, message));
            if (replacing) {
                const merged = ['realtime','motion-input'].includes(kind) ? mergeRealtime(tail.message, message) : message;
                const mergedText = JSON.stringify(merged);
                entry = { message: merged, text: mergedText, size: Buffer.byteLength(mergedText), kind };
            }
            const obsolete = replacing ? tail : obsoleteIndex >= 0 ? this.queue[obsoleteIndex] : null;
            const bytes = this.bytes - (obsolete?.size || 0) + entry.size;
            if (entry.size > this.options.maxMessageBytes || bytes + this.inflightBytes + this.socket.bufferedAmount > this.options.maxBytes
                || this.queue.length + (obsolete ? 0 : 1) + (this.inflight ? 1 : 0) > this.options.maxMessages)
                return this.fail('outbound queue limit', true);
            this.bytes = bytes;
            if (replacing) this.queue[this.queue.length - 1] = entry;
            else {
                if (obsoleteIndex >= 0) this.queue.splice(obsoleteIndex, 1);
                this.queue.push(entry);
            }
            if (obsolete) this.stats.merged++;
            this.stats.accepted++;
            this.pump(); return true;
        } catch (error) { return this.fail(`send serialization: ${error.message}`); }
    }
    pump() {
        if (this.closed || (!this.inflight && !this.queue.length)) return;
        if (!this.startedAt) this.startedAt = Date.now();
        if (Date.now() - this.startedAt >= this.options.stallMs) return this.fail('slow consumer timeout', true);
        if (!this.timer) {
            this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.options.pollMs);
            this.timer.unref?.();
        }
        if (this.inflight || this.socket.bufferedAmount > this.options.highWaterBytes) return;
        if (this.socket.readyState !== 1) return this.dispose();
        const entry = this.queue.shift(); this.bytes -= entry.size;
        this.inflight = true; this.inflightBytes = entry.size;
        try {
            this.socket.send(entry.text, error => {
                if (this.closed) return;
                this.inflight = false; this.inflightBytes = 0;
                if (error) return this.fail(`send callback: ${error.message}`);
                this.stats.sent++; this.startedAt = 0;
                if (this.queue.length) this.pump();
                else { clearTimeout(this.timer); this.timer = null; }
            });
        } catch (error) { this.fail(`send exception: ${error.message}`); }
    }
    fail(reason, overflow = false) {
        if (this.closed) return false;
        this.stats.errors++; if (overflow) this.stats.overflows++;
        this.failure = reason; this.dispose();
        // 1013 explicitly requests reconnect + reload authoritative configuration.
        try { this.socket.close(1013, 'Resource limit/send failure; reconnect and resync'); }
        catch { try { this.socket.terminate(); } catch {} }
        const timer = setTimeout(() => { try { this.socket.terminate(); } catch {} }, 250);
        timer.unref?.();
        return false;
    }
    dispose() {
        this.closed = true; clearTimeout(this.timer); this.timer = null;
        this.queue.length = 0; this.bytes = 0; this.inflightBytes = 0; this.inflight = false;
    }
}
module.exports = { WsOutboundQueue, mergeRealtime, hasMotionBoundary, defaults };
