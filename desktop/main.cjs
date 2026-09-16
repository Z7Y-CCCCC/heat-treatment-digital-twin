const { app, BrowserWindow, dialog, Menu, shell, Tray } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { hasProcessExited, terminateProcess } = require('./processLifecycle.cjs');
const {
    cleanupLogArchives,
    createRotatingLogWriter
} = require('./logManager.cjs');

const APP_NAME = '热处理数字孪生大屏';
const backendOnlySmokeMode = !app.isPackaged
    && process.env.NATIVE_CLIENT_SMOKE_MODE === 'true'
    && process.env.DESKTOP_SMOKE_BACKEND_ONLY === 'true';
// 现场大屏需要在无人值守时自动播报，Electron 默认的 Chromium 音频自动播放限制会阻止这一点。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.env.APP_USER_DATA_DIR) {
    app.setPath('userData', path.resolve(process.env.APP_USER_DATA_DIR));
}
let mainWindow = null;
let tray = null;
let backendProcess = null;
let nativeProcess = null;
const managedProcesses = new Set();
let backendStopPromise = null;
let nativeStopPromise = null;
let backendLogStream = null;
let backendErrorLogStream = null;
let nativeLogStream = null;
let nativeErrorLogStream = null;
let desktopErrorLogStream = null;
let logCleanupTimer = null;
let backendPort = null;
let backendShutdownToken = null;
let applicationOrigin = null;
let writablePaths = null;
let desktopSettingsTimer = null;
let appliedAutoStartSetting = null;
let desktopControlServer = null;
let desktopControlOrigin = null;
let desktopControlToken = null;
let isQuitting = false;
let quitReady = false;
let hasShownTrayHint = false;
let mainWindowClosePromptActive = false;
let backendRestartTimer = null;
let backendRestartResetTimer = null;
let backendRestartAttempts = 0;
let backendHealthFailures = 0;
let backendRestartInProgress = false;
let applicationShutdownForceTimer = null;
let applicationReadyForInteraction = false;
let pendingNativeAdminRequest = false;
let startupWindow = null;
let startupWindowClosingForSuccess = false;
let startupFailureLogPath = null;
let nativeHostReady = false;
const nativeHostReadyWaiters = new Set();
const startupState = {
    progress: 0,
    status: 'running',
    title: '正在准备启动环境',
    detail: '正在检查程序组件',
    error: '',
    logPath: '',
    steps: []
};
const BACKEND_RESTART_DELAYS_MS = [1000, 3000, 10000];
const BACKEND_RESTART_RESET_MS = 60 * 1000;

function resourcePath(...parts) {
    const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
    return path.join(root, ...parts);
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function trackManagedProcess(child) {
    managedProcesses.add(child);
    child.once('exit', () => managedProcesses.delete(child));
    child.once('error', () => {
        if (!child.pid) managedProcesses.delete(child);
    });
    return child;
}

function sendStartupState() {
    if (!startupWindow || startupWindow.isDestroyed() || startupWindow.webContents.isLoading()) return;
    const serialized = JSON.stringify(startupState).replace(/</g, '\\u003c');
    startupWindow.webContents.executeJavaScript(`window.updateStartup?.(${serialized})`, true).catch(() => {});
}

function updateStartupProgress(id, progress, title, detail = '') {
    const previous = startupState.steps.find(step => step.status === 'running');
    if (previous && previous.id !== id) previous.status = 'done';
    let step = startupState.steps.find(item => item.id === id);
    if (!step) {
        step = { id, title, detail, status: 'running' };
        startupState.steps.push(step);
    } else {
        step.title = title;
        step.detail = detail;
        step.status = 'running';
    }
    startupState.progress = Math.max(startupState.progress, Math.min(100, Math.round(progress)));
    startupState.status = 'running';
    startupState.title = title;
    startupState.detail = detail;
    startupState.error = '';
    sendStartupState();
}

function completeStartupProgress() {
    const current = startupState.steps.find(step => step.status === 'running');
    if (current) current.status = 'done';
    startupState.progress = 100;
    startupState.status = 'success';
    startupState.title = '启动完成';
    startupState.detail = '三维场景、实时数据和顶部组件均已就绪';
    sendStartupState();
}

function startupAction(url) {
    let action = '';
    try { action = new URL(url).hostname; } catch (error) { return; }
    if (action === 'open-log') {
        if (startupFailureLogPath && fs.existsSync(startupFailureLogPath)) {
            shell.showItemInFolder(startupFailureLogPath);
        } else {
            shell.openPath(path.join(app.getPath('userData'), 'logs')).catch(() => {});
        }
        return;
    }
    if (action === 'restart') {
        app.relaunch();
        app.quit();
        return;
    }
    if (action === 'exit') app.quit();
}

async function createStartupWindow() {
    if (startupWindow && !startupWindow.isDestroyed()) return startupWindow;
    startupWindowClosingForSuccess = false;
    startupWindow = new BrowserWindow({
        width: 620,
        height: 430,
        minWidth: 620,
        minHeight: 430,
        maxWidth: 620,
        maxHeight: 430,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        show: false,
        center: true,
        alwaysOnTop: true,
        skipTaskbar: false,
        backgroundColor: '#00000000',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    startupWindow.webContents.on('will-navigate', (event, targetUrl) => {
        if (!targetUrl.startsWith('startup-action://')) return;
        event.preventDefault();
        startupAction(targetUrl);
    });
    startupWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('startup-action://')) startupAction(url);
        return { action: 'deny' };
    });
    startupWindow.on('closed', () => {
        const shouldQuit = !startupWindowClosingForSuccess && !applicationReadyForInteraction;
        startupWindow = null;
        startupWindowClosingForSuccess = false;
        if (shouldQuit && !isQuitting) setImmediate(() => app.quit());
    });
    await startupWindow.loadFile(path.join(__dirname, 'assets', 'startup.html'));
    if (!startupWindow || startupWindow.isDestroyed()) throw new Error('启动加载页面创建失败');
    if (!backendOnlySmokeMode) {
        startupWindow.show();
        startupWindow.focus();
    }
    sendStartupState();
    await delay(120);
    return startupWindow;
}

function closeStartupWindow() {
    if (!startupWindow || startupWindow.isDestroyed()) return;
    startupWindowClosingForSuccess = true;
    startupWindow.setAlwaysOnTop(false);
    startupWindow.close();
}

