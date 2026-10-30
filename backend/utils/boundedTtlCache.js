'use strict';

// Cache only replaceable query results. Reliable events belong in durable storage.
class BoundedTtlCache {
    constructor({ maxEntries = 256, maxBytes = 16 * 1024 * 1024, clock = Date.now } = {}) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.clock = clock;
        this.entries = new Map();
        this.bytes = 0;
        this.version = 0;
    }

    delete(key) {
        const entry = this.entries.get(key);
        if (entry) this.bytes -= entry.bytes;
        return this.entries.delete(key);
    }

    prune() {
        const now = this.clock();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.delete(key);
        }
    }

    get(key) {
        this.prune();
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key, value, expiresAt, version = this.version) {
        // A config save invalidates work that started with the previous config.
        if (version !== this.version) return false;
        this.prune();
        this.delete(key);
        const bytes = Buffer.byteLength(String(key)) + Buffer.byteLength(JSON.stringify(value));
        if (bytes > this.maxBytes || expiresAt <= this.clock()) return false;
        while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
            this.delete(this.entries.keys().next().value);
        }
        this.entries.set(key, { value, bytes, expiresAt });
        this.bytes += bytes;
        return true;
    }

    clear() {
        this.entries.clear();
        this.bytes = 0;
        this.version += 1;
    }

    status() {
        this.prune();
        return { entries: this.entries.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes };
    }
}

module.exports = { BoundedTtlCache };
