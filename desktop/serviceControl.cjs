'use strict';
const crypto = require('node:crypto');

function collectorCenterViewForPath(pathname) {
    return pathname === '/service/collector-center/data' ? 'points'
        : pathname === '/service/collector-center/runtime' ? 'overview' : null;
}
function collectorCenterArguments(view) {
    if (view == null) return [];
    if (!['points', 'overview'].includes(view)) throw new Error('不支持的运行中心视角');
    return ['--open-view', view];
}

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
        if (request.method !== 'POST' || !['/service/unity-restart', '/service/collector-center', '/service/collector-center/data', '/service/collector-center/runtime'].includes(pathname)) return false;
        if (busy) { reply(response, 409, { success: false, error: '已有服务操作正在执行' }); return true; }
        busy = true;
        if (pathname.startsWith('/service/collector-center')) {
            const view = collectorCenterViewForPath(pathname);
            Promise.resolve().then(() => view ? openCenter({ view }) : openCenter()).then(result => {
                if (view && (result?.opened !== true || result.view !== view)) throw new Error('运行中心视角未确认');
                reply(response, 200, view ? { success: true, opened: true, view } : { success: true, opened: true });
            }).catch(() => reply(response, 503, { success: false, error: '采集运行中心无法确认打开所选页面，请同步运行中心界面后重试' })).finally(() => { busy = false; });
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
module.exports = { createServiceControl, collectorCenterViewForPath, collectorCenterArguments };
