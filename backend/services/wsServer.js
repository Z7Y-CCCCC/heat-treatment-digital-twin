/**
 * wsServer.js - WebSocket 服务器
 * 
 * 提供前端连接的 WebSocket 通道。
 * 数据引擎（dataEngine）通过此模块把设备实时数据推送给所有已连接的前端客户端。
 * 
 * 消息协议：
 * - 服务端 → 客户端: { type: "realtime_frame", payload: { seq, timestamp, devices: [] } }
 * - 服务端 → 客户端: { type: "plc_status", payload: { status, message } }
 * - 客户端 → 服务端: { type: "ping" }  →  回复 { type: "pong" }
 * - 客户端 → 服务端: { type: "client_hello", role: "unity" }
 */

const { WebSocketServer } = require('ws');

function shortText(value, maxLength = 160) {
    return String(value || '').trim().slice(0, maxLength);
}

function shortTextArray(value, maxItems = 64, maxLength = 128) {
    return Array.isArray(value)
        ? value.slice(0, maxItems).map(item => shortText(item, maxLength)).filter(Boolean)
        : [];
}

function projectedPoint(value) {
    const valid = value && Number.isFinite(value.x) && Number.isFinite(value.y);
    return { x: valid ? Math.max(0, Math.min(1, value.x)) : 0, y: valid ? Math.max(0, Math.min(1, value.y)) : 0, visible: !!valid && value.visible === true };
}

function inspectionContext(source, mode) {
    const active = mode === 'device' && source.inspectionEnabled === true;
    return {
        inspectionEnabled: active,
        inspectionProgress: active && Number.isFinite(source.inspectionProgress) ? Math.max(0, Math.min(1, source.inspectionProgress)) : 0,
        inspectionAnimating: active && source.inspectionAnimating === true,
        inspectionPhase: active ? shortText(source.inspectionPhase, 32) : '',
        inspectionIsolated: active && source.inspectionIsolated === true,
        inspectionLabelsEnabled: active && source.inspectionLabelsEnabled === true,
        inspectionLeaderLines: active && source.inspectionLeaderLines === true,
        inspectionHoveredPartId: active ? shortText(source.inspectionHoveredPartId, 128) : '',
        inspectionIssues: active && Array.isArray(source.inspectionIssues) ? source.inspectionIssues.slice(0, 100).map(issue => typeof issue === 'string' ? { message: shortText(issue, 2000) } : {
            code: shortText(issue?.code, 80), partId: shortText(issue?.partId, 128), message: shortText(issue?.message, 2000), severity: issue?.severity === 'error' ? 'error' : 'warning'
        }) : [],
        inspectionParts: active && Array.isArray(source.inspectionParts) ? source.inspectionParts.slice(0, 64).filter(part => part && typeof part === 'object').map(part => ({
            id: shortText(part.id, 128), name: shortText(part.name, 180), group: shortText(part.group, 180), description: shortText(part.description, 2000),
            pointIds: shortTextArray(part.pointIds, 256), pointKeys: shortTextArray(part.pointKeys, 256), selected: part.selected === true,
            anchor: projectedPoint(part.anchor), label: projectedPoint(part.label)
        })) : []
    };
}

class WsServer {
    constructor() {
        this.wss = null;
        this.wssInstances = new Set();
        this.clients = new Set();
        this.sequence = 0;
        this.dashboardContext = null;
    }

