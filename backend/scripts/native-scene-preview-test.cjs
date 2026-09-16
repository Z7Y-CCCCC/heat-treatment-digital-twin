const WebSocket = require('ws');

const port = Number(process.env.PORT || 3001);
const baseUrl = `http://127.0.0.1:${port}`;
const managementHeaders = {
    'Content-Type': 'application/json',
    ...(process.env.ADMIN_API_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_API_TOKEN } : {}),
    ...(process.env.MCP_API_TOKEN ? { 'X-MCP-Token': process.env.MCP_API_TOKEN } : {})
};

function waitForEvent(socket, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`未收到 ${type}`)), timeoutMs);
        const onMessage = raw => {
            const message = JSON.parse(String(raw));
            if (message.type !== type) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(message);
        };
        socket.on('message', onMessage);
    });
}

async function main() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));

    const contextPayload = {
        viewId: 'device_part',
        sceneReady: true,
        viewMode: 'device',
        sceneId: 'scene_factory_overview',
        workshopId: 'workshop_preview',
        lineId: 'preview_line',
        deviceId: 'preview_device',
        inspectionStage: 'part',
        partId: 'front_door_open',
        partName: '前门组件',
        partDescription: '前室升降门与驱动组件',
        partPointIds: ['557'],
        partPointKeys: ['doors.front_door_open'],
        partDetailViewId: 'device_part'
    };
    const pongPromise = waitForEvent(socket, 'pong');
    socket.send(JSON.stringify({ type: 'dashboard_context', payload: contextPayload }));
    socket.send(JSON.stringify({ type: 'ping' }));
    await pongPromise;

    const webSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Web 数据层连接超时')), 5000);
        webSocket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        webSocket.once('error', reject);
    });
    const contextEventPromise = waitForEvent(webSocket, 'dashboard_context_changed');
    webSocket.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
    const contextEvent = await contextEventPromise;
    if (contextEvent.payload?.inspectionStage !== 'part') throw new Error('设备检查阶段未转发到 Web 数据层');
    if (contextEvent.payload?.partName !== '前门组件') throw new Error('部件名称未转发到 Web 数据层');
    if (contextEvent.payload?.partPointIds?.[0] !== '557') throw new Error('部件点位 ID 未转发到 Web 数据层');
    if (contextEvent.payload?.partPointKeys?.[0] !== 'doors.front_door_open') throw new Error('部件点位键未转发到 Web 数据层');

    const eventPromise = waitForEvent(socket, 'native_scene_preview');
    const response = await fetch(`${baseUrl}/api/native-preview`, {
        method: 'POST',
        headers: managementHeaders,
        body: JSON.stringify({
            action: 'apply',
            sessionId: 'native-preview-test',
            sequence: 7,
            source: 'test',
            includeLayout: true,
            devices: [{
                id: 'preview_device',
                name: '预览设备',
                model_type: 'builtin_furnace',
                pos_x: 12.5,
                pos_y: 0,
                pos_z: -3.5,
                rotation_y: 1.5708,
                scale: 1.2,
                instance_config: { mirrorX: true }
            }, {
                id: 'pending_preview_device',
                name: '待放置产线设备',
                line_id: 'pending_preview_line',
                model_type: 'builtin_furnace',
                pos_x: 0,
                pos_y: 0,
                pos_z: 0
            }],
            lines: [{
                id: 'preview_line',
                layout: {
                    flowDirection: 'left',
                    lanes: [{ id: 'lane_1', name: '设备线 1', offsetZ: -5, length: 72 }],
                    rails: [{ id: 'rail_1', name: '导轨 1', offsetZ: 2, length: 60 }]
                }
            }, {
                id: 'pending_preview_line',
                layout: {
                    placementPending: true,
                    lanes: [{ id: 'lane_1', name: '设备线 1', offsetZ: 0, length: 60 }],
                    rails: []
                }
            }],
            focus: { mode: 'device', deviceId: 'preview_device' }
        })
    });
    const result = await response.json();
    const event = await eventPromise;
    if (!result.success || result.unityClients < 1) throw new Error('Unity 客户端计数不正确');
    if (event.payload?.devices?.[0]?.pos_x !== 12.5) throw new Error('设备实时位置未正确转发');
    if (event.payload?.lines?.[0]?.layout_json?.rails?.[0]?.length !== 60) throw new Error('产线布局未正确转发');
    if (event.payload?.lines?.some(line => line.id === 'pending_preview_line')) throw new Error('待放置产线不应进入 Unity 实时预览');
    if (event.payload?.devices?.some(device => device.id === 'pending_preview_device')) throw new Error('待放置产线设备不应进入 Unity 实时预览');

    const returnEventPromise = waitForEvent(socket, 'native_scene_preview');
    const returnResponse = await fetch(`${baseUrl}/api/native-preview`, {
        method: 'POST',
        headers: managementHeaders,
        body: JSON.stringify({
            action: 'focus',
            source: 'dashboard_overlay',
            focus: { mode: 'line', lineId: '' }
        })
    });
    const returnResult = await returnResponse.json();
    const returnEvent = await returnEventPromise;
    if (!returnResult.success || returnEvent.payload?.focus?.mode !== 'line') {
        throw new Error('返回产线视角指令未正确转发');
    }

    const cleanupPongPromise = waitForEvent(socket, 'pong');
    socket.send(JSON.stringify({
        type: 'dashboard_context',
        payload: {
            viewId: 'factory_overview',
            sceneReady: true,
            viewMode: 'factory',
            sceneId: 'scene_factory_overview',
            workshopId: '',
            lineId: '',
            deviceId: '',
            inspectionStage: '',
            partId: '',
            partName: '',
            partDescription: '',
            partPointIds: [],
            partPointKeys: [],
            partDetailViewId: ''
        }
    }));
    socket.send(JSON.stringify({ type: 'ping' }));
    await cleanupPongPromise;

    socket.close();
    webSocket.close();
    console.log(JSON.stringify({
        success: true,
        type: event.type,
        action: event.payload.action,
        unityClients: result.unityClients,
        deviceX: event.payload.devices[0].pos_x,
        lineId: event.payload.lines[0].id,
        returnMode: returnEvent.payload.focus.mode,
        inspectionStage: contextEvent.payload.inspectionStage,
        partName: contextEvent.payload.partName
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
