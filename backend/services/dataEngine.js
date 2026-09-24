const { getDb } = require('../db/database');
const PlcReader = require('./plcReader');
const Simulator = require('./simulator');

class DataEngine {
    constructor(wsServer) {
        this.wsServer = wsServer;
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
        this.alarmWriteQueue = Promise.resolve();
        this.deviceSnapshots = new Map();
        this.lastMetricSnapshotAt = 0;
        this.metricSnapshotIntervalMs = 5000;
        this.runVersion = 0;
    }

    async start() {
        const runVersion = ++this.runVersion;
        this._stopSources();
        this.deviceSnapshots.clear();
        this.alarmState.clear();
        this.lastMetricSnapshotAt = 0;
        this.currentMode = null;
        const db = await getDb();
        if (runVersion !== this.runVersion) return;
        const activeFactory = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
        this.activeFactoryId = String(activeFactory?.value || 'factory_default');
        const rows = await db.all('SELECT * FROM settings');
        if (runVersion !== this.runVersion) return;
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });
        const factoryRows = await db.all('SELECT `key`, value FROM factory_settings WHERE factory_id = ?', [this.activeFactoryId]);
        factoryRows.forEach(row => { settings[row.key] = row.value; });

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
    }

    stop() {
        this.runVersion += 1;
        this._stopSources();
        this.currentMode = null;
        this.plcStatus = { status: 'stopped', message: '采集器已停止', timestamp: Date.now() };
        this.collectorStatus = { ...this.collectorStatus, ...this.plcStatus };
        console.log('[DataEngine] 所有数据源已停止');
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
            mode: this.currentMode,
            plcStatus: this.plcStatus,
            collectorStatus: this.collectorStatus
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
        this._recordAlarmEvents(deviceDataArray).catch(e => {
            console.warn('[DataEngine] 事件履历写入失败:', e.message);
        });
        this.wsServer.broadcastDeviceData(deviceDataArray);
    }

    async _recordMetrics(deviceDataArray) {
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
    }

    _recordAlarmEvents(deviceDataArray) {
        const runVersion = this.runVersion;
        const pending = this.alarmWriteQueue.then(() => this._writeAlarmEvents(deviceDataArray, runVersion));
        this.alarmWriteQueue = pending.catch(() => {});
        return pending;
    }

    async _writeAlarmEvents(deviceDataArray, runVersion) {
        if (runVersion !== this.runVersion) return;
        const db = await getDb();
        if (runVersion !== this.runVersion) return;
        const activeFactory = await db.get('SELECT value FROM settings WHERE `key` = ?', ['active_factory_id']);
        const factoryId = String(activeFactory?.value || 'factory_default');
        for (const deviceData of deviceDataArray) {
            if (runVersion !== this.runVersion) return;
            const id = deviceData.furnace_id;
            if (!id || deviceData.status?.alarm === null || deviceData.status?.alarm === undefined
                || ['bad', 'stale'].includes(deviceData.quality?.status?.alarm)) continue;
            const alarm = !!deviceData.status?.alarm;
            const previous = this.alarmState.get(id) || false;

            if (alarm !== previous) {
                await db.run(`INSERT INTO event_logs (
                    factory_id, event_type, level, source_id, title, message, value, quality
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                    factoryId,
                    'alarm',
                    alarm ? 'critical' : 'info',
                    id,
                    alarm ? `${deviceData.furnace_name || id} 报警触发` : `${deviceData.furnace_name || id} 报警恢复`,
                    alarm ? '设备实时数据出现报警状态' : '报警状态已恢复',
                    String(alarm),
                    this._deviceQuality(deviceData)
                ]);
                if (runVersion === this.runVersion) this.alarmState.set(id, alarm);
            }
        }
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
