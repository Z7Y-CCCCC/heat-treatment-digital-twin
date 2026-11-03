const { getDb } = require('../db/database');
const PlcReader = require('./plcReader');
const Simulator = require('./simulator');
const { getAlarmOutbox } = require('./alarmOutbox');
const { assertNoPendingSiteRecovery } = require('./siteRecoveryIntent');

class DataEngine {
    constructor(wsServer, options = {}) {
        this.wsServer = wsServer;
        this.fixedFactoryId = String(options.factoryId || '');
        this.isSecondary = options.isSecondary === true;
        this.factoryEngines = new Map();
        this.plcReader = null;
        this.simulator = null;
        this.currentMode = null;
        this.plcStatus = { status: 'idle', message: '未启动' };
        this.collectorStatus = {
            status: 'idle',
            message: '内置低延迟采集器未启动',
            lastFrameAt: null,
            frames: 0,
            devices: 0
        };
        this.alarmState = new Map();
        this.alarmOutboxProvider = options.alarmOutbox || getAlarmOutbox;
        this.alarmWritePending = null;
        this.alarmRetryTimer = null;
        this.alarmRetryCount = 0;
        this.alarmStorageStopped = false;
        this.eventStorageStatus = { status: 'idle', pendingEvents: 0, lastError: null };
        this.deviceSnapshots = new Map();
        this.lastMetricSnapshotAt = 0;
        this.lastMetricSavedAt = 0;
        this.metricSummary = null;
        this.metricSnapshotIntervalMs = 5000;
        this.metricWritePending = null;
        this.runVersion = 0;
    }

