'use strict';
const crypto = require('node:crypto');

// Called only AFTER the existing loopback + private token gate. No command,
// executable, remote target, body or shell string is accepted from the page.
function createServiceControl({ restart, openCenter, now = Date.now, schedule = (fn) => setTimeout(fn, 1500) }) {
    const operations = new Map();
    let busy = false;
    function reply(response, status, body) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
    }
    function prune() { for (const [id, value] of operations) if (now() - value.at > 120000) operations.delete(id); }
    return function handle(request, response, pathname) {
        prune();
        if (request.method === 'GET' && /^\/service\/unity-restart\/[a-f0-9]{32}$/.test(pathname)) {
            const value = operations.get(pathname.split('/').pop());
            reply(response, value ? 200 : 404, value ? { success: true, state: value.state }
                : { success: false, error: '未找到当前桌面重启操作' });
            return true;
        }
        if (request.method !== 'POST' || !['/service/unity-restart', '/service/collector-center'].includes(pathname)) return false;
        if (busy) { reply(response, 409, { success: false, error: '已有服务操作正在执行' }); return true; }
        busy = true;
        if (pathname === '/service/collector-center') {
            Promise.resolve().then(openCenter).then(() => reply(response, 200, { success: true, opened: true }),
                () => reply(response, 503, { success: false, error: '采集运行中心无法打开' })).finally(() => { busy = false; });
            return true;
        }
        const operationId = crypto.randomBytes(16).toString('hex');
        const operation = { at: now(), state: 'accepted' };
        operations.set(operationId, operation);
        // Reply first, allowing the WebView to persist this non-secret receipt.
        reply(response, 202, { success: true, accepted: true, operationId });
        schedule(async () => {
            operation.state = 'restarting';
            try { await restart(); operation.state = 'ready'; }
            catch { operation.state = 'failed'; }
            finally { busy = false; }
        });
        return true;
    };
}
module.exports = { createServiceControl };
