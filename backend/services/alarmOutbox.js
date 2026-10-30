'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Alarm transitions are reliable records. Persist them independently of a slow
// or unavailable business database, and only load a bounded delivery batch.
class AlarmOutbox {
    constructor(filename) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        const Database = require('better-sqlite3');
        this.database = new Database(filename);
        this.pendingCounts = new Map();
        try {
            this.database.pragma('busy_timeout = 5000');
            this.database.pragma('journal_mode = WAL');
            this.database.pragma('synchronous = FULL');
            this.database.exec(`CREATE TABLE IF NOT EXISTS observed_alarm (
                factory_id TEXT NOT NULL, device_id TEXT NOT NULL, alarm INTEGER NOT NULL,
                PRIMARY KEY (factory_id, device_id));
                CREATE TABLE IF NOT EXISTS pending_alarm (
                id INTEGER PRIMARY KEY AUTOINCREMENT, factory_id TEXT NOT NULL,
                event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_pending_alarm_factory ON pending_alarm (factory_id, id);`);
            this.observed = this.database.prepare('SELECT alarm FROM observed_alarm WHERE factory_id = ? AND device_id = ?');
            this.saveObserved = this.database.prepare(`INSERT INTO observed_alarm (factory_id, device_id, alarm)
                VALUES (?, ?, ?) ON CONFLICT(factory_id, device_id) DO UPDATE SET alarm = excluded.alarm`);
            this.enqueue = this.database.prepare('INSERT INTO pending_alarm (factory_id, event_key, payload) VALUES (?, ?, ?)');
            this.readBatch = this.database.prepare('SELECT id, event_key, payload FROM pending_alarm WHERE factory_id = ? ORDER BY id LIMIT ?');
            this.remove = this.database.prepare('DELETE FROM pending_alarm WHERE id = ? AND event_key = ?');
            this.countPending = this.database.prepare('SELECT COUNT(*) AS count FROM pending_alarm WHERE factory_id = ?');
            this.recordBatch = this.database.transaction((factoryId, records) => {
                let added = 0;
                for (const record of records) {
                    const previous = !!this.observed.get(factoryId, record.deviceId)?.alarm;
                    if (previous === record.alarm) continue;
                    const eventKey = randomUUID();
                    this.enqueue.run(factoryId, eventKey, JSON.stringify({ ...record, factoryId, eventKey }));
                    this.saveObserved.run(factoryId, record.deviceId, record.alarm ? 1 : 0);
                    added += 1;
                }
                return added;
            });
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    record(factoryId, records) {
        const before = this.pending(factoryId);
        const added = this.recordBatch(factoryId, records);
        this.pendingCounts.set(factoryId, before + added);
        return added;
    }
    batch(factoryId, limit = 32) {
        return this.readBatch.all(factoryId, limit).map(row => ({ ...JSON.parse(row.payload), journalId: row.id }));
    }
    acknowledge(event) {
        const before = this.pending(event.factoryId);
        const removed = this.remove.run(event.journalId, event.eventKey).changes;
        this.pendingCounts.set(event.factoryId, Math.max(0, before - removed));
    }
    pending(factoryId) {
        if (!this.pendingCounts.has(factoryId)) this.pendingCounts.set(factoryId, this.countPending.get(factoryId).count);
        return this.pendingCounts.get(factoryId);
    }
    close() { this.database.close(); }

    beginImportSnapshot(filename) {
        const snapshot = openValidatedSnapshot(filename);
        try {
            this.database.prepare('BEGIN IMMEDIATE').run();
            const addPending = this.database.prepare('INSERT OR IGNORE INTO pending_alarm (factory_id, event_key, payload) VALUES (?, ?, ?)');
            const addObserved = this.database.prepare('INSERT OR IGNORE INTO observed_alarm (factory_id, device_id, alarm) VALUES (?, ?, ?)');
            for (const row of snapshot.prepare('SELECT factory_id, event_key, payload FROM pending_alarm ORDER BY id').iterate()) {
                addPending.run(row.factory_id, row.event_key, row.payload);
            }
            // Preserve live observed states when restoring an older backup.
            for (const row of snapshot.prepare('SELECT factory_id, device_id, alarm FROM observed_alarm').iterate()) {
                addObserved.run(row.factory_id, row.device_id, row.alarm);
            }
        } catch (error) {
            if (this.database.inTransaction) this.database.prepare('ROLLBACK').run();
            throw error;
        } finally { snapshot.close(); }
        let active = true;
        const finish = command => {
            if (!active) return;
            this.database.prepare(command).run();
            active = false;
            this.pendingCounts.clear();
        };
        return { commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') };
    }
}

function openValidatedSnapshot(filename) {
    const Database = require('better-sqlite3');
    const snapshot = new Database(filename, { readonly: true, fileMustExist: true });
    try {
        if (snapshot.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('报警事件快照完整性检查失败');
        const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
        for (const row of snapshot.prepare('SELECT factory_id, device_id, alarm FROM observed_alarm').iterate()) {
            if (!validId(row.factory_id) || !validId(row.device_id) || ![0, 1].includes(row.alarm)) throw new Error('报警事件快照包含无效状态');
        }
        for (const row of snapshot.prepare('SELECT factory_id, event_key, payload FROM pending_alarm ORDER BY id').iterate()) {
            if (Buffer.byteLength(row.payload) > 32768) throw new Error('报警事件快照的单条记录过大');
            const event = JSON.parse(row.payload);
            if (!validId(row.factory_id) || !validId(event.deviceId) || event.factoryId !== row.factory_id || event.eventKey !== row.event_key
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.eventKey)
                || typeof event.deviceName !== 'string' || event.deviceName.length > 180 || typeof event.alarm !== 'boolean'
                || !['good', 'bad', 'stale'].includes(event.quality) || !Number.isSafeInteger(event.occurredAt)
                || event.occurredAt < 0 || event.occurredAt > 8640000000000000) throw new Error('报警事件快照包含无效记录');
        }
        return snapshot;
    } catch (error) { snapshot.close(); throw error; }
}

function verifyAlarmOutboxSnapshot(filename) {
    const snapshot = openValidatedSnapshot(filename);
    snapshot.close();
}

async function snapshotAlarmOutbox(source, destination) {
    const Database = require('better-sqlite3');
    const database = new Database(source, { readonly: true, fileMustExist: true });
    try { await database.backup(destination); }
    finally { database.close(); }
    verifyAlarmOutboxSnapshot(destination);
}

let sharedOutbox;
function getAlarmOutbox() {
    if (!sharedOutbox) {
        const dataDirectory = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : path.join(__dirname, '..', 'data');
        sharedOutbox = new AlarmOutbox(path.join(dataDirectory, 'alarm-outbox.db'));
    }
    return sharedOutbox;
}
function closeAlarmOutbox() {
    if (sharedOutbox) sharedOutbox.close();
    sharedOutbox = null;
}

module.exports = { AlarmOutbox, getAlarmOutbox, closeAlarmOutbox, verifyAlarmOutboxSnapshot, snapshotAlarmOutbox };
