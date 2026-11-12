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
            this.database.exec(`CREATE TABLE IF NOT EXISTS observed_point_alarm (
                factory_id TEXT NOT NULL, device_id TEXT NOT NULL, point_id TEXT NOT NULL,
                alarm INTEGER NOT NULL, occurrence_id TEXT, started_at INTEGER, observed_at INTEGER NOT NULL, details TEXT,
                PRIMARY KEY (factory_id, device_id, point_id));`);
            // Same reliable journal/backup boundary as alarms, separate queues.
            this.database.exec(`CREATE TABLE IF NOT EXISTS pending_point_sample (
                id INTEGER PRIMARY KEY AUTOINCREMENT, factory_id TEXT NOT NULL, sample_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_pending_sample_factory ON pending_point_sample(factory_id,id);
                CREATE TABLE IF NOT EXISTS observed_point_sample (
                scope TEXT PRIMARY KEY, sample_key TEXT NOT NULL);`);
            this.sampleCountCache=new Map();
            const observedSample=this.database.prepare('SELECT sample_key FROM observed_point_sample WHERE scope=?');
            const saveSample=this.database.prepare('INSERT OR REPLACE INTO observed_point_sample(scope,sample_key) VALUES (?,?)');
            const enqueueSample=this.database.prepare('INSERT OR IGNORE INTO pending_point_sample(factory_id,sample_key,payload) VALUES (?,?,?)');
            this.recordSampleBatch=this.database.transaction((records)=>{
                let added=0;for(const record of records){
                    const scope=JSON.stringify([record.factoryId,record.deviceId,record.pointId,record.sourceMode]);
                    if(observedSample.get(scope)?.sample_key===record.sampleKey)continue;
                    added+=enqueueSample.run(record.factoryId,record.sampleKey,JSON.stringify(record)).changes;
                    saveSample.run(scope,record.sampleKey);
                }return added;
            });
            this.readSamples=this.database.prepare('SELECT id,payload FROM pending_point_sample WHERE factory_id=? ORDER BY id LIMIT ?');
            this.removeSample=this.database.prepare('DELETE FROM pending_point_sample WHERE id=? AND sample_key=? AND factory_id=?');
            this.removeSampleBatch = this.database.transaction(records => {
                const removedByFactory = new Map();
                for (const record of records) {
                    const removed = this.removeSample.run(record.journalId, record.sampleKey, record.factoryId).changes;
                    if (removed) removedByFactory.set(record.factoryId, (removedByFactory.get(record.factoryId) || 0) + removed);
                }
                return removedByFactory;
            });
            this.observedPoint = this.database.prepare('SELECT * FROM observed_point_alarm WHERE factory_id=? AND device_id=? AND point_id=?');
            this.saveObservedPoint = this.database.prepare(`INSERT INTO observed_point_alarm
                (factory_id, device_id, point_id, alarm, occurrence_id, started_at, observed_at, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(factory_id, device_id, point_id) DO UPDATE SET alarm=excluded.alarm,
                occurrence_id=excluded.occurrence_id, started_at=excluded.started_at, observed_at=excluded.observed_at, details=excluded.details`);
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
                    if (record.pointId) {
                        const previous = this.observedPoint.get(factoryId, record.deviceId, record.pointId);
                        if (!!previous?.alarm === record.alarm || previous?.observed_at > record.occurredAt) continue;
                        const eventKey = randomUUID();
                        // Text, condition and start time are captured once per occurrence.
                        // Renaming/editing a live point must not rewrite its historical alarm.
                        const details = record.alarm ? record : JSON.parse(previous.details);
                        const occurrenceId = record.alarm ? eventKey : previous.occurrence_id;
                        const startedAt = record.alarm ? record.occurredAt : previous.started_at;
                        const event = { ...details, alarm: record.alarm, quality: record.quality,
                            occurredAt: record.occurredAt, factoryId, eventKey, occurrenceId, startedAt,
                            endedAt: record.alarm ? null : record.occurredAt };
                        this.enqueue.run(factoryId, eventKey, JSON.stringify(event));
                        this.saveObservedPoint.run(factoryId, record.deviceId, record.pointId, record.alarm ? 1 : 0,
                            occurrenceId, startedAt, record.occurredAt, JSON.stringify(details));
                        added += 1;
                        continue;
                    }
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
    recordSamples(factoryId,records){const before=this.pendingSamples(factoryId),added=this.recordSampleBatch(records);this.sampleCountCache.set(factoryId,before+added);return added;}
    sampleBatch(factoryId,limit=256){return this.readSamples.all(factoryId,limit).map(row=>({...JSON.parse(row.payload),journalId:row.id}));}
    acknowledgeSample(record) { return this.acknowledgeSamples([record]); }
    acknowledgeSamples(records) {
        if (!records.length) return 0;
        // Keep FULL durability, but pay for one journal commit per delivered
        // batch rather than one fsync per point. Update counts only after the
        // transaction commits; a failed delete must leave rows and cache intact.
        const removedByFactory = this.removeSampleBatch(records);
        let total = 0;
        for (const [factoryId, removed] of removedByFactory) {
            if (this.sampleCountCache.has(factoryId)) {
                this.sampleCountCache.set(factoryId, Math.max(0, this.sampleCountCache.get(factoryId) - removed));
            }
            total += removed;
        }
        return total;
    }
    pendingSamples(factoryId){if(!this.sampleCountCache.has(factoryId))this.sampleCountCache.set(factoryId,this.database.prepare('SELECT COUNT(*) n FROM pending_point_sample WHERE factory_id=?').get(factoryId).n);return this.sampleCountCache.get(factoryId);}

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
            if(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='pending_point_sample'").get()) {
                const addSample=this.database.prepare('INSERT OR IGNORE INTO pending_point_sample(factory_id,sample_key,payload) VALUES (?,?,?)');
                for(const row of snapshot.prepare('SELECT factory_id,sample_key,payload FROM pending_point_sample ORDER BY id').iterate())addSample.run(row.factory_id,row.sample_key,row.payload);
            }
            if (snapshot.prepare("SELECT name FROM sqlite_master WHERE name='observed_point_alarm'").get()) {
                const addPoint = this.database.prepare(`INSERT OR IGNORE INTO observed_point_alarm
                    (factory_id,device_id,point_id,alarm,occurrence_id,started_at,observed_at,details) VALUES (?,?,?,?,?,?,?,?)`);
                for (const row of snapshot.prepare('SELECT * FROM observed_point_alarm').iterate()) {
                    addPoint.run(row.factory_id, row.device_id, row.point_id, row.alarm, row.occurrence_id, row.started_at, row.observed_at, row.details);
                }
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
            this.sampleCountCache.clear();
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
        if(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='pending_point_sample'").get())for(const row of snapshot.prepare('SELECT factory_id,sample_key,payload FROM pending_point_sample').iterate()) {
            const sample=JSON.parse(row.payload);
            if(!validId(row.factory_id) || sample.factoryId!==row.factory_id || !validId(sample.deviceId) || !validId(sample.pointId)
                || !/^[a-f0-9]{64}$/.test(row.sample_key) || sample.sampleKey!==row.sample_key || !Number.isSafeInteger(sample.sampledAt) || sample.sampledAt<=0
                || !['good','bad','stale'].includes(sample.quality) || !['simulation','integrated_plc'].includes(sample.sourceMode)
                || typeof sample.pointKey!=='string' || sample.pointKey.length>255 || typeof sample.valueJson!=='string'
                || typeof sample.pointName!=='string' || sample.pointName.length>255 || typeof sample.unit!=='string' || sample.unit.length>64
                || (sample.valueNumber!==null && (typeof sample.valueNumber!=='number' || !Number.isFinite(sample.valueNumber)))
                || sample.sampledAt>8640000000000000
                || (sample.retentionUntil != null && (!Number.isSafeInteger(sample.retentionUntil) || sample.retentionUntil < sample.sampledAt || sample.retentionUntil > 8640000000000000))
                || Buffer.byteLength(row.payload)>1048576)throw Error('点位历史待入库快照包含无效记录');
            JSON.parse(sample.valueJson);
        }
        for (const row of snapshot.prepare('SELECT factory_id, device_id, alarm FROM observed_alarm').iterate()) {
            if (!validId(row.factory_id) || !validId(row.device_id) || ![0, 1].includes(row.alarm)) throw new Error('报警事件快照包含无效状态');
        }
        const validPointEvent = event => validId(event.pointId) && typeof event.pointName === 'string' && event.pointName.length <= 256
            && typeof event.alarmText === 'string' && event.alarmText.length <= 4000 && typeof event.condition === 'string' && event.condition.length <= 64;
        if (snapshot.prepare("SELECT name FROM sqlite_master WHERE name='observed_point_alarm'").get()) {
            for (const row of snapshot.prepare('SELECT * FROM observed_point_alarm').iterate()) {
                const details = JSON.parse(row.details);
                if (!validId(row.factory_id) || !validId(row.device_id) || !validId(row.point_id) || ![0,1].includes(row.alarm)
                    || !validPointEvent(details) || details.pointId !== row.point_id || details.deviceId !== row.device_id
                    || !Number.isSafeInteger(row.started_at) || row.started_at <= 0 || row.started_at > 8640000000000000
                    || !Number.isSafeInteger(row.observed_at) || row.observed_at < row.started_at || row.observed_at > 8640000000000000
                    || !/^[a-f0-9-]{36}$/i.test(row.occurrence_id)) throw new Error('报警点位快照包含无效状态');
            }
        }
        for (const row of snapshot.prepare('SELECT factory_id, event_key, payload FROM pending_alarm ORDER BY id').iterate()) {
            if (Buffer.byteLength(row.payload) > 32768) throw new Error('报警事件快照的单条记录过大');
            const event = JSON.parse(row.payload);
            if (!validId(row.factory_id) || !validId(event.deviceId) || event.factoryId !== row.factory_id || event.eventKey !== row.event_key
                || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.eventKey)
                || typeof event.deviceName !== 'string' || event.deviceName.length > 180 || typeof event.alarm !== 'boolean'
                || !['good', 'bad', 'stale'].includes(event.quality) || !Number.isSafeInteger(event.occurredAt)
                || event.occurredAt < 0 || event.occurredAt > 8640000000000000) throw new Error('报警事件快照包含无效记录');
            if (event.pointId && (!validPointEvent(event) || !/^[a-f0-9-]{36}$/i.test(event.occurrenceId)
                || !Number.isSafeInteger(event.startedAt) || event.startedAt <= 0 || event.startedAt > event.occurredAt
                || (event.alarm ? event.endedAt !== null : event.endedAt !== event.occurredAt))) throw new Error('报警点位快照包含无效记录');
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
