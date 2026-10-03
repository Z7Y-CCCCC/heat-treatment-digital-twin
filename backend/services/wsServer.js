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
const { normalizeSceneProjection } = require('../utils/sceneProjection');
const { getAdminAuth } = require('./adminAuth');
const { WsOutboundQueue, defaults: queueDefaults } = require('../utils/wsOutboundQueue');

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
    constructor(queueOptions = {}) {
        this.queueOptions = queueOptions;
        this.outbound = new Map();
        this.wss = null;
        this.wssInstances = new Set();
        this.clients = new Set();
        this.sequence = 0;
        this.dashboardContext = null;
        this.sceneProjection = null;
        this.sceneProjectionOwner = null;
    }

    /**
     * 将 WebSocket 绑定到已有的 HTTP Server 上
     * @param {http.Server} httpServer
     */
    attach(httpServer, options = {}) {
        const wss = new WebSocketServer({
            server: httpServer,
            path: '/ws',
            maxPayload: queueDefaults.maxMessageBytes,
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
            this.outbound.set(ws, new WsOutboundQueue(ws, this.queueOptions));
            if (req.adminSessionToken) {
                ws.sessionCheckTimer = setInterval(() => {
                    if (!getAdminAuth().status(req.adminSessionToken).displayAuthenticated) {
                        try { ws.close(4401, 'Session expired'); } catch { ws.terminate(); }
                    }
                }, 5000);
                ws.sessionCheckTimer.unref?.();
            }
            options.onConnection?.(ws, req);

            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (data.type === 'ping') {
                        this.send(ws, { type: 'pong', timestamp: Date.now() });
                    } else if (data.type === 'client_hello') {
                        const role = String(data.role || data.payload?.role || '').trim().toLowerCase();
                        ws.clientRole = ['unity', 'web', 'admin'].includes(role) ? role : '';
                        if (ws.clientRole === 'web' && this.dashboardContext && ws.readyState === 1) {
                            this.send(ws, { type: 'dashboard_context_changed', payload: this.dashboardContext });
                        }
                        if (ws.clientRole === 'unity') this.sendProjectionSubscription(ws);
                        else this.updateProjectionSubscriptions();
                    } else if (data.type === 'scene_projection_subscribe' && ws.clientRole === 'web') {
                        ws.sceneProjectionSubscribed = data.enabled === true;
                        this.updateProjectionSubscriptions();
                        if (ws.sceneProjectionSubscribed && this.sceneProjection && Date.now()-this.sceneProjection.receivedAt < 1500) {
                            this.send(ws, { type:'scene_projection', payload:this.sceneProjection });
                        }
                    } else if (data.type === 'scene_projection' && ws.clientRole === 'unity') {
                        const now=Date.now();
                        if (ws.lastSceneProjectionAt && now-ws.lastSceneProjectionAt < 65) return;
                        if (this.sceneProjectionOwner && this.sceneProjectionOwner !== ws) return;
                        const frame=normalizeSceneProjection(data.payload,now);
                        if (!frame) return;
                        if (this.sceneProjection?.streamId===frame.streamId && frame.seq<=this.sceneProjection.seq) return;
                        ws.lastSceneProjectionAt=now;
                        this.sceneProjectionOwner=ws;
                        this.sceneProjection=frame;
                        this.broadcastProjection(frame);
                    } else if (data.type === 'dashboard_context' && ws.clientRole === 'unity') {
                        if(this.sceneProjectionOwner!==ws){this.sceneProjectionOwner=ws;this.sceneProjection=null;}
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
                        if(this.dashboardContext.sceneReady===false){this.sceneProjection=null;this.broadcastProjection({available:false,receivedAt:Date.now()});}
                    }
                } catch (e) { /* 忽略非 JSON 消息 */ }
            });

            ws.on('close', (code, reason) => {
                const outbound = this.outbound.get(ws);
                const diagnostic = { at: new Date().toISOString(), code, reason: shortText(reason), role: ws.clientRole || '',
                    failure: shortText(outbound?.failure, 320), stats: outbound ? { ...outbound.stats } : null };
                if (ws.sessionCheckTimer) clearInterval(ws.sessionCheckTimer);
                this.clients.delete(ws);
                outbound?.dispose(); this.outbound.delete(ws);
                if(this.sceneProjectionOwner===ws){this.sceneProjectionOwner=null;this.sceneProjection=null;this.broadcastProjection({available:false,receivedAt:Date.now()});}
                this.updateProjectionSubscriptions();
                options.onClose?.(ws, req);
                console.log(`[WebSocket] 客户端断开: ${clientIp} (剩余 ${this.clients.size} 个连接) ${JSON.stringify(diagnostic)}`);
            });

            ws.on('error', (err) => {
                if (ws.sessionCheckTimer) clearInterval(ws.sessionCheckTimer);
                console.error(`[WebSocket] 客户端错误:`, err.message);
                this.clients.delete(ws);
                this.outbound.get(ws)?.fail(`socket error: ${err.message}`);
            });

            // 连接成功后立即发送一条欢迎消息
            this.send(ws, {
                type: 'welcome',
                payload: { message: '数字孪生 WebSocket 通道已建立', timestamp: Date.now() }
            });
        });

        console.log('[WebSocket] 服务已启动，等待客户端连接 (路径: /ws)');
        return wss;
    }

    sendProjectionSubscription(client) {
        if(client.readyState!==1 || client.clientRole!=='unity') return;
        const enabled=[...this.clients].some(peer=>peer.readyState===1 && peer.clientRole==='web' && peer.sceneProjectionSubscribed);
        if(client.sceneProjectionEnabled===enabled) return;
        client.sceneProjectionEnabled=enabled;
        this.send(client, {type:'scene_projection_subscription',payload:{enabled}});
    }

    send(client, message, serialized) {
        if (client.readyState !== 1) return false;
        let queue = this.outbound.get(client);
        if (!queue) { queue = new WsOutboundQueue(client, this.queueOptions); this.outbound.set(client, queue); }
        return queue.enqueue(message, serialized);
    }

    updateProjectionSubscriptions() {
        this.clients.forEach(client=>this.sendProjectionSubscription(client));
    }

    broadcastProjection(payload) {
        const message={type:'scene_projection',payload};
        const serialized=JSON.stringify(message);
        this.clients.forEach(client=>{
            if(client.readyState===1 && client.clientRole==='web' && client.sceneProjectionSubscribed) this.send(client, message, serialized);
        });
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

        const message = {
            type: 'realtime_frame',
            payload: {
                seq: ++this.sequence,
                timestamp: Date.now(),
                devices: deviceDataArray
            }
        };

        const serialized = JSON.stringify(message);
        this.clients.forEach(client => {
            if (client.readyState === 1) { // WebSocket.OPEN
                this.send(client, message, serialized);
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

        const message = { type, payload };
        const serialized = JSON.stringify(message);
        let sent = 0;
        this.clients.forEach(client => {
            if (client.readyState === 1) {
                if (this.send(client, message, serialized)) sent += 1;
            }
        });
        return sent;
    }

    broadcastToRole(type, payload = {}, role = '') {
        if (this.clients.size === 0) return 0;
        const normalizedRole = String(role || '').trim().toLowerCase();
        const message = { type, payload };
        const serialized = JSON.stringify(message);
        let sent = 0;
        this.clients.forEach(client => {
            if (client.readyState !== 1) return;
            if (normalizedRole && client.clientRole !== normalizedRole) return;
            if (this.send(client, message, serialized)) sent += 1;
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
        for (const client of this.clients) {
            if (client.sessionCheckTimer) clearInterval(client.sessionCheckTimer);
            this.outbound.get(client)?.dispose();
            try { client.terminate(); } catch {}
        }
        this.outbound.clear();
        for (const wss of this.wssInstances) {
            try { wss.close(); } catch (error) { /* ignore */ }
        }
        this.wssInstances.clear();
        this.wss = null;
        this.clients.clear();
        this.sceneProjection=null;
        this.sceneProjectionOwner=null;
        console.log('[WebSocket] 服务已关闭');
    }
}

module.exports = WsServer;
