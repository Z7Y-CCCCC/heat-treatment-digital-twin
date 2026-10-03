const { getDb } = require('../db/database');

const RETENTION_DAYS = 90;
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;
const DAY_MS = 86400000;

class HistoryRetention {
    constructor({ database = getDb, intervalMs = 60000, clock = Date.now, enabled = true } = {}) {
        this.database = database; this.intervalMs = intervalMs; this.clock = clock; this.enabled = enabled;
        this.timer = null; this.pending = null; this.stopped = true; this.nextRun = 0;
        this.state = { enabled, metricDays: RETENTION_DAYS, eventDays: null,
            lastRunAt: null, deleted: 0, backlog: false, error: null };
    }
    status() { return { ...this.state, running: !!this.pending }; }
    start() {
        if (!this.enabled || this.timer) return;
        this.stopped = false;
        // Startup seeds/migrations complete first; no large delete on launch.
        this.timer = setInterval(() => {
            if (this.clock() >= this.nextRun) this.run().catch(error => console.warn('[HistoryRetention]', error.message));
        }, this.intervalMs);
        this.timer.unref?.();
    }
    async stop() {
        this.stopped = true; clearInterval(this.timer); this.timer = null;
        await this.pending?.catch(() => {});
    }
    run() {
        if (this.pending) return this.pending;
        if (this.stopped || !this.enabled) return Promise.resolve(this.status());
        this.pending = this.prune().finally(() => { this.pending = null; });
        return this.pending;
    }
    async prune() {
        const db = await this.database();
        const cutoff = new Date(this.clock() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
        let deleted = 0, backlog = false;
        try {
            for (let batch = 0; batch < MAX_BATCHES && !this.stopped; batch++) {
                // Existing time index bounds each query. Yield between batches
                // to avoid holding a long transaction or blocking PLC writes.
                const keys = await db.all(`SELECT id FROM metric_snapshots WHERE snapshot_time < ?
                    ORDER BY snapshot_time ASC, id ASC LIMIT ${BATCH_SIZE}`, [cutoff]);
                if (this.stopped || !keys.length) { backlog = false; break; }
                const ids = keys.map(row => row.id);
                const result = await db.run(`DELETE FROM metric_snapshots WHERE snapshot_time < ?
                    AND id IN (${ids.map(() => '?').join(',')})`, [cutoff, ...ids]);
                deleted += Number(result.changes ?? result.affectedRows ?? 0);
                backlog = keys.length === BATCH_SIZE;
                if (!backlog) break;
                await new Promise(resolve => setImmediate(resolve));
            }
            this.state = { ...this.state, lastRunAt: new Date(this.clock()).toISOString(), deleted, backlog, error: null };
            this.nextRun = this.clock() + (backlog ? 5 * 60000 : 6 * 3600000);
            return this.status();
        } catch (error) {
            this.state.error = error.message;
            this.nextRun = this.clock() + 5 * 60000;
            throw error;
        }
    }
}
const historyRetention = new HistoryRetention();
module.exports = { HistoryRetention, historyRetention, RETENTION_DAYS };
