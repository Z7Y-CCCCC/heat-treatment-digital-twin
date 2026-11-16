'use strict';
// Run before any business navigation. Intercept offline pages locally: an
// unrelated listener owning the old port must never receive drafts or requests.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const markerName = 'ui-origin-migration.json';
const nativeFiles = ['HeatTreatmentAdminHost.exe', 'HeatTreatmentAdminHost.dll'];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function writeUiOriginRecoveryMarker(directory) {
    fs.writeFileSync(path.join(directory, markerName), JSON.stringify({ version: 1,
        files: Object.fromEntries(nativeFiles.map(name => [name, digest(path.join(directory, name))])) }));
}
function verifyUiOriginRecoveryResources(directory) {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, markerName), 'utf8'));
    if (marker.version !== 1 || nativeFiles.some(name => marker.files?.[name] !== digest(path.join(directory, name))))
        throw Error('后台宿主缺少匹配的本地草稿迁移能力，请更新完整程序资源');
}
function offlineUrl(origin) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) < 1024
        || url.origin !== origin || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
        throw Error('Invalid loopback UI origin');
    return origin + '/__local_origin_recovery__';
}
function validateReceipt(value, engine) {
    if (value?.success !== true || value.engine !== engine || value.sourceUnmodified !== true
        || !Number.isInteger(value.sourceCount) || value.sourceCount < 0 || value.sourceCount !== value.verifiedCount)
        throw Error('本地草稿迁移校验未通过，原数据保留');
    return value;
}
async function migrateElectronUiOrigin({ BrowserWindow, browserSession, migration, output }) {
    const oldUrl = offlineUrl(migration.fromOrigin), newUrl = offlineUrl(migration.toOrigin);
    if (oldUrl === newUrl) throw Error('Identical migration origins');
    const read = name => fs.readFileSync(path.join(__dirname, 'ui-origin', name), 'utf8');
    fs.mkdirSync(output, { recursive: true });
    let window, handled = false, timer;
    try {
        await browserSession.protocol.handle('http', event => new Response('<!doctype html><title>Offline storage recovery</title>', {
            status: [oldUrl, newUrl].includes(event.url) ? 200 : 403,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'none'; connect-src 'none'" }
        }));
        handled = true;
        window = new BrowserWindow({ show: false, webPreferences: { session: browserSession,
            sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => { if (![oldUrl, newUrl].includes(url)) event.preventDefault(); });
        const operation = async () => {
            const snapshot = () => window.webContents.executeJavaScript(read('snapshot.js') + '()');
            await window.loadURL(oldUrl);
            const source = await snapshot();
            fs.writeFileSync(path.join(output, 'source-local-storage.json'), JSON.stringify(source), { mode: 0o600 });
            if (source.indexedDbCount !== 0) throw Error('源地址包含 IndexedDB，需单独迁移；原数据保留');
            await window.loadURL(newUrl);
            const target = await snapshot();
            fs.writeFileSync(path.join(output, 'target-local-storage-before.json'), JSON.stringify(target), { mode: 0o600 });
            const transfer = await window.webContents.executeJavaScript(read('transfer.js') + '(' + JSON.stringify(source.entries) + ')');
            if (transfer?.success !== true) throw Error('目标地址草稿冲突或写入失败，未覆盖原内容');
            const actual = new Map((await snapshot()).entries);
            if (source.entries.some(([key, value]) => actual.get(key) !== value)) throw Error('草稿迁移回读不一致');
            await window.loadURL(oldUrl);
            if (JSON.stringify((await snapshot()).entries) !== JSON.stringify(source.entries)) throw Error('迁移期间原地址内容发生变化');
            browserSession.flushStorageData();
            const result = validateReceipt({ success: true, engine: 'Electron', sourceCount: source.entries.length,
                verifiedCount: transfer.verified, sourceUnmodified: true, networkRequests: 0,
                sourceSha256: crypto.createHash('sha256').update(JSON.stringify(source.entries)).digest('hex') }, 'Electron');
            fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result), { mode: 0o600 });
            return result;
        };
        return await Promise.race([operation(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('本地草稿迁移超时，原内容保留')), 90000);
        })]);
    } finally {
        clearTimeout(timer);
        if (window && !window.isDestroyed()) window.destroy();
        if (handled) await browserSession.protocol.unhandle('http');
    }
}
async function recoverUiOrigin({ BrowserWindow, browserSession, profileRoot, migration, nativeHostExecutable }) {
    offlineUrl(migration.fromOrigin); offlineUrl(migration.toOrigin);
    if (migration.fromOrigin === migration.toOrigin || !path.isAbsolute(profileRoot)) throw Error('Invalid UI recovery');
    const nativeDir = path.dirname(nativeHostExecutable);
    // An old executable would ignore the new flag and open the normal app.
    // Require a build-generated matching capability marker before launching it.
    verifyUiOriginRecoveryResources(nativeDir);
    const backup = path.join(profileRoot, 'recovery', 'ui-origin-' + Date.now() + '-' + crypto.randomUUID());
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const output = path.join(backup, 'WebView2'), requestFile = path.join(backup, 'request.json');
    const fixedRuntime = path.join(nativeDir, 'WebView2Runtime');
    fs.writeFileSync(requestFile, JSON.stringify({ Profile: path.join(profileRoot, 'webview2'),
        OldOrigin: migration.fromOrigin, NewOrigin: migration.toOrigin, Output: output,
        ...(fs.existsSync(fixedRuntime) ? { FixedRuntime: fixedRuntime } : {}) }), { mode: 0o600, flag: 'wx' });
    try {
        await new Promise((resolve, reject) => execFile(nativeHostExecutable, ['--migrate-ui-origin', requestFile],
            { windowsHide: true, timeout: 120000 }, (error, stdout, stderr) => {
                fs.writeFileSync(path.join(backup, 'native-recovery.log'), (stdout || '') + (stderr || ''), { mode: 0o600 });
                if (error) reject(Error('WebView2 本地草稿迁移未完成')); else resolve();
            }));
        const native = validateReceipt(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')), 'WebView2');
        const electron = await migrateElectronUiOrigin({ BrowserWindow, browserSession, migration, output: path.join(backup, 'Electron') });
        const receipt = { success: true, fromOrigin: migration.fromOrigin, toOrigin: migration.toOrigin, native, electron };
        fs.writeFileSync(path.join(backup, 'result.json'), JSON.stringify(receipt), { mode: 0o600 });
        return receipt;
    } catch (error) {
        throw new Error(`自动更换界面端口后，草稿保护尚未完成。原数据和迁移记录保留，可重试；备份：${backup}。${error.message}`, { cause: error });
    }
}
module.exports = { recoverUiOrigin, migrateElectronUiOrigin, verifyUiOriginRecoveryResources, writeUiOriginRecoveryMarker };
