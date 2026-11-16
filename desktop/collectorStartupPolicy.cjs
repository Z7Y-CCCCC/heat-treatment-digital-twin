'use strict';
const fs = require('node:fs');
const path = require('node:path');

const REMOTE_CLIENT_TIMEOUT_MS = 15000;
const LOCAL_BACKEND_TIMEOUT_MS = 60000;
const INSTALLED_LOCAL_COLLECTOR_TIMEOUT_MS = 300000;

function origin(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || url.pathname !== '/' || url.search || url.hash) return null;
        return url;
    } catch { return null; }
}

function loopback(url) {
    return url && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

// Selection is read-only: an installed machine-service record is evidence for
// a longer startup wait, never authority to start/restart a service or open DBs.
function selectCollectorStartupPolicy(deployment, { platform = process.platform, serviceConfig = null } = {}) {
    const client = deployment?.mode === 'client';
    const fallback = { timeoutMs: client ? REMOTE_CLIENT_TIMEOUT_MS : LOCAL_BACKEND_TIMEOUT_MS,
        installedLocalCollector: false, hardBudget: false };
    if (!client || platform !== 'win32') return fallback;
    const configured = origin(deployment.backendOrigin);
    const installed = origin(serviceConfig?.backendOrigin);
    if (!loopback(configured) || !loopback(installed) || configured.origin !== installed.origin
        || serviceConfig?.version !== 1 || serviceConfig?.serviceName !== 'HeatTreatmentCollector'
        || !Number.isInteger(serviceConfig?.port) || serviceConfig.port < 1024 || serviceConfig.port > 65535
        || Number(installed.port || (installed.protocol === 'https:' ? 443 : 80)) !== serviceConfig.port) return fallback;
    return { timeoutMs: INSTALLED_LOCAL_COLLECTOR_TIMEOUT_MS, installedLocalCollector: true, hardBudget: true };
}

function resolveCollectorStartupPolicy(deployment, { platform = process.platform, env = process.env,
    readFileSync = fs.readFileSync } = {}) {
    if (platform !== 'win32' || deployment?.mode !== 'client' || !loopback(origin(deployment.backendOrigin)))
        return selectCollectorStartupPolicy(deployment, { platform });
    const filename = env.DIGITAL_TWIN_COLLECTOR_CONFIG || path.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData',
        'HeatTreatmentDigitalTwin', 'collector-service.json');
    let serviceConfig = null;
    try { serviceConfig = JSON.parse(readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
    catch { /* Missing, unreadable or invalid records retain the original budget. */ }
    return selectCollectorStartupPolicy(deployment, { platform, serviceConfig });
}

module.exports = { selectCollectorStartupPolicy, resolveCollectorStartupPolicy,
    REMOTE_CLIENT_TIMEOUT_MS, LOCAL_BACKEND_TIMEOUT_MS, INSTALLED_LOCAL_COLLECTOR_TIMEOUT_MS };
