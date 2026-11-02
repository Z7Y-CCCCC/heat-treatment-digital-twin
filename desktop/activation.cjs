const http = require('node:http'), https = require('node:https');
function createActivationClient(origin) {
    const base = new URL(origin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash)
        throw new Error('激活服务地址无效');
    let token = null;
    async function request(method, data, pathname = '/api/activation') {
        return new Promise((resolve, reject) => {
            const body = data ? JSON.stringify(data) : null;
            const req = (base.protocol === 'https:' ? https : http).request(new URL(pathname, base), {
                method, headers: { Origin: base.origin, ...(token ? { 'X-Activation-Token': token } : {}),
                    ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) }
            }, res => {
                const chunks = []; let size = 0;
                res.on('data', chunk => { size += chunk.length; if (size > 65536) req.destroy(new Error('激活响应过大')); else chunks.push(chunk); });
                res.on('error', reject);
                res.on('end', () => {
                    try {
                        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (res.statusCode !== 200 || !value.success) throw new Error(value.error || '激活服务暂不可用，请确认后台版本');
                        resolve(value);
                    } catch (error) { reject(error); }
                });
            });
            req.setTimeout(10000, () => req.destroy(new Error('激活服务连接超时，请重试')));
            req.on('error', reject); req.end(body);
        });
    }
    return {
        async status() {
            const license = await request('GET', null, '/api/license');
            if (typeof license.enforce !== 'boolean' || typeof license.valid !== 'boolean') throw new Error('授权服务响应无效，请确认后台版本');
            if (!license.enforce || license.valid) return { success: true, required: false, valid: license.valid };
            const result = await request('GET'); token = result.token; const { token: secret, ...safe } = result; return safe;
        },
        async activate(code) {
            if (typeof code !== 'string' || code.length > 16384) throw new Error('请粘贴完整激活码');
            const current = await this.status(); // Refresh a nonce after service recovery.
            if (current.valid) return { success: true, valid: true };
            return request('POST', { activationCode: code });
        }
    };
}
async function runStartupActivation({ origin, ipcMain, clipboard, getWindow, createWindow, onWaiting }) {
    const client = createActivationClient(origin);
    const initial = await client.status();
    if (!initial.required) return;
    if (!getWindow() || getWindow().isDestroyed()) await createWindow();
    const startupWindow = getWindow();
    onWaiting?.();
    startupWindow.setSize(720, 590); startupWindow.center(); startupWindow.setSkipTaskbar(false);
    const trusted = event => event.sender === startupWindow?.webContents && event.senderFrame === startupWindow.webContents.mainFrame;
    let resolveActivation;
    const completed = new Promise(resolve => { resolveActivation = resolve; });
    let pollTimer = null, watching = true;
    const watchActivation = async () => {
        try {
            if ((await client.status()).valid && watching) { resolveActivation(); return; }
        } catch { /* A service recovery must leave the user's input intact. */ }
        if (watching) pollTimer = setTimeout(watchActivation, 2000);
    };
    let busy = false;
    const handlers = {
        'startup:activation-status': async () => client.status(),
        'startup:copy-fingerprint': async () => { const status = await client.status(); if (!status.machineId) throw new Error('暂时无法读取指纹，请重试'); clipboard.writeText(status.machineId); return { success: true }; },
        'startup:activate': async (event, code) => {
            if (busy) return { success: false, error: '正在激活' };
            busy = true;
            try {
                const result = await client.activate(code);
                if (!result.valid || (await client.status()).required) throw new Error('激活状态未确认，请重试');
                setImmediate(resolveActivation); return { success: true };
            } finally { busy = false; }
        }
    };
    for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, async (event, ...args) => {
        if (!trusted(event)) return { success: false, error: '激活窗口无效' };
        try { return await handler(event, ...args); } catch (error) { return { success: false, error: error.message }; }
    });
    try {
        const serialized = JSON.stringify(initial).replace(/</g, '\\u003c');
        await startupWindow.webContents.executeJavaScript(`window.showActivation?.(${serialized})`);
        // Another local client/admin can complete activation against the same
        // service. Continue without demanding a second copy of the same code.
        pollTimer = setTimeout(watchActivation, 2000);
        await completed;
    }
    finally { watching = false; clearTimeout(pollTimer); for (const name of Object.keys(handlers)) ipcMain.removeHandler(name); }
    if (startupWindow && !startupWindow.isDestroyed()) {
        await startupWindow.webContents.executeJavaScript('window.hideActivation?.()').catch(() => {});
        startupWindow.setSize(440, 200); startupWindow.center(); startupWindow.setSkipTaskbar(true);
    }
}

module.exports = { createActivationClient, runStartupActivation };
