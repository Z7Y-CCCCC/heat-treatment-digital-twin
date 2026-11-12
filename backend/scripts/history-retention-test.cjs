const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { HistoryRetention } = require('../services/historyRetention');
const { orderedReleases } = require('../utils/orderedReleases');

(async () => {
    const root = createRunDirectory('history-retention'), file = path.join(root, 'test.db'), cutoff = Date.now();
    const sqlite = new Database(file);
    sqlite.exec(`CREATE TABLE metric_snapshots (id INTEGER PRIMARY KEY, retention_until REAL);
        CREATE INDEX metric_expiry ON metric_snapshots(retention_until, id);
        CREATE TABLE point_samples (sample_key TEXT PRIMARY KEY, retention_until REAL);
        CREATE INDEX point_expiry ON point_samples(retention_until, sample_key);
        CREATE TABLE event_logs (id INTEGER PRIMARY KEY, occurred_at TEXT);
        CREATE TABLE releases (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT, is_current INTEGER, snapshot_json TEXT);`);
    const insert = sqlite.prepare('INSERT INTO metric_snapshots(retention_until) VALUES (?)');
    const insertPoint = sqlite.prepare('INSERT INTO point_samples VALUES (?,?)');
    sqlite.transaction(() => {
        for (let i = 0; i < 11000; i++) { insert.run(cutoff - 1); insertPoint.run('expired-' + i, cutoff - 1); }
        for (const [key, deadline] of [['legacy', null], ['permanent', null], ['boundary', cutoff], ['future', cutoff + 1]]) {
            insert.run(deadline); insertPoint.run(key, deadline);
        }
    })();
    sqlite.exec("INSERT INTO event_logs VALUES (1, '2020-01-01 00:00:00')");
    const db = { all: async (sql, args) => sqlite.prepare(sql).all(...args),
        run: async (sql, args) => sqlite.prepare(sql).run(...args) };
    const disabled=new HistoryRetention({enabled:false,database:async()=>{throw Error('Disabled maintenance must not access history');}});
    disabled.start();assert.equal((await disabled.run()).enabled,false);assert.equal(disabled.timer,null);await disabled.stop();
    const maintenance = new HistoryRetention({ database: async () => db, clock: () => cutoff });
    try {
        assert.equal((await maintenance.run()).deleted, 0, 'maintenance does not run before explicit start');
        maintenance.start();
        assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM point_samples').get().n, 11004, 'start does not delete synchronously');
        const first = maintenance.run();
        assert.equal(maintenance.run(), first, 'overlapping runs coalesce');
        const status = await first;
        assert.equal(status.policy, 'record-deadline');
        assert.equal(status.pointDeleted, 10000);
        assert.equal(status.metricDeleted, 10000);
        assert.equal(status.deleted, 20000);
        assert.equal(maintenance.status().backlog, true);
        assert.equal((await maintenance.run()).deleted, 2000);
        assert.equal(maintenance.status().backlog, false);
        assert.deepEqual(sqlite.prepare('SELECT sample_key FROM point_samples ORDER BY sample_key').all().map(r=>r.sample_key), ['boundary','future','legacy','permanent']);
        assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM metric_snapshots').get().n, 4);
        assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM event_logs').get().n, 1, 'alarm/operation events are independent');
        await maintenance.stop();
        await maintenance.run();
        assert.equal(maintenance.status().running, false);
        for (const [id, date, current] of [['a', '2026-01-01', 0], ['b', '2026-02-01', 1]])
            sqlite.prepare('INSERT INTO releases VALUES (?, ?, ?, ?, ?)').run(id, 'p', date, current, 'x'.repeat(1024 * 1024));
        const checked = { all: async (sql, args) => {
            assert.ok(!/SELECT \* FROM releases.*ORDER BY/s.test(sql), 'never sort full JSON snapshots in SQL');
            return db.all(sql, args);
        } };
        assert.deepEqual((await orderedReleases(checked, 'p')).map(row => row.id), ['b', 'a']);
        assert.equal((await orderedReleases(checked, 'p', { currentOnly: true, limit: 1 }))[0].id, 'b');
        assert.deepEqual(await orderedReleases(checked, 'empty'), []);
        console.log(JSON.stringify({ success: true, recordDeadlines: true, legacyAndPermanentPreserved: true, eventsUntouched: true,
            boundedBatches: true, releaseSortKeysOnly: true, root }));
    } finally { await maintenance.stop(); sqlite.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
