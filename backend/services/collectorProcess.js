'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const bounded = (value, fallback, min, max) => value !== undefined && value !== null
    && String(value).trim() !== '' && Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;

// API-side facade. Only the worker loads PLC drivers, simulation and alarm
// storage. A crashed, stuck or memory-limited worker never exits the API.
class CollectorProcess {
    constructor(wsServer, options = {}) {
        this.wsServer = wsServer;
        this.options = options;
        this.child = null;
        this.pending = new Map();
        this.pendingBytes = 0;
        this.sequence = 0;
        this.wanted = false;
        this.closed = false;
        this.operation = Promise.resolve();
        this.queued = 0;
        this.restartPromise = null;
        this.restartRequested = false;
        this.retry = null;
        this.watchdog = null;
        this.failures = 0;
        this.restartCount = 0;
        this.snapshots = new Map();
        this.snapshotBytes = 0;
        this.factories = {};
        this.state = { mode: null, plcStatus: { status: 'idle', message: '独立采集进程未启动' },
            collectorStatus: { status: 'idle', lastFrameAt: null }, eventStorageStatus: { status: 'idle' } };
        this.processStatus = { isolation: 'child_process', status: 'idle', pid: null, restartCount: 0, lastError: null };
        this.heartbeatTimeout = bounded(options.heartbeatTimeoutMs ?? process.env.COLLECTOR_HEARTBEAT_TIMEOUT_MS, 15000, 1500, 120000);
        this.startTimeout = bounded(options.startTimeoutMs ?? process.env.COLLECTOR_START_TIMEOUT_MS, 45000, 1000, 120000);
    }

    _enqueue(work) {
        if (this.queued >= 64) return Promise.reject(new Error('Collector control queue is busy'));
        this.queued++;
        const operation = this.operation.then(work);
        this.operation = operation.catch(() => {}).finally(() => { this.queued--; });
        return operation;
    }
    start() {
        if (this.closed) return Promise.reject(new Error('Collector supervisor is shut down'));
        return this._enqueue(async () => {
            if (this.closed) return;
            this.wanted = true;
            clearTimeout(this.retry); this.retry = null;
            if (!this.child) await this._launch();
        });
    }
    stop() {
        this.wanted = false;
        this.restartRequested = false;
        clearTimeout(this.retry); this.retry = null;
        return this._enqueue(async () => {
            this.wanted = false;
            await this._stopChild();
            this._offline('stopped', '独立采集进程已停止');
        });
    }
    restart() {
        if (this.closed) return Promise.reject(new Error('Collector supervisor is shut down'));
        if (this.restartPromise) {
            this.restartRequested = true;
            return this.restartPromise;
        }
        const operation = this._enqueue(async () => {
            do {
                if (this.closed) return;
                this.restartRequested = false;
                clearTimeout(this.retry); this.retry = null;
                this.wanted = true;
                await this._stopChild();
                await this._launch();
                // Changes arriving while the worker loads configuration need
                // one latest-state pass, not one new process per saved point.
            } while (this.restartRequested && this.wanted && !this.closed);
        });
        const tracked = operation.finally(() => {
            if (this.restartPromise === tracked) this.restartPromise = null;
        });
        this.restartPromise = tracked;
        return tracked;
    }
    async dispose() {
        // Final service shutdown is not a temporary database-maintenance stop.
        // Cancel delayed configuration restarts and stop without waiting behind
        // a control queue whose startup may be blocked on an unavailable DB.
        this.closed = true;
        this.wanted = false;
        this.restartRequested = false;
        clearTimeout(this.retry); this.retry = null;
        await this._stopChild();
        this._offline('stopped', '独立采集进程已关闭');
    }
    getStatus() { return { ...this.state, process: { ...this.processStatus, lastHeartbeatAt: this.lastMessageAt || null,
        heartbeatTimeoutMs: this.heartbeatTimeout, pendingCommands: this.queued } }; }
    getFactoryStatuses() { return this.factories; }
    reloadFactoryConfiguration(factoryId) {
        return this._enqueue(async () => {
            if (this.closed || this.processStatus.status !== 'running') throw new Error('Collector unavailable');
            const result = await this._rpc('reloadFactory', { factoryId:String(factoryId) });
            for (const id of result.removedDeviceIds || []) {
                const previous = this.snapshots.get(id);
                if (previous) { this.snapshotBytes -= Buffer.byteLength(JSON.stringify(previous)); this.snapshots.delete(id); }
            }
            return result;
        });
    }
    setFactoryCollectionEnabled(factoryId) {
        return this._enqueue(async () => {
            if (this.closed || this.processStatus.status !== 'running') throw new Error('Collector unavailable');
            return this._rpc('factoryCollection', { factoryId: String(factoryId) });
        });
    }
    async getPointRuntimeValues(deviceId, points = [], factoryId = '') {
        try {
            if (this.processStatus.status !== 'running') throw new Error('Collector unavailable');
            return await this._rpc('points', { deviceId, points, factoryId }, 2000);
        } catch {
            return { deviceStatus: { deviceId, status: 'offline', quality: 'bad' }, snapshotTimestamp: null,
                points: points.map(point => ({ ...point, value: null, quality: 'bad', lastReadAt: null })) };
        }
    }

