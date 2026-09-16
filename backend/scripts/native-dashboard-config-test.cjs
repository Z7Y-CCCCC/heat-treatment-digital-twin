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
    waitForHttp
} = require('./integration-test-utils.cjs');

function waitForOpen(socket, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), timeoutMs);
        socket.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function waitForConfigurationChanged(socket, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('未收到 configuration_changed')), timeoutMs);
        const onMessage = raw => {
            const message = JSON.parse(String(raw));
            if (message.type !== 'configuration_changed') return;
            if (!message.payload?.keys?.includes('native_dashboard_config')) return;
            if (!message.payload?.keys?.includes('native_environment_config')) return;
            clearTimeout(timer);
            socket.off('message', onMessage);
            resolve(message);
        };
        socket.on('message', onMessage);
    });
}

async function main() {
    const runDirectory = createRunDirectory('native-dashboard-config');
    const dataDir = path.join(runDirectory, 'data');
    await createTestDatabase(path.join(dataDir, 'factory.db'));
    const port = await findFreePort(Number(process.env.TEST_BACKEND_PORT || 3011));
    const origin = `http://127.0.0.1:${port}`;
    const backend = startLoggedProcess(process.execPath, ['server.js'], {
        cwd: BACKEND_DIR,
        logFile: path.join(runDirectory, 'backend.log'),
        env: {
            ...process.env,
            PORT: String(port),
            HOST: '127.0.0.1',
            APP_DATA_DIR: dataDir,
            DB_TYPE: 'sqlite'
        }
    });

    let socket;
    let originalText;
    let originalEnvironmentText;
    try {
        const health = await waitForHttp(`${origin}/api/health`, 35000);
        const originalSettings = await requestJson(`${origin}/api/settings`);
        originalText = originalSettings.native_dashboard_config || '{}';
        originalEnvironmentText = originalSettings.native_environment_config || '{}';
        const original = JSON.parse(originalText);
        const originalEnvironment = JSON.parse(originalEnvironmentText);
        const changed = {
            ...original,
            sideMargin: Number(original.sideMargin || 24) === 31 ? 32 : 31
        };
        const changedEnvironment = {
            ...originalEnvironment,
            preset: 'custom',
            sceneBrightness: Number(originalEnvironment.sceneBrightness || 1.2) === 1.23 ? 1.24 : 1.23
        };

        socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await waitForOpen(socket);
        const eventPromise = waitForConfigurationChanged(socket);
        const saved = await requestJson(`${origin}/api/settings`, {
            method: 'PUT',
            body: JSON.stringify({
                native_dashboard_config: JSON.stringify(changed),
                native_environment_config: JSON.stringify(changedEnvironment)
            })
        });
        const event = await eventPromise;
        const persisted = await requestJson(`${origin}/api/settings`);
        const persistedConfig = JSON.parse(persisted.native_dashboard_config);
        const persistedEnvironment = JSON.parse(persisted.native_environment_config);
        const config = await requestJson(`${origin}/api/config`);
        const devices = (config.workshops || []).flatMap(workshop => [
            ...(workshop.devices || []),
            ...(workshop.lines || []).flatMap(line => line.devices || [])
        ]);
        const points = devices.reduce((sum, device) => sum + (device.dataPoints || []).length, 0);

        if (saved.success !== true) throw new Error('设置保存接口未返回 success');
        if (event.type !== 'configuration_changed') throw new Error('WebSocket 配置事件类型不正确');
        if (persistedConfig.sideMargin !== changed.sideMargin) throw new Error('配置未持久化');
        if (persistedEnvironment.sceneBrightness !== changedEnvironment.sceneBrightness) {
            throw new Error('场景与光效配置未持久化');
        }
        if (health.db?.type !== 'sqlite') throw new Error(`测试后端未使用隔离 SQLite: ${health.db?.type}`);
        if (devices.length === 0 || points === 0) throw new Error('测试库中未读到设备或点位配置');

        console.log(JSON.stringify({
            success: true,
            database: health.db?.type,
            eventType: event.type,
            changedKeys: event.payload.keys,
            persistedSideMargin: persistedConfig.sideMargin,
            persistedSceneBrightness: persistedEnvironment.sceneBrightness,
            devices: devices.length,
            points,
            output: runDirectory
        }, null, 2));
    } finally {
        if (originalText !== undefined || originalEnvironmentText !== undefined) {
            try {
                await requestJson(`${origin}/api/settings`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        native_dashboard_config: originalText || '{}',
                        native_environment_config: originalEnvironmentText || '{}'
                    })
                });
            } catch (error) {
                console.error(`原配置恢复失败: ${error.message}`);
            }
        }
        try { socket?.close(); } catch (error) { /* ignore */ }
        await forceStop(backend);
    }
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
