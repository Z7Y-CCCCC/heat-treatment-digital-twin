'use strict';
const { collectorHealth } = require('./collectorHealth');

const stamp = (value, now) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= now ? Number(value) : null;
const bounded = value => String(value || '').slice(0, 120);
const enumValue = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
const tone = state => ['ready', 'online', 'healthy', 'authenticated'].includes(state) ? 'is-online'
    : ['offline', 'stale', 'degraded', 'stopped', 'locked', 'login_required'].includes(state) ? 'is-offline'
    : ['syncing', 'simulation', 'starting', 'paused', 'external'].includes(state) ? 'is-partial' : 'is-unknown';

// Only observations and explicitly selected fields leave this boundary. Never
// forward raw database config, PLC messages/addresses, auth state or /health.
function adminConnectionStatus({ now = Date.now(), factoryId = '', factory = null, engine = {},
    configuredMode = null, pluginInstalled = false, databaseConnected = false, recoveryPending = false,
    unityHealth = {}, runtime = {}, sessionStatus = {}, automationAuthorized = false, collectionAllowed = true } = {}) {
    const unity = {
        state: unityHealth.status === 'online' && Number(unityHealth.sceneReadyClients) > 0 ? 'ready'
            : unityHealth.status === 'online' ? 'syncing' : unityHealth.status === 'stale' ? 'stale' : 'offline',
        connectedClients: count(unityHealth.connectedClients),
        sceneReadyClients: count(unityHealth.sceneReadyClients),
        lastCommunicationAt: stamp(unityHealth.lastCommunicationAt, now)
    };
    unity.ageMs = unity.lastCommunicationAt ? now - unity.lastCommunicationAt : null;
    unity.label = { ready: '场景就绪', syncing: '场景同步中', stale: '通信已过期', offline: '实时通道离线' }[unity.state];
    unity.reason = unity.state === 'syncing' ? '实时通道在线，场景尚未就绪' : unity.state === 'stale' ? '实时通道心跳超时' : '';

    let collection;
    if (!collectionAllowed) collection = { state: 'forbidden', label: '无权限查看', reason: '当前账户无设备采集查看权限' };
    else {
        // A missing current-factory runtime must not borrow the active factory's
        // readings from engineStatus, including on empty installations.
        const source = factory ? { ...factory,
            collectorStatus: { ...factory.collectorStatus, lastFrameAt: stamp(factory.collectorStatus?.lastFrameAt, now) },
            plcStatus: { ...factory.plcStatus, devices: (factory.plcStatus?.devices || []).map(device => ({
                ...device, lastReadAt: stamp(device.lastReadAt, now), message: ''
            })) } } : {};
        const processStatus = enumValue(engine.process?.status, ['running', 'starting', 'recovering', 'stopped', 'offline', 'error', 'unresponsive', 'not_installed', 'idle']);
        const heartbeatAt = stamp(engine.process?.lastHeartbeatAt, now);
        const health = collectorHealth({ ...engine, process: { ...engine.process, status: processStatus,
            lastHeartbeatAt: heartbeatAt } }, { [factoryId]: source }, { now, databaseReady: databaseConnected });
        const processRunning = health.processRunning && heartbeatAt !== null;
        const observedMode = ['simulation', 'integrated_plc', 'external'].includes(factory?.mode) ? factory.mode : null;
        const state = recoveryPending ? 'paused' : !databaseConnected ? 'degraded' : !factoryId ? 'idle'
            : !factory ? 'unknown' : pluginInstalled && processStatus === 'running' && heartbeatAt === null ? 'starting' : health.state;
        const labels = { paused: '采集已暂停', degraded: !databaseConnected ? '数据库异常' : health.counts.normal ? '部分采集异常' : '采集异常',
            idle: '等待设备配置', unknown: '等待工厂采集状态' };
        const reason = recoveryPending ? '整站恢复待确认，采集暂停' : !databaseConnected ? '数据库连接不可用'
            : !factoryId ? '尚未配置工厂' : !factory ? '尚未取得当前工厂运行状态'
            : pluginInstalled && processStatus === 'running' && heartbeatAt === null ? '等待采集进程有效心跳'
            : health.counts.abnormal ? `${health.counts.abnormal} 台设备读数无效或过期`
            : health.process.heartbeatAgeMs > 15000 ? '采集进程心跳超时' : '';
        const mode = observedMode || configuredMode;
        collection = { state, label: labels[state] || health.label, reason,
            mode, configuredMode, pluginInstalled: pluginInstalled === true, processRunning,
            processStatus, heartbeatAgeMs: health.process.heartbeatAgeMs,
            lastCommunicationAt: stamp(health.lastSampleAt, now), ageMs: health.lastSampleAgeMs, counts: health.counts,
            devices: health.factories[0].devices.map(device => ({ deviceId: bounded(device.deviceId), name: bounded(device.name),
                state: device.state, status: enumValue(device.status, ['connected', 'disconnected', 'connecting', 'offline', 'error', 'idle', 'disabled', 'stopped', 'simulating']),
                quality: enumValue(device.quality, ['good', 'bad', 'stale']),
                lastReadAt: stamp(device.lastReadAt, now), sampleAgeMs: device.sampleAgeMs,
                reason: device.state === 'abnormal' ? '设备读数无效、离线或过期' : device.state === 'pending' ? '等待设备有效读数' : '' })) };
        if (mode === 'simulation' && !collection.label.includes('模拟')) collection.label = `模拟 · ${collection.label}`;
    }
    const data = { state: databaseConnected && !recoveryPending ? 'online' : 'degraded',
        label: recoveryPending ? '恢复待确认' : databaseConnected ? 'API / 数据库正常' : '数据库连接异常',
        apiReachable: true, databaseConnected: databaseConnected === true, lastCommunicationAt: now,
        reason: recoveryPending ? '整站恢复待确认，业务接口已暂停' : databaseConnected ? '' : '后台 API 可达，数据库不可用' };
    const session = { state: sessionStatus.authenticated ? 'authenticated'
        : sessionStatus.displayAuthenticated ? 'locked' : 'login_required',
        label: sessionStatus.authenticated ? '会话有效' : sessionStatus.displayAuthenticated ? '后台已锁定' : '需要登录',
        expiresAt: stamp(sessionStatus.expiresAt, Number.MAX_SAFE_INTEGER), lastCommunicationAt: now };
    // An automation token authenticates its caller, not the browser's user.
    if (automationAuthorized && !sessionStatus.authenticated) session.label = '当前浏览器需登录';
    const service = (key, name, item, detail, extra = {}) => ({ key, name, label: item.label, detail,
        state: item.state, tone: tone(item.state), connected: ['ready', 'online', 'healthy', 'authenticated'].includes(item.state),
        observedAt: now, lastSuccessAt: item.lastCommunicationAt || null, stale: item.state === 'stale',
        restricted: item.state === 'forbidden', ...extra });
    const devices = collection.devices || [];
    const total = devices.filter(device => device.state !== 'disabled').length;
    const services = [
        service('unity', 'Unity', unity, unity.reason || `${unity.connectedClients} 个实时通道，${unity.sceneReadyClients} 个场景就绪`),
        service('devices', '设备采集', collection, collection.reason || (collection.mode === 'simulation' ? '模拟数据，不代表真实 PLC 在线'
            : `进程${collection.processRunning ? '运行' : '未连接'}；有效设备 ${collection.counts?.normal || 0} / ${total}`), {
            tone: collection.state === 'degraded' && databaseConnected && collection.counts?.normal > 0 ? 'is-partial' : tone(collection.state),
            mode: collection.mode, online: collection.counts?.normal || 0, total, rows: devices.map(device => ({ id: device.deviceId, name: device.name,
                connected: device.state === 'normal' && collection.mode !== 'simulation', state: device.state,
                status: device.status, tone: collection.mode === 'simulation' && device.state === 'normal' ? 'is-partial' : tone(device.state === 'normal' ? 'online' : device.state === 'abnormal' ? 'offline' : device.state),
                detail: collection.mode === 'simulation' ? '模拟数据' : device.reason, lastSuccessAt: device.lastReadAt })) }),
        service('data', '数据服务', data, data.reason || '后台 API 可达，数据库已连接'),
        service('session', '登录状态', session, session.state === 'authenticated' ? '当前会话校验有效' : '返回现有登录 / 解锁界面')
    ];
    return { success: true, readOnly: true, observedAt: now, factoryId, runtime: {
        role: runtime.role === 'collector' ? 'collector' : 'display',
        owner: ['windows-service', 'standalone', 'display'].includes(runtime.owner) ? runtime.owner : 'display'
    }, unity, collection, data, session, services };
}
module.exports = { adminConnectionStatus };
