const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const {
    BACKEND_DIR,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `runtime-test-${process.pid}-${Date.now()}`;

async function websocketConnect(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        const timer = setTimeout(() => {
            try { socket.terminate(); } catch (error) { /* ignore */ }
            reject(new Error('WebSocket 连接超时'));
        }, 5000);
        socket.once('open', () => {
            clearTimeout(timer);
            socket.close();
            resolve(true);
        });
        socket.once('unexpected-response', (_request, response) => {
            clearTimeout(timer);
            response.resume();
            resolve(false);
        });
        socket.once('error', error => {
            clearTimeout(timer);
            if (/Unexpected server response: 401/.test(error.message)) resolve(false);
            else reject(error);
        });
    });
}

async function main() {
    const runDirectory = createRunDirectory('runtime-display');
    const dataDir = path.join(runDirectory, 'data');
    const uploadsDir = path.join(runDirectory, 'uploads');
    const databaseFile = path.join(dataDir, 'factory.db');
    const backendPort = await findFreePort(3401);
    const castPort = await findFreePort(8787);
    const origin = `http://127.0.0.1:${backendPort}`;
    const castOrigin = `http://127.0.0.1:${castPort}`;
    let backend = null;

    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(uploadsDir, { recursive: true });
        await createTestDatabase(databaseFile, { source: process.env.RUNTIME_TEST_SOURCE_DB });
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2));

        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(backendPort),
                APP_DATA_DIR: dataDir,
                UPLOADS_DIR: uploadsDir,
                FRONTEND_DIST: path.resolve(BACKEND_DIR, '..', 'frontend', 'dist'),
                DESKTOP_PACKAGED: 'true',
                DESKTOP_AUTO_START_SUPPORTED: 'true',
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN,
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000)
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${origin}/api/health`, 30000);

        const initial = await requestJson(`${origin}/api/system/runtime`);
        if (
            !initial.success
            || typeof initial.auto_start_enabled !== 'boolean'
            || initial.auto_start_supported !== true
            || initial.packaged !== true
            || !/^\d{6}$/.test(initial.lan_display_pin)
        ) {
            throw new Error(`运行配置读取结果不正确: ${JSON.stringify(initial)}`);
        }

        const enabled = await requestJson(`${origin}/api/system/runtime`, {
            method: 'PUT',
            body: JSON.stringify({
                auto_start_enabled: false,
                lan_display_enabled: true,
                lan_display_port: castPort,
                lan_display_pin: initial.lan_display_pin
            })
        });
        if (
            enabled.auto_start_enabled !== false
            || !enabled.lan_display?.running
            || enabled.lan_display.port !== castPort
        ) {
            throw new Error(`投屏服务未启动: ${JSON.stringify(enabled)}`);
        }

        const pairing = await fetch(`${castOrigin}/`, { redirect: 'manual' });
        if (pairing.status !== 200 || !(await pairing.text()).includes('投屏码')) {
            throw new Error(`未授权入口异常: HTTP ${pairing.status}`);
        }
        const pin = initial.lan_display_pin;
        const tokenUrl = `${castOrigin}/?cast_token=${pin}&cast=1`;
        const redirect = await fetch(tokenUrl, { redirect: 'manual' });
        const setCookie = redirect.headers.get('set-cookie') || '';
        if (redirect.status !== 302 || !setCookie.includes('heat_treatment_cast_access=')) {
            throw new Error(`投屏授权跳转异常: HTTP ${redirect.status} ${setCookie}`);
        }
        const cookie = setCookie.split(';')[0];
        const authorized = await fetch(`${castOrigin}/api/config`, { headers: { Cookie: cookie } });
        const unauthorized = await fetch(`${castOrigin}/api/config`);
        const admin = await fetch(`${castOrigin}/admin`);
        const mutation = await fetch(`${castOrigin}/api/config`, { method: 'POST', headers: { Cookie: cookie } });
        if (!authorized.ok || unauthorized.status !== 401 || admin.status !== 403 || mutation.status !== 405) {
            throw new Error(`投屏只读/鉴权检查失败: ${authorized.status}/${unauthorized.status}/${admin.status}/${mutation.status}`);
        }

        const wsUrl = `ws://127.0.0.1:${castPort}/ws`;
        const rejectedSocket = await websocketConnect(wsUrl);
        const acceptedSocket = await websocketConnect(wsUrl, { Cookie: cookie });
        if (rejectedSocket || !acceptedSocket) throw new Error('WebSocket 投屏鉴权检查失败');

        const rotated = await requestJson(`${origin}/api/system/runtime/rotate-pin`, { method: 'POST' });
        const oldCookieResponse = await fetch(`${castOrigin}/api/config`, { headers: { Cookie: cookie } });
        if (!rotated.lan_display_pin || rotated.lan_display_pin === pin || oldCookieResponse.status !== 401) {
            throw new Error('旧投屏码未失效或新投屏码生成失败');
        }

        const disabled = await requestJson(`${origin}/api/system/runtime`, {
            method: 'PUT',
            body: JSON.stringify({ lan_display_enabled: false })
        });
        if (disabled.lan_display.running) throw new Error('关闭投屏后服务仍在运行');
        let released = false;
        try {
            await fetch(`${castOrigin}/`, { signal: AbortSignal.timeout(1000) });
        } catch (error) {
            released = true;
        }
        if (!released) throw new Error('关闭投屏后端口仍可访问');

        await requestJson(`${origin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
        await waitForExit(backend, 15000);
        backend = null;
        console.log(JSON.stringify({ success: true, backendPort, castPort, runDirectory }, null, 2));
    } finally {
        if (backend) await forceStop(backend);
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
