const fs = require('fs');
const path = require('path');
const {
    BACKEND_DIR,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    testFetch,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `deletion-safety-${process.pid}-${Date.now()}`;

function associationCount(impact, key) {
    return Number(impact?.associations?.find(item => item.key === key)?.count || 0);
}

async function requestStatus(url, options = {}) {
    const response = await testFetch(url, {
        ...options,
        headers: {
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (error) { body = text; }
    return { status: response.status, body };
}

async function addPoint(origin, deviceId, index) {
    return requestJson(`${origin}/api/datapoints`, {
        method: 'POST',
        body: JSON.stringify({
            device_id: deviceId,
            name: `point_${index}`,
            label: `测试点位 ${index}`,
            plc_tag: `DB1.DBW${index * 2}`,
            data_type: 'WORD'
        })
    });
}

async function main() {
    const runDirectory = createRunDirectory('deletion-safety');
    const dataDir = path.join(runDirectory, 'data');
    const uploadsDir = path.join(runDirectory, 'uploads');
    const port = await findFreePort(3531);
    const origin = `http://127.0.0.1:${port}`;
    let backend = null;

    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: path.join(dataDir, 'factory.db')
        }, null, 2));

        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(port),
                APP_DATA_DIR: dataDir,
                UPLOADS_DIR: uploadsDir,
                FRONTEND_DIST: path.resolve(BACKEND_DIR, '..', 'frontend', 'dist'),
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN,
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000)
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${origin}/api/health`, 30000);

        const suffix = `${process.pid}_${Date.now()}`;
        const workshopId = `delete_ws_${suffix}`;
        const workshopName = '删除安全测试车间';
        const lineId = `delete_line_${suffix}`;
        const lineName = '删除安全测试产线';
        const deviceId = `delete_device_${suffix}`;
        const deviceName = '删除安全测试设备';
        const auxiliaryId = `delete_aux_${suffix}`;

        await requestJson(`${origin}/api/workshops`, {
            method: 'POST',
            body: JSON.stringify({ id: workshopId, name: workshopName })
        });
        await requestJson(`${origin}/api/lines`, {
            method: 'POST',
            body: JSON.stringify({ id: lineId, name: lineName, workshop_id: workshopId })
        });
        await requestJson(`${origin}/api/devices`, {
            method: 'POST',
            body: JSON.stringify({ id: deviceId, name: deviceName, line_id: lineId })
        });
        await requestJson(`${origin}/api/devices`, {
            method: 'POST',
            body: JSON.stringify({
                id: auxiliaryId,
                name: '删除安全测试料车',
                line_id: '',
                model_type: 'transfer_cart',
                instance_config: { role: 'auxiliary', workshop_id: workshopId }
            })
        });
        await addPoint(origin, deviceId, 1);
        await addPoint(origin, deviceId, 2);
        await addPoint(origin, auxiliaryId, 3);
        await requestJson(`${origin}/api/settings`, {
            method: 'PUT',
            body: JSON.stringify({
                native_environment_config: JSON.stringify({
                    walls: [
                        { id: 'target-wall', workshopId },
                        { id: 'retained-wall', workshopId: 'another-workshop' }
                    ]
                })
            })
        });

        const workshopImpact = await requestJson(`${origin}/api/workshops/${encodeURIComponent(workshopId)}/deletion-impact`);
        const missingConfirmation = await requestStatus(`${origin}/api/workshops/${encodeURIComponent(workshopId)}`, {
            method: 'DELETE'
        });
        const wrongConfirmation = await requestStatus(`${origin}/api/workshops/${encodeURIComponent(workshopId)}`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmationName: `${workshopName}错误` })
        });
        const workshopDelete = await requestJson(`${origin}/api/workshops/${encodeURIComponent(workshopId)}`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmationName: workshopName })
        });

        const remainingLines = await requestJson(`${origin}/api/lines`);
        const remainingDevices = await requestJson(`${origin}/api/devices`);
        const remainingPoints = await requestJson(`${origin}/api/datapoints`);
        const settings = await requestJson(`${origin}/api/settings`);
        const environment = JSON.parse(settings.native_environment_config || '{}');

        const lineWorkshopId = `line_parent_${suffix}`;
        const guardedLineId = `guarded_line_${suffix}`;
        const guardedLineName = '需要名称确认的产线';
        const guardedDeviceId = `line_device_${suffix}`;
        await requestJson(`${origin}/api/workshops`, {
            method: 'POST',
            body: JSON.stringify({ id: lineWorkshopId, name: '保留车间' })
        });
        await requestJson(`${origin}/api/lines`, {
            method: 'POST',
            body: JSON.stringify({ id: guardedLineId, name: guardedLineName, workshop_id: lineWorkshopId })
        });
        await requestJson(`${origin}/api/devices`, {
            method: 'POST',
            body: JSON.stringify({ id: guardedDeviceId, name: '产线关联设备', line_id: guardedLineId })
        });
        await addPoint(origin, guardedDeviceId, 4);
        const lineImpact = await requestJson(`${origin}/api/lines/${encodeURIComponent(guardedLineId)}/deletion-impact`);
        const lineWrong = await requestStatus(`${origin}/api/lines/${encodeURIComponent(guardedLineId)}`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmationName: '错误产线名' })
        });
        await requestJson(`${origin}/api/lines/${encodeURIComponent(guardedLineId)}`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmationName: guardedLineName })
        });

        const deviceLineId = `device_line_${suffix}`;
        const guardedDevice2Id = `guarded_device_${suffix}`;
        const guardedDevice2Name = '需要名称确认的设备';
        await requestJson(`${origin}/api/lines`, {
            method: 'POST',
            body: JSON.stringify({ id: deviceLineId, name: '保留产线', workshop_id: lineWorkshopId })
        });
        await requestJson(`${origin}/api/devices`, {
            method: 'POST',
            body: JSON.stringify({ id: guardedDevice2Id, name: guardedDevice2Name, line_id: deviceLineId })
        });
        await addPoint(origin, guardedDevice2Id, 5);
        await addPoint(origin, guardedDevice2Id, 6);
        const deviceImpact = await requestJson(`${origin}/api/devices/${encodeURIComponent(guardedDevice2Id)}/deletion-impact`);
        const deviceWrong = await requestStatus(`${origin}/api/devices/${encodeURIComponent(guardedDevice2Id)}`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmationName: `${guardedDevice2Name}错误` })
        });
        await requestJson(`${origin}/api/devices/${encodeURIComponent(guardedDevice2Id)}`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmationName: guardedDevice2Name })
        });

        const finalLines = await requestJson(`${origin}/api/lines`);
        const finalDevices = await requestJson(`${origin}/api/devices`);
        const finalPoints = await requestJson(`${origin}/api/datapoints`);
        const checks = {
            workshopImpactCounts: associationCount(workshopImpact, 'lines') === 1
                && associationCount(workshopImpact, 'devices') === 2
                && associationCount(workshopImpact, 'dataPoints') === 3
                && associationCount(workshopImpact, 'walls') === 1,
            workshopNameRequired: missingConfirmation.status === 409 && wrongConfirmation.status === 409,
            workshopCascadeComplete: workshopDelete.success === true
                && !remainingLines.some(item => item.id === lineId)
                && !remainingDevices.some(item => item.id === deviceId || item.id === auxiliaryId)
                && !remainingPoints.some(item => item.device_id === deviceId || item.device_id === auxiliaryId),
            workshopWallCleanupScoped: !environment.walls.some(item => item.id === 'target-wall')
                && environment.walls.some(item => item.id === 'retained-wall'),
            lineImpactCounts: associationCount(lineImpact, 'devices') === 1
                && associationCount(lineImpact, 'dataPoints') === 1,
            lineNameRequired: lineWrong.status === 409,
            lineCascadeComplete: !finalLines.some(item => item.id === guardedLineId)
                && !finalDevices.some(item => item.id === guardedDeviceId)
                && !finalPoints.some(item => item.device_id === guardedDeviceId),
            deviceImpactCounts: associationCount(deviceImpact, 'dataPoints') === 2,
            deviceNameRequired: deviceWrong.status === 409,
            deviceCascadeComplete: finalLines.some(item => item.id === deviceLineId)
                && !finalDevices.some(item => item.id === guardedDevice2Id)
                && !finalPoints.some(item => item.device_id === guardedDevice2Id)
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key);
        if (failed.length) throw new Error(`删除安全检查失败：${failed.join(', ')}\n${JSON.stringify({ workshopImpact, lineImpact, deviceImpact }, null, 2)}`);

        await requestJson(`${origin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
        await waitForExit(backend, 15000);
        backend = null;
        console.log(JSON.stringify({ success: true, checks, runDirectory }, null, 2));
    } finally {
        if (backend) await forceStop(backend);
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
