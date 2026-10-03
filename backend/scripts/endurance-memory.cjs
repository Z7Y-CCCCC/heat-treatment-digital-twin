const fs = require('node:fs/promises');
const { setImmediate: yieldToTimers } = require('node:timers/promises');
const { TextDecoder } = require('node:util');

// Retain only one aggregate per process generation, not its complete telemetry history.
function createMemorySummaryReader(filename, { chunkBytes = 64 * 1024, maxLineBytes = 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || !Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('Invalid memory reader buffer limits');
    const byPid = new Map();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let samples = 0, offset = 0, pending = Buffer.alloc(0), identity, failure, inFlight;

    function summary() {
        const generations = [];
        let peakRssMb = 0, maxRssGrowthMb = 0;
        for (const [pid, state] of byPid) {
            const item = { pid, samples: state.samples, peakRssMb: state.peak / 1048576, rssGrowthMb: (state.last - (state.warm ?? state.first)) / 1048576, baselineAfterWarmup: state.warm !== undefined };
            generations.push(item);
            peakRssMb = Math.max(peakRssMb, item.peakRssMb);
            maxRssGrowthMb = Math.max(maxRssGrowthMb, item.rssGrowthMb);
        }
        return { samples, generations, peakRssMb, maxRssGrowthMb };
    }
    function consume(line) {
        if (line.length > maxLineBytes) throw new Error('Memory telemetry line exceeds size limit');
        const text = decoder.decode(line).trim();
        if (!text) return;
        const row = JSON.parse(text);
        if (!Number.isSafeInteger(row?.pid) || row.pid <= 0 || !Number.isFinite(row.rss) || row.rss < 0 || !Number.isFinite(row.uptime) || row.uptime < 0) throw new Error('Invalid memory telemetry sample');
        let state = byPid.get(row.pid);
        if (!state) { state = { samples: 0, first: row.rss, peak: row.rss }; byPid.set(row.pid, state); }
        state.samples++;
        state.last = row.rss;
        state.peak = Math.max(state.peak, row.rss);
        if (state.warm === undefined && row.uptime >= 60) state.warm = row.rss;
        samples++;
    }
    async function readAppended(final) {
        if (failure) throw failure;
        let handle;
        try {
            try { handle = await fs.open(filename, 'r'); }
            catch (error) { if (error.code === 'ENOENT' && !identity) return summary(); throw error; }
            const stat = await handle.stat();
            const currentIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            if (identity && identity !== currentIdentity) throw new Error('Memory telemetry file was replaced');
            if (stat.size < offset) throw new Error('Memory telemetry file was truncated');
            identity = currentIdentity;
            // Snapshot the size so an active writer cannot prolong this refresh indefinitely.
            const limit = stat.size;
            const buffer = Buffer.allocUnsafe(chunkBytes);
            while (offset < limit) {
                const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, limit - offset), offset);
                if (!bytesRead) throw new Error('Memory telemetry file shortened during read');
                offset += bytesRead;
                const data = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
                let start = 0, end, batch = 0;
                while ((end = data.indexOf(10, start)) !== -1) {
                    consume(data.subarray(start, end));
                    start = end + 1;
                    if (++batch % 256 === 0) await yieldToTimers();
                }
                pending = Buffer.from(data.subarray(start));
                if (pending.length > maxLineBytes) throw new Error('Unterminated memory telemetry line exceeds size limit');
                await yieldToTimers();
            }
            if (final && pending.length && decoder.decode(pending).trim()) throw new Error('Incomplete memory telemetry record at final report');
            return summary();
        } catch (error) {
            failure = new Error(`Cannot read memory telemetry ${filename}: ${error.message}`, { cause: error });
            throw failure;
        } finally { await handle?.close(); }
    }
    function refresh({ final = false } = {}) {
        // Serialize reads so a final call rechecks the file after any in-flight
        // normal snapshot, applying its own stricter end-of-file validation.
        const operation = (inFlight || Promise.resolve()).then(() => readAppended(final));
        inFlight = operation.catch(() => {});
        return operation;
    }
    return { refresh, summary };
}

module.exports = { createMemorySummaryReader };
