const { getDb, getDbStatus } = require('../db/database');
const PlcReader = require('./runtimeEngine').collectorAvailable() ? require('./plcReader') : null;
const Simulator = require('./simulator');
const { getAlarmOutbox } = require('./alarmOutbox');
const { assertNoPendingSiteRecovery } = require('./siteRecoveryIntent');
const { pointAlarmReadings, alarmEventValue } = require('./pointAlarm');
const { observedSamples } = require('./pointHistory');
const { DEFAULT_POLICY, readPolicy, readHistoryPoints, normalizePointPolicy, selectSamples, DAY_MS } = require('./historyPolicy');

class DataEngine {
    constructor(wsServer, options = {}) {
        this.wsServer = wsServer;
        this.fixedFactoryId = String(options.factoryId || '');
        this.isSecondary = options.isSecondary === true;
        this.displayOnly = options.displayOnly === true;
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
        this.historyWritePending=null;this.historyRetryTimer=null;this.historyStopped=false;
        this.historyStorageStatus={status:'idle',pendingSamples:0,lastError:null};
        this.historyJournalError=null;
        this.historyPolicy = { ...DEFAULT_POLICY };
        this.pointHistoryPolicies = new Map();
        this.runVersion = 0;
    }

    async start({ ownFactoryOnly = false } = {}) {
        assertNoPendingSiteRecovery();
        const runVersion = ++this.runVersion;
        this.alarmStorageStopped = false;
        this.historyStopped=false;
        clearTimeout(this.historyRetryTimer);this.historyRetryTimer=null;
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
        this._flushPointSamples().catch(()=>{});
        const factory = await db.get('SELECT collection_enabled FROM factories WHERE id = ?', [factoryId]);
        if (runVersion !== this.runVersion) return;
        if (Number(factory?.collection_enabled ?? 1) === 0) {
            if (this.displayOnly) this.currentMode = 'external';
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
        if (!await this._loadHistoryPolicies(db, factoryId, runVersion)) return;
        this._drainAlarmEvents().catch(() => {});

        const mode = this._normalizeMode(settings.data_mode);
        this.currentMode = mode;
        console.log(`\n[DataEngine] 启动，模式: ${mode}`);

        try {
            switch (mode) {
                case 'external':
                    this.plcStatus = { status: 'idle', message: '外部接口模式', timestamp: Date.now() };
                    this.collectorStatus = { status: 'idle', message: '外部接口模式', lastFrameAt: null, frames: 0, devices: 0 };
                    break;
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

    async _loadHistoryPolicies(db, factoryId, runVersion = this.runVersion) {
        const policy = await readPolicy(db, factoryId), points = await readHistoryPoints(db, factoryId);
        if (runVersion !== this.runVersion) return false;
        this.historyPolicy = policy;
        this.pointHistoryPolicies = new Map(points.map(p => [String(p.id), {
            ...normalizePointPolicy({mode:p.history_mode ?? 'recent',days:p.history_days ?? 30}), deviceId:String(p.device_id)
        }]));
        return true;
    }

    async _startSecondaryEngines(db, runVersion) {
        const factories = await db.all('SELECT id FROM factories');
        if (runVersion !== this.runVersion) return;
        const silentWs = { broadcastDeviceData() {}, broadcastStatus() {} };
        await Promise.all(factories.filter(factory => String(factory.id) !== this.activeFactoryId).map(async factory => {
            const id = String(factory.id);
            const engine = new DataEngine(silentWs, { factoryId: id, isSecondary: true, displayOnly: this.displayOnly });
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
            engine = new DataEngine({ broadcastDeviceData() {}, broadcastStatus() {} }, { factoryId: id, isSecondary: true, displayOnly: this.displayOnly });
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
        // Configuration reloads deliberately keep the running reader/timers;
        // retention policy must still refresh before the next sampling frame.
        if (!await source._loadHistoryPolicies(db, id)) return {factoryId:id,status:source.getStatus(),removedDeviceIds:[]};
        if (Number(factory?.collection_enabled ?? 1) !== 0 && source.currentMode === mode && source.plcReader) {
            await source.plcReader.reloadConfiguration(); source.configLoadedAt = Date.now();
        } else if (Number(factory?.collection_enabled ?? 1) !== 0 && source.currentMode === mode && mode === 'simulation' && source.simulator) {
            await source.simulator.reloadConfiguration(); source.configLoadedAt = Date.now();
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
        this.historyStopped=true;clearTimeout(this.historyRetryTimer);this.historyRetryTimer=null;
        clearTimeout(this.alarmRetryTimer);
        this.alarmRetryTimer = null;
        const secondaryStopping = this._stopSecondaryEngines();
        this._stopSources();
        this.currentMode = null;
        this.plcStatus = { status: 'stopped', message: '采集器已停止', timestamp: Date.now() };
        this.collectorStatus = { ...this.collectorStatus, ...this.plcStatus };
        console.log('[DataEngine] 所有数据源已停止');
        return Promise.allSettled([secondaryStopping, this.alarmWritePending, this.metricWritePending, this.historyWritePending]);
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
        const observedAt = Date.now();
        const simulationDevices = this.currentMode === 'simulation' ? this._simulationDeviceStatuses(observedAt) : null;
        return {
            observedAt,
            configLoadedAt: this.configLoadedAt || null,
            configuredDevices: simulationDevices ? simulationDevices.length : this.plcReader?.deviceStatus?.size ?? 0,
            mode: this.currentMode,
            plcStatus: simulationDevices ? { ...this.plcStatus, devices: simulationDevices } : this.plcStatus,
            collectorStatus: this.collectorStatus,
            eventStorageStatus: { ...this.eventStorageStatus },
            historyStorageStatus:{...this.historyStorageStatus,retention:'configured',policy:{...this.historyPolicy}}
        };
    }

    _simulationDeviceStatuses(observedAt) {
        const simulator = this.simulator;
        const interval = Number(simulator?.pollIntervalMs);
        const freshnessMs = Math.max(6000, (Number.isFinite(interval) && interval >= 100 && interval <= 60000 ? interval : 2000) * 3);
        const plcState = String(this.plcStatus?.status || '').toLowerCase();
        const collectorState = String(this.collectorStatus?.status || '').toLowerCase();
        const stopped = !simulator || simulator.stopped === true || ['stopped', 'stopping', 'disabled'].includes(plcState)
            || ['stopped', 'stopping', 'disabled'].includes(collectorState);
        const failed = ['error', 'offline', 'disconnected'].includes(plcState)
            || ['error', 'offline', 'disconnected', 'recovering', 'unresponsive'].includes(collectorState);
        const running = !stopped && !failed && ['simulating', 'connected'].includes(plcState);
        const seen = new Set();
        return (simulator?.devices || []).flatMap(device => {
            const deviceId = String(device?.id ?? '').trim();
            if (!deviceId || seen.has(deviceId)) return [];
            seen.add(deviceId);
            const stored = this.deviceSnapshots.get(deviceId);
            // A configured device is never assigned a different device's last
            // frame, and snapshot counts cannot identify which devices work.
            const snapshot = String(stored?.furnace_id ?? '') === deviceId ? stored : null;
            const rawTimestamp = snapshot?.timestamp;
            const timestamp = rawTimestamp == null || rawTimestamp === '' ? NaN : Number.isFinite(Number(rawTimestamp))
                ? Number(rawTimestamp) : Date.parse(rawTimestamp);
            const lastReadAt = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
            const qualityValues = Object.values(snapshot?.quality || {}).flatMap(group => Object.values(group || {}));
            const reportedQuality = snapshot ? this._deviceQuality(snapshot) : 'good';
            const quality = reportedQuality !== 'good' ? reportedQuality
                : !qualityValues.length || qualityValues.some(value => value !== 'good') ? 'unknown' : 'good';
            const stale = lastReadAt !== null && (lastReadAt > observedAt || observedAt - lastReadAt > freshnessMs);
            let status = 'starting', connectionQuality = 'unknown';
            if (stopped) { status = 'stopped'; connectionQuality = 'bad'; }
            else if (failed || snapshot?.status?.online === false || quality === 'bad') { status = 'error'; connectionQuality = 'bad'; }
            else if (stale || quality === 'stale') { status = 'stale'; connectionQuality = 'stale'; }
            else if (running && lastReadAt !== null && quality === 'good') { status = 'connected'; connectionQuality = 'good'; }
            return [{ deviceId, deviceName: String(device.name || deviceId), status, quality: connectionQuality, lastReadAt, freshnessMs }];
        });
    }

    getPointRuntimeValues(deviceId, points = []) {
        if (this.plcReader?.getPointRuntimeValues) {
            return { ...this.plcReader.getPointRuntimeValues(deviceId, points), sourceMode: this.currentMode };
        }

        const deviceStatus = (this.currentMode === 'simulation' ? this._simulationDeviceStatuses(Date.now()) : this.plcStatus?.devices || []).find(device => device.deviceId === deviceId) || null;
        const snapshot = this.deviceSnapshots?.get(deviceId);
        return {
            sourceMode: this.currentMode,
            deviceStatus,
            snapshotTimestamp: snapshot?.timestamp || null,
            points: points.map(point => {
                const category = point.category || 'analog', field = point.value_role || point.name;
                const reading = this.currentMode === 'simulation' ? snapshot?.simulationPoints?.[String(point.id)] : null;
                const value = this.currentMode === 'simulation' && snapshot?.simulationPoints
                    ? reading?.value ?? null : snapshot?.[category]?.[field] ?? null;
                const timestamp = new Date(reading?.timestamp || snapshot?.timestamp || 0).getTime();
                const sampleMs = this.currentMode === 'simulation' ? Math.max(Number(point.sample_interval_ms || 1000), this.simulator?.pollIntervalMs || 0) : Number(point.sample_interval_ms || 1000);
                const stale = !timestamp || Date.now() - timestamp > Math.max(6000, sampleMs * 3);
                return ({
                ...point,
                category_resolved: point.category || 'analog',
                field_name: point.value_role || point.name,
                plc_address: point.plc_tag || '',
                value,
                quality: value === null || snapshot?.status?.online === false ? 'bad' : stale ? 'stale' : reading?.quality || snapshot?.quality?.[category]?.[field] || deviceStatus?.quality || 'good',
                lastReadAt: value === null ? null : reading?.timestamp || snapshot?.timestamp || null,
                simulationManual: this.currentMode === 'simulation' && reading?.manual === true,
                simulationOverriddenAt: reading?.overriddenAt || null,
                sourceMode: this.currentMode
            }); })
        };
    }

    setSimulationPointValue(point, value, reset = false, factoryId = '') {
        const id = String(factoryId || this.activeFactoryId || ''), source = id === this.activeFactoryId ? this : this.factoryEngines.get(id);
        if (!source || source.currentMode !== 'simulation' || !source.simulator || source.simulator.stopped) throw new Error('仅运行中的模拟模式允许修改模拟值；不会写入 PLC');
        return source.simulator.setPointValue(point, value, reset);
    }

    _normalizeMode(mode) {
        const value = String(mode || '').trim();
        if (value === 'external' || this.displayOnly && value !== 'simulation') return 'external';
        return value === 'simulation' ? 'simulation' : 'integrated_plc';
    }

    _publishRealtimeData(deviceDataArray) {
        if (!Array.isArray(deviceDataArray) || deviceDataArray.length === 0) return;
        if(!this.historyStopped && ['simulation','integrated_plc'].includes(this.currentMode)) {
            try {
                const records=selectSamples(observedSamples(this.activeFactoryId || this.fixedFactoryId || 'factory_default',deviceDataArray,this.currentMode),this.historyPolicy,this.pointHistoryPolicies);
                if(records.length){this.alarmOutboxProvider().recordSamples(this.activeFactoryId || this.fixedFactoryId || 'factory_default',records);this.historyJournalError=null;this._flushPointSamples().catch(()=>{});}
            } catch(error){this.historyJournalError=error.message;this.historyStorageStatus={status:'error',stage:'journal',pendingSamples:this.historyStorageStatus.pendingSamples,lastError:error.message};console.warn('[PointHistory] 原始采样持久记录失败:',error.message);}
        }
        for (const device of deviceDataArray) {
            const pointAlarms = pointAlarmReadings(device);
            if (pointAlarms.length) {
                const active = pointAlarms.some(point => point.alarm === true);
                const unknown = pointAlarms.some(point => point.alarm === null);
                device.alarmSummary = { active: active ? true : unknown ? null : false, quality: !active && unknown ? 'stale' : 'good' };
                // A configured status.alarm is also a raw point reading; don't overwrite
                // it with an aggregate boolean (e.g. an inverted =0 or numeric threshold).
                if (!device.pointMeta?.['status.alarm']) {
                    device.status = { ...device.status, alarm: device.alarmSummary.active };
                    device.quality = { ...device.quality, status: { ...device.quality?.status, alarm: device.alarmSummary.quality } };
                }
            }
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

    _flushPointSamples() {
        if(this.historyStopped)return Promise.resolve();
        if(this.historyWritePending)return this.historyWritePending;
        const factoryId=this.activeFactoryId || this.fixedFactoryId || 'factory_default';
        const tracked=(async()=>{
            const journal=this.alarmOutboxProvider();
            if(typeof journal.sampleBatch!=='function')return;
            try {
                for(let batch=0;batch<16 && !this.historyStopped;batch++) {
                    const records=journal.sampleBatch(factoryId,128);if(!records.length)break;
                    const db=await getDb();
                    await db.transaction(async tx=>{
                        const existing=new Set((await tx.all(`SELECT sample_key FROM point_samples WHERE sample_key IN (${records.map(()=>'?').join(',')})`,records.map(r=>r.sampleKey))).map(r=>r.sample_key));
                        const missing=records.filter(r=>!existing.has(r.sampleKey));if(!missing.length)return;
                        await tx.run(`INSERT INTO point_samples (sample_key,factory_id,device_id,point_id,point_key,point_name,unit,source_mode,sampled_at,value_json,value_number,quality,retention_until)
                            VALUES ${missing.map(()=>'(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,missing.flatMap(r=>[r.sampleKey,r.factoryId,r.deviceId,r.pointId,r.pointKey,r.pointName,r.unit,r.sourceMode,r.sampledAt,r.valueJson,r.valueNumber,r.quality,r.retentionUntil ?? null]));
                    });
                    for(const record of records)journal.acknowledgeSample(record);
                    await new Promise(resolve=>setImmediate(resolve));
                }
                this.historyStorageStatus=this.historyJournalError?{status:'error',stage:'journal',pendingSamples:journal.pendingSamples(factoryId),lastError:this.historyJournalError}:{status:'healthy',pendingSamples:journal.pendingSamples(factoryId),lastError:null};
            }catch(error){this.historyStorageStatus={status:'error',pendingSamples:journal.pendingSamples(factoryId),lastError:error.message};}
            finally {
                if(!this.historyStopped && (this.historyStorageStatus.pendingSamples || this.historyStorageStatus.status==='error')) {
                    clearTimeout(this.historyRetryTimer);this.historyRetryTimer=setTimeout(()=>{this.historyRetryTimer=null;this._flushPointSamples().catch(()=>{});},this.historyStorageStatus.status==='error'?3000:10);this.historyRetryTimer.unref?.();
                }
            }
        })().finally(()=>{if(this.historyWritePending===tracked)this.historyWritePending=null;});
        this.historyWritePending=tracked;return tracked;
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

        if (this.historyPolicy.metricMode !== 'off') await db.run(`INSERT INTO metric_snapshots (
            factory_id, current_output, daily_target, overall_oee, energy_consumption,
            running_devices, alarm_devices, online_devices, total_devices, retention_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            factoryId,
            currentOutput,
            dailyTarget,
            parseFloat(overallOee.toFixed(1)),
            energyConsumption,
            runningDevices,
            alarmDevices,
            onlineDevices,
            totalDevices,
            this.historyPolicy.metricMode === 'permanent' ? null : now + this.historyPolicy.metricDays * DAY_MS
        ]);
        if (runVersion === this.runVersion) {
            if (this.historyPolicy.metricMode !== 'off') this.lastMetricSavedAt = Date.now();
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
                if (!device.furnace_id) continue;
                const pointAlarms = pointAlarmReadings(device);
                if (pointAlarms.length) {
                    records.push(...pointAlarms.filter(point => point.alarm !== null));
                    continue; // No duplicate device-total event for configured trigger points.
                }
                if (!device.furnace_id || device.status?.alarm == null || ['bad', 'stale'].includes(device.quality?.status?.alarm)) continue;
                if (this.alarmState.has(device.furnace_id) && this.alarmState.get(device.furnace_id) === !!device.status.alarm) continue;
                records.push({ deviceId: String(device.furnace_id), deviceName: String(device.furnace_name || device.furnace_id).slice(0, 180),
                    alarm: !!device.status.alarm, quality: this._deviceQuality(device), occurredAt: Date.now() });
            }
            if (!records.length) return Promise.resolve();
            const outbox = this.alarmOutboxProvider();
            const added = outbox.record(factoryId, records);
            for (const record of records) if (!record.pointId) this.alarmState.set(record.deviceId, record.alarm);
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
                    const value = event.pointId ? alarmEventValue(event) : String(event.alarm);
                    if (event.pointId && !event.alarm) {
                        // Keep the original trigger record complete as well as the recovery event.
                        // Replays are idempotent after a lost acknowledgement.
                        await db.run('UPDATE event_logs SET value=? WHERE factory_id=? AND collector_event_id=?',
                            [value, event.factoryId, event.occurrenceId]);
                    }
                    if (existing?.collector_event_id !== event.eventKey) {
                        // The unique collector key handles a commit followed by
                        // a lost response/crash before the local acknowledgement.
                        await db.run(`INSERT INTO event_logs (
                            factory_id, event_type, level, source_id, title, message, value, quality, collector_event_id, occurred_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                            event.factoryId, 'alarm', event.alarm ? 'critical' : 'info', event.deviceId,
                            `${event.deviceName} ${event.alarm ? '报警触发' : '报警恢复'}`.slice(0, 255),
                            event.pointId ? event.alarmText : event.alarm ? '设备实时数据出现报警状态' : '报警状态已恢复',
                            value, event.quality, event.eventKey,
                            new Date(event.occurredAt + ((getDbStatus?.().type || 'sqlite') === 'sqlite' ? 0 : 8 * 3600000)).toISOString().slice(0, 19).replace('T', ' ')
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
        if (this.displayOnly) throw new Error('请先安装采集插件');
        if (!PlcReader) throw new Error('采集插件实现缺失');
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
