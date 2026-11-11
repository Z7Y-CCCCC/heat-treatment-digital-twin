'use strict';

// Private child process: no HTTP listener and no browser/admin credentials.
if (!process.send || !process.connected) throw new Error('Collector requires a private IPC channel');
process.env.COLLECTOR_DATABASE_CONNECT_ONLY = 'true';
const DataEngine = require('./dataEngine');
const { closeDb } = require('../db/database');
const { closeAlarmOutbox } = require('./alarmOutbox');
const { CollectorTelemetry } = require('../utils/collectorTelemetry');
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
let stopping = false, started = false;
let eventLoopLagMs = 0, lastTick = Date.now(), memoryRssBytes = process.memoryUsage().rss;

function send(message, callback = () => {}) {
    if (!process.connected) { callback(new Error('Parent disconnected')); return; }
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_MESSAGE_BYTES) {
        callback(new Error('Collector IPC payload exceeds bounded capacity'));
        stop(1);
        return;
    }
    try { process.send(message, callback); }
    catch (error) { callback(error); stop(1); }
}

const telemetry = new CollectorTelemetry((devices, done) => send({
    type: 'telemetry', devices, status: engine.getStatus(),
    factories: engine.getFactoryStatuses(), activeFactoryId: engine.activeFactoryId,
    diagnostics: { droppedSamples: telemetry.dropped, memoryRssBytes, eventLoopLagMs }
}, done));
const engine = new DataEngine({
    broadcastDeviceData(devices) { if (!stopping) telemetry.add(devices); },
    broadcastStatus() { /* included in heartbeat and latest-frame telemetry */ }
});
const heartbeat = setInterval(() => {
    const now = Date.now(); eventLoopLagMs = Math.max(0, now - lastTick - 1000); lastTick = now;
    memoryRssBytes = process.memoryUsage().rss;
    if (!stopping) telemetry.flush();
}, 1000);

async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    telemetry.close();
    const deadline = setTimeout(() => process.exit(1), 7000);
    try {
        await engine.stop();
        closeAlarmOutbox();
        await closeDb();
        clearTimeout(deadline);
        process.exit(code);
    } catch (error) {
        console.error('[CollectorWorker] Shutdown:', error.message);
        process.exit(1);
    }
}

process.on('message', async message => {
    if (stopping || !message || message.type !== 'request') return;
    const { id, method, payload } = message;
    try {
        let result;
        if (method === 'start' && !started) {
            started = true;
            await engine.start();
            telemetry.flush();
            result = { started: true };
        } else if (method === 'factoryCollection' && started) {
            result = await engine.setFactoryCollectionEnabled(payload.factoryId);
            telemetry.flush();
        } else if (method === 'reloadFactory' && started) {
            result = await engine.reloadFactoryConfiguration(payload.factoryId);
            telemetry.remove(result.removedDeviceIds);
            telemetry.flush();
        } else if (method === 'simulationPoint' && started) {
            result = engine.setSimulationPointValue(payload.point, payload.value, payload.reset, payload.factoryId);
            telemetry.flush();
        } else if (method === 'points' && started) {
            const source = payload.factoryId && payload.factoryId !== engine.activeFactoryId
                ? engine.factoryEngines.get(payload.factoryId) : engine;
            result = source?.getPointRuntimeValues(payload.deviceId, payload.points) || {
                deviceStatus: null, snapshotTimestamp: null,
                points: payload.points.map(point => ({ ...point, value: null, quality: 'bad' }))
            };
        } else if (method === 'stop') {
            await stop();
            return;
        } else throw new Error('Unknown collector command');
        send({ type: 'response', id, result });
    } catch (error) {
        send({ type: 'response', id, error: String(error.message).slice(0, 500) });
    }
});
process.once('disconnect', () => stop());
process.once('SIGTERM', () => stop());
process.once('SIGINT', () => stop());
send({ type: 'online' });
