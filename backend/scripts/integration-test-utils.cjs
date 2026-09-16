const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(BACKEND_DIR, '..');
const OUTPUT_DIR = path.join(REPO_DIR, 'output');
const testBackends = new Map();

function requireTestPath(filename) {
    if (!filename || typeof filename !== 'string') throw new Error('A test artifact path is required');
    const resolved = path.resolve(filename);
    const relative = path.relative(OUTPUT_DIR, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error(`Test artifacts must be in a dedicated directory below ${OUTPUT_DIR}`);
    }
    // Lexical containment alone permits a Windows junction below output/ to
    // redirect cleanup or database writes into a commissioned installation.
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const rootReal = fs.realpathSync(OUTPUT_DIR);
    const rootRelative = path.relative(fs.realpathSync(REPO_DIR), rootReal);
    if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
        throw new Error('The test output directory must not link outside the workspace');
    }
    let ancestor = resolved;
    const missing = [];
    while (!fs.existsSync(ancestor)) {
        missing.unshift(path.basename(ancestor));
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error('Cannot resolve the test artifact parent');
        ancestor = parent;
    }
    const realDestination = path.resolve(fs.realpathSync(ancestor), ...missing);
    const realRelative = path.relative(rootReal, realDestination);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw new Error('A test artifact path links outside the dedicated output directory');
    }
    return resolved;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function runToken() {
    return new Date().toISOString().replace(/[-:.]/g, '');
}

function createRunDirectory(prefix) {
    if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(prefix)) throw new Error('Invalid test directory prefix');
    const directory = requireTestPath(path.join(OUTPUT_DIR, `${prefix}-${runToken()}-${process.pid}-`));
    return fs.mkdtempSync(directory);
}

async function copySqliteDatabase(source, destination) {
    const Database = require('better-sqlite3');
    destination = requireTestPath(destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
        await db.backup(destination);
    } finally {
        db.close();
    }
}

async function createTestDatabase(destination, options = {}) {
    const filename = requireTestPath(destination);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) throw new Error('Refusing to overwrite an existing test database');
    if (options.source) await copySqliteDatabase(path.resolve(options.source), filename);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'seed-test-database.cjs'), filename], {
        cwd: BACKEND_DIR,
        env: { ...process.env },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 45000
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Test database initialization failed: ${result.error?.message || result.stderr || result.stdout}`);
    }
    return filename;
}

async function findFreePort(preferred) {
    const firstPort = Number(preferred) || 0;
    if (!Number.isInteger(firstPort) || firstPort < 0 || firstPort > 65535) throw new Error('Invalid preferred test port');
    const probe = (port, host) => new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen({ port, host, exclusive: true }, () => {
            const selected = server.address().port;
            server.close(() => resolve(selected));
        });
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = firstPort ? firstPort + attempt : 0;
        if (candidate > 65535) break;
        try {
            // Windows may allow a wildcard probe beside an existing loopback
            // listener. Check both scopes used by our actual backend processes.
            const selected = await probe(candidate, '127.0.0.1');
            await probe(selected, '0.0.0.0');
            return selected;
        } catch (error) {
            if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
        }
    }
    throw new Error('No free test port found in the requested range');
}

function startLoggedProcess(command, args, options) {
    let env = options.env || process.env;
    let testOrigin;
    const isBackend = args.some(arg => path.resolve(options.cwd || BACKEND_DIR, arg) === path.join(BACKEND_DIR, 'server.js'));
    if (isBackend) {
        if (!env.APP_DATA_DIR) throw new Error('Backend tests must specify an isolated APP_DATA_DIR');
        const dataDir = requireTestPath(env.APP_DATA_DIR);
        const configPath = path.join(dataDir, 'database-config.json');
        const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
        const databaseType = String(config.type || 'sqlite').toLowerCase();
        if (databaseType !== 'sqlite' && options.allowExternalDatabase !== true) {
            throw new Error('External database tests require an explicitly isolated database and allowExternalDatabase');
        }
        if (databaseType === 'sqlite') {
            const filename = requireTestPath(config.filename || path.join(dataDir, 'factory.db'));
            if (!fs.existsSync(configPath)) {
                fs.mkdirSync(dataDir, { recursive: true });
                fs.writeFileSync(configPath, JSON.stringify({ type: 'sqlite', filename }, null, 2));
            }
        }
        env = {
            ...env,
            APP_DATA_DIR: dataDir,
            DB_TYPE: '',
            SQLITE_FILE: '',
            UPLOADS_DIR: requireTestPath(env.UPLOADS_DIR || path.join(dataDir, 'uploads')),
            DB_BACKUP_DIR: path.join(dataDir, 'backups'),
            DB_RECOVERY_DIR: path.join(dataDir, 'recovery'),
            SITE_BACKUP_DIR: path.join(dataDir, 'site-backups'),
            SITE_IMPORT_DIR: path.join(dataDir, 'site-imports'),
            SITE_BACKUP_MIRROR_DIR: '',
            DATA_SOURCE_BACKUP_DIR: path.join(dataDir, 'data-source-backups'),
            SQLITE_RECOVERY_TEMPLATE: '',
            SQLITE_UPGRADE_TEMPLATE: '',
            SQLITE_TEMPLATE_FILE: '',
            LICENSE_FILE: path.join(dataDir, 'license.json'),
            LICENSE_ENFORCE: 'false',
            ADMIN_API_TOKEN: env.ADMIN_API_TOKEN || crypto.randomBytes(32).toString('hex')
        };
        // A developer's shell must not redirect a test into their commissioned DB.
        for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) delete env[key];
        testOrigin = `http://127.0.0.1:${Number(env.PORT)}`;
        testBackends.set(testOrigin, env.ADMIN_API_TOKEN);
    }
    const log = fs.createWriteStream(requireTestPath(options.logFile), { flags: 'a' });
    const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', error => {
        log.end(`Process failed to start: ${error.message}\n`);
    });
    child.once('close', () => {
        log.end();
        if (testOrigin && testBackends.get(testOrigin) === env.ADMIN_API_TOKEN) testBackends.delete(testOrigin);
    });
    return child;
}