function persistStartupFailure(error) {
    const logDirectory = ensureDirectory(path.join(app.getPath('userData'), 'logs'));
    const filename = path.join(logDirectory, 'startup-error.log');
    const message = error?.stack || error?.message || String(error || '未知启动错误');
    try {
        fs.appendFileSync(filename, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    } catch (writeError) { /* startup UI will still show the original error */ }
    return filename;
}

async function showStartupFailure(error) {
    startupFailureLogPath = persistStartupFailure(error);
    if (backendOnlySmokeMode) {
        app.quit();
        return;
    }
    const current = startupState.steps.find(step => step.status === 'running');
    if (current) current.status = 'error';
    startupState.status = 'error';
    startupState.title = '程序启动失败';
    startupState.detail = '请查看下面的失败原因，修复后可重新启动';
    startupState.error = error?.message || String(error || '未知启动错误');
    startupState.logPath = startupFailureLogPath;
    if (!startupWindow || startupWindow.isDestroyed()) await createStartupWindow();
    sendStartupState();
    startupWindow?.show();
    startupWindow?.focus();
}

function signalNativeHostReady() {
    nativeHostReady = true;
    for (const resolve of nativeHostReadyWaiters) resolve();
    nativeHostReadyWaiters.clear();
}

function waitForNativeHostReady(timeoutMs = 30000) {
    if (nativeHostReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const finish = () => {
            clearTimeout(timer);
            nativeHostReadyWaiters.delete(finish);
            resolve();
        };
        const timer = setTimeout(() => {
            nativeHostReadyWaiters.delete(finish);
            reject(new Error('顶部栏与数据组件加载超时，请检查 admin-host.log 和 WebView2 运行环境'));
        }, timeoutMs);
        nativeHostReadyWaiters.add(finish);
    });
}

function copyMissingDirectoryContents(source, destination) {
    if (!fs.existsSync(source)) return;
    ensureDirectory(destination);
    fs.cpSync(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false
    });
}

function backendDependenciesReady(directory) {
    return Boolean(directory) && [
        path.join(directory, 'express', 'package.json'),
        path.join(directory, 'better-sqlite3', 'package.json'),
        path.join(directory, 'ws', 'package.json')
    ].every(filename => fs.existsSync(filename));
}

function ensureBackendDependencies() {
    const tarFile = resourcePath('backend-dependencies.tar');
    const uncompressedDir = resourcePath('backend-dependencies');

    if (!fs.existsSync(tarFile) && backendDependenciesReady(uncompressedDir)) {
        return uncompressedDir;
    }
    if (!fs.existsSync(tarFile)) {
        throw new Error('安装资源不完整：缺少 backend-dependencies.tar');
    }

    const root = app.getPath('userData');
    const targetDir = path.join(root, 'backend-dependencies');
    const stagingDir = path.join(root, `backend-dependencies.preparing-${process.pid}`);
    const markerFile = path.join(targetDir, '.prepared');

    let needsExtract = true;
    if (fs.existsSync(markerFile)) {
        try {
            const preparedTime = new Date(fs.readFileSync(markerFile, 'utf8').trim()).getTime();
            if (fs.existsSync(tarFile)) {
                const tarStat = fs.statSync(tarFile);
                if (preparedTime >= tarStat.mtime.getTime()) {
                    needsExtract = !backendDependenciesReady(targetDir);
                }
            } else {
                needsExtract = false;
            }
        } catch (e) {
            needsExtract = true;
        }
    }

    if (needsExtract) {
        try {
            const { execFileSync } = require('child_process');
            fs.rmSync(stagingDir, { recursive: true, force: true });
            ensureDirectory(stagingDir);
            execFileSync('tar', ['-xf', tarFile, '-C', stagingDir], { windowsHide: true });
            if (!backendDependenciesReady(stagingDir)) {
                throw new Error('依赖包解压完成，但关键模块不完整');
            }
            fs.rmSync(targetDir, { recursive: true, force: true });
            fs.renameSync(stagingDir, targetDir);
            fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');
        } catch (error) {
            fs.rmSync(stagingDir, { recursive: true, force: true });
            if (!backendDependenciesReady(targetDir)) {
                throw new Error(`首次启动资源准备失败：${error.message}`);
            }
        }
    }

    if (!backendDependenciesReady(targetDir)) {
        throw new Error('首次启动资源准备失败：后端依赖目录不完整');
    }
    return targetDir;
}

function initializeWritableData() {
    const root = app.getPath('userData');
    const dataDir = ensureDirectory(path.join(root, 'data'));
    const uploadsDir = path.join(root, 'uploads');
    const logsDir = ensureDirectory(path.join(root, 'logs'));
    const databaseFile = path.join(dataDir, 'factory.db');
    const databaseConfigFile = path.join(dataDir, 'database-config.json');
    const templateRoot = resourcePath('templates');
    const dependenciesDir = ensureBackendDependencies();

    if (!fs.existsSync(databaseFile)) {
        fs.copyFileSync(path.join(templateRoot, 'factory-template.db'), databaseFile);
    }
    if (process.env.DESKTOP_SMOKE_ISOLATED !== 'true') {
        copyMissingDirectoryContents(path.join(templateRoot, 'uploads'), uploadsDir);
    }
    ensureDirectory(path.join(uploadsDir, 'models'));
    ensureDirectory(path.join(uploadsDir, 'audio'));

    if (!fs.existsSync(databaseConfigFile)) {
        fs.writeFileSync(databaseConfigFile, JSON.stringify({
            type: 'mysql',
            host: process.env.DESKTOP_MYSQL_HOST || process.env.MYSQL_HOST || '127.0.0.1',
            port: Number(process.env.DESKTOP_MYSQL_PORT || process.env.MYSQL_PORT || 3307),
            user: process.env.DESKTOP_MYSQL_USER || process.env.MYSQL_USER || 'root',
            password: process.env.DESKTOP_MYSQL_PASSWORD || process.env.MYSQL_PASSWORD || 'root',
            database: process.env.DESKTOP_MYSQL_DATABASE || process.env.MYSQL_DATABASE || 'dongtai_daping',
            // 保留随安装包生成的 SQLite 快照，供离线应急、迁移或人工切换时使用。
            filename: databaseFile
        }, null, 2), 'utf8');
    }

    return { dataDir, uploadsDir, logsDir, dependenciesDir };
}

