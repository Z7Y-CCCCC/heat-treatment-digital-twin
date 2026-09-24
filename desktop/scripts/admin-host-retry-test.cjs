const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { stopOwnedSmokeProcess } = require('./smoke-sandbox.cjs');

const root = path.resolve(__dirname, '../..');
const executable = process.env.ADMIN_HOST_TEST_EXECUTABLE || path.join(root, 'unity-client/Builds/Windows/AdminHost/HeatTreatmentAdminHost.exe');
const directory = path.join(root, 'tmp', `admin-retry-${Date.now()}-${process.pid}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (check()) return; await delay(100); }
    throw new Error(`Timed out: ${label}`);
}
async function main() {
    if (!fs.existsSync(executable)) throw new Error('Build the native admin host first.');
    fs.mkdirSync(directory, { recursive: true });
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const failures = new Set(), recovered = new Set();
    let available = false, listening = false, parent, host;
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        if (url.pathname === '/proof') {
            recovered.add(url.searchParams.get('page'));
            response.writeHead(204); response.end(); return;
        }
        if (!available) {
            failures.add(url.pathname);
            response.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            response.end('<!doctype html><title>Backend starting</title>Not ready'); return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`<!doctype html><title>Isolated retry recovered</title><script>
            fetch('/proof?page='+encodeURIComponent(location.pathname));
            window.chrome?.webview?.postMessage({type:'overlay_ready'});
        </script>`);
    });
    try {
        // A hidden, disposable parent process keeps this test independent of
        // the user's running Unity, cookies, ports and site database.
        parent = spawn(process.execPath, ['-e', "process.on('message',m=>{if(m==='stop')process.exit(0)});setTimeout(()=>process.exit(0),45000)"], { windowsHide:true, stdio:['ignore','ignore','ignore','ipc'] });
        await once(parent, 'spawn');
        host = spawn(executable, ['--url', `http://127.0.0.1:${port}/admin?embedded=unity`, '--parent-pid', String(parent.pid), '--parent-hwnd', '0', '--user-data', path.join(directory,'webview2'), '--dashboard-mode'], { windowsHide:true, stdio:'ignore', cwd:path.dirname(executable) });
        await once(host, 'spawn');
        const logPath = path.join(directory,'logs/admin-host.log');
        await until(() => {
            if (!fs.existsSync(logPath)) return false;
            const log = fs.readFileSync(logPath,'utf8');
            return log.includes('后台页面加载失败') && log.includes('透明数据层导航失败');
        }, 'both surfaces initially fail while backend is absent');
        server.listen(port,'127.0.0.1'); await once(server,'listening'); listening=true;
        await until(() => failures.has('/admin') && failures.has('/overlay'), 'both surfaces retry and receive HTTP 503');
        if (recovered.size) throw new Error('A failed page was incorrectly reported as recovered.');
        available=true;
        await until(() => recovered.has('/admin') && recovered.has('/overlay'), 'both surfaces automatically recover and execute the page');
        const liveBeforeParentExit = host.exitCode === null;
        parent.send('stop');
        await until(() => parent.exitCode !== null && host.exitCode !== null, 'owned host exits with the disposable parent');
        if (!liveBeforeParentExit || parent.exitCode !== 0 || host.exitCode !== 0) throw new Error('Parent/host lifecycle did not end cleanly.');
        console.log(JSON.stringify({success:true,checks:{connectionRefusal:true,http503:true,adminRecovered:true,overlayRecovered:true,parentExit:true},directory},null,2));
    } finally {
        if (parent?.connected) parent.send('stop');
        await delay(300);
        await Promise.all([stopOwnedSmokeProcess(host),stopOwnedSmokeProcess(parent)]);
        if (listening) { server.closeAllConnections?.(); await new Promise(resolve=>server.close(resolve)); }
    }
}
main().catch(error=>{console.error(error.stack || error);process.exitCode=1;});
