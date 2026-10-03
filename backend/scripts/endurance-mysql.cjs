const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const mysql = require('mysql2/promise');
const { requireTestPath, findFreePort, forceStop } = require('./integration-test-utils.cjs');
const { seedMysql } = require('../services/mysqlSeed');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Owns only a new output/ datadir and a random loopback listener. Never attaches
// to a user's configured MySQL instance or modifies its service registration.
class EnduranceMysql {
    constructor(directory, runtimeDir, sampling = {}) {
        this.directory = requireTestPath(directory);
        this.dataDir = requireTestPath(path.join(directory, 'mysql-data'));
        this.runtimeDir = fs.realpathSync(runtimeDir);
        assert.ok(fs.existsSync(path.join(this.runtimeDir, 'bin', 'mysqld.exe')), 'MySQL runtime must contain bin/mysqld.exe');
        this.password = crypto.randomBytes(32).toString('hex');
        this.database = 'endurance_private';
        this.generations = [];
        this.memorySampleCount = 0;
        this.memoryErrors = [];
        this.memoryByGeneration = new Map();
        this.memoryExec = sampling.execFile || promisify(execFile);
        this.memoryAppend = sampling.appendFile || fs.promises.appendFile.bind(fs.promises);
        this.memoryNow = sampling.now || Date.now;
        this.memoryTimeoutMs = sampling.timeoutMs || 5000;
    }
    launch(args) {
        const log = fs.openSync(path.join(this.directory, 'mysqld.log'), 'a');
        this.launchedAt = Date.now();
        try { this.child = spawn(path.join(this.runtimeAlias, 'bin', 'mysqld.exe'), args, { cwd: this.aliasRoot, windowsHide: true, stdio: ['ignore', log, log] }); }
        finally { fs.closeSync(log); }
        this.exit = new Promise((resolve, reject) => { this.child.once('exit', resolve); this.child.once('error', reject); });
        this.exit.catch(() => {});
        return this.child;
    }
    async initialize(sourcePath, configPath) {
        fs.mkdirSync(this.dataDir); // Refuse reuse, even of another test's database.
        this.aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-endurance-mysql-'));
        if (/[^\x00-\x7f]/.test(this.aliasRoot)) throw new Error('MySQL test requires an ASCII TEMP path');
        this.runtimeAlias = path.join(this.aliasRoot, 'runtime');
        this.dataAlias = path.join(this.aliasRoot, 'data');
        fs.symlinkSync(this.runtimeDir, this.runtimeAlias, 'junction');
        fs.symlinkSync(this.dataDir, this.dataAlias, 'junction');
        this.launch(['--no-defaults', '--initialize-insecure', `--basedir=${this.runtimeAlias}`, `--datadir=${this.dataAlias}`, '--console']);
        let timer;
        const code = await Promise.race([this.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MySQL initialization timeout')), 120000); })]).finally(() => clearTimeout(timer));
        assert.equal(code, 0, 'Private MySQL initialization failed; see mysqld.log');
        this.port = await findFreePort();
        await this.start(true);
        const config = { type: 'mysql', host: '127.0.0.1', port: this.port, user: 'root', password: this.password, database: this.database };
        await seedMysql({ connection: config, sourcePath });
        const { type: _type, ...connectionOptions } = config;
        const seed = await mysql.createConnection(connectionOptions);
        try {
            await seed.query('CREATE TABLE endurance_metrics (id INTEGER PRIMARY KEY, actual DOUBLE NOT NULL)');
            await seed.execute('INSERT INTO endurance_metrics (id, actual) VALUES (?, ?)', [1, 42.25]);
        } finally { await seed.end(); }
        fs.writeFileSync(requireTestPath(configPath), JSON.stringify(config), { mode: 0o600 });
    }
    async start(first = false) {
        this.launch(['--no-defaults', `--basedir=${this.runtimeAlias}`, `--datadir=${this.dataAlias}`, '--bind-address=127.0.0.1', `--port=${this.port}`, '--mysqlx=0', '--max-allowed-packet=64M', '--innodb-buffer-pool-size=128M', '--skip-log-bin', '--console']);
        let connection;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('Private MySQL exited before ready; see mysqld.log');
            try { connection = await mysql.createConnection({ host: '127.0.0.1', port: this.port, user: 'root', password: first ? '' : this.password, connectTimeout: 1000 }); break; } catch { await sleep(200); }
        }
        if (!connection) throw new Error('Private MySQL did not become ready');
        try {
            const [[identity]] = await connection.query('SELECT @@version AS version, @@datadir AS datadir, @@port AS port');
            assert.equal(fs.realpathSync(identity.datadir).replace(/[\\/]+$/, ''), fs.realpathSync(this.dataDir));
            assert.equal(Number(identity.port), this.port);
            if (first) await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [this.password]);
            this.version = identity.version;
            this.generations.push({ pid: this.child.pid, startedAt: new Date().toISOString(), launchedAt: this.launchedAt });
        } finally { await connection.end(); }
    }
    async restart() { await this.stop(); await this.start(); }
    async verifySnapshot(sceneId, revision, cycle, releaseId) {
        const connection = await mysql.createConnection({ host: '127.0.0.1', port: this.port, user: 'root', password: this.password, database: this.database, connectTimeout: 3000 });
        try {
            const [[row]] = await connection.execute('SELECT draft_revision, draft_json, published_release_id FROM scenes WHERE id = ?', [sceneId]);
            assert.ok(row, 'Scene must exist in the private MySQL instance');
            assert.equal(Number(row.draft_revision), Number(revision), 'MySQL revision differs from HTTP result');
            const document = typeof row.draft_json === 'string' ? JSON.parse(row.draft_json) : row.draft_json;
            assert.equal(document.metadata.enduranceCycle, cycle, 'MySQL draft differs from HTTP result');
            assert.equal(row.published_release_id, releaseId, 'MySQL published release differs from HTTP result');
            const [[release]] = await connection.execute('SELECT snapshot_json, draft_revision FROM releases WHERE id = ? AND scene_id = ?', [releaseId, sceneId]);
            assert.ok(release, 'MySQL published snapshot is missing from the expected scene');
            const snapshot = typeof release.snapshot_json === 'string' ? JSON.parse(release.snapshot_json) : release.snapshot_json;
            assert.equal(snapshot.metadata.enduranceCycle, cycle, 'MySQL published snapshot differs from the saved cycle');
            assert.equal(Number(release.draft_revision), Number(revision), 'MySQL published snapshot revision differs from saved draft');
            this.verifiedSnapshots = (this.verifiedSnapshots || 0) + 1;
        } finally { await connection.end(); }
    }
    async stop() {
        if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
        if (!this.port) { await forceStop(this.child); return; }
        let connection;
        try {
            connection = await mysql.createConnection({ host: '127.0.0.1', port: this.port, user: 'root', password: this.password, connectTimeout: 3000 });
            const [[identity]] = await connection.query('SELECT @@datadir AS datadir, @@port AS port');
            assert.equal(fs.realpathSync(identity.datadir).replace(/[\\/]+$/, ''), fs.realpathSync(this.dataDir));
            assert.equal(Number(identity.port), this.port);
            await connection.query('SHUTDOWN');
        } catch { /* Initialization or an unavailable owned server is force-stopped below. */ }
        finally { await connection?.end().catch(() => {}); }
        let timer;
        await Promise.race([this.exit.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 10000); })]).finally(() => clearTimeout(timer));
        await forceStop(this.child);
        assert.ok(this.child.exitCode !== null || this.child.signalCode !== null, 'Owned private MySQL process did not exit during cleanup');
    }
    sampleMemory(force = false) {
        if (this.memoryPending) return this.memoryPending;
        const child = this.child;
        const generation = this.generations.at(-1);
        if (!child?.pid || child.exitCode !== null || child.signalCode !== null || generation?.pid !== child.pid) return Promise.resolve();
        if (!force && this.lastMemoryAttempt?.generation === generation && this.memoryNow() - this.lastMemoryAttempt.timestamp < 60000) return Promise.resolve();
        this.lastMemoryAttempt = { generation, timestamp: this.memoryNow() };
        // CIM includes MySQL's Windows supervisor and actual server child. Collect
        // asynchronously: a slow PowerShell startup must not pause HTTP/WS timers.
        const script = "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'mysqld.exe'\" | ForEach-Object { @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; executable = $_.ExecutablePath; commandLine = $_.CommandLine; createdAt = $_.CreationDate.ToUniversalTime().ToString('o'); rss = [double]$_.WorkingSetSize; privateBytes = [double]$_.PrivatePageCount } }) | ConvertTo-Json -Compress";
        this.memoryPending = (async () => {
            try {
                const { stdout } = await this.memoryExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: this.memoryTimeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 });
                assert.ok(this.child === child && child.exitCode === null && child.signalCode === null, 'MySQL generation changed during memory sampling');
                const parsed = JSON.parse(stdout);
                const rows = Array.isArray(parsed) ? parsed : [parsed];
                const sample = ownedMemorySample(rows, generation, this.runtimeAlias, this.runtimeDir, this.dataAlias, this.memoryNow());
                await this.memoryAppend(path.join(this.directory, 'mysql-memory.jsonl'), JSON.stringify(sample) + '\n');
                const stats = this.memoryByGeneration.get(generation) || { count: 0, peak: 0, first: sample, firstWarm: null };
                stats.count++;
                stats.peak = Math.max(stats.peak, sample.rss);
                stats.last = sample;
                if (!stats.firstWarm && sample.timestamp - Date.parse(generation.startedAt) >= 60000) stats.firstWarm = sample;
                this.memoryByGeneration.set(generation, stats);
                this.memorySampleCount++;
                return sample;
            } catch (failure) { this.memoryErrors.push({ timestamp: this.memoryNow(), message: failure.message }); }
        })().finally(() => { this.memoryPending = null; });
        return this.memoryPending;
    }
    summary() {
        const generations = this.generations.map(generation => {
            const stats = this.memoryByGeneration.get(generation);
            return { ...generation, samples: stats?.count || 0, peakRssMb: (stats?.peak || 0) / 1048576, rssGrowthMb: stats ? (stats.last.rss - (stats.firstWarm || stats.first).rss) / 1048576 : 0, baselineAfterWarmup: Boolean(stats?.firstWarm), processes: stats?.last.processes || [] };
        });
        return { type: 'mysql', host: '127.0.0.1', port: this.port, database: this.database, dataDir: this.dataDir, version: this.version, pid: this.child?.pid, generations, verifiedSnapshots: this.verifiedSnapshots || 0, ownedPrivateInstance: true, memory: { metric: 'Sum of owned mysqld process tree WorkingSetSize (RSS) and PrivatePageCount; shared pages may be counted twice', samples: this.memorySampleCount, peakRssMb: Math.max(0, ...generations.map(row => row.peakRssMb)), maxRssGrowthMb: Math.max(0, ...generations.map(row => row.rssGrowthMb)), errors: this.memoryErrors.slice() } };
    }
}
function ownedMemorySample(rows, generation, runtimeAlias, runtimeDir, dataAlias, timestamp) {
    const normalize = value => path.win32.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
    const executablePaths = [runtimeAlias, runtimeDir].map(root => normalize(path.win32.join(root, 'bin', 'mysqld.exe')));
    const root = rows.find(row => row?.pid === generation.pid);
    assert.ok(root, 'Owned MySQL root process is missing');
    const created = Date.parse(root.createdAt);
    assert.ok(Number.isFinite(created) && created >= generation.launchedAt - 2000 && created <= Date.parse(generation.startedAt) + 2000, 'MySQL root creation time does not match the launched generation');
    if (generation.processCreatedAt) assert.equal(root.createdAt, generation.processCreatedAt, 'MySQL root PID was reused');
    const owned = [root];
    const seen = new Set([root.pid]);
    for (let i = 0; i < owned.length; i++) {
        for (const row of rows) if (row && row.parentPid === owned[i].pid && !seen.has(row.pid)) { seen.add(row.pid); owned.push(row); }
    }
    const processes = owned.map(row => {
        assert.ok(executablePaths.includes(normalize(row.executable)), 'Owned MySQL executable identity mismatch');
        const datadir = /(?:^|\s)(?:"--datadir=([^"]+)"|--datadir=(?:"([^"]+)"|(\S+)))(?=\s|$)/i.exec(row.commandLine || '');
        assert.ok(datadir && normalize(datadir[1] || datadir[2] || datadir[3]) === normalize(dataAlias), 'Owned MySQL datadir identity mismatch');
        assert.ok(Date.parse(row.createdAt) >= created && Date.parse(row.createdAt) <= timestamp + 2000, 'MySQL child creation time mismatch');
        assert.ok(Number.isFinite(row.rss) && row.rss > 0 && Number.isFinite(row.privateBytes) && row.privateBytes >= 0, 'MySQL memory counters unavailable');
        return { pid: row.pid, parentPid: row.parentPid, createdAt: row.createdAt, rss: row.rss, privateBytes: row.privateBytes };
    });
    generation.processCreatedAt = root.createdAt;
    return { pid: generation.pid, timestamp, rss: processes.reduce((sum, row) => sum + row.rss, 0), privateBytes: processes.reduce((sum, row) => sum + row.privateBytes, 0), processes };
}
module.exports = { EnduranceMysql, ownedMemorySample };
