const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort, startLoggedProcess, testFetch: fetch } = require('../backend/scripts/integration-test-utils.cjs');

const projectDir = path.resolve(__dirname, '..');
const backendDir = path.join(projectDir, 'backend');
let tmpDir;
let port;
const shutdownToken = `native-smoke-${process.pid}-${Date.now()}`;
let unityLog;
const unityExe = path.join(
    projectDir,
    'unity-client',
    'Builds',
    'Windows',
    'HeatTreatmentDigitalTwin.exe'
);

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForHealth(url, child, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Isolated backend exited during startup');
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (response.ok) return;
        } catch (error) { /* retry */ }
        await wait(300);
    }
    throw new Error(`Backend health timeout: ${url}`);
}

async function waitForUnityReady(child, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const text = fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
        if (text.includes('[FactoryRuntime] Native factory ready')) {
            await wait(2500);
            return fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : text;
        }
        if (text.includes('Factory ready; one or more model files used fallback geometry')) return text;
        if (child.exitCode !== null) return text;
        await wait(500);
    }
    return fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
}

async function waitForUnityLiveConfiguration(previousCount, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const text = fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
        const count = (text.match(/\[FactoryRuntime\] Dashboard configuration updated live/g) || []).length;
        if (count > previousCount) return text;
        await wait(250);
    }
    return fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
}