function waitForExit(child, timeoutMs = 15000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child?.exitCode);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Process ${child.pid} did not exit in ${timeoutMs}ms`));
        }, timeoutMs);
        const onExit = code => {
            cleanup();
            resolve(code);
        };
        const cleanup = () => {
            clearTimeout(timer);
            child.off('exit', onExit);
        };
        child.once('exit', onExit);
    });
}

async function forceStop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill('SIGKILL'); } catch (error) { /* process may already be gone */ }
    try { await waitForExit(child, 5000); } catch (error) { /* best-effort cleanup */ }
}

function testFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = testBackends.get(new URL(url).origin);
    if (token && !headers.has('x-admin-token') && !headers.has('authorization')) headers.set('X-Admin-Token', token);
    return fetch(url, { ...options, headers, ...(token ? { redirect: 'error' } : {}), signal: options.signal || AbortSignal.timeout(30000) });
}

async function requestJson(url, options = {}) {
    const response = await testFetch(url, {
        ...options,
        headers: {
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    let body = null;
    if (text) {
        try { body = JSON.parse(text); } catch (error) { body = text; }
    }
    if (!response.ok) {
        throw new Error(`${options.method || 'GET'} ${url} failed: HTTP ${response.status} ${text}`);
    }
    return body;
}

async function waitForHttp(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await requestJson(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))) });
        } catch (error) {
            lastError = error;
            await sleep(200);
        }
    }
    throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'no response'}`);
}

async function waitUntil(predicate, timeoutMs, label, intervalMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function percentile(values, percent) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)];
}

function round(value, digits = 1) {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

module.exports = {
    BACKEND_DIR,
    REPO_DIR,
    copySqliteDatabase,
    createTestDatabase,
    createRunDirectory,
    findFreePort,
    forceStop,
    percentile,
    requestJson,
    requireTestPath,
    round,
    sleep,
    startLoggedProcess,
    testFetch,
    waitForExit,
    waitForHttp,
    waitUntil
};
