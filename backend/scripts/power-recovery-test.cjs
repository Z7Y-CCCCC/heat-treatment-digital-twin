const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
    BACKEND_DIR,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    requestJson,
    requireTestPath,
    sleep,
    startLoggedProcess,
    testFetch,
    waitForHttp,
    waitUntil
} = require('./integration-test-utils.cjs');

const SHUTDOWN_TOKEN = `recovery-test-${process.pid}-${Date.now()}`;
const ACK_KEY = 'power_test_last_acknowledged_write';
const RECOVERY_KEY = 'power_test_recovery_marker';

let backend = null;
let backendOrigin = null;
let runDirectory = null;
let launchIndex = 0;
const processLifetimes = new WeakMap();
const fixtureDatabaseHandles = new Set();
const lifetimeProofs = [];
const sidecarRemovalProofs = [];

function openRecoveryDatabase(filename, options) {
    const db = new Database(filename, options);
    fixtureDatabaseHandles.add(db);
    return db;
}

function closeRecoveryDatabase(db) {
    db.close();
    fixtureDatabaseHandles.delete(db);
}

// Register immediately after spawn: exit can precede stdio close. A sent kill
// signal or the integration helper's best-effort timeout is not an ownership
// release and must never authorize another backend or a WAL unlink.
function trackRecoveryProcess(child) {
    if (!child || typeof child.once !== 'function') throw new Error('Recovery lifetime requires an owned child process');
    if (processLifetimes.has(child)) return processLifetimes.get(child);
    const state = { pid: child.pid, exitObserved: child.exitCode != null || child.signalCode != null,
        closeObserved: false, exitAt: null, closeAt: null, killRequestedAt: null, error: null, confirmedAt: null };
    state.exitPromise = new Promise(resolve => {
        if (state.exitObserved) return resolve();
        child.once('exit', () => { state.exitObserved = true; state.exitAt = Date.now(); resolve(); });
    });
    state.closePromise = new Promise(resolve => {
        child.once('close', () => { state.closeObserved = true; state.closeAt = Date.now(); resolve(); });
    });
    child.once('error', error => { state.error = { code: error.code, message: error.message }; });
    processLifetimes.set(child, state);
    return state;
}

function recoveryProcessSnapshot(child) {
    const state = processLifetimes.get(child);
    return { pid: child?.pid, exitObserved: state?.exitObserved === true, closeObserved: state?.closeObserved === true,
        exitCode: child?.exitCode, signalCode: child?.signalCode, killed: child?.killed === true,
        exitAt: state?.exitAt, closeAt: state?.closeAt, killRequestedAt: state?.killRequestedAt,
        confirmedAt: state?.confirmedAt, error: state?.error,
        localDatabaseHandles: fixtureDatabaseHandles.size };
}

async function waitForRecoveryProcessClose(child, { timeoutMs = 15000 } = {}) {
    const state = processLifetimes.get(child);
    if (!state) throw new Error('Refusing to wait on an unowned recovery process');
    let timer;
    try {
        await Promise.race([
            Promise.all([state.exitPromise, state.closePromise]),
            new Promise((_, reject) => { timer = setTimeout(() => {
                const error = new Error(`Recovery process ${state.pid} did not exit and close in ${timeoutMs}ms: ${JSON.stringify(recoveryProcessSnapshot(child))}`);
                error.code = 'RECOVERY_PROCESS_LIFETIME_TIMEOUT'; reject(error);
            }, timeoutMs); })
        ]);
    } finally { clearTimeout(timer); }
    if (!state.exitObserved || !state.closeObserved || child.exitCode == null && child.signalCode == null || state.error) {
        throw new Error(`Recovery process ownership was not released: ${JSON.stringify(recoveryProcessSnapshot(child))}`);
    }
    state.confirmedAt = Date.now();
    return recoveryProcessSnapshot(child);
}