async function waitForUnityQuality(profile, previousCount, timeoutMs = 15000) {
    const escaped = String(profile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\[NativeQuality\\] Applied ${escaped}\\b`, 'g');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const text = fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
        if ((text.match(pattern) || []).length > previousCount) return text;
        await wait(250);
    }
    return fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
}

async function waitForUnityAnyQuality(previousCount, timeoutMs = 15000) {
    const pattern = /\[NativeQuality\] Applied (integrated_gpu|balanced|showcase)\b/g;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const text = fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
        if ((text.match(pattern) || []).length > previousCount) return text;
        await wait(250);
    }
    return fs.existsSync(unityLog) ? fs.readFileSync(unityLog, 'utf8') : '';
}

async function main() {
    if (!fs.existsSync(unityExe)) throw new Error(`Missing Unity player: ${unityExe}`);
    const sandbox = await createSmokeSandbox('native-client-smoke');
    tmpDir = sandbox.directory;
    unityLog = path.join(tmpDir, 'native-smoke-unity.log');
    port = await findFreePort(process.env.NATIVE_SMOKE_PORT);

    const origin = `http://127.0.0.1:${port}`;
    let backend;
    let unity;
    let originalDashboardConfig;
    let originalQualityProfile;
    try {
        const databaseType = 'sqlite';
        backend = startLoggedProcess(process.execPath, ['server.js'], {
            cwd: backendDir,
            logFile: path.join(tmpDir, 'backend.log'),
            env: {
                ...sandbox.env,
                NODE_ENV: 'production',
                HOST: '127.0.0.1',
                PORT: String(port),
                FRONTEND_DIST: path.join(projectDir, 'frontend', 'dist'),
                ENABLE_CORS: 'true',
                DESKTOP_SHUTDOWN_TOKEN: shutdownToken
            }
        });
        await waitForHealth(`${origin}/api/health`, backend);

        const configResponse = await fetch(`${origin}/api/config`);
        if (!configResponse.ok) throw new Error(`Config HTTP ${configResponse.status}`);
        const config = await configResponse.json();
        const devices = (config.workshops || []).flatMap(workshop => [
            ...(workshop.devices || []),
            ...(workshop.lines || []).flatMap(line => line.devices || [])
        ]);
        const deviceModels = [...new Set(devices.map(device => device.model_type))];
        const modelById = new Map((config.models || []).map(model => [model.id, model]));
        const modelResults = [];
        for (const modelId of deviceModels) {
            const model = modelById.get(modelId);
            if (!model?.file_path) throw new Error(`Configured model has no file: ${modelId}`);
            const modelUrl = new URL(model.file_path, origin);
            const response = await fetch(modelUrl);
            const bytes = (await response.arrayBuffer()).byteLength;
            modelResults.push({
                id: modelId,
                status: response.status,
                contentType: response.headers.get('content-type'),
                bytes
            });
            if (!response.ok || bytes <= 0) throw new Error(`Model ${modelId} HTTP ${response.status}`);
        }

        unity = spawn(unityExe, [
            '-batchmode',
            '-force-d3d11',
            '-screen-fullscreen', '0',
            '-screen-width', '960',
            '-screen-height', '540',
            '-logFile', unityLog
        ], {
            cwd: path.dirname(unityExe),
            windowsHide: true,
            env: {
                ...sandbox.env,
                NO_PROXY: [process.env.NO_PROXY, 'localhost', '127.0.0.1']
                    .filter(Boolean)
                    .join(','),
                DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
                DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace(/^http/i, 'ws') + '/ws'
            },
            stdio: 'ignore'
        });
        let unityText = await waitForUnityReady(unity);
        const loadedModels = deviceModels.filter(modelId => unityText.includes(`[RuntimeModelLibrary] Loaded ${modelId}`));
        const readyLine = unityText.split(/\r?\n/).find(line =>
            line.includes('[FactoryRuntime] Native factory ready')
        ) || '';
        const settings = await fetch(`${origin}/api/settings`).then(response => response.json());
        originalDashboardConfig = settings.native_dashboard_config || '{}';
        originalQualityProfile = settings.native_quality_profile || 'auto';
        const dashboardConfig = JSON.parse(originalDashboardConfig);

        const qualityApplicationsBefore = (unityText.match(/\[NativeQuality\] Applied (integrated_gpu|balanced|showcase)\b/g) || []).length;
        const integratedApplicationsBefore = (unityText.match(/\[NativeQuality\] Applied integrated_gpu\b/g) || []).length;
        await fetch(`${origin}/api/settings`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ native_quality_profile: 'integrated_gpu' })
        });
        unityText = await waitForUnityQuality('integrated_gpu', integratedApplicationsBefore);
        const integratedQualityApplied = (unityText.match(/\[NativeQuality\] Applied integrated_gpu\b/g) || []).length > integratedApplicationsBefore;
        const qualityApplicationsAfterIntegrated = (unityText.match(/\[NativeQuality\] Applied (integrated_gpu|balanced|showcase)\b/g) || []).length;
        await fetch(`${origin}/api/settings`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ native_quality_profile: 'auto' })
        });
        unityText = await waitForUnityAnyQuality(qualityApplicationsAfterIntegrated);
        const automaticQualityApplied = (unityText.match(/\[NativeQuality\] Applied (integrated_gpu|balanced|showcase)\b/g) || []).length > qualityApplicationsAfterIntegrated;

        const previousLiveUpdates = (unityText.match(/\[FactoryRuntime\] Dashboard configuration updated live/g) || []).length;
        await fetch(`${origin}/api/settings`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                native_dashboard_config: JSON.stringify({
                    ...dashboardConfig,
                    sideMargin: Number(dashboardConfig.sideMargin || 24) === 31 ? 32 : 31
                })
            })
        });
        unityText = await waitForUnityLiveConfiguration(previousLiveUpdates);
        const liveConfigurationApplied = (unityText.match(/\[FactoryRuntime\] Dashboard configuration updated live/g) || []).length > previousLiveUpdates;
        const usedFallback = unityText.includes('one or more model files used fallback geometry');
        const runtimeExceptions = unityText.match(/(?:InvalidCast|NullReference|Argument|IndexOutOfRange)Exception:/g) || [];
        const result = {
            success: devices.length > 0
                && deviceModels.length > 0
                && modelResults.every(model => model.status === 200 && model.bytes > 0)
                && loadedModels.length === deviceModels.length
                && Boolean(readyLine)
                && integratedQualityApplied
                && automaticQualityApplied
                && liveConfigurationApplied
                && unity.exitCode === null && unity.signalCode === null
                && !usedFallback
                && runtimeExceptions.length === 0,
            backendPort: port,
            databaseType,
            deviceCount: devices.length,
            deviceModels,
            modelResults,
            loadedModels,
            readyLine,
            integratedQualityApplied,
            automaticQualityApplied,
            liveConfigurationApplied,
            usedFallback,
            runtimeExceptionCount: runtimeExceptions.length,
            unityExitedEarly: unity.exitCode !== null
        };
        console.log(JSON.stringify(result, null, 2));
        if (!result.success) throw new Error(`Native smoke test failed; inspect ${unityLog}`);
    } finally {
        if (originalDashboardConfig && backend) {
            try {
                await fetch(`${origin}/api/settings`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ native_dashboard_config: originalDashboardConfig })
                });
            } catch (error) { /* best effort restore */ }
        }
        if (backend && originalQualityProfile !== undefined) {
            try {
                await fetch(`${origin}/api/settings`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ native_quality_profile: originalQualityProfile })
                });
            } catch (error) { /* best effort restore */ }
        }
        await stopOwnedSmokeProcess(unity);
        if (backend) {
            try {
                await fetch(`${origin}/api/internal/shutdown`, {
                    method: 'POST',
                    headers: { 'x-shutdown-token': shutdownToken }
                });
                await wait(1200);
            } catch (error) { /* force close below */ }
            await stopOwnedSmokeProcess(backend);
        }
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
