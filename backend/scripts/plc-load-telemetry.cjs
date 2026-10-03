// Test-only instrumentation. All reads still use the real nodes7 TCP driver.
const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const { requireTestPath } = require('./integration-test-utils.cjs');
if (process.env.PLC_LOAD_METRICS_FILE) {
    const filename = requireTestPath(process.env.PLC_LOAD_METRICS_FILE);
    const PlcReader = require('../services/plcReader');
    const counts = { readBatches: 0, readPoints: 0, readFailures: 0 };
    const success = PlcReader.prototype._handleTaskReadSuccess;
    const failure = PlcReader.prototype._handleTaskFailure;
    PlcReader.prototype._handleTaskReadSuccess = function(task, values) {
        counts.readBatches++; counts.readPoints += task.points.length;
        return success.call(this, task, values);
    };
    PlcReader.prototype._handleTaskFailure = function(...args) {
        counts.readFailures++; return failure.apply(this, args);
    };
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    let lastTime = performance.now();
    let lastCpu = process.cpuUsage();
    const sample = () => {
        const now = performance.now();
        const cpu = process.cpuUsage();
        const cpuMs = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000;
        const cpuPercentOneCore = cpuMs / Math.max(1, now - lastTime) * 100;
        fs.appendFileSync(filename, JSON.stringify({ timestamp: Date.now(), pid: process.pid, uptime: process.uptime(),
            ...process.memoryUsage(), ...counts, cpuPercentOneCore,
            cpuPercentHost: cpuPercentOneCore / os.cpus().length,
            eventLoopMeanMs: Number(delay.mean || 0) / 1e6,
            eventLoopP99Ms: Number(delay.percentile(99) || 0) / 1e6,
            eventLoopMaxMs: Number(delay.max || 0) / 1e6 }) + '\n');
        lastTime = now; lastCpu = cpu; delay.reset();
    };
    setInterval(sample, 5000).unref();
    process.once('exit', sample);
}
