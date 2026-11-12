'use strict';
// Read-only, bounded diagnostics. Never changes the configured connection,
// starts/stops the collector, sends PLC commands, or returns raw health secrets.
const http = require('node:http'), https = require('node:https');
const { normalizeDeployment } = require('./deployment.cjs');
const age = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => age(value) === null ? 0 : Math.floor(value);

function summarizeCollectorConnection(health, { address, latencyMs, checkedAt = Date.now() } = {}) {
    const identity = health?.runtime;
    if (health?.status !== 'ok' || identity?.role !== 'collector' || identity?.owner !== 'windows-service' || identity?.serviceName !== 'HeatTreatmentCollector') {
        return { state:'wrong-service', address, checkedAt, latencyMs, transport:'服务身份不匹配', collection:'未验证', message:'该地址不是独立采集服务，未切换连接或使用模拟数据。' };
    }
    const observed = health.collectorHealth, link = health.components?.displayConnection;
    const databaseReady = health.db?.connected === true;
    const license = health.version?.license;
    const licensed = !license?.enforce || license.valid === true;
    const modes = (Array.isArray(health.collectorFactories) ? health.collectorFactories : []).map(value => value?.mode);
    const simulated = observed?.state === 'simulation' || modes.includes('simulation') || health.engine?.mode === 'simulation';
    const state = !databaseReady || !licensed ? 'degraded' : observed?.state === 'simulation' ? 'simulation' : observed?.state === 'healthy' ? 'online' : 'degraded';
    return {
        state, address, checkedAt, latencyMs, transport:'服务接口可达',
        collection: !licensed ? '等待正式激活' : !databaseReady ? '数据库异常' : typeof observed?.label === 'string' ? observed.label.slice(0, 80) : '采集状态未知',
        database: databaseReady ? '已连接' : '异常', lastSampleAgeMs: age(observed?.lastSampleAgeMs),
        display: link ? { status:['online', 'stale', 'offline'].includes(link.status) && (link.status !== 'online' || count(link.connectedClients) > 0) ? link.status : 'unknown',
            clients:count(link.clients), connectedClients:count(link.connectedClients), sceneReadyClients:Math.min(count(link.connectedClients), count(link.sceneReadyClients)), ageMs:age(link.ageMs) } : null,
        message: (!licensed ? '授权未就绪；仅检测状态，不绕过激活。' : '接口可达、实时通道和采集质量分别判断；断开不会切换数据库或模拟数据。')
            + (simulated ? ' 当前含模拟演示数据，不代表已连接现场 PLC。' : '')
    };
}

async function probeCollectorConnection(raw, { timeoutMs = 3000 } = {}) {
    const config = normalizeDeployment(raw);
    const checkedAt = Date.now();
    if (config.mode !== 'client') return { state:'independent', checkedAt, address:'', transport:'独立展示模式', collection:'未连接独立采集服务', display:null, message:'此模式不进行 PLC 采集，也不以本机展示后端冒充采集服务。' };
    const address = config.backendOrigin, started = Date.now();
    try {
        const health = await new Promise((resolve, reject) => {
            const url = new URL('/api/health', address), transport = url.protocol === 'https:' ? https : http;
            let request, timer, settled = false;
            const fail = error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); request?.destroy(); };
            request = transport.get(url, { headers:{ Accept:'application/json' } }, response => {
                if (response.statusCode !== 200) { response.resume(); fail(new Error(`HTTP ${response.statusCode}`)); return; }
                let bytes = 0, chunks = [];
                response.on('data', chunk => { if (settled) return; bytes += chunk.length; if (bytes > 1024 * 1024) { fail(new Error('健康响应过大')); return; } chunks.push(chunk); });
                response.on('aborted', () => fail(new Error('健康响应中断')));
                response.on('error', fail);
                response.on('end', () => { if (settled) return; try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); settled = true; clearTimeout(timer); resolve(value); } catch { fail(new Error('健康响应格式无效')); } });
            });
            timer = setTimeout(() => fail(new Error('检测超时')), Math.min(3000, Math.max(20, timeoutMs)));
            request.on('error', fail);
        });
        return summarizeCollectorConnection(health, { address, checkedAt:Date.now(), latencyMs:Date.now()-started });
    } catch (error) {
        return { state:'offline', address, checkedAt:Date.now(), latencyMs:null, transport:'采集服务不可达', collection:'未获取到数据状态', display:null,
            message: /HTTP \d+|检测超时|健康响应/.test(error.message) ? error.message : '连接失败，请检查服务是否运行、地址和网络；未自动切换数据源。' };
    }
}
module.exports = { probeCollectorConnection, summarizeCollectorConnection };