function configureAutoStart(enabled) {
    if (!app.isPackaged || process.platform !== 'win32' || process.env.DISABLE_AUTO_START === 'true') return false;
    try {
        app.setLoginItemSettings({
            openAtLogin: Boolean(enabled),
            openAsHidden: false,
            path: process.execPath,
            args: ['--autostart']
        });
        return true;
    } catch (error) {
        logDesktopError('auto-start', error);
        return false;
    }
}

function findAvailablePort(startPort = 3001) {
    return new Promise((resolve, reject) => {
        const tryPort = (port) => {
            const server = net.createServer();
            server.unref();
            server.once('error', (error) => {
                if (error.code === 'EADDRINUSE' && port < startPort + 50) {
                    tryPort(port + 1);
                    return;
                }
                reject(error);
            });
            server.listen(port, '127.0.0.1', () => {
                const selected = server.address().port;
                server.close(() => resolve(selected));
            });
        };
        tryPort(startPort);
    });
}

function waitForHealth(url, timeoutMs = 30000, processToWatch = null) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const check = () => {
            if (processToWatch && (
                processToWatch.killed
                || processToWatch.exitCode !== null
                || processToWatch.signalCode
            )) {
                reject(new Error('后端进程在健康探测完成前已退出'));
                return;
            }
            const request = http.get(url, (response) => {
                response.resume();
                if (response.statusCode === 200) {
                    resolve();
                    return;
                }
                retry();
            });
            request.setTimeout(1500, () => request.destroy());
            request.on('error', retry);
        };
        const retry = () => {
            if (Date.now() >= deadline) {
                reject(new Error('本地服务启动超时'));
                return;
            }
            setTimeout(check, 300);
        };
        check();
    });
}

function isLoopbackAddress(address) {
    return address === '::1' || /^(::ffff:)?127\.0\.0\.1$/.test(String(address || ''));
}

function startDesktopControlServer() {
    if (desktopControlServer) return Promise.resolve(desktopControlOrigin);
    desktopControlToken = crypto.randomBytes(32).toString('hex');
    desktopControlServer = http.createServer((request, response) => {
        const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
        if (request.method === 'GET' && pathname === '/health') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            return;
        }

        const suppliedToken = String(request.headers['x-desktop-control-token'] || '');
        if (!isLoopbackAddress(request.socket.remoteAddress) || suppliedToken !== desktopControlToken) {
            response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: false, error: '拒绝访问' }));
            return;
        }

        if (request.method === 'POST' && pathname === '/startup-ready') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(signalNativeHostReady);
            return;
        }

        if (request.method === 'POST' && pathname === '/open-admin') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(showNativeAdminPanel);
            return;
        }

        if (request.method === 'POST' && pathname === '/show-dashboard') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(showNativeDashboard);
            return;
        }

        if (request.method === 'POST' && (pathname === '/prepare-cast' || pathname === '/restore-cast')) {
            const command = pathname === '/prepare-cast' ? 'prepare_cast' : 'restore_cast';
            sendNativeHostCommandWithRetry(command).then(success => {
                response.writeHead(success ? 202 : 503, { 'content-type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ success, command }));
            }).catch(error => {
                response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ success: false, error: error.message }));
            });
            return;
        }

        if (request.method === 'POST' && pathname === '/minimize-to-tray') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(minimizeApplicationToTray);
            return;
        }

        if (request.method === 'POST' && pathname === '/quit') {
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ success: true }));
            setImmediate(() => app.quit());
            return;
        }

        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ success: false, error: '未找到桌面控制命令' }));
    });

    return new Promise((resolve, reject) => {
        const server = desktopControlServer;
        server.once('error', error => {
            if (desktopControlServer === server) {
                desktopControlServer = null;
                desktopControlOrigin = null;
                desktopControlToken = null;
            }
            reject(error);
        });
        server.listen(0, '127.0.0.1', () => {
            desktopControlOrigin = `http://127.0.0.1:${server.address().port}`;
            resolve(desktopControlOrigin);
        });
    });
}

function nativeHostPipePath() {
    return nativeProcess?.pid
        ? `\\\\.\\pipe\\HeatTreatmentAdminHost_${nativeProcess.pid}`
        : '';
}

function sendNativeHostCommand(command, timeout = 1200) {
    const pipePath = nativeHostPipePath();
    if (!pipePath) return Promise.resolve(false);
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        let socket;
        try {
            socket = net.createConnection(pipePath);
        } catch (error) {
            finish(false);
            return;
        }
        socket.setTimeout(timeout);
        socket.once('connect', () => {
            // 等待命令真正写入管道后再向后端确认，避免只连上管道但宿主尚未
            // 收到换行结尾的命令时就误报成功。
            socket.end(`${command}\n`, 'utf8', () => finish(true));
        });
        socket.once('timeout', () => {
            try { socket.destroy(); } catch (error) { /* ignore */ }
            finish(false);
        });
        socket.once('error', () => finish(false));
        socket.once('close', () => finish(false));
    });
}

async function sendNativeHostCommandWithRetry(command) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        if (await sendNativeHostCommand(command)) return true;
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    return false;
}

function stopDesktopControlServer() {
    const server = desktopControlServer;
    desktopControlServer = null;
    desktopControlOrigin = null;
    desktopControlToken = null;
    if (!server) return Promise.resolve();
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(forceTimer);
            resolve();
        };
        const forceTimer = setTimeout(() => {
            // A WebView may leave a keep-alive request open while the desktop app
            // is quitting.  Do not let that connection block a production shutdown.
            try { server.closeIdleConnections?.(); } catch (error) { /* ignore */ }
            try { server.closeAllConnections?.(); } catch (error) { /* ignore */ }
            finish();
        }, 3000);
        try {
            server.close(finish);
            server.closeIdleConnections?.();
        } catch (error) {
            finish();
        }
    });
}

