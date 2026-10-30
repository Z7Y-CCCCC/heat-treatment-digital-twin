const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const mysql = require('mysql2/promise');
const { requireTestPath, findFreePort } = require('./integration-test-utils.cjs');
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
        this.processExec = sampling.processExec || promisify(execFile);
        this.processTimeoutMs = sampling.processTimeoutMs || 5000;
        this.createConnection = sampling.createConnection || mysql.createConnection;
    }
    launch(args) {
        const log = fs.openSync(path.join(this.directory, 'mysqld.log'), 'a');
        this.launchedAt = Date.now();
        try { this.child = spawn(path.join(this.runtimeAlias, 'bin', 'mysqld.exe'), args, { cwd: this.aliasRoot, windowsHide: true, stdio: ['ignore', log, log] }); }
        finally { fs.closeSync(log); }
        this.processGeneration = { pid: this.child.pid, launchedAt: this.launchedAt, startedAt: new Date().toISOString() };
        Object.defineProperty(this.processGeneration, 'knownProcesses', { value: [], writable: true });
        const generation = this.processGeneration;
        this.exit = new Promise((resolve, reject) => { this.child.once('exit', code => { generation.exitedAt = Date.now(); resolve(code); }); this.child.once('error', reject); });
        this.exit.catch(() => {});
        return this.child;
    }
    prepareAliases() {
        fs.mkdirSync(this.dataDir); // Refuse reuse, even of another test's database.
        this.aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-endurance-mysql-'));
        this.runtimeAlias = path.join(this.aliasRoot, 'runtime');
        this.dataAlias = path.join(this.aliasRoot, 'data');
        if (/[^\x00-\x7f]/.test(this.aliasRoot)) throw new Error('MySQL test requires an ASCII TEMP path');
        fs.symlinkSync(this.runtimeDir, this.runtimeAlias, 'junction');
        fs.symlinkSync(this.dataDir, this.dataAlias, 'junction');
    }
    async initialize(sourcePath, configPath) {
        this.prepareAliases();
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
            this.processGeneration.startedAt = new Date().toISOString();
            this.generations.push(this.processGeneration);
            await this.captureOwnedProcesses();
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
        if (!this.child) return;
        // Windows MySQL starts a supervisor and a separate server. A supervisor
        // exit is not evidence that its previously identified server also exited.
        let owned = await this.captureOwnedProcesses();
        if (!owned.length) {
            // An empty CIM snapshot alone cannot overrule a live ChildProcess.
            let timer;
            await Promise.race([this.exit.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]).finally(() => clearTimeout(timer));
            assert.ok(this.child.exitCode !== null || this.child.signalCode !== null, 'MySQL supervisor is alive but unavailable to ownership inspection');
            return;
        }
        let connection, shutdownRequested = false;
        try {
            if (!this.port) throw new Error('Initialization has no SQL listener');
            connection = await this.createConnection({ host: '127.0.0.1', port: this.port, user: 'root', password: this.password, connectTimeout: 3000 });
            const [[identity]] = await connection.query({ sql: 'SELECT @@datadir AS datadir, @@port AS port', timeout: 3000 });
            assert.equal(fs.realpathSync(identity.datadir).replace(/[\\/]+$/, ''), fs.realpathSync(this.dataDir));
            assert.equal(Number(identity.port), this.port);
            await connection.query({ sql: 'SHUTDOWN', timeout: 5000 });
            shutdownRequested = true;
        } catch { /* Initialization or an unavailable owned server is force-stopped below. */ }
        finally { connection?.destroy(); }
        let timer;
        if (shutdownRequested) await Promise.race([this.exit.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 10000); })]).finally(() => clearTimeout(timer));
        owned = await this.captureOwnedProcesses();
        if (owned.length) {
            await this.processExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ownedTerminationScript(owned, this.dataAlias)], { windowsHide: true, timeout: Math.max(this.processTimeoutMs, 15000), encoding: 'utf8', maxBuffer: 1024 * 1024 });
            await Promise.race([this.exit.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]).finally(() => clearTimeout(timer));
        }
        assert.equal((await this.captureOwnedProcesses()).length, 0, 'Owned private MySQL process tree did not exit during cleanup');
        assert.ok(this.child.exitCode !== null || this.child.signalCode !== null, 'Owned private MySQL supervisor did not exit during cleanup');
    }
    async captureOwnedProcesses() {
        const script = "$ErrorActionPreference = 'Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'mysqld.exe'\" | ForEach-Object { @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; executable = $_.ExecutablePath; commandLine = $_.CommandLine; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress";
        const { stdout } = await this.processExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: this.processTimeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 });
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return selectOwnedProcesses(rows, this.processGeneration, this.runtimeAlias, this.runtimeDir, this.dataAlias, Date.now());
    }
    async dispose() {
        await this.stop();
        removeOwnedAliases(this.aliasRoot, this.runtimeAlias, this.dataAlias, this.runtimeDir, this.dataDir);
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
                if (stats.firstWarm) stats.warmPeak = Math.max(stats.warmPeak ?? stats.firstWarm.rss, sample.rss);
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
            const baseline = stats && (stats.firstWarm || stats.first).rss;
            return { ...generation, samples: stats?.count || 0, peakRssMb: (stats?.peak || 0) / 1048576, rssGrowthMb: stats ? (stats.last.rss - baseline) / 1048576 : 0, peakRssGrowthMb: stats ? Math.max(0, (stats.warmPeak ?? stats.peak) - baseline) / 1048576 : 0, baselineAfterWarmup: Boolean(stats?.firstWarm), processes: stats?.last.processes || [] };
        });
        return { type: 'mysql', host: '127.0.0.1', port: this.port, database: this.database, dataDir: this.dataDir, version: this.version, pid: this.child?.pid, generations, verifiedSnapshots: this.verifiedSnapshots || 0, ownedPrivateInstance: true, memory: { metric: 'Sum of owned mysqld process tree WorkingSetSize (RSS) and PrivatePageCount; shared pages may be counted twice', samples: this.memorySampleCount, peakRssMb: Math.max(0, ...generations.map(row => row.peakRssMb)), maxRssGrowthMb: Math.max(0, ...generations.map(row => row.peakRssGrowthMb)), errors: this.memoryErrors.slice() } };
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
function selectOwnedProcesses(rows, generation, runtimeAlias, runtimeDir, dataAlias, timestamp) {
    if (!generation?.pid) return [];
    const normalize = value => path.win32.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase();
    const executables = [runtimeAlias, runtimeDir].map(root => normalize(path.win32.join(root, 'bin', 'mysqld.exe')));
    const known = generation.knownProcesses || [];
    const validate = (row, expected) => {
        assert.ok(executables.includes(normalize(row.executable)), 'Owned MySQL cleanup executable identity mismatch');
        const datadir = /(?:^|\s)(?:"--datadir=([^"]+)"|--datadir=(?:"([^"]+)"|(\S+)))(?=\s|$)/i.exec(row.commandLine || '');
        assert.ok(datadir && normalize(datadir[1] || datadir[2] || datadir[3]) === normalize(dataAlias), 'Owned MySQL cleanup datadir identity mismatch');
        const created = Date.parse(row.createdAt);
        assert.ok(Number.isFinite(created) && created >= generation.launchedAt - 2000 && created <= timestamp + 2000, 'Owned MySQL cleanup creation time mismatch');
        if (expected) assert.equal(row.createdAt, expected.createdAt, 'Owned MySQL cleanup PID was reused');
        return { pid: row.pid, parentPid: row.parentPid, createdAt: row.createdAt, executable: row.executable, commandLine: row.commandLine };
    };
    const root = rows.find(row => row?.pid === generation.pid);
    const owned = [];
    if (root) {
        const expected = known.find(row => row.pid === root.pid);
        const identity = validate(root, expected);
        const created = Date.parse(root.createdAt);
        assert.ok(created <= Date.parse(generation.startedAt) + 2000, 'Owned MySQL supervisor generation does not match');
        if (generation.processCreatedAt) assert.equal(root.createdAt, generation.processCreatedAt, 'Owned MySQL supervisor PID was reused');
        generation.processCreatedAt = root.createdAt;
        owned.push(identity);
        const seen = new Set([root.pid]);
        for (let index = 0; index < owned.length; index++) {
            for (const row of rows) {
                if (!row || row.parentPid !== owned[index].pid || seen.has(row.pid)) continue;
                const child = validate(row, known.find(item => item.pid === row.pid));
                assert.ok(Date.parse(child.createdAt) >= created, 'Owned MySQL child predates supervisor');
                seen.add(row.pid); owned.push(child);
            }
        }
    }
    // Retain identities while the supervisor is gone. Never infer ownership of
    // a newly seen orphan solely from a potentially reused parent PID.
    for (const expected of known) {
        if (owned.some(row => row.pid === expected.pid)) continue;
        const row = rows.find(item => item?.pid === expected.pid);
        if (row) owned.push(validate(row, expected));
    }
    if (!root) {
        // A supervisor can fail during startup before its child was sampled.
        // Require the unique private datadir, executable, creation interval and
        // parent relationship together; a parent PID by itself proves nothing.
        const parentCreated = generation.processCreatedAt ? Date.parse(generation.processCreatedAt) : generation.launchedAt - 2000;
        const latestChildCreation = generation.exitedAt ?? timestamp;
        for (const row of rows) {
            if (!row || row.parentPid !== generation.pid || owned.some(item => item.pid === row.pid)) continue;
            const datadir = /(?:^|\s)(?:"--datadir=([^"]+)"|--datadir=(?:"([^"]+)"|(\S+)))(?=\s|$)/i.exec(row.commandLine || '');
            if (!datadir || normalize(datadir[1] || datadir[2] || datadir[3]) !== normalize(dataAlias)) continue;
            const child = validate(row);
            assert.ok(Date.parse(child.createdAt) >= parentCreated && Date.parse(child.createdAt) <= latestChildCreation + 2000, 'Orphan MySQL child does not match the launched generation');
            owned.push(child);
        }
    }
    generation.knownProcesses = [...known.filter(expected => !owned.some(row => row.pid === expected.pid)), ...owned];
    return owned;
}
function ownedTerminationScript(identities, dataAlias) {
    const encoded = Buffer.from(JSON.stringify({ identities, dataAlias }), 'utf8').toString('base64');
    return `$ErrorActionPreference = 'Stop';
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json;
function Normalize-OwnedPath($value) { [IO.Path]::GetFullPath([string]$value).TrimEnd([char[]]'\\/').ToLowerInvariant() }
$validated = @();
try {
  foreach ($expected in @($request.identities)) {
    $process = Get-Process -Id ([int]$expected.pid) -ErrorAction SilentlyContinue;
    if (!$process) { continue }
    $null = $process.Handle;
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$expected.pid);
    if (!$current) { $process.Dispose(); continue }
    $created = $current.CreationDate.ToUniversalTime().ToString('o');
    if ($created -cne [string]$expected.createdAt) { throw 'Owned MySQL cleanup PID was reused before termination' }
    if ((Normalize-OwnedPath $current.ExecutablePath) -cne (Normalize-OwnedPath $expected.executable)) { throw 'Owned MySQL executable changed before termination' }
    $match = [regex]::Match([string]$current.CommandLine, '(?:^|\\s)(?:"--datadir=([^"]+)"|--datadir=(?:"([^"]+)"|(\\S+)))(?=\\s|$)', 'IgnoreCase');
    if (!$match.Success) { throw 'Owned MySQL datadir is missing before termination' }
    $actualData = @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value) | Where-Object { $_ } | Select-Object -First 1;
    if ((Normalize-OwnedPath $actualData) -cne (Normalize-OwnedPath $request.dataAlias)) { throw 'Owned MySQL datadir changed before termination' }
    if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $current.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 2) { throw 'Owned MySQL process handle creation time mismatch' }
    $validated += $process;
  }
  foreach ($process in $validated) { if (!$process.HasExited) { $process.Kill() } }
  foreach ($process in $validated) { if (!$process.WaitForExit(5000)) { throw 'Owned MySQL process did not exit after termination' } }
  @{ terminated = @($validated | ForEach-Object { $_.Id }) } | ConvertTo-Json -Compress;
} finally { foreach ($process in $validated) { $process.Dispose() } }`;
}
function removeOwnedAliases(aliasRoot, runtimeAlias, dataAlias, runtimeDir, dataDir) {
    if (!aliasRoot || !fs.existsSync(aliasRoot)) return;
    const resolved = path.resolve(aliasRoot), temp = fs.realpathSync(os.tmpdir());
    const relative = path.relative(temp, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && /^dt-endurance-mysql-[a-zA-Z0-9]+$/.test(relative), 'Refusing to remove an unexpected MySQL alias root');
    const rootStat = fs.lstatSync(resolved);
    assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink() && path.resolve(fs.realpathSync(resolved)) === resolved, 'MySQL alias root is not an owned physical directory');
    const links = [[runtimeAlias, runtimeDir], [dataAlias, dataDir]];
    for (const [alias, target] of links) {
        assert.ok(path.dirname(path.resolve(alias)) === resolved, 'MySQL alias is outside its owned root');
        if (!fs.existsSync(alias)) continue;
        assert.ok(fs.lstatSync(alias).isSymbolicLink(), 'Refusing to remove a non-junction MySQL alias');
        assert.equal(fs.realpathSync(alias), fs.realpathSync(target), 'MySQL alias target changed');
    }
    for (const [alias] of links) if (fs.existsSync(alias)) fs.unlinkSync(alias);
    fs.rmdirSync(resolved); // Empty directory only; never recursively remove targets.
}
module.exports = { EnduranceMysql, ownedMemorySample, selectOwnedProcesses, ownedTerminationScript, removeOwnedAliases };
