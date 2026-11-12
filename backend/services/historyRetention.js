'use strict';
const { getDb } = require('../db/database');
const BATCH_SIZE = 500, MAX_BATCHES = 20;

class HistoryRetention {
    constructor({ database = getDb, intervalMs = 60000, clock = Date.now, enabled = true } = {}) {
        this.database = database; this.intervalMs = intervalMs; this.clock = clock; this.enabled = enabled;
        this.timer = null; this.pending = null; this.stopped = true; this.nextRun = 0;
        this.state = { enabled, policy:'record-deadline',eventDays:null,
            lastRunAt: null, deleted: 0, pointDeleted:0,metricDeleted:0,backlog: false, error: null };
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
        const counts={pointDeleted:0,metricDeleted:0};
        let backlog = false;
        try {
            const db=await this.database(),cutoff=this.clock();
            for(const [table,key,counter] of [['point_samples','sample_key','pointDeleted'],['metric_snapshots','id','metricDeleted']]) {
                for (let batch = 0; batch < MAX_BATCHES && !this.stopped; batch++) {
                    // NULL deadlines (legacy/permanent) and exact boundaries
                    // survive. Configuration saves never rewrite old deadlines.
                    const keys=await db.all(`SELECT ${key} FROM ${table} WHERE retention_until < ?
                        ORDER BY retention_until,${key} LIMIT ${BATCH_SIZE}`,[cutoff]);
                    if(this.stopped || !keys.length)break;
                    const ids=keys.map(row=>row[key]);
                    const result=await db.run(`DELETE FROM ${table} WHERE retention_until < ?
                        AND ${key} IN (${ids.map(()=>'?').join(',')})`,[cutoff,...ids]);
                    counts[counter]+=Number(result.changes ?? result.affectedRows ?? 0);
                    if(keys.length<BATCH_SIZE)break;
                    if(batch===MAX_BATCHES-1)backlog=true;
                    await new Promise(resolve=>setImmediate(resolve));
                }
            }
            this.state = { ...this.state,...counts, lastRunAt: new Date(this.clock()).toISOString(),deleted:counts.pointDeleted+counts.metricDeleted, backlog, error: null };
            this.nextRun = this.clock() + (backlog ? 5000 : 60000);
            return this.status();
        } catch (error) {
            this.state.error = error.message;
            this.nextRun = this.clock() + 60000;
            throw error;
        }
    }
}
const historyRetention = new HistoryRetention();
module.exports = { HistoryRetention, historyRetention };
