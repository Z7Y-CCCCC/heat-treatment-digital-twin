'use strict';
// Explicit offline repair, not a normal app startup. Never serves or fetches
// business UI, exports cookies, clears storage, or changes the old origin.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const requestFile = process.argv[process.argv.indexOf('--request') + 1];
if (!requestFile || !process.argv.includes('--request')) throw Error('Recovery request required');
const request = JSON.parse(fs.readFileSync(requestFile, 'utf8').replace(/^\uFEFF/, ''));
function validate(origin) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) < 1024 || url.origin !== origin || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
        throw Error('Only exact loopback origins allowed');
    return origin + '/__local_origin_recovery__';
}
const oldUrl = validate(request.OldOrigin), newUrl = validate(request.NewOrigin);
if (oldUrl === newUrl || !path.isAbsolute(request.Profile) || !path.isAbsolute(request.Output)) throw Error('Invalid recovery request');
if (request.SelfTest && !path.resolve(request.Profile).startsWith(path.resolve(request.Output) + path.sep)) throw Error('Fixture must stay in test output');
app.setPath('userData', request.Profile);
app.commandLine.appendSwitch('disable-http-cache');
const read = name => fs.readFileSync(path.resolve(__dirname, '../../desktop/ui-origin', name), 'utf8');
let window;
const watchdog = setTimeout(() => app.exit(1), 90000);
app.whenReady().then(async () => {
    fs.mkdirSync(request.Output, { recursive: true });
    const allowed = new Set([oldUrl, newUrl]);
    session.defaultSession.protocol.handle('http', event => new Response('<!doctype html><title>Offline origin recovery</title>', {
        status: allowed.has(event.url) ? 200 : 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; connect-src 'none'" }
    }));
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!allowed.has(url)) event.preventDefault(); });
    await window.loadURL(oldUrl);
    if (request.SelfTest) await window.webContents.executeJavaScript("localStorage.setItem('dashboard-designer-draft:fixture', '草稿<\\\"\\\\>'); localStorage.setItem('reading','18')");
    const source = await window.webContents.executeJavaScript(read('snapshot.js') + '()');
    fs.writeFileSync(path.join(request.Output, 'source-local-storage.json'), JSON.stringify(source));
    if (source.indexedDbCount !== 0) throw Error('Source has IndexedDB; explicit migration required');
    await window.loadURL(newUrl);
    const target = await window.webContents.executeJavaScript(read('snapshot.js') + '()');
    fs.writeFileSync(path.join(request.Output, 'target-local-storage-before.json'), JSON.stringify(target));
    const transfer = await window.webContents.executeJavaScript(read('transfer.js') + '(' + JSON.stringify(source.entries) + ')');
    if (transfer?.success !== true) throw Error('Destination conflict or write failure');
    const actual = new Map((await window.webContents.executeJavaScript(read('snapshot.js') + '()')).entries);
    if (source.entries.some(([key, value]) => actual.get(key) !== value)) throw Error('Readback mismatch');
    await window.loadURL(oldUrl);
    const sourceAfter = await window.webContents.executeJavaScript(read('snapshot.js') + '()');
    if (JSON.stringify(sourceAfter.entries) !== JSON.stringify(source.entries)) throw Error('Source changed during recovery');
    session.defaultSession.flushStorageData();
    fs.writeFileSync(path.join(request.Output, 'result.json'), JSON.stringify({ success: true, engine: 'Electron',
        sourceCount: source.entries.length, verifiedCount: transfer.verified, sourceUnmodified: true, networkRequests: 0,
        sourceSha256: crypto.createHash('sha256').update(JSON.stringify(source.entries)).digest('hex') }));
    window.destroy(); clearTimeout(watchdog); app.quit();
}).catch(error => {
    fs.mkdirSync(request.Output, { recursive: true });
    fs.writeFileSync(path.join(request.Output, 'failure.json'), JSON.stringify({ success: false, reason: error.message }));
    console.error('Electron origin migration failed; source retained; inspect local failure report');
    if (window && !window.isDestroyed()) window.destroy(); clearTimeout(watchdog); app.exit(1);
});
