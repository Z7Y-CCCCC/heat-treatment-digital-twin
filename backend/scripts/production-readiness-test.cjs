const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    BACKEND_DIR,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    startLoggedProcess,
    waitForExit,
    waitForHttp
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `production-readiness-${process.pid}-${Date.now()}`;
let backend = null;
let origin = null;

async function fetchResult(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (error) { body = text; }
    return { response, body, text };
}

function chooseLanAddress() {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
                return entry.address;
            }
        }
    }
    return null;
}

async function gracefulStop() {
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    await fetchResult(`${origin}/api/internal/shutdown`, {
        method: 'POST',
        headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
    });
    await waitForExit(backend, 30000);
    backend = null;
}

async function main() {
    const runDirectory = createRunDirectory('production-readiness');
    const resultFile = path.join(runDirectory, 'result.json');
    const dataDir = path.join(runDirectory, 'data');
    const startedAt = Date.now();
    let result;

    try {
        const databaseFile = path.join(dataDir, 'factory.db');
        fs.mkdirSync(dataDir, { recursive: true });
        await createTestDatabase(databaseFile);
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2));

        const port = await findFreePort(3501);
        origin = `http://127.0.0.1:${port}`;
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                HOST: '0.0.0.0',
                PORT: String(port),
                APP_DATA_DIR: dataDir,
                FRONTEND_DIST: path.resolve(BACKEND_DIR, '..', 'frontend', 'dist'),
                ENABLE_CORS: 'true',
                DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
                DB_BACKUP_RETENTION: '3',
                DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
            },
            logFile: path.join(runDirectory, 'backend.log')
        });
        await waitForHttp(`${origin}/api/health`, 30000);

        const health = await fetchResult(`${origin}/api/health`);
        const version = await fetchResult(`${origin}/api/version`);
        const license = await fetchResult(`${origin}/api/license`);
        const licenseContract = await fetchResult(`${origin}/api/license/contract`);
        const release = await fetchResult(`${origin}/api/release`);
        const acceptance = await fetchResult(`${origin}/api/acceptance-report`);
        const headers = health.response.headers;
        const disallowedCors = await fetchResult(`${origin}/api/health`, {
            headers: { Origin: 'https://attacker.invalid' }
        });
        const malformed = await fetchResult(`${origin}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not-json'
        });
        const oversized = await fetchResult(`${origin}/api/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oversized: 'x'.repeat(6 * 1024 * 1024) })
        });
        const traversal = await fetchResult(`${origin}/api/database/backups/%2e%2e%2foutside.db/download`);
        const staticDirectory = await fetchResult(`${origin}/uploads/`);

        const lanAddress = chooseLanAddress();
        let remoteMutationBlocked = true;
        if (lanAddress) {
            const remote = await fetchResult(`http://${lanAddress}:${port}/api/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ remote_attack_probe: 'must-be-blocked' })
            });
            remoteMutationBlocked = remote.response.status === 403;
        }

        const checks = {
            healthOk: health.response.status === 200 && health.body?.status === 'ok',
            healthContract: !!health.body?.components?.backend
                && !!health.body?.components?.database
                && !!health.body?.components?.dataEngine
                && !!health.body?.components?.unity
                && ['ready', 'degraded', 'not_ready'].includes(health.body?.readiness?.status)
                && typeof health.body?.readiness?.displayReady === 'boolean',
            versionContract: version.response.status === 200
                && version.body?.success === true
                && version.body?.productVersion
                && version.body?.configurationVersion
                && Number.isInteger(version.body?.dashboardSchemaVersion)
                && Number.isInteger(version.body?.businessDataContractVersion)
                && version.body?.license?.format,
            licenseContract: license.response.status === 200
                && license.body?.success === true
                && license.body?.readOnly === true
                && license.body?.format
                && licenseContract.response.status === 200
                && Array.isArray(licenseContract.body?.fields),
            healthLicenseContract: !!health.body?.components?.license
                && typeof health.body?.components?.license?.enforce === 'boolean',
            releaseContract: release.response.status === 200
                && release.body?.success === true
                && release.body?.readOnly === true
                && release.body?.mode === 'offline_signed_package'
                && release.body?.contract?.signatureRequired === true
                && release.body?.contract?.sha256Required === true,
            acceptanceReportContract: acceptance.response.status === 200
                && acceptance.body?.success === true
                && acceptance.body?.readOnly === true
                && typeof acceptance.body?.configurationReady === 'boolean'
                && typeof acceptance.body?.displayReady === 'boolean'
                && Array.isArray(acceptance.body?.blockingFailures),
            healthDoesNotClaimDisplayReadyWithoutUnity: health.body?.components?.unity?.status !== 'connected'
                ? health.body?.readiness?.displayReady === false
                : true,
            noPoweredBy: !headers.get('x-powered-by'),
            securityHeadersPresent: headers.get('x-content-type-options') === 'nosniff'
                && headers.get('content-security-policy')
                && headers.get('referrer-policy') === 'no-referrer',
            disallowedCorsBlocked: !disallowedCors.response.headers.get('access-control-allow-origin'),
            malformedJsonDoesNotLeakStack: malformed.response.status >= 400
                && !/[A-Z]:\\|\n\s*at\s+/i.test(String(malformed.text)),
            oversizedBodyRejected: oversized.response.status === 413,
            traversalRejected: traversal.response.status >= 400,
            uploadDirectoryNotListed: staticDirectory.response.status >= 400,
            remoteMutationBlocked
        };
        const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
        if (failed.length) throw new Error(`生产安全检查失败：${failed.join(', ')}`);

        await gracefulStop();
        result = {
            success: true,
            durationMs: Date.now() - startedAt,
            lanAddress,
            checks,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
    } catch (error) {
        result = {
            success: false,
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message,
            artifacts: { result: resultFile, log: path.join(runDirectory, 'backend.log') }
        };
        process.exitCode = 1;
    } finally {
        await forceStop(backend);
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    }
}

main();
