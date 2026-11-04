'use strict';
// Loopback-only, in-memory process/part API for repeatable dashboard acceptance.
const http = require('node:http');
async function createLatencyHttpFixture(port = 0) {
    const state = { epoch: 0, fail: false, delayMs: 0 }, requests = [];
    const server = http.createServer(async (req, res) => {
        try {
            let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw Error('body too large'); }
            const url = new URL(req.url, 'http://fixture'), body = raw ? JSON.parse(raw) : {};
            const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
            if (url.pathname === '/health') return reply(200, { ok: true });
            if (url.pathname === '/control') {
                if (req.method === 'POST') {
                    if (body.epoch !== undefined) state.epoch = Number(body.epoch);
                    if (body.fail !== undefined) state.fail = !!body.fail;
                    if (body.delayMs !== undefined) state.delayMs = Math.max(0, Math.min(5000, Number(body.delayMs)));
                }
                return reply(200, { ...state, requests: requests.length });
            }
            if (url.pathname !== '/read') return reply(404, { error: 'not found' });
            const device = body.device || url.searchParams.get('device') || 'latency_cleaner';
            const part = body.part || url.searchParams.get('part') || '';
            const snapshot = { ...state }, base = 7000 + snapshot.epoch + (part === 'part_b' ? 100 : 0);
            const rows = [0, 1, 2].map(i => ({ id: device, name: part || device, value: base + i, temp: base + i,
                pressure: base / 10 + i, running: true, online: true, alarm: false, description: '本地接口联调',
                time: `采样${i + 1}`, msg: `接口序号${base + i}`, level: 'info', epoch: snapshot.epoch }));
            const entry = { method: req.method, device, part, epoch: snapshot.epoch, receivedAt: Date.now() }; requests.push(entry);
            if (snapshot.delayMs) await new Promise(r => setTimeout(r, snapshot.delayMs));
            entry.repliedAt = Date.now(); entry.status = snapshot.fail ? 503 : 200;
            return reply(entry.status, snapshot.fail ? { error: 'injected fixture outage' } : { rows });
        } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return { state, requests, origin: `http://127.0.0.1:${server.address().port}`,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createLatencyHttpFixture };
// Preserve an existing JSON-export contract while making its values dynamic.
async function createReferenceJsonFixture(payload, port = 0) {
    const state = { epoch: 0, fail: false }, requests = [];
    const server = http.createServer((req, res) => {
        const epoch = state.epoch;
        function update(value) {
            if (Array.isArray(value)) return value.map(update);
            if (!value || typeof value !== 'object') return value;
            const out = Object.fromEntries(Object.entries(value).map(([key, v]) => [key, update(v)]));
            if (typeof out.reading === 'number') out.reading = 90000 + epoch;
            if (typeof out.msg === 'string') out.msg += ` · API_EPOCH_${epoch}`;
            return out;
        }
        requests.push({ receivedAt: Date.now(), epoch, method: req.method, path: req.url, status: state.fail ? 503 : 200 });
        res.writeHead(state.fail ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(state.fail ? { error: 'injected outage' } : update(payload)));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return { state, requests, origin: `http://127.0.0.1:${server.address().port}`,
        async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports.createReferenceJsonFixture = createReferenceJsonFixture;
if (require.main === module) createLatencyHttpFixture(Number(process.env.PORT || 0)).then(f => console.log(JSON.stringify({ origin: f.origin, read: '/read?device=latency_cleaner', control: '/control' })));
