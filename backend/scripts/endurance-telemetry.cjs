// Test-only preload: never enabled by the normal server entry point.
const fs = require('node:fs');
const { requireTestPath } = require('./integration-test-utils.cjs');
if (process.env.ENDURANCE_METRICS_FILE) {
    const filename = requireTestPath(process.env.ENDURANCE_METRICS_FILE);
    const sample = () => fs.appendFileSync(filename, JSON.stringify({ timestamp: Date.now(), pid: process.pid, uptime: process.uptime(), ...process.memoryUsage() }) + '\n');
    sample();
    setInterval(sample, 5000).unref();
}
