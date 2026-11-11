'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Distribution capability, not a user-editable settings switch. An environment
// variable cannot turn a display package (which lacks readers) into a collector.
function collectorAvailable(directory = __dirname, env = process.env) {
    if (env.APP_RUNTIME_ROLE === 'display') return false;
    const file = path.join(directory, '..', 'distribution.json');
    let declared = false;
    if (fs.existsSync(file)) {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (manifest.collector !== true) return false;
        declared = true;
    }
    const available = ['collectorProcess.js','collectorWorker.cjs','plcReader.js','plcProtocolDrivers.js','s7ReadSafety.js']
        .every(name => fs.existsSync(path.join(directory,name)));
    if (declared && !available) throw new Error('采集插件文件不完整，请修复插件；未切换数据来源');
    return available;
}

function createRuntimeEngine(wsServer) {
    if (collectorAvailable()) return new (require('./collectorProcess'))(wsServer);
    const DataEngine = require('./dataEngine');
    class DisplayEngine extends DataEngine {
        constructor() { super(wsServer, { displayOnly: true }); this.closed = false; }
        async start(...args) { if (!this.closed) return super.start(...args); }
        async dispose() { this.closed = true; await super.stop(); }
        getStatus() {
            return { ...super.getStatus(), plugin: { installed: false },
                process: { status: 'not_installed', isolation: 'none', pid: null } };
        }
        getPointRuntimeValues(deviceId, points, factoryId) {
            const source = factoryId && factoryId !== this.activeFactoryId ? this.factoryEngines.get(factoryId) : this;
            return source ? DataEngine.prototype.getPointRuntimeValues.call(source, deviceId, points)
                : { deviceStatus: null, snapshotTimestamp: null, points: (points || []).map(p => ({ ...p, value: null, quality: 'bad' })) };
        }
    }
    return new DisplayEngine();
}
function runtimeIdentity() {
    const collector = collectorAvailable();
    return { version: 1, role: collector ? 'collector' : 'display',
        owner: collector && process.env.APP_RUNTIME_OWNER === 'windows-service' ? 'windows-service' : collector ? 'standalone' : 'display',
        serviceName: collector && process.env.APP_RUNTIME_OWNER === 'windows-service' ? 'HeatTreatmentCollector' : null };
}
module.exports = { createRuntimeEngine, collectorAvailable, runtimeIdentity };
