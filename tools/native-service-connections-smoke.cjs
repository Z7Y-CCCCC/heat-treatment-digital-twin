'use strict';
// Real WebView2/native bridge, but every process, cookie, pipe, HTTP endpoint,
// runtime-center launcher and channel belongs to this disposable fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRunDirectory, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const executable = requireTestPath(process.env.ADMIN_HOST_EXECUTABLE || path.join(root,
  'output/service-connections/native-build/AdminHost/HeatTreatmentAdminHost.exe'));
const directory = createRunDirectory('native-service-connections');
process.env.APP_DATA_DIR = path.join(directory, 'auth');
process.env.LICENSE_ENFORCE = 'false';
const { getAdminAuth } = require('../backend/services/adminAuth');
const { adminSessionCookieName, adminWebSocketCookieName } = require('../backend/middleware/security');
const WsServer = require('../backend/services/wsServer');
const { WebSocket } = require('../backend/node_modules/ws');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], proofs = [], results = new Map(), children = [], sockets = [], secrets = [];
let parent, host, appServer, desktopServer, untrustedServer, hub, cookieToken = '', overlayPlan = 'success', centerPlan = 'success';
let centerCalls = 0, centerSpawns = 0, ticketCalls = 0, confirmCalls = 0, sessionCalls = 0, pipeCalls = 0, untrustedHits = 0, foreignExecutions = 0;
const untrustedRequests = [];
const commands = { admin: [], overlay: [] };
const desktopToken = crypto.randomBytes(32).toString('hex'); secrets.push(desktopToken);
const pass = message => { checks.push(message); console.log('PASS ' + message); };
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    assert.ok(!host || host.exitCode === null, 'owned native host exited before completion');
    await delay(50);
  }
  throw Error('Timed out: ' + label);
}
const snapshotCounts = () => ({ centerCalls, centerSpawns, ticketCalls, confirmCalls, pipeCalls });
const fixtureHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>隔离服务连接宿主验收</title>
<body style="background:#f1f5f9">隔离 WebView2 服务连接验收，不连接现场系统。
<script>
const surface=location.pathname==='/overlay'?'overlay':'admin',loadId=crypto.randomUUID();let socket=null;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const proof=data=>fetch('/proof',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({surface,loadId,path:location.pathname,...data})});
window.__DIGITAL_TWIN_FINISH_LOADING__=()=>true;
window.addEventListener('error',e=>proof({kind:'page-error',message:e.message}));
window.chrome.webview.addEventListener('message',async e=>{
  const message=e.data;
  if(message.type==='service_connection_result'){await proof({kind:'result',message});return;}
  if(message.type!=='service_channel_reconnect'||surface!=='overlay')return;
  await proof({kind:'overlay-request',requestId:message.requestId});
  const plan=await fetch('/overlay-plan').then(r=>r.json());
  if(plan.kind==='inactive'){window.chrome.webview.postMessage({type:'service_channel_reconnect_result',requestId:message.requestId,success:false,channels:0});return;}
  // An unrelated id must not satisfy the native completion or bypass handshake.
  window.chrome.webview.postMessage({type:'service_channel_reconnect_result',requestId:'wrong-'+message.requestId,success:true,channels:99});
  if(socket){socket.onmessage=null;socket.close();}
  const fresh=new WebSocket(location.origin.replace('http:','ws:')+'/ws');socket=fresh;
  fresh.onopen=()=>fresh.send(JSON.stringify({type:'client_hello',role:'web'}));
  fresh.onmessage=async e=>{
    const event=JSON.parse(e.data);if(event.type!=='welcome'||fresh!==socket||fresh.readyState!==1)return;
    fresh.onmessage=null;await proof({kind:'overlay-handshake',requestId:message.requestId,at:Date.now()});
    await wait(700);
    window.chrome.webview.postMessage({type:'service_channel_reconnect_result',requestId:message.requestId,success:true,channels:1});
    await proof({kind:'overlay-confirmed',requestId:message.requestId});
  };
});
async function poll(){
  try{
    const command=await fetch('/next?surface='+surface,{cache:'no-store'}).then(r=>r.json());
    if(command.path){history.replaceState({},'',command.path);await wait(30);}
    if(command.message){window.chrome.webview.postMessage(command.message);await proof({kind:'sent',requestId:command.message.requestId});}
    if(command.restore){await wait(700);history.replaceState({},'','/admin');await proof({kind:'restored'});}
    if(command.navigate){location.assign(command.navigate);await wait(300);await proof({kind:'navigation-remaining'});}
  }catch(e){await proof({kind:'page-error',message:e.message});}
  setTimeout(poll,50);
}
proof({kind:'loaded',cookie:document.cookie});
window.chrome.webview.postMessage({type:'overlay_ready',pageReady:true,nativeSceneReady:true,loadId});
poll();
</script></body></html>`;

async function action(actionName, id) {
  commands.admin.push({ message: { type: 'service_connection_action', action: actionName, requestId: id } });
  await until(() => results.has(id), 'native result ' + id, 35000);
  return results.get(id);
}
async function sourceDenied(sourcePath, id) {
  const counts = snapshotCounts(), reads = sessionCalls;
  commands.admin.push({ path: sourcePath, restore: true,
    message: { type: 'service_connection_action', action: 'collector_center_data', requestId: id } });
  await until(() => proofs.some(proof => proof.kind === 'sent' && proof.requestId === id), 'untrusted path message sent');
  await delay(500);
  assert.equal(results.has(id), false, 'non-admin source receives no privileged result');
  assert.deepEqual(snapshotCounts(), counts); assert.equal(sessionCalls, reads, 'non-admin source is rejected before even reading session');
  await until(() => proofs.some(proof => proof.kind === 'restored' && proof.path === '/admin'), 'fixture restores admin URL');
}

async function main() {
  assert.equal(process.platform, 'win32', 'this smoke requires Windows WebView2');
  assert.ok(fs.existsSync(executable), 'compile the latest host into the isolated output directory first');
  const auth = getAdminAuth(), password = crypto.randomBytes(24).toString('base64url');
  let owner = await auth.setup(password, 'native-owned-source'); cookieToken = owner.token; secrets.push(owner.token);
  const express = require('../backend/node_modules/express'), app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use((request, response, next) => {
    if (request.path === '/api/admin-auth/native-ticket') ticketCalls++;
    if (request.path === '/api/admin-auth/native-confirm') confirmCalls++;
    if (request.path === '/api/admin-auth/session') sessionCalls++;
    next();
  });
  app.use('/api/admin-auth', require('../backend/routes/adminAuth')());
  app.get('/api/settings/loading-experience', (request, response) => response.json({ success: true, config: {} }));
  app.get('/next', (request, response) => {
    // Only HttpOnly cookies, never page JSON or JavaScript, contain this token.
    response.cookie(adminSessionCookieName(), cookieToken, { httpOnly: true, sameSite: 'strict', path: '/api' });
    response.json(commands[request.query.surface]?.shift() || {});
  });
  app.get('/overlay-plan', (request, response) => response.json({ kind: overlayPlan }));
  app.get('/foreign-executed', (request, response) => { foreignExecutions++; response.status(204).end(); });
  app.post('/proof', (request, response) => {
    proofs.push({ ...request.body, receivedAt: Date.now() });
    if (request.body.kind === 'result') results.set(request.body.message.requestId, request.body.message);
    response.status(204).end();
  });
  app.get(['/admin', '/overlay'], (request, response) => {
    response.cookie(adminSessionCookieName(), cookieToken, { httpOnly: true, sameSite: 'strict', path: '/api' });
    response.set('Cache-Control', 'no-store').type('html').send(fixtureHtml);
  });
  appServer = http.createServer(app); hub = new WsServer();
  hub.attach(appServer, { verifyClient: (info, done) => {
    const prefix = adminWebSocketCookieName() + '=';
    const value = String(info.req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    const token = value?.slice(prefix.length) || '';
    info.req.adminSessionToken = auth.status(token).displayAuthenticated ? token : '';
    done(true); // The unauthenticated overlay fixture receives no site telemetry.
  } });
  global.wsServer = hub;
  await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
  process.env.PORT = String(appServer.address().port);
  const origin = 'http://127.0.0.1:' + appServer.address().port;
  desktopServer = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers['x-desktop-control-token'] !== desktopToken) { response.writeHead(403).end('{"success":false}'); return; }
    if (request.url === '/service/collector-center') {
      centerCalls++;
      if (centerPlan === 'false_receipt') { response.end('{"success":true,"opened":false}'); return; }
      const executable = centerPlan === 'success' ? process.execPath : path.join(directory, 'does-not-exist.exe');
      const child = spawn(executable, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' }); children.push(child);
      const opened = await new Promise(resolve => { child.once('spawn', () => { centerSpawns++; resolve(true); }); child.once('error', () => resolve(false)); });
      response.end(JSON.stringify({ success: opened, opened })); return;
    }
    // Appearance/startup receipts are fixture-only; never accept restart here.
    if (request.url?.startsWith('/appearance/') || request.url === '/startup-ready') { response.end('{"success":true}'); return; }
    response.writeHead(404).end('{"success":false}');
  });
  await new Promise(resolve => desktopServer.listen(0, '127.0.0.1', resolve));
  untrustedServer = http.createServer((request, response) => {
    untrustedHits++; untrustedRequests.push({ url: request.url, method: request.method,
      purpose: request.headers['sec-purpose'] || request.headers.purpose || '', mode: request.headers['sec-fetch-mode'] || '' });
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><script>new Image().src=${JSON.stringify(origin + '/foreign-executed')};window.chrome?.webview?.postMessage({type:'service_connection_action',action:'collector_center_data',requestId:'foreign-origin-action'});</script>`);
  });
  await new Promise(resolve => untrustedServer.listen(0, '127.0.0.1', resolve));
  const parentSource = `const net=require('node:net');const server=net.createServer(socket=>{let data='';socket.on('data',chunk=>{data+=chunk;if(!data.includes('\\n'))return;try{const message=JSON.parse(data.split('\\n')[0]);process.send({kind:'unity-command',message});socket.end('ok\\n');}catch{socket.destroy();}})});server.listen('\\\\\\\\.\\\\pipe\\\\HeatTreatmentUnityAuth_'+process.pid,()=>process.send({kind:'ready'}));process.on('message',m=>{if(m==='stop'){server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),200).unref()}});setTimeout(()=>process.exit(0),120000).unref();`;
  parent = spawn(process.execPath, ['-e', parentSource], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let pipeReady = false, pipeError = false;
  parent.on('message', async message => {
    if (message.kind === 'ready') { pipeReady = true; return; }
    if (message.kind !== 'unity-command') return;
    pipeCalls++;
    try {
      assert.equal(message.message.action, 'sync_unity_session');
      const ticket = message.message.ticket; secrets.push(ticket);
      const child = auth.exchangeNativeTicket(ticket); secrets.push(child.token);
      const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: adminWebSocketCookieName() + '=' + child.token } });
      sockets.push(socket); await once(socket, 'open');
      socket.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
      socket.on('error', () => { pipeError = true; });
    } catch { pipeError = true; }
  });
  await until(() => pipeReady, 'disposable parent pipe ready');
  host = spawn(executable, ['--url', origin + '/admin?embedded=unity', '--parent-pid', String(parent.pid), '--parent-hwnd', '0',
    '--user-data', path.join(directory, 'webview2'), '--desktop-control-url',
    'http://127.0.0.1:' + desktopServer.address().port + '/', '--desktop-control-token', desktopToken],
  { windowsHide: true, stdio: 'ignore', cwd: path.dirname(executable) });
  await once(host, 'spawn');
  await until(() => ['admin', 'overlay'].every(surface => proofs.some(proof => proof.kind === 'loaded' && proof.surface === surface)), 'real admin and overlay WebView2 pages');
  assert.equal(proofs.filter(proof => proof.kind === 'loaded').every(proof => !proof.cookie), true, 'session cookies remain HttpOnly');
  const before = snapshotCounts();
  assert.equal((await action('run_arbitrary_shell', 'unknown-action')).success, false); assert.deepEqual(snapshotCounts(), before);
  auth.lock(owner.token, owner.status.csrfToken);
  assert.equal((await action('collector_center_data', 'locked-session')).success, false); assert.deepEqual(snapshotCounts(), before);
  owner = await auth.login(password, 'native-owned-unlock', owner.token); secrets.push(owner.token); cookieToken = owner.token;
  const user = await auth.createUser(owner.token, owner.status.csrfToken, { username: 'native_no_runtime', role: 'viewer', password,
    permissions: { view: false }, pagePermissions: { models: { view: true } } });
  const viewer = await auth.login(password, 'native-owned-viewer', '', user.username); secrets.push(viewer.token); cookieToken = viewer.token;
  assert.equal((await action('collector_center_data', 'no-runtime-grant')).success, false); assert.deepEqual(snapshotCounts(), before);
  cookieToken = owner.token;
  pass('unknown, locked and page-only unauthorized actions are rejected without desktop operations or native tickets');

  assert.equal((await action('collector_center_data', 'center-success')).opened, true);
  assert.equal(centerCalls, 1); assert.equal(centerSpawns, 1);
  centerPlan = 'failure'; assert.equal((await action('collector_center_runtime', 'center-failed-spawn')).success, false);
  assert.equal(centerCalls, 2); assert.equal(centerSpawns, 1);
  centerPlan = 'false_receipt'; assert.equal((await action('collector_center_runtime', 'center-not-opened')).success, false,
    'HTTP success without a positive opened receipt is not launcher success');
  assert.equal(centerCalls, 3); assert.equal(centerSpawns, 1);
  pass('runtime-center bridge reports a real disposable launcher spawn and refuses a failed launcher instead of claiming opened');

  const loadsBefore = proofs.filter(proof => proof.kind === 'loaded').length, channelStart = Date.now();
  const data = await action('data_reconnect', 'data-new-handshake');
  assert.equal(data.success, true); assert.equal(data.channels, 1, 'unrelated id with channels=99 cannot settle the result');
  assert.ok(Date.now() - channelStart >= 650, 'host waits for the newly handshaken channel confirmation');
  assert.ok(proofs.some(proof => proof.kind === 'overlay-handshake' && proof.requestId === 'data-new-handshake'));
  assert.equal(proofs.filter(proof => proof.kind === 'loaded').length, loadsBefore, 'data reconnect never reloads either WebView');
  overlayPlan = 'inactive'; assert.equal((await action('data_reconnect', 'data-no-active-channel')).success, false);
  pass('data reconnect crosses the real overlay bridge, matches request id and new WS handshake, never reloads and rejects no active channel');

  const unity = await action('unity_reconnect', 'unity-exact-child');
  assert.equal(unity.success, true); assert.equal(unity.connected, true); assert.equal(pipeCalls, 1);
  assert.equal(ticketCalls, 1); assert.ok(confirmCalls > 0); assert.equal(pipeError, false);
  pass('Unity reconnect uses the owned parent pipe, one-time actual native ticket exchange and exact-child backend confirmation');
  await sourceDenied('/admin-suffix', 'wrong-admin-path');
  await sourceDenied('/overlay', 'wrong-overlay-path');
  const deniedId = 'invalid id with spaces', countsBefore = snapshotCounts();
  commands.admin.push({ message: { type: 'service_connection_action', action: 'collector_center_data', requestId: deniedId } });
  await until(() => proofs.some(proof => proof.kind === 'sent' && proof.requestId === deniedId), 'invalid id sent'); await delay(500);
  assert.equal(results.has(deniedId), false); assert.deepEqual(snapshotCounts(), countsBefore);
  commands.admin.push({ navigate: 'http://127.0.0.1:' + untrustedServer.address().port + '/untrusted' });
  await until(() => proofs.some(proof => proof.kind === 'navigation-remaining'), 'foreign navigation blocked');
  await delay(1000);
  assert.equal(foreignExecutions, 0, 'foreign document code must not execute in the trusted WebView');
  assert.equal(results.has('foreign-origin-action'), false); assert.deepEqual(snapshotCounts(), countsBefore);
  assert.equal(untrustedHits, 0);
  pass('only exact same-origin /admin source and valid correlation ids reach service actions; foreign navigation is canceled');
  assert.deepEqual(proofs.filter(proof => proof.kind === 'page-error'), []);
  const proofText = JSON.stringify(proofs);
  const logFile = path.join(directory, 'logs/admin-host.log'), log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  for (const secret of secrets) { assert.equal(proofText.includes(secret), false); assert.equal(log.includes(secret), false); }
  pass('page messages and native logs contain no desktop token, session token or ticket');
  parent.send('stop');
  await until(() => parent.exitCode !== null && host.exitCode !== null, 'native host follows exact owned parent exit');
  assert.equal(parent.exitCode, 0); assert.equal(host.exitCode, 0);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, checks, counts: snapshotCounts(),
    scope: 'real isolated WebView2 bridge; no installed service, real Unity, dangerous restart prompt or UAC operation', directory }, null, 2));
  console.log('REPORT ' + directory);
}
main().catch(error => {
  let diagnostic = JSON.stringify({ success: false, checks, counts: snapshotCounts(), untrustedRequests, foreignExecutions, proofs, failure: error.stack, directory }, null, 2);
  for (const secret of secrets) diagnostic = diagnostic.split(secret).join('[REDACTED]');
  fs.writeFileSync(path.join(directory, 'report.json'), diagnostic);
  console.error(error.stack); process.exitCode = 1;
}).finally(async () => {
  if (parent?.connected) parent.send('stop');
  for (const socket of sockets) socket.terminate(); hub?.close(); global.wsServer = undefined;
  await Promise.all([host, parent, ...children].map(child => stopOwnedSmokeProcess(child)));
  for (const server of [appServer, desktopServer, untrustedServer]) {
    server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  }
});
