const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const { requireTestPath, findFreePort, forceStop } = require('./integration-test-utils.cjs');
const { seedMysql } = require('../services/mysqlSeed');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Owns only a new output/ datadir and a random loopback listener. Never attaches
// to a user's configured MySQL instance or modifies its service registration.
class EnduranceMysql {
    constructor(directory, runtimeDir) {
        this.directory = requireTestPath(directory);
        this.dataDir = requireTestPath(path.join(directory, 'mysql-data'));
        this.runtimeDir = fs.realpathSync(runtimeDir);
        assert.ok(fs.existsSync(path.join(this.runtimeDir, 'bin', 'mysqld.exe')), 'MySQL runtime must contain bin/mysqld.exe');
        this.password = crypto.randomBytes(32).toString('hex');
        this.database = 'endurance_private';
        this.generations = [];
        this.memorySamples = [];
        this.memoryErrors = [];
    }
    launch(args) {
        const log = fs.openSync(path.join(this.directory, 'mysqld.log'), 'a');
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
            this.generations.push({ pid: this.child.pid, startedAt: new Date().toISOString() });
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
        if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
        const previous = this.memorySamples.at(-1);
        if (!force && previous?.pid === this.child.pid && Date.now() - previous.timestamp < 60000) return;
        try {
            const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${Number(this.child.pid)} -ErrorAction Stop; @{ rss = $p.WorkingSet64; privateBytes = $p.PrivateMemorySize64 } | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
            const sample = { ...JSON.parse(output), pid: this.child.pid, timestamp: Date.now() };
            assert.ok(Number.isFinite(sample.rss) && sample.rss > 0, 'MySQL working set unavailable');
            this.memorySamples.push(sample);
            fs.appendFileSync(path.join(this.directory, 'mysql-memory.jsonl'), JSON.stringify(sample) + '\n');
        } catch (failure) { this.memoryErrors.push({ timestamp: Date.now(), message: failure.message }); }
    }
    summary() {
        this.sampleMemory();
        const generations = this.generations.map(generation => {
            const samples = this.memorySamples.filter(row => row.pid === generation.pid);
            const warm = samples.filter(row => row.timestamp - Date.parse(generation.startedAt) >= 60000);
            const first = warm[0] || samples[0];
            return { ...generation, samples: samples.length, peakRssMb: Math.max(0, ...samples.map(row => row.rss)) / 1048576, rssGrowthMb: samples.length ? (samples.at(-1).rss - first.rss) / 1048576 : 0, baselineAfterWarmup: warm.length > 0 };
        });
        return { type: 'mysql', host: '127.0.0.1', port: this.port, database: this.database, dataDir: this.dataDir, version: this.version, pid: this.child?.pid, generations, verifiedSnapshots: this.verifiedSnapshots || 0, ownedPrivateInstance: true, memory: { metric: 'Windows WorkingSet64 (RSS) and PrivateMemorySize64', samples: this.memorySamples.length, peakRssMb: Math.max(0, ...generations.map(row => row.peakRssMb)), maxRssGrowthMb: Math.max(0, ...generations.map(row => row.rssGrowthMb)), errors: this.memoryErrors } };
    }
}
module.exports = { EnduranceMysql };