async function stopRecoveryProcess(child, options = {}) {
    const state = processLifetimes.get(child);
    if (!state) throw new Error('Refusing to terminate an unowned recovery process');
    if (!state.exitObserved && child.exitCode == null && child.signalCode == null && !state.killRequestedAt) {
        state.killRequestedAt = Date.now();
        try { child.kill('SIGKILL'); }
        catch (error) {
            if (error.code !== 'ESRCH') throw error;
            // ESRCH alone is not a close acknowledgement. The registered child
            // lifecycle still has to confirm termination below.
        }
    }
    return waitForRecoveryProcessClose(child, options);
}

async function forceStopBackend(phase) {
    if (!backend) return null;
    const child = backend;
    const proof = await stopRecoveryProcess(child);
    lifetimeProofs.push({ phase, ...proof });
    if (backend === child) backend = null;
    return proof;
}

function recoveryArtifactPath(filename, fixtureDirectory, resolveRealPath = fs.realpathSync) {
    const fixture = requireTestPath(fixtureDirectory), absolute = requireTestPath(filename);
    const within = (base, target) => { const relative = path.relative(base, target); return !!relative && relative !== '..'
        && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    if (!within(fixture, absolute)) throw new Error('Recovery sidecar must remain in this exact fixture directory');
    let ancestor = absolute;
    const missing = [];
    let realTarget;
    // SQLite may unlink a sidecar between existsSync and realpathSync while
    // completing its closed connection cleanup. Resolve directly and walk up
    // only on ENOENT; retain the realpath containment check for existing links.
    while (true) {
        try { realTarget = path.resolve(resolveRealPath(ancestor), ...missing); break; }
        catch (error) {
            const parent = path.dirname(ancestor);
            if (error.code !== 'ENOENT' || parent === ancestor) throw error;
            missing.unshift(path.basename(ancestor)); ancestor = parent;
        }
    }
    if (!within(fs.realpathSync(fixture), realTarget)) throw new Error('Recovery sidecar resolves outside this exact fixture directory');
    return absolute;
}

async function removeClosedRecoverySidecars(databaseFile, fixtureDirectory, child,
    { timeoutMs = 3000, intervalMs = 50, remove = filename => fs.rmSync(filename, { force: true }), pause = sleep } = {}) {
    const released = () => {
        const state = processLifetimes.get(child);
        if (!state?.confirmedAt || !state.exitObserved || !state.closeObserved || child.exitCode == null && child.signalCode == null) {
            throw new Error(`Refusing WAL unlink before owned backend exit/close: ${JSON.stringify(recoveryProcessSnapshot(child))}`);
        }
        if (fixtureDatabaseHandles.size) throw new Error(`Refusing WAL unlink with ${fixtureDatabaseHandles.size} open local SQLite handle(s)`);
    };
    released();
    const database = recoveryArtifactPath(databaseFile, fixtureDirectory);
    const targets = ['-wal', '-shm'].map(suffix => recoveryArtifactPath(`${database}${suffix}`, fixtureDirectory));
    const proof = { owner: recoveryProcessSnapshot(child), databaseFile: database, files: [] };
    for (const filename of targets) {
        const startedAt = Date.now(), attempts = [];
        while (true) {
            released();
            const target = recoveryArtifactPath(filename, fixtureDirectory);
            try { remove(target); attempts.push({ at: Date.now(), outcome: 'removed-or-absent' }); break; }
            catch (error) {
                attempts.push({ at: Date.now(), code: error.code });
                // A bounded residual Windows lock wait is permitted only AFTER
                // the actual owner/stdio closed and every local DB handle closed.
                if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || Date.now() - startedAt >= timeoutMs) {
                    error.message += `; closed-owner WAL cleanup ${JSON.stringify({ filename: target, owner: recoveryProcessSnapshot(child), attempts })}`;
                    throw error;
                }
                await pause(intervalMs);
            }
        }
        proof.files.push({ filename, durationMs: Date.now() - startedAt, attempts });
    }
    return proof;
}