    setSimulationPointValue(point, value, reset = false, factoryId = '') {
        return this._enqueue(async () => {
            if (this.closed || this.processStatus.status !== 'running') throw new Error('模拟运行进程未连接');
            return this._rpc('simulationPoint', { point, value, reset, factoryId }, 3000);
        });
    }

    _offline(status, message) {
        this.processStatus.status = status;
        this.state = { ...this.state, mode: null,
            plcStatus: { status: status === 'stopped' ? 'stopped' : 'error', message, timestamp: Date.now() },
            collectorStatus: { ...this.state.collectorStatus, status, message, lastFrameAt: null } };
        for (const [id, value] of Object.entries(this.factories)) {
            this.factories[id] = { ...value, mode: null, plcStatus: this.state.plcStatus,
                collectorStatus: { ...value.collectorStatus, status, lastFrameAt: null } };
        }
        const invalid = [...this.snapshots.values()].map(device => ({ ...device,
            connectionStatusTimestamp: Date.now(),
            status: { ...device.status, online:false },
            quality: Object.fromEntries(['analog', 'status', 'digital'].map(group => [group,
                Object.fromEntries(Object.keys(device[group] || {}).map(key => [key, 'bad']))])) }));
        this.snapshots.clear();
        this.snapshotBytes = 0;
        this.lastPlcStatus = '';
        let batch = [], batchBytes = 0;
        for (const device of invalid) {
            const bytes = Buffer.byteLength(JSON.stringify(device));
            if (batch.length && batchBytes + bytes > 2 * 1024 * 1024) {
                this.wsServer.broadcastDeviceData(batch); batch = []; batchBytes = 0;
            }
            batch.push(device); batchBytes += bytes;
        }
        if (batch.length) this.wsServer.broadcastDeviceData(batch);
        this.wsServer.broadcastStatus(this.state.plcStatus);
    }
    _rpc(method, payload, timeoutMs = this.startTimeout) {
        const child = this.child;
        if (!child?.connected || this.pending.size >= 64) return Promise.reject(new Error('Collector unavailable or busy'));
        const id = ++this.sequence, message = { type: 'request', id, method, payload };
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (bytes > MAX_MESSAGE_BYTES || this.pendingBytes + bytes > 8 * 1024 * 1024) return Promise.reject(new Error('Collector request too large or busy'));
        return new Promise((resolve, reject) => {
            const finish = (error, result) => {
                const pending = this.pending.get(id);
                if (!pending) return;
                clearTimeout(pending.timer); this.pending.delete(id);
                this.pendingBytes -= pending.bytes;
                error ? reject(error) : resolve(result);
            };
            const timer = setTimeout(() => finish(new Error(`Collector ${method} timed out`)), timeoutMs);
            this.pendingBytes += bytes;
            this.pending.set(id, { timer, finish, bytes });
            try { child.send(message, error => { if (error) finish(error); }); }
            catch (error) { finish(error); }
        });
    }
    async _launch() {
        if (this.closed) throw new Error('Collector supervisor is shut down');
        clearTimeout(this.retry); this.retry = null;
        this._offline('starting', '独立采集进程正在启动');
        const env = { ...(this.options.env || process.env), COLLECTOR_DATABASE_CONNECT_ONLY: 'true' };
        for (const key of ['ADMIN_API_TOKEN', 'MCP_API_TOKEN', 'DESKTOP_SHUTDOWN_TOKEN', 'NODE_OPTIONS']) delete env[key];
        const memory = bounded(process.env.COLLECTOR_MEMORY_MB, 256, 128, 2048);
        this.startedAt = Date.now();
        let child;
        try { child = fork(this.options.workerFile || path.join(__dirname, 'collectorWorker.cjs'), [], {
            env, execArgv: [`--max-old-space-size=${memory}`], windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        }); } catch (error) {
            this.processStatus.lastError = error.message;
            this._offline('recovering', '无法启动独立采集进程，自动恢复中');
            this._scheduleRestart();
            throw error;
        }
        this.child = child;
        this.startedAt = Date.now();
        this.lastMessageAt = Date.now();
        this.processStatus = { ...this.processStatus, status: 'starting', pid: child.pid || null };
        child.stdout.pipe(process.stdout, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
        child.on('message', message => {
            if (this.child !== child || !message) return;
            if (message.type === 'response') {
                this.pending.get(message.id)?.finish(message.error ? new Error(message.error) : null, message.result);
            } else if (message.type === 'telemetry' && message.status && this.processStatus.status !== 'stopping') {
                this.state = message.status;
                this.factories = message.factories || {};
                this.processStatus.droppedSamples = Number(message.diagnostics?.droppedSamples || 0);
                this.processStatus.memoryRssBytes = Number(message.diagnostics?.memoryRssBytes) || null;
                this.processStatus.eventLoopLagMs = Number(message.diagnostics?.eventLoopLagMs) || 0;
                const devices = Array.isArray(message.devices) ? message.devices : [];
                const newest = Math.max(0, ...devices.map(d => Number(d.timestamp) || 0));
                if (newest) this.processStatus.telemetryDelayMs = Math.max(0, Date.now() - newest);
                for (const device of devices) {
                    if (!device?.furnace_id) continue;
                    const bytes = Buffer.byteLength(JSON.stringify(device));
                    const previous = this.snapshots.get(device.furnace_id);
                    const before = previous ? Buffer.byteLength(JSON.stringify(previous)) : 0;
                    if ((!previous && this.snapshots.size >= 10000) || this.snapshotBytes - before + bytes > 8 * 1024 * 1024) continue;
                    this.snapshots.set(device.furnace_id, device);
                    this.snapshotBytes += bytes - before;
                }
                if (devices.length) this.wsServer.broadcastDeviceData(devices);
                const signature = JSON.stringify(this.state.plcStatus);
                if (signature !== this.lastPlcStatus) {
                    this.lastPlcStatus = signature;
                    this.wsServer.broadcastStatus(this.state.plcStatus);
                }
            } else if (message.type !== 'online') return;
            this.lastMessageAt = Date.now();
        });
        child.once('exit', (code, signal) => this._exited(child, new Error(`Collector exited (${signal || code})`)));
        child.on('error', error => {
            if (this.child !== child) return;
            if (!child.pid) { this._exited(child, error); return; }
            // An IPC/kill error does not prove that the process has exited.
            // Keep ownership until exit; never launch a duplicate PLC reader.
            this.processStatus.lastError = error.message;
            this._offline('unresponsive', '采集进程通信异常，等待独立恢复');
            console.error('[CollectorProcess] Child process error:', error.message);
        });
        this.watchdog = setInterval(() => {
            if (this.child !== child || Date.now() - this.lastMessageAt <= this.heartbeatTimeout) return;
            this.processStatus.lastError = 'Collector heartbeat timeout';
            this._offline('unresponsive', '采集进程无响应，正在独立恢复；管理接口继续运行');
            this._kill(child);
        }, Math.min(1000, this.heartbeatTimeout / 2));
        this.watchdog.unref?.();
        try {
            await this._rpc('start');
            if (this.child !== child) throw new Error('Collector exited during startup');
            this.processStatus = { ...this.processStatus, status: 'running', lastError: null, startedAt: this.startedAt };
            this.processStatus.retryAt = null;
        } catch (error) {
            this.processStatus.lastError = error.message;
            await this._stopChild();
            this._scheduleRestart();
            throw error;
        }
    }
    _exited(child, error) {
        if (this.child !== child) return;
        clearInterval(this.watchdog); this.watchdog = null;
        this.child = null;
        this.processStatus.pid = null;
        this.processStatus.lastError = error.message;
        for (const pending of [...this.pending.values()]) pending.finish(error);
        this._offline(this.wanted ? 'recovering' : 'stopped', this.wanted
            ? '采集进程已退出，自动恢复中；管理接口继续运行' : '独立采集进程已停止');
        this._scheduleRestart();
    }
    _scheduleRestart() {
        if (!this.wanted || this.retry) return;
        if (Date.now() - this.startedAt > 60000) this.failures = 0;
        const delay = Math.min(30000, (this.options.retryDelayMs || 1000) * 2 ** Math.min(this.failures++, 5));
        this.processStatus.retryAt = Date.now() + delay;
        this.retry = setTimeout(() => {
            this.retry = null;
            if (!this.wanted) return;
            this.restartCount++;
            this.processStatus.restartCount = this.restartCount;
            this._enqueue(async () => { if (this.wanted && !this.child) await this._launch(); }).catch(error => {
                console.warn('[CollectorProcess] Recovery failed:', error.message);
                this._scheduleRestart();
            });
        }, delay);
        this.retry.unref?.();
    }
    _kill(child) {
        try { child.kill('SIGKILL'); }
        catch (error) {
            this.processStatus.lastError = `Cannot stop collector: ${error.message}`;
            console.error('[CollectorProcess]', this.processStatus.lastError);
        }
    }
    async _stopChild() {
        const child = this.child;
        if (!child) return;
        clearInterval(this.watchdog); this.watchdog = null;
        this._offline('stopping', '独立采集进程正在安全停止');
        // Resolve only after the process and its database connection have gone.
        // Database restore/switch callers must not race a still-writing worker.
        const closed = new Promise(resolve => child.once('close', resolve));
        try { if (child.connected) child.send({ type: 'request', method: 'stop' }, () => {}); }
        catch { /* kill below */ }
        let timer;
        const forced = new Promise(resolve => { timer = setTimeout(() => { this._kill(child); resolve('forced'); }, 7500); });
        const result = await Promise.race([closed, forced]);
        clearTimeout(timer);
        if (result === 'forced') {
            let deadline;
            try { await Promise.race([closed, new Promise((_, reject) => {
                deadline = setTimeout(() => reject(new Error('Collector did not stop; database maintenance refused')), 2000);
            })]); } finally { clearTimeout(deadline); }
        }
    }
}
module.exports = CollectorProcess;
