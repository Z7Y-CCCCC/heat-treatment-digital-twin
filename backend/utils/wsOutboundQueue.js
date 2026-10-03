'use strict';

const defaults = { maxMessageBytes: 4 * 1024 * 1024, maxBytes: 16 * 1024 * 1024,
    maxMessages: 256, highWaterBytes: 512 * 1024, stallMs: 15000, pollMs: 25 };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// Empty/missing quality groups must not erase another PLC task's bad points.
function mergePatch(previous, patch) {
    const result = { ...previous };
    for (const [key, value] of Object.entries(patch)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        result[key] = object(value) && object(result[key]) ? mergePatch(result[key], value) : value;
    }
    return result;
}
function hasFault(value) {
    if (object(value) || Array.isArray(value)) return Object.values(value).some(hasFault);
    return value === 'bad' || value === 'stale';
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
            const kind = message.type === 'realtime_frame' && !message.payload.devices.some(d => hasFault(d.quality))
                ? 'realtime' : message.type === 'scene_projection' ? 'projection' : 'reliable';
            const tail = this.queue[this.queue.length - 1];
            let entry = { message, text, size, kind };
            // Reliable entries are barriers: never move a patch across a control/fault event.
            if (kind !== 'reliable' && tail?.kind === kind) {
                const merged = kind === 'realtime' ? mergeRealtime(tail.message, message) : message;
                const mergedText = JSON.stringify(merged);
                entry = { message: merged, text: mergedText, size: Buffer.byteLength(mergedText), kind };
            }
            const replacing = kind !== 'reliable' && tail?.kind === kind;
            const bytes = this.bytes - (replacing ? tail.size : 0) + entry.size;
            if (entry.size > this.options.maxMessageBytes || bytes + this.inflightBytes + this.socket.bufferedAmount > this.options.maxBytes
                || this.queue.length + (replacing ? 0 : 1) + (this.inflight ? 1 : 0) > this.options.maxMessages)
                return this.fail('outbound queue limit', true);
            this.bytes = bytes;
            if (replacing) { this.queue[this.queue.length - 1] = entry; this.stats.merged++; }
            else this.queue.push(entry);
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
module.exports = { WsOutboundQueue, mergeRealtime, defaults };