function configureDatabase(filename) {
    const db = openRecoveryDatabase(filename);
    try {
        db.prepare("INSERT INTO settings (key, value) VALUES ('data_mode', 'simulation') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
        db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(ACK_KEY, RECOVERY_KEY);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        const integrity = db.pragma('quick_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`Test database quick_check failed: ${integrity}`);
    } finally {
        closeRecoveryDatabase(db);
    }
}

function inspectDatabase(filename) {
    const db = openRecoveryDatabase(filename, { readonly: true, fileMustExist: true });
    try {
        return {
            quickCheck: db.pragma('quick_check', { simple: true }),
            journalMode: db.pragma('journal_mode', { simple: true }),
            ackValue: db.prepare('SELECT value FROM settings WHERE key=?').get(ACK_KEY)?.value ?? null,
            recoveryValue: db.prepare('SELECT value FROM settings WHERE key=?').get(RECOVERY_KEY)?.value ?? null
        };
    } finally {
        closeRecoveryDatabase(db);
    }
}

function startBackend(dataDir, port) {
    launchIndex += 1;
    const child = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: String(port),
            APP_DATA_DIR: dataDir,
            DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000),
            DB_BACKUP_RETENTION: '20',
            DESKTOP_SHUTDOWN_TOKEN: SHUTDOWN_TOKEN
        },
        logFile: path.join(runDirectory, `backend-${launchIndex}.log`)
    });
    trackRecoveryProcess(child);
    return child;
}

async function waitForDatabase() {
    return waitUntil(async () => {
        try { return await requestJson(`${backendOrigin}/api/settings`); } catch (error) { return null; }
    }, 30000, 'database API readiness', 100);
}

async function putSettings(values) {
    return requestJson(`${backendOrigin}/api/settings`, {
        method: 'PUT',
        body: JSON.stringify(values)
    });
}

async function gracefulStop() {
    if (!backend) return null;
    const child = backend;
    const acceptedAt = Date.now();
    if (child.exitCode == null && child.signalCode == null) {
        await requestJson(`${backendOrigin}/api/internal/shutdown`, {
            method: 'POST',
            headers: { 'x-shutdown-token': SHUTDOWN_TOKEN }
        });
    }
    const proof = await waitForRecoveryProcessClose(child, { timeoutMs: 15000 });
    lifetimeProofs.push({ phase: 'graceful-shutdown', ...proof });
    const code = child.exitCode;
    if (backend === child) backend = null;
    return { code, durationMs: Date.now() - acceptedAt };
}

async function downloadAndVerifyBackup(filename) {
    const response = await testFetch(`${backendOrigin}/api/database/backups/${encodeURIComponent(filename)}/download`);
    if (!response.ok) throw new Error(`Backup download failed: HTTP ${response.status}`);
    const destination = path.join(runDirectory, `downloaded-${filename}`);
    fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
    const db = openRecoveryDatabase(destination, { readonly: true, fileMustExist: true });
    try {
        return {
            file: destination,
            bytes: fs.statSync(destination).size,
            quickCheck: db.pragma('quick_check', { simple: true }),
            recoveryValue: db.prepare('SELECT value FROM settings WHERE key=?').get(RECOVERY_KEY)?.value ?? null
        };
    } finally {
        closeRecoveryDatabase(db);
    }
}

