const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { stopOwnedSmokeProcess } = require('./smoke-sandbox.cjs');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const hostExecutable = process.env.ADMIN_HOST_TEST_EXECUTABLE || path.join(
    projectDir,
    'unity-client',
    'Builds',
    'Windows',
    'AdminHost',
    'HeatTreatmentAdminHost.exe'
);
const outputDir = path.join(projectDir, 'output', `admin-host-parent-${Date.now()}-${process.pid}`);

function waitForSpawn(child) {
    return new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
    });
}

function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`进程 ${child.pid} 未在限定时间退出`)), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function main() {
    if (!fs.existsSync(hostExecutable)) throw new Error(`找不到后台宿主：${hostExecutable}`);
    fs.mkdirSync(outputDir, { recursive: true });
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Isolated parent lifecycle test</title>');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const testUrl = `http://127.0.0.1:${server.address().port}/admin?embedded=unity`;

    let parent;
    let host;
    try {
        parent = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 6000)'], {
            windowsHide: true,
            stdio: 'ignore'
        });
        await waitForSpawn(parent);

        host = spawn(hostExecutable, [
            '--url', testUrl,
            '--parent-pid', String(parent.pid),
            '--parent-hwnd', '0',
            '--user-data', path.join(outputDir, 'webview2'),
            '--dashboard-mode'
        ], {
            cwd: path.dirname(hostExecutable),
            windowsHide: true,
            stdio: 'ignore'
        });
        await waitForSpawn(host);

        await new Promise(resolve => setTimeout(resolve, 1000));
        const runningWhileParentAlive = host.exitCode === null && host.signalCode === null;
        const parentExit = await waitForExit(parent, 15000);
        const hostExit = await waitForExit(host, 15000);
        const checks = {
            hostStarted: runningWhileParentAlive,
            parentExitedCleanly: parentExit.code === 0,
            hostExitedAfterParent: hostExit.code === 0
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        const result = { success: failed.length === 0, checks, parentExit, hostExit, outputDir };
        console.log(JSON.stringify(result, null, 2));
        if (failed.length) throw new Error(`AdminHost 父进程联动检查失败：${failed.join(', ')}`);
    } finally {
        await Promise.all([stopOwnedSmokeProcess(host), stopOwnedSmokeProcess(parent)]);
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    }
}

main().then(
    () => process.exit(0),
    error => {
        console.error(error.stack || error.message);
        process.exit(1);
    }
);
