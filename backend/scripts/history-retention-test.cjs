const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { HistoryRetention } = require('../services/historyRetention');
const { orderedReleases } = require('../utils/orderedReleases');

(async () => {
    const root = createRunDirectory('history-retention'), file = path.join(root, 'test.db');
    const sqlite = new Database(file);
    sqlite.exec(`CREATE TABLE metric_snapshots (id INTEGER PRIMARY KEY, snapshot_time TEXT);
        CREATE INDEX metric_time ON metric_snapshots(snapshot_time, id);
        CREATE TABLE event_logs (id INTEGER PRIMARY KEY, occurred_at TEXT);
        CREATE TABLE releases (id TEXT PRIMARY KEY, project_id TEXT, created_at TEXT, is_current INTEGER, snapshot_json TEXT);`);
    const insert = sqlite.prepare('INSERT INTO metric_snapshots(snapshot_time) VALUES (?)');
    sqlite.transaction(() => { for (let i = 0; i < 11000; i++) insert.run('2025-01-01 00:00:00'); })();
    insert.run('2026-09-30 00:00:00');
    insert.run('2026-07-02 00:00:00'); // Exactly 90 days: keep boundary.
    sqlite.exec("INSERT INTO event_logs VALUES (1, '2020-01-01 00:00:00')");
    const db = { all: async (sql, args) => sqlite.prepare(sql).all(...args),
        run: async (sql, args) => sqlite.prepare(sql).run(...args) };
    const maintenance = new HistoryRetention({ database: async () => db, clock: () => Date.parse('2026-09-30T00:00:00Z') });
    try {
        maintenance.start();
        const first = maintenance.run();
        assert.equal(maintenance.run(), first, 'overlapping runs coalesce');
        assert.equal((await first).deleted, 10000);
        assert.equal(maintenance.status().backlog, true);
        assert.equal((await maintenance.run()).deleted, 1000);
        assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM metric_snapshots').get().n, 2);
        assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM event_logs').get().n, 1);
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
        console.log(JSON.stringify({ success: true, metricDays: 90, eventsUntouched: true,
            boundedBatches: true, releaseSortKeysOnly: true, root }));
    } finally { await maintenance.stop(); sqlite.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
