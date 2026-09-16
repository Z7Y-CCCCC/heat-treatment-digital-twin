const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const {
    BACKEND_DIR,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    requestJson,
    startLoggedProcess,
    testFetch,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = 'voice-feature-test-shutdown';

async function stopBackend(backendOrigin, backend) {
    if (!backend) return;
    try {
        await fetch(`${backendOrigin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
    } catch (error) { /* best effort */ }
    try {
        await waitForExit(backend, 15000);
    } catch (error) {
        await forceStop(backend);
    }
}

async function main() {
    const runDirectory = createRunDirectory('voice-feature');
    const dataDir = path.join(runDirectory, 'data');
    const uploadsDir = path.join(runDirectory, 'uploads');
    const databaseFile = path.join(dataDir, 'factory.db');
    const resultFile = path.join(runDirectory, 'result.json');
    let backend = null;
    let backendOrigin = '';
    const startedAt = Date.now();

    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(uploadsDir, { recursive: true });
        await createTestDatabase(databaseFile);
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2));

        const port = await findFreePort(3401);
        backendOrigin = `http://127.0.0.1:${port}`;
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HOST: '127.0.0.1',
                PORT: String(port),
                APP_DATA_DIR: dataDir,
                UPLOADS_DIR: uploadsDir,
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN,
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000)
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${backendOrigin}/api/health`, 30000);

        const voiceList = await requestJson(`${backendOrigin}/api/voice/voices`);
        if (!voiceList.success || !Array.isArray(voiceList.voices)) throw new Error('System voice list API failed');

        const devices = await requestJson(`${backendOrigin}/api/devices`);
        const device = devices[0];
        if (!device?.id) throw new Error('No device available for voice point test');

        const rule = {
            id: 'voice_test_rule',
            enabled: true,
            trigger: 'rising',
            mode: 'auto',
            text: '{设备} 测试点位已接通',
            cooldown_ms: 5000,
            volume: 0.8,
            rate: 1,
            announce_on_start: false
        };
        const created = await requestJson(`${backendOrigin}/api/datapoints`, {
            method: 'POST',
            body: JSON.stringify({
                device_id: device.id,
                name: 'voice_feature_test',
                label: '语音功能测试点',
                plc_tag: 'DB1.DBX0.0',
                data_type: 'BOOL',
                category: 'status',
                value_role: 'voice_feature_test',
                sample_interval_ms: 1000,
                access_type: 'READ',
                voice_config: { enabled: true, rules: [rule] }
            })
        });
        if (!created.success || !created.id) throw new Error('Voice point creation failed');

        const points = await requestJson(`${backendOrigin}/api/datapoints?device_id=${encodeURIComponent(device.id)}`);
        const savedPoint = points.find(point => Number(point.id) === Number(created.id));
        if (!savedPoint) throw new Error('Saved voice point cannot be read back');
        const savedVoiceConfig = JSON.parse(savedPoint.voice_config || '{}');
        if (savedVoiceConfig.rules?.[0]?.text !== rule.text) throw new Error('Voice rule was not persisted correctly');

        const generated = await requestJson(`${backendOrigin}/api/voice/generate`, {
            method: 'POST',
            body: JSON.stringify({
                text: '语音功能集成测试成功',
                voice_name: voiceList.voices.find(voice => voice.culture === 'zh-CN')?.name || '',
                rate: 1,
                volume: 0.8
            })
        });
        if (!generated.success || !generated.url) throw new Error('Voice WAV generation API failed');
        const audioResponse = await fetch(`${backendOrigin}${generated.url}`);
        if (!audioResponse.ok) throw new Error(`Generated audio download failed: HTTP ${audioResponse.status}`);
        const audio = Buffer.from(await audioResponse.arrayBuffer());
        if (audio.length <= 44 || audio.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('Generated audio is not a valid WAV file');

        const exported = await requestJson(`${backendOrigin}/api/site-backups/export`, { method: 'POST' });
        if (!exported.success || !exported.backup?.filename) throw new Error('Site backup export failed');
        const archiveResponse = await testFetch(`${backendOrigin}/api/site-backups/${encodeURIComponent(exported.backup.filename)}/download`);
        const archiveFilename = path.join(runDirectory, exported.backup.filename);
        fs.writeFileSync(archiveFilename, Buffer.from(await archiveResponse.arrayBuffer()));
        const archive = await unzipper.Open.file(archiveFilename);
        const audioArchivePath = `uploads/audio/${generated.filename}`;
        if (!archive.files.some(entry => entry.path === audioArchivePath)) {
            throw new Error(`Site backup is missing generated voice file: ${audioArchivePath}`);
        }

        const result = {
            success: true,
            durationMs: Date.now() - startedAt,
            backendOrigin,
            systemVoiceCount: voiceList.voices.length,
            chineseVoice: voiceList.voices.find(voice => voice.culture === 'zh-CN')?.name || null,
            pointId: created.id,
            voiceConfig: savedVoiceConfig,
            generatedAudio: {
                filename: generated.filename,
                size: audio.length,
                archivePath: audioArchivePath
            }
        };
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ resultFile, ...result }, null, 2));
    } catch (error) {
        const result = { success: false, error: error.stack || error.message, durationMs: Date.now() - startedAt };
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        throw error;
    } finally {
        await stopBackend(backendOrigin, backend);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