async function main() {
    runDirectory = createRunDirectory('power-recovery');
    const resultFile = path.join(runDirectory, 'result.json');
    const startedAt = Date.now();
    let result;

    try {
        const port = await findFreePort(3201);
        backendOrigin = `http://127.0.0.1:${port}`;
        const dataDir = path.join(runDirectory, 'data');
        const databaseFile = path.join(dataDir, 'factory.db');
        fs.mkdirSync(dataDir, { recursive: true });
        await createTestDatabase(databaseFile, { source: process.env.RECOVERY_TEST_SOURCE_DB });
        configureDatabase(databaseFile);
        fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({
            type: 'sqlite',
            filename: databaseFile
        }, null, 2));

        backend = startBackend(dataDir, port);
        await waitForHttp(`${backendOrigin}/api/health`, 30000);
        await waitForDatabase();
        const initialBackupStatus = await waitUntil(async () => {
            try {
                const status = await requestJson(`${backendOrigin}/api/database/backups`);
                return status.backups?.some(item => item.filename.includes('-startup.db')) ? status : null;
            } catch (error) {
                return null;
            }
        }, 15000, 'startup backup', 200);

        let keepWriting = true;
        let writeAttempt = 0;
        let lastAcknowledged = -1;
        const writer = (async () => {
            while (keepWriting) {
                const value = String(++writeAttempt);
                try {
                    await putSettings({ [ACK_KEY]: value });
                    lastAcknowledged = Number(value);
                } catch (error) {
                    if (keepWriting) await sleep(10);
                }
            }
        })();
        await sleep(2500);
        const powerCutAt = Date.now();
        await forceStopBackend('power-cut');
        keepWriting = false;
        await writer;
        if (lastAcknowledged < 1) throw new Error('No write was acknowledged before the forced power cut');

        const backupCountBeforeRestart = fs.readdirSync(path.join(dataDir, 'backups')).filter(name => name.endsWith('.db')).length;
        backend = startBackend(dataDir, port);
        await waitForHttp(`${backendOrigin}/api/health`, 30000);
        const settingsAfterCut = await waitForDatabase();
        const recoveredAcknowledged = Number(settingsAfterCut[ACK_KEY]);
        const postCutInspection = inspectDatabase(databaseFile);
        const postCutBackupStatus = await waitUntil(async () => {
            try {
                const status = await requestJson(`${backendOrigin}/api/database/backups`);
                return status.backups?.length > backupCountBeforeRestart ? status : null;
            } catch (error) {
                return null;
            }
        }, 15000, 'post-power-cut startup backup', 200);

        await putSettings({ [RECOVERY_KEY]: 'value-from-valid-backup' });
        const manualBackupResponse = await requestJson(`${backendOrigin}/api/database/backups`, { method: 'POST' });
        const recoveryBackup = manualBackupResponse.backup;
        if (!recoveryBackup?.filename) throw new Error('Manual backup API did not return a filename');
        const downloadedBackup = await downloadAndVerifyBackup(recoveryBackup.filename);

        await putSettings({ [RECOVERY_KEY]: 'unbacked-value-before-corruption' });
        const corruptionOwner = backend;
        await forceStopBackend('before-corruption');
        // A valid WAL can replay page 1 and repair a damaged main database header.
        // Remove the closed database sidecars first so this branch tests the actual
        // backup-recovery path instead of SQLite's normal WAL crash recovery path.
        sidecarRemovalProofs.push(await removeClosedRecoverySidecars(databaseFile, runDirectory, corruptionOwner));
        const corruptHandle = fs.openSync(databaseFile, 'r+');
        try {
            fs.writeSync(corruptHandle, Buffer.alloc(4096, 0x58), 0, 4096, 0);
            fs.fsyncSync(corruptHandle);
        } finally {
            fs.closeSync(corruptHandle);
        }

        backend = startBackend(dataDir, port);
        await waitForHttp(`${backendOrigin}/api/health`, 30000);
        const settingsAfterCorruption = await waitForDatabase();
        const recoveryStatus = await requestJson(`${backendOrigin}/api/database/backups`);
        const recoveryFiles = fs.existsSync(path.join(dataDir, 'recovery'))
            ? fs.readdirSync(path.join(dataDir, 'recovery'))
            : [];
        const postCorruptionInspection = inspectDatabase(databaseFile);

        await putSettings({ [RECOVERY_KEY]: 'changed-before-manual-restore' });
        const restoreResponse = await requestJson(
            `${backendOrigin}/api/database/backups/${encodeURIComponent(recoveryBackup.filename)}/restore`,
            { method: 'POST' }
        );
        const settingsAfterManualRestore = await waitForDatabase();
        const finalBackupStatus = await requestJson(`${backendOrigin}/api/database/backups`);
        const gracefulShutdown = await gracefulStop();
        const finalInspection = inspectDatabase(databaseFile);

        const checks = {
            startupBackupCreated: initialBackupStatus.backups.some(item => item.valid && item.filename.includes('-startup.db')),
            // A request can commit durably just before the test process is killed but
            // finish its HTTP response after the client stops tracking acknowledgements.
            // Recovery may therefore be ahead of the last observed acknowledgement;
            // it must never be behind it.
            acknowledgedWriteSurvivedPowerCut: Number.isFinite(recoveredAcknowledged)
                && recoveredAcknowledged >= lastAcknowledged,
            walRecoveryQuickCheckOk: postCutInspection.quickCheck === 'ok',
            walModeEnabled: String(postCutInspection.journalMode).toLowerCase() === 'wal',
            restartBackupCreated: postCutBackupStatus.backups.length > backupCountBeforeRestart,
            backupDownloadValid: downloadedBackup.quickCheck === 'ok' && downloadedBackup.bytes > 0,
            automaticCorruptionRecovery: settingsAfterCorruption[RECOVERY_KEY] === 'value-from-valid-backup',
            recoveryReported: recoveryStatus.lastRecovery?.reason === 'integrity_failure',
            corruptFilesQuarantined: recoveryFiles.some(name => name.includes('.corrupt')),
            manualRestoreSucceeded: restoreResponse.success === true && settingsAfterManualRestore[RECOVERY_KEY] === 'value-from-valid-backup',
            preRestoreRollbackCreated: finalBackupStatus.backups.some(item => item.valid && item.filename.includes('-before-restore.db')),
            gracefulShutdownCompleted: gracefulShutdown?.code === 0 && gracefulShutdown.durationMs < 15000,
            finalQuickCheckOk: finalInspection.quickCheck === 'ok'
        };
        result = {
            success: Object.values(checks).every(Boolean),
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            sourceDatabase: process.env.RECOVERY_TEST_SOURCE_DB || 'generated isolated test fixture',
            databaseFile,
            powerCut: {
                at: new Date(powerCutAt).toISOString(),
                acknowledgedWrites: lastAcknowledged,
                recoveredAcknowledged,
                inspection: postCutInspection
            },
            corruptionRecovery: {
                backup: recoveryBackup.filename,
                recoveredValue: settingsAfterCorruption[RECOVERY_KEY],
                lastRecovery: recoveryStatus.lastRecovery,
                quarantinedFiles: recoveryFiles,
                inspection: postCorruptionInspection
            },
            manualRestore: {
                restoredValue: settingsAfterManualRestore[RECOVERY_KEY],
                downloadedBackup,
                rollbackBackups: finalBackupStatus.backups.filter(item => item.filename.includes('-before-restore.db')).map(item => item.filename)
            },
            gracefulShutdown,
            checks
        };
        if (!result.success) throw new Error('One or more recovery checks failed');
    } catch (error) {
        result = {
            ...(result || {}),
            success: false,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: error.stack || error.message
        };
        process.exitCode = 1;
    } finally {
        try { await forceStopBackend('final-cleanup'); }
        catch (error) {
            result = { ...(result || {}), success: false, cleanupError: error.stack || error.message,
                remainingOwnedProcess: recoveryProcessSnapshot(backend) };
            process.exitCode = 1;
        }
        result.processLifetimes = lifetimeProofs;
        result.sidecarRemovalProofs = sidecarRemovalProofs;
        result.openLocalDatabaseHandles = fixtureDatabaseHandles.size;
        fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ resultFile, ...result }, null, 2));
    }
}

module.exports = { trackRecoveryProcess, recoveryProcessSnapshot, waitForRecoveryProcessClose,
    stopRecoveryProcess, recoveryArtifactPath, removeClosedRecoverySidecars,
    openRecoveryDatabase, closeRecoveryDatabase };
if (require.main === module) main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