    async start({ ownFactoryOnly = false } = {}) {
        assertNoPendingSiteRecovery();
        const runVersion = ++this.runVersion;
        this.alarmStorageStopped = false;
        clearTimeout(this.alarmRetryTimer);
        this.alarmRetryTimer = null;
        if (!ownFactoryOnly) await this._stopSecondaryEngines();
        this._stopSources();
        this.deviceSnapshots.clear();
        this.alarmState.clear();
        this.lastMetricSnapshotAt = 0;
        this.lastMetricSavedAt = 0;
        this.metricSummary = null;
        this.currentMode = null;
        const db = await getDb();
        if (runVersion !== this.runVersion) return;
        const activeFactory = this.fixedFactoryId ? null : await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
        if (runVersion !== this.runVersion) return;
        const factoryId = this.fixedFactoryId || String(activeFactory?.value || 'factory_default');
        this.activeFactoryId = factoryId;
        const factory = await db.get('SELECT collection_enabled FROM factories WHERE id = ?', [factoryId]);
        if (runVersion !== this.runVersion) return;
        if (Number(factory?.collection_enabled ?? 1) === 0) {
            this.alarmStorageStopped = true;
            this.plcStatus = { status: 'stopped', message: '工厂采集已停用', timestamp: Date.now() };
            this.collectorStatus = { status: 'stopped', message: '工厂采集已停用', lastFrameAt: null, frames: 0, devices: 0 };
            if (!this.isSecondary && !ownFactoryOnly) await this._startSecondaryEngines(db, runVersion);
            return;
        }
        const rows = await db.all('SELECT * FROM settings');
        if (runVersion !== this.runVersion) return;
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });
        const factoryRows = await db.all('SELECT `key`, value FROM factory_settings WHERE factory_id = ?', [factoryId]);
        if (runVersion !== this.runVersion) return;
        factoryRows.forEach(row => { settings[row.key] = row.value; });
        this._drainAlarmEvents().catch(() => {});

        const mode = this._normalizeMode(settings.data_mode);
        this.currentMode = mode;
        console.log(`\n[DataEngine] 启动，模式: ${mode}`);

        try {
            switch (mode) {
                case 'integrated_plc':
                    await this._startIntegratedPlcMode();
                    break;
                case 'simulation':
                default:
                    await this._startSimulationMode();
                    break;
            }
        } catch (error) {
            if (runVersion === this.runVersion) {
                this._stopSources();
                this.currentMode = null;
                this.plcStatus = { status: 'error', message: error.message, timestamp: Date.now() };
                this.collectorStatus = { ...this.collectorStatus, ...this.plcStatus };
            }
            throw error;
        }
        if (!this.isSecondary && !ownFactoryOnly && runVersion === this.runVersion) await this._startSecondaryEngines(db, runVersion);
        if (runVersion === this.runVersion) this.configLoadedAt = Date.now();
    }

    async _startSecondaryEngines(db, runVersion) {
        const factories = await db.all('SELECT id FROM factories');
        if (runVersion !== this.runVersion) return;
        const silentWs = { broadcastDeviceData() {}, broadcastStatus() {} };
        await Promise.all(factories.filter(factory => String(factory.id) !== this.activeFactoryId).map(async factory => {
            const id = String(factory.id);
            const engine = new DataEngine(silentWs, { factoryId: id, isSecondary: true });
            this.factoryEngines.set(id, engine);
            try { await engine.start(); }
            catch (error) { console.warn(`[DataEngine] 工厂 ${id} 采集启动失败:`, error.message); }
            if (runVersion !== this.runVersion) engine.stop();
        }));
    }

    async setFactoryCollectionEnabled(factoryId) {
        const id = String(factoryId);
        let engine = id === this.activeFactoryId ? this : this.factoryEngines.get(id);
        if (!engine) {
            engine = new DataEngine({ broadcastDeviceData() {}, broadcastStatus() {} }, { factoryId: id, isSecondary: true });
            this.factoryEngines.set(id, engine);
        }
        const previous = [...engine.deviceSnapshots.values()];
        // Read the persisted switch in start(), not an out-of-order IPC value.
        // Keep every other factory's readers, timers and metric state intact.
        await engine.start({ ownFactoryOnly: true });
        if (engine.collectorStatus.status === 'stopped' && previous.length) {
            engine.wsServer.broadcastDeviceData(previous.map(device => ({ ...device,
                quality: Object.fromEntries(['analog', 'status', 'digital'].map(group => [group,
                    Object.fromEntries(Object.keys(device[group] || {}).map(key => [key, 'bad']))]))
            })));
        }
        return { factoryId: id, status: engine.getStatus() };
    }

    async reloadFactoryConfiguration(factoryId) {
        const id = String(factoryId), source = id === this.activeFactoryId ? this : this.factoryEngines.get(id);
        if (!source) return this.setFactoryCollectionEnabled(id);
        const previousIds = [...source.deviceSnapshots.keys()];
        const db = await getDb();
        const factory = await db.get('SELECT collection_enabled FROM factories WHERE id=?', [id]);
        const local = await db.get('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', [id,'data_mode']);
        const mode = source._normalizeMode(local?.value ?? (await db.get('SELECT value FROM settings WHERE `key`=?', ['data_mode']))?.value);
        if (Number(factory?.collection_enabled ?? 1) !== 0 && source.currentMode === mode && source.plcReader) {
            await source.plcReader.reloadConfiguration(); source.configLoadedAt = Date.now();
        } else await source.start({ ownFactoryOnly: true });
        const present = source.plcReader ? new Set(source.plcReader.deviceStatus.keys()) : new Set((source.simulator?.devices || []).map(d => d.id));
        for (const key of source.deviceSnapshots.keys()) if (!present.has(key)) source.deviceSnapshots.delete(key);
        for (const key of source.alarmState.keys()) if (!present.has(key)) source.alarmState.delete(key);
        return { factoryId:id, status:source.getStatus(), removedDeviceIds:previousIds.filter(key => !present.has(key)) };
    }

    _stopSecondaryEngines() {
        const stopping = [...this.factoryEngines.values()].map(engine => engine.stop());
        this.factoryEngines.clear();
        return Promise.allSettled(stopping);
    }

    getFactoryStatuses() {
        const result = {};
        if (this.activeFactoryId) result[this.activeFactoryId] = { ...this.getStatus(), lastMetricSavedAt: this.lastMetricSavedAt, metricSummary: this.metricSummary };
        for (const [id, engine] of this.factoryEngines) result[id] = { ...engine.getStatus(), lastMetricSavedAt: engine.lastMetricSavedAt, metricSummary: engine.metricSummary };
        return result;
    }

    _stopSources() {
        const reader = this.plcReader;
        const simulator = this.simulator;
        this.plcReader = null;
        this.simulator = null;
        reader?.stop();
        simulator?.stop();
        this.deviceSnapshots.clear();
        this.alarmState.clear();
        this.lastMetricSnapshotAt = 0;
        this.lastMetricSavedAt = 0;
        this.metricSummary = null;
    }

    stop() {
        this.runVersion += 1;
        this.alarmStorageStopped = true;
        clearTimeout(this.alarmRetryTimer);
        this.alarmRetryTimer = null;
        const secondaryStopping = this._stopSecondaryEngines();
        this._stopSources();
        this.currentMode = null;
        this.plcStatus = { status: 'stopped', message: '采集器已停止', timestamp: Date.now() };
        this.collectorStatus = { ...this.collectorStatus, ...this.plcStatus };
        console.log('[DataEngine] 所有数据源已停止');
        return Promise.allSettled([secondaryStopping, this.alarmWritePending, this.metricWritePending]);
    }

    async restart() {
        console.log('[DataEngine] 正在重启数据引擎...');
        this.stop();
        const runVersion = this.runVersion;
        await new Promise(resolve => setTimeout(resolve, 500));
        if (runVersion !== this.runVersion) return;
        await this.start();
    }

    getStatus() {
        return {
            observedAt: Date.now(),
            configLoadedAt: this.configLoadedAt || null,
            configuredDevices: this.plcReader?.deviceStatus?.size ?? this.simulator?.devices?.length ?? 0,
            mode: this.currentMode,
            plcStatus: this.plcStatus,
            collectorStatus: this.collectorStatus,
            eventStorageStatus: { ...this.eventStorageStatus }
        };
    }

    getPointRuntimeValues(deviceId, points = []) {
        if (this.plcReader?.getPointRuntimeValues) {
            return this.plcReader.getPointRuntimeValues(deviceId, points);
        }

        const deviceStatus = (this.plcStatus?.devices || []).find(device => device.deviceId === deviceId) || null;
        return {
            deviceStatus,
            snapshotTimestamp: null,
            points: points.map(point => ({
                ...point,
                category_resolved: point.category || 'analog',
                field_name: point.value_role || point.name,
                plc_address: point.plc_tag || '',
                value: null,
                quality: deviceStatus?.quality || 'bad',
                lastReadAt: deviceStatus?.lastReadAt || null
            }))
        };
    }

    _normalizeMode(mode) {
        const value = String(mode || '').trim();
        return value === 'simulation' ? 'simulation' : 'integrated_plc';
    }

    _publishRealtimeData(deviceDataArray) {
        if (!Array.isArray(deviceDataArray) || deviceDataArray.length === 0) return;
        for (const device of deviceDataArray) {
            if (device?.furnace_id) this.deviceSnapshots.set(device.furnace_id, device);
        }
        const snapshots = [...this.deviceSnapshots.values()];

        this.collectorStatus = {
            ...this.collectorStatus,
            status: 'connected',
            message: `内置采集器数据正常 (${snapshots.length} 台设备)`,
            lastFrameAt: Date.now(),
            frames: this.collectorStatus.frames + 1,
            devices: snapshots.length
        };

        this._recordMetrics(snapshots).catch(e => {
            console.warn('[DataEngine] 指标快照写入失败:', e.message);
        });
        this._recordAlarmEvents(deviceDataArray).catch(() => {});
        this.wsServer.broadcastDeviceData(deviceDataArray);
    }

    _recordMetrics(deviceDataArray) {
        // A slow/unavailable database must not create one pending write per
        // snapshot interval. The next live frame retries after this write ends.
        if (this.metricWritePending) return Promise.resolve();
        const pending = this._writeMetrics(deviceDataArray);
        this.metricWritePending = pending.finally(() => {
            if (this.metricWritePending === tracked) this.metricWritePending = null;
        });
        const tracked = this.metricWritePending;
        return tracked;
    }

    async _writeMetrics(deviceDataArray) {
        const runVersion = this.runVersion;
        const now = Date.now();
        if (now - this.lastMetricSnapshotAt < this.metricSnapshotIntervalMs) return;
        this.lastMetricSnapshotAt = now;

        const db = await getDb();
        if (runVersion !== this.runVersion) return;
        const factoryId = this.activeFactoryId || 'factory_default';
        const totalDevices = deviceDataArray.length;
        const runningDevices = deviceDataArray.filter(d => !!d.status?.running).length;
        const alarmDevices = deviceDataArray.filter(d => !!d.status?.alarm).length;
        const onlineDevices = deviceDataArray.filter(d => this._deviceQuality(d) !== 'bad').length;
        const avgTemp = this._avg(deviceDataArray.map(d => Number(d.analog?.actual_temp)).filter(Number.isFinite));
        const currentOutput = Math.round(runningDevices * 180 + Math.max(0, avgTemp - 760));
        const dailyTarget = Math.max(totalDevices * 250, 1);
        const overallOee = totalDevices ? Math.max(0, Math.min(99.9, (runningDevices / totalDevices) * 92 - alarmDevices * 4)) : 0;
        const energyConsumption = Math.round((avgTemp || 0) * Math.max(runningDevices, 1) * 0.72);

        await db.run(`INSERT INTO metric_snapshots (
            factory_id, current_output, daily_target, overall_oee, energy_consumption,
            running_devices, alarm_devices, online_devices, total_devices
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            factoryId,
            currentOutput,
            dailyTarget,
            parseFloat(overallOee.toFixed(1)),
            energyConsumption,
            runningDevices,
            alarmDevices,
            onlineDevices,
            totalDevices
        ]);
        if (runVersion === this.runVersion) {
            this.lastMetricSavedAt = Date.now();
            this.metricSummary = { currentOutput, dailyTarget, overallOee: parseFloat(overallOee.toFixed(1)), energyConsumption, runningDevices, alarmDevices, onlineDevices, totalDevices };
        }
    }

    _recordAlarmEvents(deviceDataArray) {
        if (this.alarmStorageStopped) return Promise.resolve();
        try { assertNoPendingSiteRecovery(); }
        catch (error) { this._alarmStorageFailure(error, 'recovery'); return Promise.reject(error); }
        const factoryId = this.activeFactoryId || this.fixedFactoryId || 'factory_default';
        try {
            const records = [];
            for (const device of deviceDataArray) {
                if (!device.furnace_id || device.status?.alarm == null || ['bad', 'stale'].includes(device.quality?.status?.alarm)) continue;
                if (this.alarmState.has(device.furnace_id) && this.alarmState.get(device.furnace_id) === !!device.status.alarm) continue;
                records.push({ deviceId: String(device.furnace_id), deviceName: String(device.furnace_name || device.furnace_id).slice(0, 180),
                    alarm: !!device.status.alarm, quality: this._deviceQuality(device), occurredAt: Date.now() });
            }
            if (!records.length) return Promise.resolve();
            const outbox = this.alarmOutboxProvider();
            const added = outbox.record(factoryId, records);
            for (const record of records) this.alarmState.set(record.deviceId, record.alarm);
            this.eventStorageStatus.pendingEvents = outbox.pending(factoryId);
            // Unchanged samples never create pending Promise chains or retain
            // full PLC frames while the business database is blocked.
            if (!added || this.alarmWritePending || this.alarmRetryTimer) return Promise.resolve();
            return this._drainAlarmEvents();
        } catch (error) {
            this._alarmStorageFailure(error, 'journal');
            return Promise.reject(error);
        }
    }

    _alarmStorageFailure(error, stage) {
        const message = `${stage}: ${error.message}`;
        if (this.eventStorageStatus.lastError !== message) console.warn('[DataEngine] 报警事件持久化降级:', message);
        this.eventStorageStatus = { ...this.eventStorageStatus, status: 'error', lastError: message, failedAt: Date.now() };
    }

    _drainAlarmEvents() {
        if (this.alarmStorageStopped || this.alarmWritePending || this.alarmRetryTimer) return Promise.resolve();
        try { assertNoPendingSiteRecovery(); }
        catch (error) { this._alarmStorageFailure(error, 'recovery'); return Promise.reject(error); }
        const runVersion = this.runVersion;
        const factoryId = this.activeFactoryId || 'factory_default';
        let outbox;
        const pending = (async () => {
            outbox = this.alarmOutboxProvider();
            while (!this.alarmStorageStopped && runVersion === this.runVersion) {
                const batch = outbox.batch(factoryId, 32);
                if (!batch.length) break;
                const db = await getDb();
                for (const event of batch) {
                    if (this.alarmStorageStopped || runVersion !== this.runVersion) return;
                    const existing = await db.get('SELECT collector_event_id FROM event_logs WHERE collector_event_id = ?', [event.eventKey]);
                    if (this.alarmStorageStopped || runVersion !== this.runVersion) return;
                    if (existing?.collector_event_id !== event.eventKey) {
                        // The unique collector key handles a commit followed by
                        // a lost response/crash before the local acknowledgement.
                        await db.run(`INSERT INTO event_logs (
                            factory_id, event_type, level, source_id, title, message, value, quality, collector_event_id, occurred_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                            event.factoryId, 'alarm', event.alarm ? 'critical' : 'info', event.deviceId,
                            `${event.deviceName} ${event.alarm ? '报警触发' : '报警恢复'}`,
                            event.alarm ? '设备实时数据出现报警状态' : '报警状态已恢复', String(event.alarm), event.quality, event.eventKey,
                            new Date(event.occurredAt + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
                        ]);
                    }
                    outbox.acknowledge(event);
                }
                await new Promise(resolve => setImmediate(resolve));
            }
            this.alarmRetryCount = 0;
            this.eventStorageStatus = { status: 'healthy', pendingEvents: outbox.pending(factoryId), lastError: null, lastSavedAt: Date.now() };
        })().catch(error => {
            this._alarmStorageFailure(error, outbox ? 'delivery' : 'journal');
            if (!this.alarmStorageStopped && runVersion === this.runVersion) {
                const delay = Math.min(60000, 1000 * 2 ** Math.min(this.alarmRetryCount++, 6));
                this.alarmRetryTimer = setTimeout(() => {
                    this.alarmRetryTimer = null;
                    this._drainAlarmEvents().catch(() => {});
                }, delay);
                this.alarmRetryTimer.unref?.();
            }
            throw error;
        }).finally(() => {
            if (this.alarmWritePending === pending) this.alarmWritePending = null;
            if (!this.alarmStorageStopped && runVersion !== this.runVersion) this._drainAlarmEvents().catch(() => {});
        });
        this.alarmWritePending = pending;
        return pending;
    }

    _deviceQuality(deviceData) {
        const groups = deviceData.quality || {};
        const values = Object.values(groups).flatMap(group => Object.values(group || {}));
        if (values.includes('bad')) return 'bad';
        if (values.includes('stale')) return 'stale';
        return 'good';
    }

    _avg(values) {
        if (!values.length) return 0;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    async _startIntegratedPlcMode() {
        console.log('[DataEngine] 内置低延迟采集模式: PLC -> 后端采集器 -> WebSocket');
        const runVersion = this.runVersion;

        this.collectorStatus = {
            status: 'starting',
            message: '内置低延迟采集器正在启动',
            lastFrameAt: null,
            frames: 0,
            devices: 0
        };

        const plcReader = new PlcReader({ profile: 'low_latency', factoryId: this.activeFactoryId });
        this.plcReader = plcReader;
        await plcReader.start(
            (deviceDataArray) => {
                if (this.runVersion !== runVersion || this.plcReader !== plcReader) return;
                this._publishRealtimeData(deviceDataArray);
            },
            (statusInfo) => {
                if (this.runVersion !== runVersion || this.plcReader !== plcReader) return;
                this.plcStatus = statusInfo;
                this.collectorStatus = {
                    ...this.collectorStatus,
                    status: statusInfo.status,
                    message: statusInfo.message,
                    lastStatusAt: statusInfo.timestamp || Date.now()
                };
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }

    async _startSimulationMode() {
        console.log('[DataEngine] 模拟模式: 生成模拟数据 -> WebSocket');
        const runVersion = this.runVersion;

        const simulator = new Simulator({ factoryId: this.activeFactoryId });
        this.simulator = simulator;
        await simulator.start(
            (deviceDataArray) => {
                if (this.runVersion !== runVersion || this.simulator !== simulator) return;
                this._publishRealtimeData(deviceDataArray);
            },
            (statusInfo) => {
                if (this.runVersion !== runVersion || this.simulator !== simulator) return;
                this.plcStatus = statusInfo;
                this.collectorStatus = {
                    status: statusInfo.status,
                    message: statusInfo.message,
                    lastFrameAt: Date.now(),
                    frames: this.collectorStatus.frames,
                    devices: this.collectorStatus.devices
                };
                this.wsServer.broadcastStatus(statusInfo);
            }
        );
    }
}

module.exports = DataEngine;
