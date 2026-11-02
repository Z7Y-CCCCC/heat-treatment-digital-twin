// Six real loopback protocols/files. No production credentials, PLC writes, or production data.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), net = require('node:net'), dgram = require('node:dgram');
const { WebSocketServer } = require('ws'), mqttPacket = require('mqtt-packet');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp } = require('./integration-test-utils.cjs');
let backend, udpSender, interval; const servers = [], sockets = new Set(), checks = [], commands = [];
const sample = JSON.stringify({ temperature: 247.5, name: '车间温度' });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); }));
function track(socket) { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }
function parseResp(buffer) {
    const end = buffer.indexOf('\r\n'); if (end < 0) return null;
    const count = Number(buffer.subarray(1, end)); let cursor = end + 2; const values = [];
    for (let i = 0; i < count; i++) {
        const e = buffer.indexOf('\r\n', cursor); if (e < 0) return null;
        const length = Number(buffer.subarray(cursor + 1, e)); cursor = e + 2;
        if (buffer.length < cursor + length + 2) return null;
        values.push(buffer.subarray(cursor, cursor + length).toString()); cursor += length + 2;
    }
    return { values, cursor };
}
(async () => {
    const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise(resolve => ws.once('listening', resolve)); servers.push(ws);
    ws.on('connection', socket => { track(socket); socket.send(sample); });
    const tcpPort = await listen(net.createServer(socket => { track(socket); const bytes = Buffer.from(sample + '\n'); socket.write(bytes.subarray(0, 40)); setTimeout(() => { if (!socket.destroyed) socket.end(bytes.subarray(40)); }, 5); }));
    const mqttPort = await listen(net.createServer(socket => {
        track(socket); const parser = mqttPacket.parser(); socket.on('data', bytes => parser.parse(bytes));
        parser.on('error', () => socket.destroy()); parser.on('packet', packet => {
            commands.push('mqtt:' + packet.cmd);
            if (packet.cmd === 'connect') socket.write(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }));
            else if (packet.cmd === 'subscribe') { socket.write(mqttPacket.generate({ cmd: 'suback', messageId: packet.messageId, granted: [0] })); socket.write(mqttPacket.generate({ cmd: 'publish', topic: 'factory/telemetry', payload: sample, qos: 0, retain: true })); }
            else if (packet.cmd === 'pingreq') socket.write(mqttPacket.generate({ cmd: 'pingresp' }));
        });
    }));
    const redisPort = await listen(net.createServer(socket => {
        track(socket); let pending = Buffer.alloc(0);
        socket.on('data', bytes => {
            pending = Buffer.concat([pending, bytes]); let parsed;
            while ((parsed = parseResp(pending))) {
                pending = pending.subarray(parsed.cursor); const [command] = parsed.values; commands.push('redis:' + command.toUpperCase());
                if (command.toUpperCase() === 'GETRANGE') socket.write(`$${Buffer.byteLength(sample)}\r\n${sample}\r\n`);
                else socket.write(command.toUpperCase() === 'PING' ? '+PONG\r\n' : '+OK\r\n');
            }
        });
    }));
    const udpPort = await findFreePort(); udpSender = dgram.createSocket('udp4');
    interval = setInterval(() => udpSender.send(sample, udpPort, '127.0.0.1', () => {}), 15);
    const sandbox = await createSmokeSandbox('source-transports'), origin = 'http://127.0.0.1:' + await findFreePort();
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...sandbox.env, PORT: new URL(origin).port, HOST: '127.0.0.1', FRONTEND_DIST: path.resolve(__dirname, '../../frontend/dist') }, logFile: path.join(sandbox.directory, 'backend.log') }); await waitForHttp(origin + '/api/health');
    let factoryId; const api = async (route, method = 'GET', body, status = 200) => {
        const response = await fetch(origin + '/api' + route, { method, headers: { 'X-Admin-Token': sandbox.env.ADMIN_API_TOKEN, ...(factoryId ? { 'X-Factory-ID': factoryId } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
        const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
    };
    factoryId = (await api('/factories')).factories[0].id;
    const definitions = [['websocket', 'ws://127.0.0.1:' + ws.address().port, '/'], ['mqtt', 'mqtt://127.0.0.1:' + mqttPort, 'factory/telemetry'], ['tcp', 'tcp://127.0.0.1:' + tcpPort, '/'], ['udp', 'udp://127.0.0.1:' + udpPort, '/'], ['redis', 'redis://127.0.0.1:' + redisPort + '/0', 'telemetry']];
    const form = new FormData(); form.set('dataFile', new Blob([sample], { type: 'application/json' }), 'owned-sample.json');
    const imported = await api('/data-sources/files', 'POST', form); definitions.push(['file', imported.file.asset, '/']);
    const ids = [];
    for (const [connector, baseUrl, healthPath] of definitions) {
        const config = { name: connector + ' owned fixture', sourceType: 'http_api', type: 'http_api', connector, baseUrl, healthPath, authType: 'none', responseFormat: 'json', enabled: true, requestTimeoutMs: 3000 };
        const tested = await api('/data-sources/test', 'POST', config); assert.equal(tested.success, true, JSON.stringify(tested));
        const saved = await api('/data-sources/connections', 'POST', { ...config, healthToken: tested.healthToken }); const id = saved.connection.id; ids.push(id);
        assert.equal(saved.connection.connector, connector); assert.equal(saved.connection.health.status, 'healthy');
        const fields = await api('/data-sources/inspect-http', 'POST', { connectionId: id, apiPath: '/' }); assert.ok(fields.result.fields.some(field => field.path === 'temperature'));
        const preview = await api('/data-sources/preview-http', 'POST', { connectionId: id, apiPath: '/', jsonPath: 'temperature' }); assert.equal(preview.result.value, 247.5);
        checks.push(connector + ': test/save/inspect/sample through real HTTP APIs and actual protocol traffic');
    }
    const csv = new FormData(); csv.set('dataFile', new Blob(['time,value\n1,12.5\n2,16\n']), 'owned.csv');
    const csvFile = await api('/data-sources/files', 'POST', csv);
    const savedCsv = await api('/data-sources/connections', 'POST', { name: 'CSV', sourceType: 'http_api', connector: 'file', baseUrl: csvFile.file.asset, healthPath: '/', enabled: true });
    const csvPreview = await api('/data-sources/preview-http', 'POST', { connectionId: savedCsv.connection.id, apiPath: '/', jsonPath: 'rows[0].value' }); assert.equal(String(csvPreview.result.value), '12.5');
    await api('/data-sources/connections', 'POST', { name: 'Rejected path', sourceType: 'http_api', connector: 'file', baseUrl: '../../admin-auth.json', healthPath: '/' }, 400);
    await api('/data-sources/connections', 'POST', { name: 'Rejected credentials', sourceType: 'http_api', connector: 'mqtt', baseUrl: 'mqtt://USER:TOKEN@localhost:1883', healthPath: 'test' }, 400);
    const backups = await api('/data-sources/backups/status'); assert.ok(backups.status.connections.every(connection => !ids.includes(connection.id)));
    assert.ok(commands.filter(command => command.startsWith('mqtt:')).every(command => !command.endsWith(':publish')));
    assert.ok(commands.filter(command => command.startsWith('redis:')).every(command => ['HELLO', 'CLIENT', 'AUTH', 'SELECT', 'PING', 'GETRANGE'].includes(command.split(':')[1])), JSON.stringify(commands));
    checks.push('CSV file fields read correctly; arbitrary file paths and URL credentials rejected; no MQTT publish or Redis write command; adapters excluded from SQL backups');
    const backup = await api('/site-backups/export', 'POST'); assert.equal(backup.success, true);
    const archive = path.join(sandbox.directory, 'data/site-backups', backup.backup.filename);
    const importedPath = path.join(sandbox.directory, 'data/data-source-files', factoryId, imported.file.asset);
    fs.unlinkSync(importedPath);
    const restoreForm = new FormData(); restoreForm.set('backup', new Blob([fs.readFileSync(archive)]), backup.backup.filename);
    const restored = await api('/site-backups/import', 'POST', restoreForm); assert.equal(restored.success, true);
    assert.equal(fs.readFileSync(importedPath, 'utf8'), sample);
    const restoredFile = await api('/data-sources/preview-http', 'POST', { connectionId: ids.at(-1), apiPath: '/', jsonPath: 'temperature' }); assert.equal(restoredFile.result.value, 247.5);
    checks.push('site backup restores the private imported file and its working connection, not just an orphaned filename');
    const silentPort = await listen(net.createServer(track));
    const started = Date.now();
    const timeout = await api('/data-sources/test', 'POST', { name: 'silent Redis', sourceType: 'http_api', connector: 'redis', baseUrl: 'redis://127.0.0.1:' + silentPort + '/0', healthPath: 'sample', requestTimeoutMs: 1000 });
    assert.equal(timeout.success, false); assert.equal(timeout.health.status, 'timeout'); assert.ok(Date.now() - started < 5000, 'Redis protocol handshake must also be timeout bounded');
    const oversizedWs = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise(resolve => oversizedWs.once('listening', resolve)); servers.push(oversizedWs);
    oversizedWs.on('connection', socket => { track(socket); socket.send(Buffer.alloc(270000, 65)); });
    const oversized = await api('/data-sources/connections', 'POST', { name: 'oversized sample', sourceType: 'http_api', connector: 'websocket', baseUrl: 'ws://127.0.0.1:' + oversizedWs.address().port, healthPath: '/', requestTimeoutMs: 1000 });
    const failedPreview = await api('/data-sources/inspect-http', 'POST', { connectionId: oversized.connection.id, apiPath: '/' }, 400); assert.ok(failedPreview.error);
    const bom = new FormData(); bom.set('dataFile', new Blob(['\uFEFF' + sample]), 'bom.json');
    const bomFile = await api('/data-sources/files', 'POST', bom); const bomConnection = await api('/data-sources/connections', 'POST', { name: 'BOM file', sourceType: 'http_api', connector: 'file', baseUrl: bomFile.file.asset, healthPath: '/' });
    const bomPreview = await api('/data-sources/preview-http', 'POST', { connectionId: bomConnection.connection.id, apiPath: '/', jsonPath: 'temperature' }); assert.equal(bomPreview.result.value, 247.5);
    checks.push('silent Redis handshake times out; oversized WebSocket payload is rejected; UTF-8 BOM imports remain readable');
    const result = { success: true, checks, directory: sandbox.directory }; fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    clearInterval(interval); udpSender?.close(); await stopOwnedSmokeProcess(backend);
    for (const socket of sockets) { if (socket.terminate) socket.terminate(); else socket.destroy(); }
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});
