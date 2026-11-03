// Collection quality, not equipment alarms/production status. Only compact
// counters and timestamps leave this module; no PLC endpoints or credentials.
const timestamp = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const maxTime = values => values.reduce((latest, value) => Math.max(latest || 0, timestamp(value) || 0), 0) || null;
function summarizeFactoryCollection(factory, devices, runtime, processStatus, now = Date.now()) {
    const enabled = Number(factory.collection_enabled ?? 1) !== 0;
    const mode = runtime?.mode || String(factory.mode || 'integrated_plc');
    const targets = mode === 'simulation' ? devices : devices.filter(device => Number(device.plc_enabled) !== 0);
    const result = { factoryId: String(factory.id), collectionEnabled: enabled, mode, status: 'starting',
        totalDevices: targets.length, normalDevices: 0, abnormalDevices: 0, pendingDevices: 0, lastReadAt: null };
    const states = new Map((runtime?.plcStatus?.devices || []).map(device => [String(device.deviceId || device.id), device]));
    result.lastReadAt = mode === 'simulation' ? timestamp(runtime?.collectorStatus?.lastFrameAt) : maxTime([...states.values()].map(device => device.lastReadAt));
    if (!enabled) { result.status = 'disabled'; return result; }
    if (!devices.length) { result.status = 'no_devices'; return result; }
    if (!targets.length) { result.status = 'unconfigured'; return result; }
    const observed = timestamp(runtime?.observedAt);
    const fresh = observed !== null && now - observed >= -5000 && now - observed <= 15000;
    if (!runtime || !processStatus || ['idle', 'starting'].includes(processStatus)) {
        result.pendingDevices = targets.length; return result;
    }
    if (processStatus !== 'running' || !fresh || ['error', 'stopped', 'recovering', 'unresponsive'].includes(runtime.collectorStatus?.status)) {
        result.status = 'unavailable'; result.abnormalDevices = targets.length; return result;
    }
    if (mode === 'simulation') {
        const frame = result.lastReadAt;
        // A recent worker heartbeat is not evidence of a recent data frame.
        const interval = Math.max(100, Math.min(60000, Number(factory.simulation_interval_ms) || 2000));
        const freshFrame = frame && now - frame >= -5000 && now - frame <= Math.max(15000, interval * 2 + 1000);
        const count = Number(runtime.collectorStatus?.devices || 0);
        if (freshFrame && runtime.collectorStatus?.status === 'connected') result.normalDevices = Math.min(targets.length, Math.max(0, count));
        result.abnormalDevices = targets.length - result.normalDevices;
        result.status = result.normalDevices === targets.length ? 'simulation' : 'abnormal';
        return result;
    }
    for (const device of targets) {
        const state = states.get(String(device.id)), last = timestamp(state?.lastReadAt);
        const interval = Math.max(0, ...(Array.isArray(state?.intervals) ? state.intervals : []).map(Number).filter(Number.isFinite));
        const maxAge = Math.max(15000, Number(state?.offlineAfterMs) || 0, interval * 2 + 1000);
        if (state?.status === 'connected' && state.quality === 'good' && last && now - last >= -5000 && now - last <= maxAge) result.normalDevices++;
        else if (!state || ['idle', 'connecting'].includes(state.status) || (state.status === 'connected' && !last)) result.pendingDevices++;
        else result.abnormalDevices++;
    }
    result.status = result.abnormalDevices ? 'abnormal' : result.pendingDevices ? 'connecting' : 'normal';
    return result;
}
module.exports = { summarizeFactoryCollection };
