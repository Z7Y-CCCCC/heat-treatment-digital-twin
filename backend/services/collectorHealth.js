'use strict';

// Read-only presentation of observed telemetry, never a desired-state switch.
// Worker liveness, per-device data quality, and display connectivity are distinct.
function collectorHealth(engine = {}, factories = {}, { now = Date.now(), databaseReady = true } = {}) {
    const proc = engine.process || {};
    const age = timestamp => Number(timestamp) > 0 ? Math.max(0, now - Number(timestamp)) : null;
    const heartbeatAgeMs = age(proc.lastHeartbeatAt);
    const processRunning = proc.status === 'running' && (heartbeatAgeMs === null || heartbeatAgeMs <= (proc.heartbeatTimeoutMs || 15000));
    const sources = Object.entries(factories).length ? Object.entries(factories) : [['', engine]];
    const summaries = sources.map(([factoryId, source]) => {
        const mode = source.mode, status = source.collectorStatus || {};
        const devices = (source.plcStatus?.devices || []).map(device => {
            const sampleAgeMs = age(device.lastReadAt);
            const freshMs = Math.max(15000, ...((device.intervals || []).map(Number).filter(Number.isFinite).map(n => n * 3)));
            let state = device.status === 'disabled' ? 'disabled' : ['idle', 'connecting'].includes(device.status) && !device.lastReadAt ? 'pending'
                : device.status === 'connected' && device.quality === 'good' && sampleAgeMs !== null && sampleAgeMs <= freshMs ? 'normal' : 'abnormal';
            if (!processRunning && state !== 'disabled') state = 'abnormal';
            return { deviceId: device.deviceId, name: device.deviceName || device.name || device.deviceId,
                state, status: device.status, quality: device.quality, lastReadAt: device.lastReadAt || null, sampleAgeMs,
                scanMs: Number.isFinite(device.lastReadDurationMs) ? device.lastReadDurationMs : null,
                normalPoints: device.normalPoints ?? null, abnormalPoints: device.abnormalPoints ?? null,
                message: device.message || '', nextRetryAt: device.nextRetryAt || null };
        });
        const counts = { normal: 0, abnormal: 0, pending: 0, disabled: 0 };
        devices.forEach(d => counts[d.state]++);
        const active = devices.length - counts.disabled;
        let state = mode === 'external' ? 'external' : status.status === 'stopped' ? 'paused' : mode === 'simulation' ? 'simulation'
            : !active ? 'idle' : counts.abnormal ? 'degraded' : counts.pending ? 'starting' : 'healthy';
        if (['error','offline','unresponsive'].includes(status.status) || source.eventStorageStatus?.status === 'error') state = 'degraded';
        if (mode === 'simulation' && (age(status.lastFrameAt) === null || age(status.lastFrameAt) > 15000)) state = 'starting';
        if (source.plcStatus?.status === 'no_devices' || mode === 'simulation' && source.configuredDevices === 0) state = 'idle';
        return { factoryId, mode, state, counts, devices, lastSampleAt: status.lastFrameAt || null,
            lastSampleAgeMs: age(status.lastFrameAt), configLoadedAt: source.configLoadedAt || null };
    });
    const counts = summaries.reduce((sum, f) => { for (const k of Object.keys(sum)) sum[k] += f.counts[k]; return sum; }, { normal: 0, abnormal: 0, pending: 0, disabled: 0 });
    let state = 'healthy', label = '采集正常', reason = '';
    if (!databaseReady) { state = 'degraded'; label = '数据库异常'; reason = '配置或历史存储不可用'; }
    else if (engine.plugin?.installed === false) {
        state = summaries.some(f => f.mode === 'simulation') ? 'simulation' : 'not_installed';
        label = state === 'simulation' ? '模拟演示运行中' : '外部接口模式';
    }
    else if (!processRunning) {
        state = ['starting', 'recovering'].includes(proc.status) ? 'starting' : proc.status === 'stopped' ? 'stopped' : 'offline';
        label = { starting: '采集进程恢复中', stopped: '采集已停止', offline: '采集进程未连接' }[state];
        reason = heartbeatAgeMs > (proc.heartbeatTimeoutMs || 15000) ? '心跳超时' : '';
    } else if (summaries.some(f => f.state === 'degraded') || engine.eventStorageStatus?.status === 'error') {
        state = 'degraded'; label = counts.normal ? '部分采集异常' : '采集异常'; reason = counts.abnormal ? `${counts.abnormal} 台设备异常${counts.normal ? '，其余设备继续采集' : ''}` : '采集任务或历史存储异常';
    } else if (Number(proc.eventLoopLagMs) > 250) { state = 'degraded'; label = '采集调度延迟'; }
    else if (summaries.every(f => f.state === 'paused')) { state = 'paused'; label = '工厂采集已暂停'; }
    else if (summaries.every(f => ['paused', 'idle', 'external'].includes(f.state)) && summaries.some(f => f.state === 'external')) { state = 'external'; label = '外部接口模式'; }
    else if (summaries.every(f => ['paused', 'idle'].includes(f.state))) { state = 'idle'; label = '等待设备配置'; }
    else if (summaries.some(f => f.state === 'starting')) { state = 'starting'; label = '正在连接设备'; }
    else if (summaries.some(f => f.mode === 'simulation')) { state = 'simulation'; label = '模拟演示运行中'; }
    const lastSampleAt = Math.max(0, ...summaries.map(f => Number(f.lastSampleAt) || 0)) || null;
    return { observedAt: now, state, label, reason, processRunning, counts, lastSampleAt, lastSampleAgeMs: age(lastSampleAt),
        process: { status: proc.status || 'idle', pid: proc.pid || null, uptimeMs: processRunning && proc.startedAt ? age(proc.startedAt) : null,
            heartbeatAgeMs, restartCount: proc.restartCount || 0, memoryRssBytes: proc.memoryRssBytes ?? null,
            eventLoopLagMs: proc.eventLoopLagMs ?? null, telemetryDelayMs: proc.telemetryDelayMs ?? null }, factories: summaries };
}
module.exports = { collectorHealth };
