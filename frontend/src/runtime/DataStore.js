import { reactive, ref } from 'vue';
import { API_BASE, getWebSocketUrl } from './backendEndpoint.js';
import { adminFetch } from './adminSession.js';

function getDeviceQuality(data) {
    const groups = data?.quality || {};
    const values = Object.values(groups).flatMap(group => Object.values(group || {}));
    if (values.includes('bad')) return 'bad';
    if (values.includes('stale')) return 'stale';
    return 'good';
}

function formatEvent(row) {
    const parsedDate = row?.occurred_at ? new Date(row.occurred_at) : new Date();
    const date = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    return {
        id: row?.id ?? `${Date.now()}-${Math.random()}`,
        time: formatEventTime(date),
        occurred_at: row?.occurred_at || null,
        msg: row?.title || row?.message || '系统事件',
        level: row?.level || 'info'
    };
}

function formatEventTime(date) {
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
    if (sameDay) return date.toLocaleTimeString();
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${date.toLocaleTimeString()}`;
}

function clampNumber(value, min, max, fallback) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.max(min, Math.min(max, next));
}

export function createDashboardDataStore(options = {}) {
    const staleMs = ref(options.staleMs || 6000);
    const metricsRefreshIntervalMs = options.metricsRefreshIntervalMs || 5000;
    const eventsRefreshIntervalMs = options.eventsRefreshIntervalMs || 5000;
    const trendUpdateIntervalMs = options.trendUpdateIntervalMs || 5000;
    const wsConnected = ref(false);
    const plcStatusText = ref('等待连接...');
    const health = reactive({
        status: 'unknown',
        readiness: { status: 'unknown', displayReady: false, failures: ['backend'] },
        components: {},
        checkedAt: null
    });
    const selectedDeviceId = ref(null);
    const selectedDeviceData = reactive({});
    const deviceStatusMap = reactive({});
    const deviceDataMap = reactive({});
    const metrics = reactive({
        current_output: 0,
        daily_target: 1,
        overall_oee: 0,
        energy_consumption: 0,
        running_devices: 0,
        alarm_devices: 0,
        online_devices: 0,
        total_devices: 0
    });
    const events = ref([{ id: 'boot', time: new Date().toLocaleTimeString(), msg: '等待实时事件接入', level: 'info' }]);
    const trendPoints = ref([]);
    const eventQueryOptions = reactive({
        limit: options.eventLimit || 20,
        eventWindowHours: options.eventWindowHours ?? 24,
        eventType: options.eventType || ''
    });

    const latestDeviceDataMap = new Map();
    const lastSeenMap = new Map();
    let wsClient = null;
    let reconnectTimer = null;
    let staleTimer = null;
    let disposed = false;
    let onDeviceData = null;
    let onMessage = null;
    let lastMetricsRefreshAt = 0;
    let lastEventsRefreshAt = 0;
    let lastTrendUpdateAt = 0;
    let lastRealtimeFrameAt = 0;
    let metricsInFlight = false;
    let eventsInFlight = false;
    let healthInFlight = false;
    let lastHealthRefreshAt = 0;
    let eventsRequestId = 0;
    const pendingRequests = new Set();

    async function readJson(url, options = {}) {
        const controller = new AbortController();
        pendingRequests.add(controller);
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await adminFetch(url, { ...options, signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } finally {
            clearTimeout(timeout);
            pendingRequests.delete(controller);
        }
    }

    function setStaleMs(value) {
        const next = Number(value);
        if (Number.isFinite(next) && next > 0) staleMs.value = next;
    }

    function setEventQueryOptions(options = {}) {
        eventQueryOptions.limit = Math.round(clampNumber(options.limit, 1, 200, eventQueryOptions.limit || 20));
        eventQueryOptions.eventWindowHours = clampNumber(
            options.eventWindowHours ?? options.windowHours ?? options.sinceHours,
            0,
            87600,
            eventQueryOptions.eventWindowHours ?? 24
        );
        eventQueryOptions.eventType = String(options.eventType || options.event_type || '').trim();
    }

    function setDeviceDataHandler(handler) {
        onDeviceData = handler;
        Object.keys(deviceStatusMap).forEach((deviceId) => {
            const cachedData = latestDeviceDataMap.get(deviceId);
            if (cachedData) {
                onDeviceData?.(cachedData);
            } else {
                onDeviceData?.(createDeviceConnectionData(deviceId, deviceStatusMap[deviceId]?.quality || 'bad'));
            }
        });
        recomputeMetricsFromRuntime();
    }

    function setMessageHandler(handler) {
        onMessage = typeof handler === 'function' ? handler : null;
    }

    function registerDevice(deviceCfg) {
        if (!deviceCfg?.id) return;
        deviceStatusMap[deviceCfg.id] = {
            name: deviceCfg.name,
            temp: '--',
            carbon: '--',
            running: false,
            alarm: false,
            online: false,
            quality: 'bad',
            lastSeen: null
        };
        if (onDeviceData) onDeviceData(createDeviceConnectionData(deviceCfg.id, 'bad'));
        recomputeMetricsFromRuntime();
    }

    function selectDevice(deviceId) {
        selectedDeviceId.value = deviceId;
        const cachedData = latestDeviceDataMap.get(deviceId);
        Object.keys(selectedDeviceData).forEach(key => delete selectedDeviceData[key]);
        if (cachedData) Object.assign(selectedDeviceData, cachedData);
    }

    function applyDeviceRealtimeData(data) {
        if (disposed || !data?.furnace_id) return;

        lastRealtimeFrameAt = Date.now();
        latestDeviceDataMap.set(data.furnace_id, data);
        deviceDataMap[data.furnace_id] = data;
        lastSeenMap.set(data.furnace_id, Date.now());

        const quality = getDeviceQuality(data);
        deviceStatusMap[data.furnace_id] = {
            name: data.furnace_name,
            temp: data.analog?.actual_temp ?? '--',
            carbon: data.analog?.actual_carbon ?? '--',
            running: !!data.status?.running,
            alarm: !!data.status?.alarm,
            online: quality !== 'bad',
            quality,
            lastSeen: Date.now()
        };

        if (selectedDeviceId.value === data.furnace_id) {
            Object.keys(selectedDeviceData).forEach(key => delete selectedDeviceData[key]);
            Object.assign(selectedDeviceData, data);
        }

        if (onDeviceData) onDeviceData(data);
        recomputeMetricsFromRuntime();
    }

    function qualityFromPlcStatus(status) {
        const value = String(status || '').toLowerCase();
        if (value === 'connected') return 'good';
        if (['connecting', 'retrying', 'idle', 'no_points'].includes(value)) return 'stale';
        if (['offline', 'error', 'disabled', 'unsupported', 'unconfigured'].includes(value)) return 'bad';
        return 'bad';
    }

    function createDeviceConnectionData(deviceId, quality, patch = {}) {
        const status = deviceStatusMap[deviceId] || {};
        return {
            furnace_id: deviceId,
            furnace_name: status.name || patch.deviceName || deviceId,
            analog: {},
            status: {
                running: false,
                alarm: false,
                connection_status: patch.status || quality
            },
            motors: {},
            doors: {},
            mechanisms: {},
            gas: {},
            quality: {
                status: {
                    _connection: quality,
                    running: quality,
                    alarm: quality
                }
            },
            plc: {
                status: patch.status || quality,
                message: patch.message || '',
                lastConnectedAt: patch.lastConnectedAt || null,
                lastReadAt: patch.lastReadAt || null,
                lastError: patch.lastError || ''
            }
        };
    }

    function applyPlcStatus(payload) {
        plcStatusText.value = payload?.message || payload?.status || '状态未知';
        (Array.isArray(payload?.devices) ? payload.devices : []).forEach((deviceStatus) => {
            const deviceId = deviceStatus.deviceId;
            if (!deviceId) return;
            const quality = deviceStatus.quality || qualityFromPlcStatus(deviceStatus.status);
            const previous = deviceStatusMap[deviceId] || {};
            deviceStatusMap[deviceId] = {
                ...previous,
                name: previous.name || deviceStatus.deviceName || deviceId,
                online: quality === 'good',
                quality,
                plcStatus: deviceStatus.status,
                lastConnectedAt: deviceStatus.lastConnectedAt || previous.lastConnectedAt || null,
                lastReadAt: deviceStatus.lastReadAt || previous.lastReadAt || null,
                lastError: deviceStatus.lastError || ''
            };

            if (quality !== 'good' || !latestDeviceDataMap.has(deviceId)) {
                const cachedData = latestDeviceDataMap.get(deviceId);
                const connectionData = cachedData
                    ? {
                        ...cloneDataWithQuality(cachedData, quality),
                        plc: {
                            ...(cachedData.plc || {}),
                            status: deviceStatus.status || quality,
                            message: deviceStatus.message || '',
                            lastConnectedAt: deviceStatus.lastConnectedAt || null,
                            lastReadAt: deviceStatus.lastReadAt || null,
                            lastError: deviceStatus.lastError || ''
                        }
                    }
                    : createDeviceConnectionData(deviceId, quality, deviceStatus);
                latestDeviceDataMap.set(deviceId, connectionData);
                deviceDataMap[deviceId] = connectionData;
                if (selectedDeviceId.value === deviceId) {
                    Object.keys(selectedDeviceData).forEach(key => delete selectedDeviceData[key]);
                    Object.assign(selectedDeviceData, connectionData);
                }
                if (onDeviceData) onDeviceData(connectionData);
            }
        });
        recomputeMetricsFromRuntime();
    }

    function cloneDataWithQuality(data, quality) {
        const next = {
            ...data,
            quality: {}
        };
        Object.entries(data?.quality || {}).forEach(([groupName, group]) => {
            next.quality[groupName] = {};
            Object.keys(group || {}).forEach(fieldName => {
                next.quality[groupName][fieldName] = quality;
            });
        });
        if (!next.quality.status) next.quality.status = {};
        next.quality.status._connection = quality;
        return next;
    }

    function applyFrame(payload) {
        const devices = Array.isArray(payload?.devices) ? payload.devices : [];
        devices.forEach(applyDeviceRealtimeData);
        updateRollingTrend(devices);
        recomputeMetricsFromRuntime();
        refreshMetrics();
        refreshEvents();
    }

    function hasRecentRealtimeFrame() {
        return lastRealtimeFrameAt > 0 && Date.now() - lastRealtimeFrameAt <= staleMs.value * 2;
    }

    function recomputeMetricsFromRuntime() {
        const statuses = Object.values(deviceStatusMap);
        metrics.total_devices = statuses.length;
        metrics.online_devices = statuses.filter(s => s.online).length;
        metrics.running_devices = statuses.filter(s => s.online && s.running).length;
        metrics.alarm_devices = statuses.filter(s => s.online && s.alarm).length;

        if (!hasRecentRealtimeFrame() || metrics.online_devices === 0) {
            metrics.current_output = 0;
            metrics.daily_target = 0;
            metrics.overall_oee = 0;
            metrics.energy_consumption = 0;
        }
    }

    function updateRollingTrend(devices) {
        const timestamp = Date.now();
        if (timestamp - lastTrendUpdateAt < trendUpdateIntervalMs) return;
        const temps = devices
            .filter(d => getDeviceQuality(d) === 'good' && d.analog?.actual_temp != null && String(d.analog.actual_temp).trim() !== '')
            .map(d => Number(d.analog.actual_temp)).filter(Number.isFinite);
        if (!temps.length) return;
        lastTrendUpdateAt = timestamp;
        const avgTemp = temps.reduce((sum, value) => sum + value, 0) / temps.length;
        const now = new Date().toLocaleTimeString().slice(0, 5);
        const points = [...trendPoints.value, { time: now, value: Number(avgTemp.toFixed(1)) }];
        trendPoints.value = points.slice(-8);
    }

    function checkStaleDevices() {
        const now = Date.now();
        Object.entries(deviceStatusMap).forEach(([deviceId, status]) => {
            const lastSeen = lastSeenMap.get(deviceId);
            if (!lastSeen) return;
            const age = now - lastSeen;
            if (age > staleMs.value) {
                const nextQuality = age > staleMs.value * 2 ? 'bad' : 'stale';
                if (status.quality !== nextQuality) {
                    status.quality = nextQuality;
                    status.online = status.quality !== 'bad';
                    const cachedData = latestDeviceDataMap.get(deviceId);
                    if (cachedData) {
                        const staleData = cloneDataWithQuality(cachedData, nextQuality);
                        latestDeviceDataMap.set(deviceId, staleData);
                        deviceDataMap[deviceId] = staleData;
                        if (selectedDeviceId.value === deviceId) {
                            Object.keys(selectedDeviceData).forEach(key => delete selectedDeviceData[key]);
                            Object.assign(selectedDeviceData, staleData);
                        }
                        if (onDeviceData) onDeviceData(staleData);
                    }
                }
            }
        });
        recomputeMetricsFromRuntime();
    }

    async function refreshEvents(force = false) {
        const now = Date.now();
        if (disposed) return;
        if (!force && (eventsInFlight || now - lastEventsRefreshAt < eventsRefreshIntervalMs)) return;
        const requestId = ++eventsRequestId;
        eventsInFlight = true;
        try {
            const params = new URLSearchParams();
            params.set('limit', String(Math.round(clampNumber(eventQueryOptions.limit, 1, 200, 20))));
            const windowHours = clampNumber(eventQueryOptions.eventWindowHours, 0, 87600, 24);
            if (windowHours > 0) params.set('window_hours', String(windowHours));
            if (eventQueryOptions.eventType) params.set('event_type', eventQueryOptions.eventType);
            const rows = await readJson(`${API_BASE}/platform/events?${params.toString()}`);
            if (disposed || requestId !== eventsRequestId || !Array.isArray(rows)) return;
            const emptyMsg = windowHours > 0
                ? `最近 ${windowHours} 小时暂无报警履历`
                : '暂无报警履历';
            events.value = rows.length ? rows.map(formatEvent) : [{ id: 'empty', time: new Date().toLocaleTimeString(), msg: emptyMsg, level: 'info' }];
        } catch (e) {
            // 离线时保留当前列表。
        } finally {
            if (requestId === eventsRequestId) {
                lastEventsRefreshAt = Date.now();
                eventsInFlight = false;
            }
        }
    }

    async function refreshMetrics(force = false) {
        const now = Date.now();
        if (disposed || metricsInFlight || (!force && now - lastMetricsRefreshAt < metricsRefreshIntervalMs)) return;
        if (Object.keys(deviceStatusMap).length > 0 && !hasRecentRealtimeFrame()) {
            recomputeMetricsFromRuntime();
            lastMetricsRefreshAt = now;
            return;
        }
        metricsInFlight = true;
        try {
            const data = await readJson(`${API_BASE}/platform/metrics/latest`);
            if (disposed || !data || typeof data !== 'object' || Array.isArray(data)) return;
            Object.assign(metrics, data);
            recomputeMetricsFromRuntime();
        } catch (e) {
            // 离线时用实时帧聚合兜底。
            if (!disposed) recomputeMetricsFromRuntime();
        } finally {
            lastMetricsRefreshAt = Date.now();
            metricsInFlight = false;
        }
    }

    function healthLabel(payload) {
        if (!payload) return '后端不可用';
        const failures = payload.readiness?.failures || [];
        if (payload.readiness?.displayReady) {
            return String(payload.engine?.mode || '').toLowerCase() === 'simulation' ? '模拟数据正常' : '实时数据正常';
        }
        if (failures.includes('unity')) return 'Unity 未连接';
        if (failures.includes('database')) return '数据库异常';
        if (failures.includes('data_engine')) return '采集器未就绪';
        if (failures.includes('data_freshness')) return '数据已过期';
        return '系统未就绪';
    }

    async function refreshHealth(force = false) {
        const now = Date.now();
        if (disposed || healthInFlight || (!force && now - lastHealthRefreshAt < 5000)) return;
        healthInFlight = true;
        try {
            const payload = await readJson(`${API_BASE}/health`, { cache: 'no-store' });
            if (disposed) return;
            if (!payload) throw new Error('健康检查失败');
            health.status = payload.status || 'unknown';
            health.readiness = payload.readiness || { status: 'unknown', displayReady: false, failures: ['backend'] };
            health.components = payload.components || {};
            health.checkedAt = payload.timestamp || new Date().toISOString();
            plcStatusText.value = healthLabel(payload);
        } catch (error) {
            if (disposed) return;
            health.status = 'offline';
            health.readiness = { status: 'not_ready', displayReady: false, failures: ['backend'] };
            health.components = { backend: { status: 'error' } };
            health.checkedAt = new Date().toISOString();
            plcStatusText.value = '后端不可用';
        } finally {
            lastHealthRefreshAt = Date.now();
            healthInFlight = false;
        }
    }

    function connect() {
        if (disposed) return;
        if (wsClient && wsClient.readyState < 2) return;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        const wsUrl = getWebSocketUrl('/ws');
        const socket = new WebSocket(wsUrl);
        wsClient = socket;

        socket.onopen = () => {
            if (disposed || wsClient !== socket) return;
            wsConnected.value = true;
            plcStatusText.value = '通信正常';
            try { socket.send(JSON.stringify({ type: 'client_hello', role: 'web', client: 'dashboard-overlay' })); } catch (e) { /* ignore */ }
            if(options.sceneProjection===true) {
                try {socket.send(JSON.stringify({type:'scene_projection_subscribe',enabled:true}));} catch { /* reconnect retries the subscription */ }
            }
        };

        socket.onmessage = (event) => {
            if (disposed || wsClient !== socket) return;
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'realtime_frame') {
                    applyFrame(msg.payload);
                } else if (msg.type === 'device_data') {
                    applyDeviceRealtimeData(msg.payload);
                    refreshMetrics();
                } else if (msg.type === 'plc_status') {
                    applyPlcStatus(msg.payload);
                }
                Promise.resolve(onMessage?.(msg)).catch(error => console.warn('[DataStore] 实时消息处理失败:', error));
            } catch (e) {
                // 忽略非 JSON 消息。
            }
        };

        socket.onclose = () => {
            if (disposed || wsClient !== socket) return;
            wsClient = null;
            wsConnected.value = false;
            plcStatusText.value = '连接断开，重连中...';
            reconnectTimer = setTimeout(() => connect(), 5000);
        };

        socket.onerror = () => {
            if (disposed || wsClient !== socket) return;
            wsConnected.value = false;
        };

        if (!staleTimer) {
            staleTimer = setInterval(() => {
                checkStaleDevices();
                refreshMetrics();
                refreshEvents();
                refreshHealth();
            }, 1000);
        }
    }

    function dispose() {
        disposed = true;
        wsConnected.value = false;
        eventsRequestId += 1;
        pendingRequests.forEach(controller => controller.abort());
        pendingRequests.clear();
        onDeviceData = null;
        onMessage = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (staleTimer) clearInterval(staleTimer);
        if (wsClient) {
            wsClient.onopen = null;
            wsClient.onmessage = null;
            wsClient.onclose = null;
            wsClient.onerror = null;
            wsClient.close();
        }
        reconnectTimer = null;
        staleTimer = null;
        wsClient = null;
    }

    return {
        staleMs,
        wsConnected,
        plcStatusText,
        health,
        selectedDeviceId,
        selectedDeviceData,
        deviceStatusMap,
        deviceDataMap,
        metrics,
        events,
        trendPoints,
        latestDeviceDataMap,
        setStaleMs,
        setEventQueryOptions,
        setDeviceDataHandler,
        setMessageHandler,
        registerDevice,
        selectDevice,
        connect,
        dispose,
        refreshEvents,
        refreshMetrics,
        refreshHealth
    };
}