function readRuntimeSettings(port) {
    return new Promise((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1',
            port,
            path: '/api/system/runtime',
            headers: { Accept: 'application/json' }
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`读取运行配置失败: HTTP ${response.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`运行配置响应格式错误: ${error.message}`));
                }
            });
        });
        request.setTimeout(2500, () => request.destroy(new Error('读取运行配置超时')));
        request.on('error', reject);
    });
}

function probeBackendHealth(port) {
    return new Promise((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1',
            port,
            path: '/api/health',
            headers: { Accept: 'application/json' }
        }, response => {
            response.resume();
            if (response.statusCode === 200) resolve();
            else reject(new Error(`后端健康探测失败: HTTP ${response.statusCode}`));
        });
        request.setTimeout(2500, () => request.destroy(new Error('后端健康探测超时')));
        request.on('error', reject);
    });
}

async function syncDesktopSettings() {
    if (!backendPort) return;
    try {
        const runtime = await readRuntimeSettings(backendPort);
        backendHealthFailures = 0;
        if (runtime?.auto_start_supported) {
            const enabled = runtime.auto_start_enabled === true;
            if (appliedAutoStartSetting !== enabled && configureAutoStart(enabled)) {
                appliedAutoStartSetting = enabled;
            }
        }
    } catch (error) {
        // 后端刚启动、正在重启或开发版不支持时，不打断桌面程序。
        logDesktopError('runtime-settings-sync', error);
        if (backendRestartInProgress) return;
        try {
            // Runtime settings may be delayed by a MySQL backup or PLC refresh.
            // Only restart the process when the lightweight health endpoint also
            // fails, otherwise a busy but healthy backend would be killed.
            await probeBackendHealth(backendPort);
            backendHealthFailures = 0;
            return;
        } catch (healthError) {
            logDesktopError('backend-health-probe', healthError);
        }
        backendHealthFailures += 1;
        if (backendHealthFailures >= 3 && backendProcess && !isQuitting) {
            backendHealthFailures = 0;
            logDesktopError('backend-watchdog', new Error('后端健康探测连续失败，准备自动重启'));
            try { backendProcess.kill(); } catch (killError) { /* exit handler will retry */ }
        }
    }
}

async function startDesktopSettingsSync() {
    if (desktopSettingsTimer) clearInterval(desktopSettingsTimer);
    desktopSettingsTimer = setInterval(() => {
        syncDesktopSettings();
    }, 4000);
    desktopSettingsTimer.unref?.();
    await syncDesktopSettings();
}

function logDesktopError(context, error) {
    const message = error?.stack || error?.message || String(error || '未知错误');
    desktopErrorLogStream?.write(`[${new Date().toISOString()}] [${context}] ${message}\n`);
}

function startLogMaintenance(logsDir) {
    cleanupLogArchives(logsDir);
    if (logCleanupTimer) clearInterval(logCleanupTimer);
    logCleanupTimer = setInterval(() => cleanupLogArchives(logsDir), 6 * 60 * 60 * 1000);
    logCleanupTimer.unref?.();
}

function closeBackendLogStreams() {
    backendLogStream?.end();
    backendErrorLogStream?.end();
    backendLogStream = null;
    backendErrorLogStream = null;
}

function guardLogStream(stream, label) {
    stream.on('error', error => {
        try {
            dialog.showErrorBox(APP_NAME, `${label}写入失败：${error.message}`);
        } catch (dialogError) { /* application may already be shutting down */ }
    });
    return stream;
}

function clearBackendRestartTimers() {
    if (backendRestartTimer) clearTimeout(backendRestartTimer);
    if (backendRestartResetTimer) clearTimeout(backendRestartResetTimer);
    backendRestartTimer = null;
    backendRestartResetTimer = null;
}

function scheduleBackendRestart(writable, port, reason) {
    if (isQuitting || backendRestartTimer) return;
    if (backendRestartResetTimer) clearTimeout(backendRestartResetTimer);
    backendRestartResetTimer = null;
    if (backendRestartAttempts >= BACKEND_RESTART_DELAYS_MS.length) {
        const message = `本地数据服务连续 ${backendRestartAttempts} 次自动恢复失败`;
        logDesktopError('backend-restart-exhausted', new Error(`${message}：${reason || '未知原因'}`));
        try {
            dialog.showErrorBox(APP_NAME, `${message}。\n请查看用户数据目录中的 logs/backend-error.log。`);
        } catch (error) { /* app may already be closing */ }
        app.quit();
        return;
    }

    const attempt = backendRestartAttempts;
    const delay = BACKEND_RESTART_DELAYS_MS[attempt];
    backendRestartAttempts += 1;
    logDesktopError('backend-restart-scheduled', new Error(`第 ${backendRestartAttempts} 次自动恢复将在 ${delay}ms 后执行：${reason || '进程退出'}`));
    backendRestartTimer = setTimeout(async () => {
        backendRestartTimer = null;
        if (isQuitting) return;
        backendRestartInProgress = true;
        backendHealthFailures = 0;
        let restartedProcess;
        try {
            restartedProcess = await startBackend(port, writable);
            await waitForHealth(`${applicationOrigin}/api/health`, 60000, restartedProcess);
            if (backendProcess !== restartedProcess || restartedProcess.exitCode !== null) {
                throw new Error('后端进程在健康探测完成前已退出');
            }
            backendHealthFailures = 0;
            logDesktopError('backend-restart-success', new Error(`后端已自动恢复（第 ${attempt + 1} 次尝试）`));
            if (backendRestartResetTimer) clearTimeout(backendRestartResetTimer);
            backendRestartResetTimer = setTimeout(() => {
                backendRestartAttempts = 0;
                backendRestartResetTimer = null;
            }, BACKEND_RESTART_RESET_MS);
            backendRestartResetTimer.unref?.();
        } catch (error) {
            logDesktopError('backend-restart-failed', error);
            // Health can time out while the process is still alive and holding
            // the port. Reap that exact attempt before spawning a replacement.
            try {
                await terminateProcess(restartedProcess);
            } catch (stopError) {
                logDesktopError('backend-restart-cleanup-failed', stopError);
                backendRestartInProgress = false;
                app.quit();
                return;
            }
            backendRestartInProgress = false;
            scheduleBackendRestart(writable, port, error.message);
            return;
        }
        backendRestartInProgress = false;
    }, delay);
    backendRestartTimer.unref?.();
}

function nativeClientDirectory() {
    return app.isPackaged
        ? resourcePath('native-client')
        : path.resolve(__dirname, '..', 'unity-client', 'Builds', 'Windows');
}

function nativeAdminHostExecutable() {
    return path.join(nativeClientDirectory(), 'AdminHost', 'HeatTreatmentAdminHost.exe');
}

function launchNativeAdminHost(showAdmin) {
    const executable = nativeAdminHostExecutable();
    const nativeRunning = nativeProcess
        && nativeProcess.exitCode === null
        && nativeProcess.signalCode === null
        && !nativeProcess.killed;
    if (!applicationOrigin || !nativeRunning) {
        if (!applicationReadyForInteraction) {
            if (showAdmin) pendingNativeAdminRequest = true;
            return;
        }
        showAdminWindow();
        return;
    }
    if (!fs.existsSync(executable)) {
        showAdminWindow();
        return;
    }

    const fixedRuntime = path.join(path.dirname(executable), 'WebView2Runtime');
    const args = [
        '--url', `${applicationOrigin}/admin?embedded=unity`,
        '--parent-pid', String(nativeProcess.pid),
        '--user-data', path.join(app.getPath('userData'), 'webview2')
    ];
    if (fs.existsSync(fixedRuntime)) args.push('--fixed-runtime', fixedRuntime);
    if (desktopControlOrigin) args.push('--desktop-control-url', desktopControlOrigin);
    if (desktopControlToken) args.push('--desktop-control-token', desktopControlToken);
    if (!showAdmin) args.push('--dashboard-mode');
    const child = spawn(executable, args, {
        cwd: path.dirname(executable),
        windowsHide: false,
        detached: false,
        env: {
            ...process.env,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
            NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1'].filter(Boolean).join(',')
        },
        stdio: 'ignore'
    });
    child.once('error', error => {
        logDesktopError(showAdmin ? 'native-admin-panel' : 'native-dashboard-restore', error);
        showAdminWindow();
    });
    child.unref();
}

function showNativeAdminPanel() {
    launchNativeAdminHost(true);
}

function showNativeDashboard() {
    launchNativeAdminHost(false);
}

function closeNativeLogStreams() {
    nativeLogStream?.end();
    nativeErrorLogStream?.end();
    nativeLogStream = null;
    nativeErrorLogStream = null;
}

function monitorNativeStartup(child, onUpdate, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let stdoutBuffer = '';
        let stderrBuffer = '';
        let lastProgress = 0;
        let lastStep = '正在启动 Unity 渲染进程';
        let lastWarning = '';
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.stdout?.off('data', onStdout);
            child.stderr?.off('data', onStderr);
            child.off('exit', onExit);
            child.off('error', onError);
            if (error) reject(error);
            else resolve();
        };
        const parseLine = line => {
            const progressMatch = line.match(/\[StartupProgress\]\s*(\d{1,3})\|(.+)/);
            if (progressMatch) {
                lastProgress = Math.max(0, Math.min(100, Number(progressMatch[1])));
                lastStep = progressMatch[2].trim() || lastStep;
                onUpdate?.({ progress: lastProgress, step: lastStep, warning: lastWarning });
                if (lastProgress >= 100) finish();
                return;
            }
            const warningMatch = line.match(/\[StartupWarning\]\s*(\d{1,3})\|(.+)/);
            if (warningMatch) {
                lastProgress = Math.max(lastProgress, Math.min(100, Number(warningMatch[1])));
                lastWarning = warningMatch[2].trim();
                onUpdate?.({ progress: lastProgress, step: lastStep, warning: lastWarning });
                return;
            }
            if (line.includes('[FactoryRuntime] Native factory ready')) {
                lastProgress = 100;
                lastStep = '三维场景已就绪';
                onUpdate?.({ progress: 100, step: lastStep, warning: lastWarning });
                finish();
            }
        };
        const consume = (chunk, isError) => {
            const combined = (isError ? stderrBuffer : stdoutBuffer) + chunk.toString('utf8');
            const lines = combined.split(/\r?\n/);
            const remainder = lines.pop() || '';
            if (isError) stderrBuffer = remainder;
            else stdoutBuffer = remainder;
            lines.forEach(parseLine);
        };
        const onStdout = chunk => consume(chunk, false);
        const onStderr = chunk => consume(chunk, true);
        const onExit = code => finish(new Error(
            `Unity 在“${lastStep}”时退出（代码 ${code ?? '未知'}）${lastWarning ? `：${lastWarning}` : ''}`
        ));
        const onError = error => finish(new Error(`Unity 启动失败：${error.message}`));
        const timer = setTimeout(() => finish(new Error(
            `Unity 在“${lastStep}”步骤加载超时${lastWarning ? `：${lastWarning}` : '，请查看 native-client.log'}`
        )), timeoutMs);
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.once('exit', onExit);
        child.once('error', onError);
        onUpdate?.({ progress: lastProgress, step: lastStep, warning: '' });
    });
}

async function startNativeClient(origin, writable, startupProgressCallback = null) {
    if (isQuitting) throw new Error('程序正在退出，已取消三维大屏启动');
    if (nativeProcess) return { process: nativeProcess, ready: Promise.resolve() };
    const clientDir = nativeClientDirectory();
    const executable = path.join(clientDir, 'HeatTreatmentDigitalTwin.exe');
    if (!fs.existsSync(executable)) {
        throw new Error(`原生大屏程序不存在：${executable}`);
    }

    const logStreams = await Promise.all([
        createRotatingLogWriter(writable.logsDir, 'native-client.log'),
        createRotatingLogWriter(writable.logsDir, 'native-client-error.log')
    ]);
    if (isQuitting) {
        logStreams.forEach(stream => stream.end());
        throw new Error('程序正在退出，已取消三维大屏启动');
    }
    nativeLogStream = guardLogStream(logStreams[0], '原生客户端日志');
    nativeErrorLogStream = guardLogStream(logStreams[1], '原生客户端错误日志');

    const webSocketOrigin = origin.replace(/^http/i, 'ws');
    const noProxy = [process.env.NO_PROXY, 'localhost', '127.0.0.1']
        .filter(Boolean)
        .join(',');
    const nativeArgs = process.env.NATIVE_CLIENT_SMOKE_MODE === 'true'
        ? [
            '-batchmode',
            '-force-d3d11',
            '-screen-fullscreen', '0',
            '-screen-width', '960',
            '-screen-height', '540',
            '-logFile', '-'
        ]
        : [
            '-screen-fullscreen', '0',
            '-screen-width', '1600',
            '-screen-height', '900',
            '-logFile', '-'
        ];
    const child = trackManagedProcess(spawn(executable, nativeArgs, {
        cwd: clientDir,
        windowsHide: false,
        env: {
            ...process.env,
            NO_PROXY: noProxy,
            no_proxy: noProxy,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
            DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: `${webSocketOrigin}/ws`,
            DIGITAL_TWIN_ADMIN_URL: `${origin}/admin`,
            DIGITAL_TWIN_ADMIN_HOST_PATH: nativeAdminHostExecutable(),
            DIGITAL_TWIN_ADMIN_FIXED_RUNTIME: path.join(path.dirname(nativeAdminHostExecutable()), 'WebView2Runtime'),
            DIGITAL_TWIN_DESKTOP_CONTROL_URL: desktopControlOrigin || '',
            DIGITAL_TWIN_DESKTOP_CONTROL_TOKEN: desktopControlToken || '',
            DIGITAL_TWIN_MAXIMIZE_WINDOW: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    }));
    nativeHostReady = false;
    nativeProcess = child;
    child.stdout?.pipe(nativeLogStream, { end: false });
    child.stderr?.pipe(nativeErrorLogStream, { end: false });
    child.once('exit', code => {
        const wasCurrent = nativeProcess === child;
        if (wasCurrent) nativeProcess = null;
        if (wasCurrent) nativeHostReady = false;
        if (wasCurrent) closeNativeLogStreams();
        updateTrayMenu();
        if (!isQuitting && wasCurrent) {
            if (code !== 0 && applicationReadyForInteraction) {
                const error = new Error(`Unity 原生大屏异常退出（代码 ${code}）`);
                logDesktopError('native-client-exit', error);
                dialog.showErrorBox(
                    APP_NAME,
                    `${error.message}。\n错误日志：${path.join(writable.logsDir, 'native-client-error.log')}`
                );
            }
            if (applicationReadyForInteraction) showAdminWindow();
        }
    });
    try {
        await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
    } catch (error) {
        if (nativeProcess === child) nativeProcess = null;
        closeNativeLogStreams();
        throw error;
    }
    updateTrayMenu();
    const timeoutMs = Math.max(30000, Number(process.env.DESKTOP_NATIVE_STARTUP_TIMEOUT_MS || 300000));
    return {
        process: child,
        ready: startupProgressCallback
            ? monitorNativeStartup(child, startupProgressCallback, timeoutMs)
            : Promise.resolve()
    };
}

function stopNativeClient() {
    if (nativeStopPromise) return nativeStopPromise;
    const processToStop = nativeProcess;
    nativeProcess = null;
    updateTrayMenu();
    nativeStopPromise = terminateProcess(processToStop).finally(() => {
        closeNativeLogStreams();
        nativeStopPromise = null;
    });
    return nativeStopPromise;
}

async function restartNativeClient() {
    if (!applicationOrigin || !writablePaths) return;
    try {
        await stopNativeClient();
        await startNativeClient(applicationOrigin, writablePaths);
    } catch (error) {
        logDesktopError('native-client-restart', error);
        dialog.showErrorBox(APP_NAME, `原生大屏启动失败：${error.message}`);
        showAdminWindow();
    }
}

async function startBackend(port, writable) {
    if (isQuitting) throw new Error('程序正在退出，已取消数据服务启动');
    if (backendProcess && !hasProcessExited(backendProcess)) {
        throw new Error('旧数据服务仍在运行，不能启动重复进程');
    }
    const backendDir = app.isPackaged
        ? resourcePath('backend')
        : path.resolve(__dirname, '..', 'backend');
    const nodeBinary = resourcePath('runtime', 'node.exe');
    const frontendDir = app.isPackaged
        ? resourcePath('frontend')
        : path.resolve(__dirname, '..', 'frontend', 'dist');
    backendPort = port;
    backendShutdownToken = crypto.randomBytes(32).toString('hex');
    const logStreams = await Promise.all([
        createRotatingLogWriter(writable.logsDir, 'backend.log'),
        createRotatingLogWriter(writable.logsDir, 'backend-error.log')
    ]);
    if (isQuitting) {
        logStreams.forEach(stream => stream.end());
        throw new Error('程序正在退出，已取消数据服务启动');
    }
    backendLogStream = guardLogStream(logStreams[0], '运行日志');
    backendErrorLogStream = guardLogStream(logStreams[1], '后端错误日志');

    const child = trackManagedProcess(spawn(nodeBinary, [path.join(backendDir, 'server.js')], {
        cwd: backendDir,
        windowsHide: true,
        env: {
            ...process.env,
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: String(port),
            APP_DATA_DIR: writable.dataDir,
            UPLOADS_DIR: writable.uploadsDir,
            FRONTEND_DIST: frontendDir,
            ENABLE_CORS: 'false',
            DESKTOP_PACKAGED: app.isPackaged ? 'true' : 'false',
            // A packaged delivery is always locked. The issuer's public key is
            // safe to ship with the customer; the private key stays in the
            // separate license-generator tool. Dev-only overrides are not
            // inherited by the packaged app.
            LICENSE_ENFORCE: app.isPackaged ? 'true' : (process.env.LICENSE_ENFORCE ?? 'false'),
            LICENSE_PUBLIC_KEY_FILE: app.isPackaged
                ? path.join(writable.dataDir, 'license-public-key.pem')
                : (process.env.LICENSE_PUBLIC_KEY_FILE ?? path.join(writable.dataDir, 'license-public-key.pem')),
            LICENSE_MACHINE_ID: app.isPackaged ? '' : (process.env.LICENSE_MACHINE_ID ?? ''),
            LICENSE_MACHINE_STATE_FILE: app.isPackaged
                ? path.join(process.env.PROGRAMDATA || app.getPath('appData'), 'HeatTreatmentDigitalTwin', 'machine-identity.json')
                : (process.env.LICENSE_MACHINE_STATE_FILE ?? ''),
            DESKTOP_AUTO_START_SUPPORTED: app.isPackaged && process.platform === 'win32' && process.env.DISABLE_AUTO_START !== 'true' ? 'true' : 'false',
            SQLITE_RECOVERY_TEMPLATE: process.env.SQLITE_RECOVERY_TEMPLATE ?? resourcePath('templates', 'factory-template.db'),
            SQLITE_UPGRADE_TEMPLATE: process.env.SQLITE_UPGRADE_TEMPLATE ?? resourcePath('templates', 'factory-template.db'),
            DESKTOP_SHUTDOWN_TOKEN: backendShutdownToken,
            DESKTOP_CONTROL_URL: desktopControlOrigin || '',
            DESKTOP_CONTROL_TOKEN: desktopControlToken || '',
            FFMPEG_PATH: resourcePath('ffmpeg', 'ffmpeg.exe'),
            CAST_WINDOW_TITLE: process.env.CAST_WINDOW_TITLE || 'Heat Treatment Digital Twin',
            NODE_PATH: writable.dependenciesDir || resourcePath('backend-dependencies')
        },
        stdio: ['ignore', 'pipe', 'pipe']
    }));

    backendProcess = child;
    child.stdout.pipe(backendLogStream, { end: false });
    child.stderr.pipe(backendErrorLogStream, { end: false });
    child.once('exit', (code, signal) => {
        const wasCurrent = backendProcess === child;
        if (wasCurrent) backendProcess = null;
        if (wasCurrent) closeBackendLogStreams();
        // 后端在投屏期间崩溃时，Node 守护进程来不及执行 stop()；由桌面
        // 宿主兜底把 AdminHost 从“纯展示态”恢复，避免壳长期保持隐藏。
        if (wasCurrent) sendNativeHostCommandWithRetry('restore_cast').catch(() => {});
        if (!isQuitting && wasCurrent) {
            const error = new Error(`本地数据服务异常退出（代码 ${code ?? 'null'}，信号 ${signal || 'none'}）`);
            logDesktopError('backend-exit', error);
            // During an active recovery attempt the awaiting health probe owns the
            // retry chain.  Let it fail fast and schedule the next backoff once.
            if (!backendRestartInProgress) scheduleBackendRestart(writable, port, error.message);
        }
    });
    try {
        await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
    } catch (error) {
        if (backendProcess === child) backendProcess = null;
        try { child.kill(); } catch (killError) { /* ignore */ }
        closeBackendLogStreams();
        throw error;
    }
    return child;
}

function requestBackendShutdown(port, token) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port,
            path: '/api/internal/shutdown',
            method: 'POST',
            headers: {
                'x-shutdown-token': token,
                'content-length': '0'
            }
        }, response => {
            response.resume();
            if (response.statusCode === 202) {
                resolve();
                return;
            }
            reject(new Error(`安全退出请求失败: HTTP ${response.statusCode}`));
        });
        request.setTimeout(2000, () => request.destroy(new Error('安全退出请求超时')));
        request.on('error', reject);
        request.end();
    });
}

function stopBackend() {
    if (backendStopPromise) return backendStopPromise;
    clearBackendRestartTimers();
    backendRestartAttempts = 0;
    backendHealthFailures = 0;
    backendRestartInProgress = false;
    const processToStop = backendProcess;
    const port = backendPort;
    const token = backendShutdownToken;
    backendProcess = null;
    backendPort = null;
    backendShutdownToken = null;
    backendStopPromise = terminateProcess(processToStop, {
        gracefulShutdown: () => requestBackendShutdown(port, token)
    }).finally(() => {
        closeBackendLogStreams();
        backendStopPromise = null;
    });
    return backendStopPromise;
}

function showAdminWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        if (applicationOrigin) createMainWindow(applicationOrigin, true);
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.maximize();
    // Unity normally occupies the full screen. Lift the bundled settings window above it
    // long enough to transfer focus, then restore normal z-order behavior.
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 800).unref?.();
}

function minimizeApplicationToTray() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    if (!tray || hasShownTrayHint) return;
    hasShownTrayHint = true;
    try {
        tray.displayBalloon({
            title: APP_NAME,
            content: '程序仍在后台运行。双击右下角托盘图标可打开软件。',
            iconType: 'info'
        });
    } catch (error) {
        logDesktopError('tray-hint', error);
    }
}

function updateTrayMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: '打开软件',
            click: showNativeDashboard
        },
        {
            label: '退出',
            click: () => app.quit()
        }
    ]));
}

function createTray() {
    if (tray) return;
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
    tray.setToolTip(APP_NAME);
    tray.on('double-click', showNativeDashboard);
    updateTrayMenu();
}

function createMainWindow(origin, showInitially = false) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (showInitially) showAdminWindow();
        return;
    }
    const adminUrl = `${origin}/admin`;
    mainWindow = new BrowserWindow({
        title: APP_NAME,
        width: 1600,
        height: 960,
        minWidth: 1180,
        minHeight: 720,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#111820',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        if (/^https?:\/\//i.test(targetUrl)) shell.openExternal(targetUrl);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
        try {
            if (new URL(targetUrl).origin !== new URL(origin).origin) event.preventDefault();
        } catch (error) { event.preventDefault(); }
    });
    mainWindow.webContents.session.on('will-download', async (event, item, webContents) => {
        if (webContents !== mainWindow?.webContents) return;
        item.pause();
        try {
            const result = await dialog.showSaveDialog(mainWindow, {
                title: '保存备份文件',
                defaultPath: item.getFilename(),
                filters: [
                    { name: '备份文件', extensions: ['zip', 'db'] },
                    { name: '所有文件', extensions: ['*'] }
                ]
            });
            if (result.canceled || !result.filePath) {
                item.cancel();
                return;
            }
            item.setSavePath(result.filePath);
            item.resume();
        } catch (error) {
            item.cancel();
            dialog.showErrorBox(APP_NAME, `备份文件保存失败：${error.message}`);
        }
    });
    mainWindow.once('ready-to-show', () => {
        if (showInitially) showAdminWindow();
    });
    mainWindow.on('close', async event => {
        if (isQuitting) return;
        event.preventDefault();
        if (mainWindowClosePromptActive) return;
        mainWindowClosePromptActive = true;
        try {
            const result = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                title: APP_NAME,
                message: '请选择关闭方式',
                buttons: ['最小化到系统托盘（推荐）', '完全退出程序'],
                defaultId: 0,
                cancelId: 0,
                noLink: true
            });
            if (result.response === 1) app.quit();
            else minimizeApplicationToTray();
        } finally {
            mainWindowClosePromptActive = false;
        }
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(adminUrl);
}

async function launchApplication() {
    await createStartupWindow();
    updateStartupProgress('resources', 6, '正在准备程序资源', '检查运行目录、数据目录和模型资源');
    if (process.env.DESKTOP_SMOKE_FORCE_STARTUP_ERROR) {
        throw new Error(String(process.env.DESKTOP_SMOKE_FORCE_STARTUP_ERROR));
    }
    const writable = initializeWritableData();
    writablePaths = writable;
    updateStartupProgress('logs', 18, '正在初始化日志系统', `日志目录：${writable.logsDir}`);
    desktopErrorLogStream = guardLogStream(
        await createRotatingLogWriter(writable.logsDir, 'desktop-error.log'),
        '桌面错误日志'
    );
    startLogMaintenance(writable.logsDir);
    updateStartupProgress('network', 25, '正在分配本地服务端口', '检测端口占用和本机通信环境');
    const port = await findAvailablePort();
    const origin = `http://127.0.0.1:${port}`;
    applicationOrigin = origin;
    // The backend needs this loopback channel in its environment so a DLNA
    // cast can switch the embedded host back to the Unity dashboard before
    // the desktop region is captured.
    updateStartupProgress('control', 32, '正在启动桌面控制服务', '准备 Unity、后台管理与系统托盘之间的通信');
    await startDesktopControlServer();
    updateStartupProgress('backend', 41, '正在启动数据服务', '连接配置数据库并载入现场配置');
    const initialBackendProcess = await startBackend(port, writable);
    updateStartupProgress('backend-health', 50, '正在检查数据服务', `等待本地接口 ${origin} 就绪`);
    await waitForHealth(`${origin}/api/health`, 60000, initialBackendProcess);
    updateStartupProgress('settings', 59, '正在读取系统设置', '同步开机自启、日志、备份和运行参数');
    await startDesktopSettingsSync();
    if (backendOnlySmokeMode) {
        applicationReadyForInteraction = true;
        completeStartupProgress();
        closeStartupWindow();
        scheduleSmokeTimers();
        return;
    }
    updateStartupProgress('tray', 65, '正在创建系统托盘', '初始化后台常驻与安全退出功能');
    createTray();
    updateStartupProgress('unity-process', 69, '正在启动三维大屏', '创建 Unity 渲染进程');
    const nativeStartup = await startNativeClient(origin, writable, state => {
        const overallProgress = 70 + Math.round(Math.min(100, Math.max(0, state.progress)) * 0.22);
        updateStartupProgress(
            'unity-scene',
            overallProgress,
            state.step || '正在加载三维场景',
            state.warning ? `最近一次加载异常：${state.warning}` : '正在加载现场层级、设备模型与实时数据'
        );
    });
    await nativeStartup.ready;
    updateStartupProgress('admin-host', 94, '正在加载顶部栏和数据组件', '等待后台管理 WebView2 完成首屏渲染');
    await waitForNativeHostReady(45000);
    applicationReadyForInteraction = true;
    if (nativeProcess && (process.argv.includes('--admin') || pendingNativeAdminRequest)) {
        pendingNativeAdminRequest = false;
        setTimeout(showNativeAdminPanel, 600).unref?.();
    }
    updateStartupProgress('ready', 99, '正在完成启动', '确认三维场景、实时数据和顶部组件状态');
    completeStartupProgress();
    await delay(420);
    closeStartupWindow();
    scheduleSmokeTimers();
}

function scheduleSmokeTimers() {
    const smokeCrashBackendAfterMs = Number(process.env.DESKTOP_SMOKE_CRASH_BACKEND_AFTER_MS || 0);
    if (Number.isFinite(smokeCrashBackendAfterMs) && smokeCrashBackendAfterMs > 0) {
        setTimeout(() => {
            if (backendProcess && !isQuitting) backendProcess.kill();
        }, smokeCrashBackendAfterMs);
    }
    const smokeExitAfterMs = Number(process.env.DESKTOP_SMOKE_EXIT_AFTER_MS || 0);
    if (Number.isFinite(smokeExitAfterMs) && smokeExitAfterMs > 0)
    {
        setTimeout(() => app.quit(), smokeExitAfterMs);
    }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (startupWindow && !startupWindow.isDestroyed() && !applicationReadyForInteraction) {
            startupWindow.show();
            startupWindow.focus();
            return;
        }
        showNativeAdminPanel();
    });

    app.whenReady().then(() => {
        return launchApplication();
    }).catch(async (error) => {
        logDesktopError('application-start', error);
        try {
            await showStartupFailure(error);
        } catch (displayError) {
            dialog.showErrorBox(APP_NAME, `${error.message}\n启动错误界面也无法显示：${displayError.message}`);
            app.quit();
        }
    });

    // Windows 上关闭后台窗口只隐藏到托盘，Unity 大屏和后端继续运行。
    app.on('window-all-closed', () => {});
    app.on('before-quit', (event) => {
        if (quitReady) return;
        event.preventDefault();
        if (isQuitting) return;
        isQuitting = true;
        // A quit request may still need to wait for Unity/WebView2 and the
        // backend to release resources. Hide the user-facing window first so
        // slow cleanup is never perceived as a stuck exit button.
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
        if (startupWindow && !startupWindow.isDestroyed()) startupWindow.hide();
        if (!applicationShutdownForceTimer) {
            applicationShutdownForceTimer = setTimeout(() => {
                logDesktopError('forced-shutdown', new Error('安全退出超过 25 秒，强制结束残留进程'));
                for (const child of managedProcesses) {
                    try { child.kill(); } catch (error) { /* ignore */ }
                }
                try { desktopControlServer?.closeIdleConnections?.(); } catch (error) { /* ignore */ }
                try { desktopControlServer?.closeAllConnections?.(); } catch (error) { /* ignore */ }
                app.exit(0);
            }, 25000);
        }
        clearBackendRestartTimers();
        if (desktopSettingsTimer) clearInterval(desktopSettingsTimer);
        desktopSettingsTimer = null;
        stopNativeClient().catch(error => logDesktopError('native-client-shutdown', error)).then(() => Promise.all([
            stopDesktopControlServer(),
            stopBackend()
        ])).catch(error => logDesktopError('application-shutdown', error)).finally(() => {
            if (applicationShutdownForceTimer) clearTimeout(applicationShutdownForceTimer);
            applicationShutdownForceTimer = null;
            if (logCleanupTimer) clearInterval(logCleanupTimer);
            logCleanupTimer = null;
            tray?.destroy();
            tray = null;
            desktopErrorLogStream?.end();
            desktopErrorLogStream = null;
            for (const child of managedProcesses) {
                try { child.kill(); } catch (error) { /* already logged by shutdown */ }
            }
            quitReady = true;
            // All managed children and local servers are already stopped.  Exit
            // directly so stray Chromium/Node handles cannot keep the tray process
            // alive for another minute after the user chose "完全退出".
            app.exit(0);
        });
    });
}
