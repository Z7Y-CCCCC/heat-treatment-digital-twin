const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { execFile } = require('child_process');
const { createRunDirectory, createTestDatabase, requireTestPath } = require('../../backend/scripts/integration-test-utils.cjs');
const { hasProcessExited, terminateProcess } = require('../processLifecycle.cjs');

function createSmokeProgramData(directory) {
    requireTestPath(directory);
    // MySQL's Windows native command line requires ASCII junction paths, while
    // the workspace can contain Chinese characters. Keep this private temp root
    // as evidence instead of touching real machine identity/mysql-links paths.
    const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-smoke-programdata-'));
    if (!/^[\x20-\x7e]+$/.test(programData)) throw new Error('Smoke ProgramData requires an ASCII temporary directory');
    fs.writeFileSync(path.join(directory, 'program-data-isolation.json'), JSON.stringify({ programData }, null, 2));
    return { ProgramData: programData, PROGRAMDATA: programData,
        LICENSE_MACHINE_STATE_FILE: path.join(programData, 'HeatTreatmentDigitalTwin', 'machine-identity.json') };
}

async function createSmokeSandbox(prefix) {
    const directory = createRunDirectory(prefix);
    const dataDir = path.join(directory, 'data');
    const uploadsDir = path.join(directory, 'uploads');
    const filename = await createTestDatabase(path.join(dataDir, 'factory.db'));
    fs.mkdirSync(uploadsDir, { recursive: true });
    const env = {
        ...process.env,
        ...createSmokeProgramData(directory),
        APP_USER_DATA_DIR: directory,
        APP_DATA_DIR: dataDir,
        UPLOADS_DIR: uploadsDir,
        DB_TYPE: 'sqlite',
        SQLITE_FILE: filename,
        SQLITE_TEMPLATE_FILE: '',
        SQLITE_RECOVERY_TEMPLATE: '',
        SQLITE_UPGRADE_TEMPLATE: '',
        DB_BACKUP_DIR: path.join(dataDir, 'backups'),
        DB_RECOVERY_DIR: path.join(dataDir, 'recovery'),
        SITE_BACKUP_DIR: path.join(dataDir, 'site-backups'),
        LICENSE_FILE: path.join(dataDir, 'license.json'),
        LICENSE_ENFORCE: 'false',
        ADMIN_API_TOKEN: crypto.randomBytes(32).toString('hex'),
        DESKTOP_SMOKE_ISOLATED: 'true',
        DESKTOP_SMOKE_STANDALONE: 'true',
        DISABLE_AUTO_START: 'true'
    };
    for (const key of Object.keys(env)) {
        if (/^(MYSQL_|DESKTOP_MYSQL_|DB_(HOST|PORT|USER|PASSWORD|NAME)$)/i.test(key)) delete env[key];
    }
    return { directory, dataDir, uploadsDir, filename, env };
}

async function stopOwnedSmokeProcess(child, options = {}) {
    if (hasProcessExited(child)) return;
    // Only the exact child created by this test is targeted. A timeout must not
    // leave Unity, WebView2 or the backend orphaned after killing their supervisor.
    if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
        await new Promise(resolve => {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                timeout: 10000
            }, () => resolve());
        });
    }
    await terminateProcess(child, options);
}

async function createSmokeSession(origin, sandbox) {
    requireTestPath(sandbox.directory);
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Smoke login requires an isolated loopback backend');
    const password = sandbox.password || `Smoke-${crypto.randomBytes(16).toString('hex')}!`;
    const status = await fetch(`${origin}/api/admin-auth/session`).then(response => response.json());
    if (status.configured && !sandbox.password) throw new Error('Refusing to change an already configured backend account');
    const response = await fetch(`${origin}/api/admin-auth/${status.configured ? 'login' : 'setup'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Admin-Request': '1' },
        body: JSON.stringify({ username: sandbox.username || 'admin', password }), signal: AbortSignal.timeout(10000)
    });
    const session = await response.json();
    if (!response.ok || !session.permissions?.launch || !session.permissions?.view) throw new Error(`Isolated smoke login failed: ${session.code || response.status}`);
    return { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrfToken: session.csrfToken };
}

async function authorizeSmokeUnity(origin, child, session) {
    const response = await fetch(`${origin}/api/admin-auth/native-ticket`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Admin-Request': '1',
            Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }, body: '{}', signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok || !/^[a-f0-9]{64}$/.test(result.ticket || '')) throw new Error('Unable to create an isolated Unity session ticket');
    const pipe = `\\\\.\\pipe\\HeatTreatmentUnityAuth_${child.pid}`;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (hasProcessExited(child)) throw new Error('Unity exited before the authentication handoff');
        try {
            await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipe);
                socket.setTimeout(2000, () => socket.destroy(new Error('Native authentication pipe timeout')));
                socket.once('error', reject);
                socket.once('connect', () => socket.end(JSON.stringify({ action: 'sync_unity_session', ticket: result.ticket }) + '\n'));
                socket.once('close', hadError => { if (!hadError) resolve(); });
            });
            return;
        } catch (error) {
            if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    throw new Error('Unity authentication pipe did not become available');
}

module.exports = { createSmokeSandbox, createSmokeProgramData, stopOwnedSmokeProcess, createSmokeSession, authorizeSmokeUnity };
