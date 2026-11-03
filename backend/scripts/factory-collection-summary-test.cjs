const assert = require('node:assert/strict');
const { summarizeFactoryCollection: summarize } = require('../services/factoryCollectionSummary');
const now = 1900000000000, factory = { id: 'hidden-factory', collection_enabled: 1, is_enabled: 0, mode: 'integrated_plc' };
const devices = [{ id: 'good', plc_enabled: 1 }, { id: 'bad', plc_enabled: 1 }, { id: 'pending', plc_enabled: 1 }, { id: 'not-collected', plc_enabled: 0 }];
const runtime = { observedAt: now, mode: 'integrated_plc', collectorStatus: { status: 'connected', lastFrameAt: now }, plcStatus: { devices: [
    { deviceId: 'good', status: 'connected', quality: 'good', lastReadAt: now - 500, intervals: [1000] },
    { deviceId: 'bad', status: 'offline', quality: 'bad', lastReadAt: now - 60000 },
    { deviceId: 'pending', status: 'connecting', quality: 'stale', lastReadAt: null },
    { deviceId: 'not-collected', status: 'disabled', quality: 'bad' }
] } };
const before = JSON.stringify({ factory, devices, runtime });
const result = summarize(factory, devices, runtime, 'running', now);
assert.deepEqual([result.totalDevices, result.normalDevices, result.abnormalDevices, result.pendingDevices], [3, 1, 1, 1]);
assert.equal(result.lastReadAt, now - 500); assert.equal(result.status, 'abnormal');
assert.equal(JSON.stringify({ factory, devices, runtime }), before);
const stopped = summarize({ ...factory, collection_enabled: 0 }, devices, runtime, 'running', now);
assert.equal(stopped.status, 'disabled'); assert.equal(stopped.abnormalDevices, 0);
assert.equal(summarize(factory, [], runtime, 'running', now).status, 'no_devices');
assert.equal(summarize(factory, [devices[3]], runtime, 'running', now).status, 'unconfigured');
assert.equal(summarize(factory, devices, null, 'starting', now).pendingDevices, 3);
for (const process of ['recovering', 'unresponsive', 'stopped']) {
    const status = summarize(factory, devices, runtime, process, now);
    assert.equal(status.status, 'unavailable'); assert.equal(status.normalDevices, 0); assert.equal(status.abnormalDevices, 3);
}
assert.equal(summarize(factory, devices, { ...runtime, observedAt: now - 20000 }, 'running', now).normalDevices, 0);
const long = { ...runtime, plcStatus: { devices: [{ ...runtime.plcStatus.devices[0], lastReadAt: now - 50000, intervals: [60000] }] } };
assert.equal(summarize(factory, [devices[0]], long, 'running', now).normalDevices, 1, 'long configured sampling interval is not treated as missing data');
assert.equal(summarize(factory, [devices[0]], { ...long, plcStatus: { devices: [{ ...long.plcStatus.devices[0], lastReadAt: null }] } }, 'running', now).normalDevices, 0, 'a socket connection without a read is not healthy acquisition');
const simulated = { observedAt: now, mode: 'simulation', collectorStatus: { status: 'connected', lastFrameAt: now - 700, devices: 4 }, metricSummary: { alarmDevices: 4 } };
const simulation = summarize(factory, devices, simulated, 'running', now);
assert.equal(simulation.status, 'simulation'); assert.equal(simulation.normalDevices, 4); assert.equal(simulation.abnormalDevices, 0, 'equipment alarms are not collection failures');
assert.equal(simulation.lastReadAt, now - 700);
assert.equal(summarize(factory, devices, { ...simulated, collectorStatus: { ...simulated.collectorStatus, lastFrameAt: now - 20000 } }, 'running', now).normalDevices, 0);
assert.equal(summarize({ ...factory, simulation_interval_ms: '60000' }, devices, { ...simulated, collectorStatus: { ...simulated.collectorStatus, lastFrameAt: now - 50000 } }, 'running', now).normalDevices, 4);
assert.doesNotMatch(JSON.stringify(result), /plc_ip|endpoint|password/);
console.log(JSON.stringify({ success: true, counts: true, hiddenFactoriesIncluded: true, stoppedAndEmptyNotAbnormal: true, actualReadRequired: true, staleWorkerRejected: true, timestampsAndIntervals: true }));