    /**
     * 将 WebSocket 绑定到已有的 HTTP Server 上
     * @param {http.Server} httpServer
     */
    attach(httpServer, options = {}) {
        const wss = new WebSocketServer({
            server: httpServer,
            path: '/ws',
            verifyClient: options.verifyClient
        });
        this.wss = this.wss || wss;
        this.wssInstances.add(wss);

        // 监听器端口被占用时，底层 WebSocketServer 也会转发 HTTP server 的 error。
        // 必须消费该事件，否则 Node 会把它视为未处理异常并结束整个后台进程。
        wss.on('error', error => {
            console.error('[WebSocket] 服务监听错误:', error.message);
            options.onError?.(error);
        });

        wss.on('connection', (ws, req) => {
            const clientIp = req.socket.remoteAddress;
            console.log(`[WebSocket] 客户端已连接: ${clientIp} (当前 ${this.clients.size + 1} 个连接)`);
            this.clients.add(ws);
            options.onConnection?.(ws, req);

            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (data.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    } else if (data.type === 'client_hello') {
                        const role = String(data.role || data.payload?.role || '').trim().toLowerCase();
                        ws.clientRole = ['unity', 'web', 'admin'].includes(role) ? role : '';
                        if (ws.clientRole === 'web' && this.dashboardContext && ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'dashboard_context_changed', payload: this.dashboardContext }));
                        }
                    } else if (data.type === 'dashboard_context' && ws.clientRole === 'unity') {
                        const source = data.payload && typeof data.payload === 'object' ? data.payload : {};
                        const mode = ['factory', 'workshop', 'line', 'device', 'custom'].includes(source.viewMode) ? source.viewMode : 'factory';
                        if (mode !== 'device') {
                            for (const key of ['inspectionStage', 'partId', 'partName', 'partDescription', 'partDetailViewId']) source[key] = '';
                            source.partPointIds = [];
                            source.partPointKeys = [];
                        }
                        this.dashboardContext = {
                            viewId: shortText(source.viewId, 128),
                            // 新版 Unity 在模型/数据准备完成前明确发送 false；旧版客户端
                            // 没有该字段时按已就绪兼容，避免透明层永久隐藏。
                            sceneReady: Object.prototype.hasOwnProperty.call(source, 'sceneReady')
                                ? source.sceneReady !== false
                                : true,
                            viewMode: mode,
                            sceneId: shortText(source.sceneId, 128),
                            workshopId: shortText(source.workshopId, 128),
                            lineId: shortText(source.lineId, 128),
                            deviceId: shortText(source.deviceId, 128),
                            inspectionStage: ['solid', 'xray', 'exploded', 'part'].includes(shortText(source.inspectionStage, 32))
                                ? shortText(source.inspectionStage, 32)
                                : '',
                            partId: shortText(source.partId, 128),
                            partName: shortText(source.partName, 180),
                            partDescription: shortText(source.partDescription, 2000),
                            partPointIds: shortTextArray(source.partPointIds, 256),
                            partPointKeys: shortTextArray(source.partPointKeys, 256),
                            partDetailViewId: shortText(source.partDetailViewId, 128),
                            ...inspectionContext(source, mode),
                            timestamp: Date.now()
                        };
                        this.broadcastToRole('dashboard_context_changed', this.dashboardContext, 'web');
                    }
                } catch (e) { /* 忽略非 JSON 消息 */ }
            });

            ws.on('close', () => {
                this.clients.delete(ws);
                options.onClose?.(ws, req);
                console.log(`[WebSocket] 客户端断开: ${clientIp} (剩余 ${this.clients.size} 个连接)`);
            });

            ws.on('error', (err) => {
                console.error(`[WebSocket] 客户端错误:`, err.message);
                this.clients.delete(ws);
            });

            // 连接成功后立即发送一条欢迎消息
            ws.send(JSON.stringify({
                type: 'welcome',
                payload: { message: '数字孪生 WebSocket 通道已建立', timestamp: Date.now() }
            }));
        });

        console.log('[WebSocket] 服务已启动，等待客户端连接 (路径: /ws)');
        return wss;
    }

    detach(wss) {
        if (!wss) return;
        this.wssInstances.delete(wss);
        if (this.wss === wss) this.wss = this.wssInstances.values().next().value || null;
        try { wss.close(); } catch (error) { /* ignore */ }
    }

    /**
     * 向所有客户端广播一个采集周期的设备数据帧
     * @param {Array} deviceDataArray - 所有设备的实时数据数组
     */
    broadcastDeviceData(deviceDataArray) {
        if (this.clients.size === 0) return;
        if (!Array.isArray(deviceDataArray) || deviceDataArray.length === 0) return;

        const message = JSON.stringify({
            type: 'realtime_frame',
            payload: {
                seq: ++this.sequence,
                timestamp: Date.now(),
                devices: deviceDataArray
            }
        });

        this.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                client.send(message);
            }
        });
    }

    /**
     * 广播 PLC/数据源连接状态
     */
    broadcastStatus(statusInfo) {
        this.broadcast('plc_status', statusInfo);
    }

    /**
     * 广播通用服务端事件。配置保存等非实时采集事件也通过同一通道推送，
     * 这样 Unity 原生客户端无需轮询或手动按 F5。
     */
    broadcast(type, payload = {}) {
        if (this.clients.size === 0) return 0;

        const message = JSON.stringify({ type, payload });
        let sent = 0;
        this.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(message);
                sent += 1;
            }
        });
        return sent;
    }

    broadcastToRole(type, payload = {}, role = '') {
        if (this.clients.size === 0) return 0;
        const normalizedRole = String(role || '').trim().toLowerCase();
        const message = JSON.stringify({ type, payload });
        let sent = 0;
        this.clients.forEach(client => {
            if (client.readyState !== 1) return;
            if (normalizedRole && client.clientRole !== normalizedRole) return;
            client.send(message);
            sent += 1;
        });
        return sent;
    }

    countClients(role = '') {
        const normalizedRole = String(role || '').trim().toLowerCase();
        let count = 0;
        this.clients.forEach(client => {
            if (client.readyState !== 1) return;
            if (normalizedRole && client.clientRole !== normalizedRole) return;
            count += 1;
        });
        return count;
    }

    /**
     * 关闭 WebSocket 服务
     */
    close() {
        for (const wss of this.wssInstances) {
            try { wss.close(); } catch (error) { /* ignore */ }
        }
        this.wssInstances.clear();
        this.wss = null;
        this.clients.clear();
        console.log('[WebSocket] 服务已关闭');
    }
}

module.exports = WsServer;
