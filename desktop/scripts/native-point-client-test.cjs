const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const project = path.resolve(__dirname, '../..');
const output = path.join(project, 'output', 'collector-center-native-tests');
fs.mkdirSync(output, { recursive: true });
(async () => {
    let reads = 0;
    const calls = [], point = { label: '温度-原配置', plc_tag: 'DB1,REAL0', data_type: 'REAL', value: 0, quality: 'good' };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost'); calls.push({ method: req.method, path: url.pathname });
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/admin-auth/login') {
            assert.equal(req.headers['x-admin-request'], '1'); assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
            let body = ''; for await (const part of req) body += part;
            assert.equal(JSON.parse(body).username, 'fixture');
            res.setHeader('Set-Cookie', 'fixture_session=authorized; HttpOnly; Path=/api; SameSite=Strict');
            res.end(JSON.stringify({ authenticated: true, csrfToken: 'fixture-csrf' })); return;
        }
        if (!req.headers.cookie?.includes('fixture_session=authorized')) { res.writeHead(401); res.end('{"error":"auth required"}'); return; }
        if (url.pathname === '/api/admin-auth/accounts/logout') {
            assert.equal(req.headers['x-csrf-token'], 'fixture-csrf'); res.end('{"success":true}'); return;
        }
        if (url.pathname === '/api/factories') return res.end('{"activeFactoryId":"factory-1","factories":[{"id":"factory-1","name":"工厂"}]}');
        if (url.pathname === '/api/devices') return res.end('[{"id":"device-1","name":"炉1"}]');
        if (url.pathname === '/api/plc/points/realtime') {
            assert.equal(url.searchParams.get('factory_id'), 'factory-1'); assert.equal(url.searchParams.get('device_id'), 'device-1');
            res.end(JSON.stringify({ points: [point] }));
            if (++reads === 1) { point.label = '温度-后台新配置'; point.plc_tag = 'DB2,REAL8'; point.value = 12.5; }
            return;
        }
        res.writeHead(404); res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const report = path.join(output, `point-client-${Date.now()}.json`);
        const child = spawn(path.join(project, 'desktop/.cache/collector-center/HeatTreatmentCollectorCenter.exe'),
            ['--point-api-test', `http://127.0.0.1:${server.address().port}`, report],
            { windowsHide: true, env: { ...process.env, NATIVE_TEST_USER: 'fixture', NATIVE_TEST_PASSWORD: 'fixture-only' } });
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        const data = JSON.parse(fs.readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
        assert.equal(code, 0, JSON.stringify(data));
        assert.equal(data.before[0].Name, '温度-原配置'); assert.equal(data.before[0].Value, '0');
        assert.equal(data.after[0].Name, '温度-后台新配置'); assert.equal(data.after[0].Address, 'DB2,REAL8'); assert.equal(data.after[0].Value, '12.5');
        assert.ok(calls.every(c => c.method === 'GET' || c.path.startsWith('/api/admin-auth/')));
        console.log(JSON.stringify({ success: true, sameBackendConfiguration: true, automaticReloadObservesChanges: true,
            existingCookieAuthAndCsrf: true, noConfigurationWrites: true, report }, null, 2));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
