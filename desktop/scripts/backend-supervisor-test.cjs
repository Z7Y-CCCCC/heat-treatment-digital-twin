const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('./smoke-sandbox.cjs');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const electron = path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');

function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('桌面进程自愈测试超时')), timeoutMs);
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
    if (!fs.existsSync(electron)) throw new Error(`找不到 Electron：${electron}`);
    const sandbox = await createSmokeSandbox('backend-supervisor');
    const outputDir = sandbox.directory;
    const child = spawn(electron, [path.join(desktopDir, 'main.cjs')], {
        cwd: desktopDir,
        windowsHide: true,
        env: {
            ...sandbox.env,
            NATIVE_CLIENT_SMOKE_MODE: 'true',
            DESKTOP_SMOKE_BACKEND_ONLY: 'true',
            DESKTOP_SMOKE_CRASH_BACKEND_AFTER_MS: '3000',
            // Only the hidden Electron supervisor and an isolated SQLite backend
            // are started. Rendering and WebView2 have independent native tests.
            DESKTOP_SMOKE_EXIT_AFTER_MS: '12000'
        },
        stdio: 'ignore'
    });
    let exit;
    try {
        exit = await waitForExit(child, 120000);
    } catch (error) {
        await stopOwnedSmokeProcess(child);
        throw error;
    }

    const logFile = path.join(outputDir, 'logs', 'desktop-error.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const checks = {
        desktopExitedCleanly: exit.code === 0,
        crashDetected: log.includes('[backend-exit]'),
        restartScheduled: log.includes('[backend-restart-scheduled]'),
        restartSucceeded: log.includes('[backend-restart-success]'),
        retryLimitNotExhausted: !log.includes('[backend-restart-exhausted]')
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const result = { success: failed.length === 0, checks, outputDir, exit };
    console.log(JSON.stringify(result, null, 2));
    if (failed.length) throw new Error(`后端自愈检查失败：${failed.join(', ')}`);
    process.exit(0);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
