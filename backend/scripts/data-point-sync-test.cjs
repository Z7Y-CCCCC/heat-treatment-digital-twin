const fs = require('fs');
const path = require('path');
const {
    BACKEND_DIR,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `data-point-sync-${process.pid}-${Date.now()}`;

function point(name, label, plcTag) {
    return {
        name,
        label,
        plc_tag: plcTag,
        data_type: 'WORD',
        sample_interval_ms: 1000,
        access_type: 'READ'
    };
}

function assertResult(actual, expected, label) {
    for (const [key, value] of Object.entries(expected)) {
        if (actual?.[key] !== value) {
            throw new Error(`${label} ${key} 应为 ${value}，实际为 ${JSON.stringify(actual)}`);
        }
    }
}

async function main() {
    const runDirectory = createRunDirectory('data-point-sync');
    const dataDir = path.join(runDirectory, 'data');
    const uploadsDir = path.join(runDirectory, 'uploads');
    const databaseFile = path.join(dataDir, 'factory.db');
    const port = await findFreePort(3491);
    const origin = `http://127.0.0.1:${port}`;
    let backend = null;

    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(uploadsDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
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
        const workshopId = `sync_ws_${suffix}`;
        const lineId = `sync_line_${suffix}`;
        const deviceId = `sync_device_${suffix}`;
        await requestJson(`${origin}/api/workshops`, {
            method: 'POST',
            body: JSON.stringify({ id: workshopId, name: '差异保存测试车间' })
        });
        await requestJson(`${origin}/api/lines`, {
            method: 'POST',
            body: JSON.stringify({ id: lineId, name: '差异保存测试产线', workshop_id: workshopId })
        });
        await requestJson(`${origin}/api/devices`, {
            method: 'POST',
            body: JSON.stringify({ id: deviceId, name: '差异保存测试设备', line_id: lineId })
        });

        const initialPoints = [
            point('temperature_actual', '实际温度', 'DB1.DBW0'),
            point('temperature_target', '目标温度', 'DB1.DBW2'),
            point('pressure_actual', '实际压力', 'DB1.DBW4')
        ];
        await requestJson(`${origin}/api/datapoints/batch`, {
            method: 'POST',
            body: JSON.stringify({ device_id: deviceId, points: initialPoints })
        });

        const loaded = await requestJson(`${origin}/api/datapoints?device_id=${encodeURIComponent(deviceId)}`);
        const originalIds = loaded.map(row => Number(row.id));
        const unchanged = await requestJson(`${origin}/api/datapoints/sync`, {
            method: 'POST',
            body: JSON.stringify({ device_id: deviceId, points: loaded })
        });
        assertResult(unchanged, { changed: 0, inserted: 0, updated: 0, deleted: 0, unchanged: 3 }, '无变化保存');

        const editedRows = loaded.map(row => ({ ...row }));
        editedRows[1].label = '温度设定值';
        const edited = await requestJson(`${origin}/api/datapoints/sync`, {
            method: 'POST',
            body: JSON.stringify({ device_id: deviceId, points: editedRows })
        });
        assertResult(edited, { changed: 1, inserted: 0, updated: 1, deleted: 0, unchanged: 2 }, '单行修改');

        const afterEdit = await requestJson(`${origin}/api/datapoints?device_id=${encodeURIComponent(deviceId)}`);
        if (afterEdit[1].label !== '温度设定值' || afterEdit.some((row, index) => Number(row.id) !== originalIds[index])) {
            throw new Error(`单行修改后数据或 ID 不正确: ${JSON.stringify(afterEdit)}`);
        }

        const desiredRows = [
            afterEdit[0],
            afterEdit[1],
            point('fan_speed', '风机转速', 'DB1.DBW6')
        ];
        const addedAndDeleted = await requestJson(`${origin}/api/datapoints/sync`, {
            method: 'POST',
            body: JSON.stringify({ device_id: deviceId, points: desiredRows })
        });
        assertResult(addedAndDeleted, { changed: 2, inserted: 1, updated: 0, deleted: 1, unchanged: 2 }, '新增并删除');

        const finalRows = await requestJson(`${origin}/api/datapoints?device_id=${encodeURIComponent(deviceId)}`);
        if (
            finalRows.length !== 3
            || Number(finalRows[0].id) !== originalIds[0]
            || Number(finalRows[1].id) !== originalIds[1]
            || finalRows[2].label !== '风机转速'
        ) {
            throw new Error(`最终点位状态不正确: ${JSON.stringify(finalRows)}`);
        }

        const alarm = { ...point('named_alarm','风机过热报警','DB1.DBW8'), point_kind:'alarm' };
        const alarmSave=await requestJson(`${origin}/api/datapoints/sync`, {
            method:'POST',body:JSON.stringify({device_id:deviceId,points:[...finalRows,alarm]})
        });
        assertResult(alarmSave,{inserted:1,updated:0,deleted:0},'新增具名报警');
        const withAlarm=await requestJson(`${origin}/api/datapoints?device_id=${encodeURIComponent(deviceId)}`);
        if(withAlarm.at(-1).alarm_condition!=='!=0') throw new Error('新报警必须默认非0触发');
        for(const invalid of [{alarm_condition:'invalid'}, {data_type:'STRING',plc_tag:'DB1,S20.20'}]) {
            let rejected=false;
            try { await requestJson(`${origin}/api/datapoints/sync`,{method:'POST',body:JSON.stringify({device_id:deviceId,points:[...withAlarm.slice(0,-1),{...withAlarm.at(-1),...invalid}]})}); }
            catch(error) { rejected=/400/.test(error.message); }
            if(!rejected) throw new Error('无效报警条件/类型必须拒绝');
            const unchanged=await requestJson(`${origin}/api/datapoints?device_id=${encodeURIComponent(deviceId)}`);
            if(JSON.stringify(unchanged)!==JSON.stringify(withAlarm)) throw new Error('无效报警配置不得改写任何点位');
        }
        console.log('PASS named alarm defaults to nonzero; invalid conditions/text triggers rejected atomically');
        await requestJson(`${origin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
        await waitForExit(backend, 15000);
        backend = null;
        console.log(JSON.stringify({ success: true, port, runDirectory }, null, 2));
    } finally {
        if (backend) await forceStop(backend);
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
