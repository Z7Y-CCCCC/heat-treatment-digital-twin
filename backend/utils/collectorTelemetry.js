'use strict';

// Realtime samples are replaceable; alarms are persisted by DataEngine before
// reaching this queue. Never accumulate an IPC send for every PLC sample.
class CollectorTelemetry {
    constructor(send, { maxBytes = 2 * 1024 * 1024, maxDevices = 10000 } = {}) {
        this.send = send;
        this.maxBytes = maxBytes;
        this.maxDevices = maxDevices;
        this.pending = new Map();
        this.bytes = 0;
        this.inFlight = false;
        this.closed = false;
        this.dropped = 0;
    }
    add(devices = []) {
        if (this.closed) return;
        for (const device of devices) {
            if (!device?.furnace_id) continue;
            const id = String(device.furnace_id);
            const bytes = Buffer.byteLength(JSON.stringify(device));
            const previous = this.pending.get(id);
            if ((!previous && this.pending.size >= this.maxDevices)
                || this.bytes - (previous?.bytes || 0) + bytes > this.maxBytes) {
                this.dropped++;
                continue;
            }
            this.pending.set(id, { device, bytes });
            this.bytes += bytes - (previous?.bytes || 0);
        }
        this.flush();
    }
    flush() {
        if (this.closed || this.inFlight) return;
        const devices = [...this.pending.values()].map(item => item.device);
        this.pending.clear();
        this.bytes = 0;
        this.inFlight = true;
        this.send(devices, error => {
            this.inFlight = false;
            if (error) { this.close(); return; }
            if (this.pending.size) this.flush();
        });
    }
    remove(deviceIds = []) {
        for (const id of deviceIds) {
            const item = this.pending.get(String(id));
            if (item) { this.bytes -= item.bytes; this.pending.delete(String(id)); }
        }
    }
    close() {
        this.closed = true;
        this.pending.clear();
        this.bytes = 0;
    }
}
module.exports = { CollectorTelemetry };
