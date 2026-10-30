const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EnduranceMysql, selectOwnedProcesses, ownedTerminationScript, removeOwnedAliases } = require('./endurance-mysql.cjs');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const base = Date.parse('2026-10-03T00:00:00.000Z');
const generation = () => ({ pid: 100, launchedAt: base, startedAt: new Date(base + 1000).toISOString(), knownProcesses: [] });
const processes = () => [
    { pid: 100, parentPid: 50, createdAt: new Date(base).toISOString(), executable: 'C:\\private-runtime\\bin\\mysqld.exe', commandLine: 'mysqld.exe --datadir=C:\\private-data --console' },
    { pid: 101, parentPid: 100, createdAt: new Date(base + 100).toISOString(), executable: 'C:\\private-runtime\\bin\\mysqld.exe', commandLine: 'mysqld.exe --datadir="C:\\private-data" --console' },
    { pid: 200, parentPid: 1, createdAt: new Date(base).toISOString(), executable: 'C:\\business\\bin\\mysqld.exe', commandLine: 'mysqld.exe --datadir=C:\\business-data' },
];
const select = (rows, gen) => selectOwnedProcesses(rows, gen, 'C:\\private-runtime', 'C:\\actual-runtime', 'C:\\private-data', base + 2000);

test('owns supervisor and server child while excluding unrelated MySQL', () => {
    assert.deepEqual(select(processes(), generation()).map(row => row.pid), [100, 101]);
});
test('finds a captured server child after supervisor exit', () => {
    const gen = generation(); select(processes(), gen); gen.exitedAt = base + 1500;
    assert.deepEqual(select(processes().slice(1), gen).map(row => row.pid), [101]);
});
test('finds a startup orphan only with private datadir, executable and creation interval', () => {
    const gen = generation(); gen.exitedAt = base + 1500;
    assert.deepEqual(select(processes().slice(1), gen).map(row => row.pid), [101]);
    const late = processes().slice(1); late[0].createdAt = new Date(base + 10000).toISOString();
    assert.throws(() => select(late, gen), /creation time|generation|PID was reused/);
    const foreign = processes().slice(1); foreign[0].commandLine = 'mysqld.exe --datadir=C:\\business-data';
    assert.deepEqual(select(foreign, generation()), []);
});
test('refuses supervisor and child PID reuse', () => {
    for (const index of [0, 1]) {
        const gen = generation(); select(processes(), gen);
        const rows = processes(); rows[index].createdAt = new Date(base + 200).toISOString();
        assert.throws(() => select(rows, gen), /PID was reused/);
    }
});
test('refuses executable or datadir changes before cleanup', () => {
    for (const change of [row => { row.executable = 'C:\\business\\bin\\mysqld.exe'; }, row => { row.commandLine = 'mysqld.exe --datadir=C:\\business-data'; }]) {
        const rows = processes(); change(rows[1]);
        assert.throws(() => select(rows, generation()), /identity mismatch/);
    }
});

function cleanupFixture({ parentExited = false, sql = false, shutdownThrows = false, postKillChildSurvives = false } = {}) {
    const instance = Object.create(EnduranceMysql.prototype);
    let rows = processes();
    const gen = generation(); select(rows, gen);
    if (parentExited) rows = rows.slice(1);
    const queries = [], scripts = [];
    Object.assign(instance, { child: { pid: 100, exitCode: parentExited ? 1 : null, signalCode: null }, processGeneration: gen,
        runtimeAlias: 'C:\\private-runtime', runtimeDir: 'C:\\actual-runtime', dataAlias: 'C:\\private-data',
        dataDir: 'C:\\private-data', port: 12345, password: 'test-only', processTimeoutMs: 100,
        exit: Promise.resolve(0), createConnection: async () => {
            if (!sql) throw new Error('Injected unavailable SQL');
            return { query: async options => { queries.push(options.sql); if (options.sql === 'SHUTDOWN' && shutdownThrows) throw new Error('Injected shutdown failure'); return [[{ datadir: 'C:\\private-data', port: 99999 }]]; }, destroy() {} };
        }, processExec: async (_file, args) => {
            const script = args.at(-1); scripts.push(script);
            if (script.includes('FromBase64String')) {
                instance.child.signalCode = 'SIGKILL';
                rows = postKillChildSurvives ? rows.filter(row => row.pid !== 100) : rows.filter(row => row.pid === 200);
                return { stdout: '{"terminated":[100,101]}' };
            }
            return { stdout: JSON.stringify(rows) };
        }
    });
    return { instance, queries, scripts };
}
test('unavailable SQL fallback terminates identified tree rather than parent alone', async () => {
    const { instance, scripts } = cleanupFixture();
    await instance.stop();
    const termination = scripts.find(script => script.includes('FromBase64String'));
    const encoded = /FromBase64String\('([^']+)'\)/.exec(termination)[1];
    const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.deepEqual(request.identities.map(row => row.pid), [100, 101]);
    assert.ok(!request.identities.some(row => row.pid === 200));
});
test('supervisor already exited still terminates the owned service child', async () => {
    const { instance, scripts } = cleanupFixture({ parentExited: true });
    await instance.stop();
    const encoded = /FromBase64String\('([^']+)'\)/.exec(scripts.find(script => script.includes('FromBase64String')))[1];
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).identities.map(row => row.pid), [101]);
});
test('cleanup refuses success when identified service child survives termination', async () => {
    const { instance } = cleanupFixture({ postKillChildSurvives: true });
    await assert.rejects(instance.stop(), /process tree did not exit/);
});
test('an empty ownership snapshot cannot declare a live supervisor stopped', async () => {
    const { instance } = cleanupFixture();
    instance.processExec = async () => ({ stdout: '[]' });
    await assert.rejects(instance.stop(), /supervisor is alive but unavailable/);
});
test('does not SHUTDOWN a listener whose private datadir or port mismatches', async () => {
    const { instance, queries } = cleanupFixture({ sql: true });
    await instance.stop();
    assert.deepEqual(queries, ['SELECT @@datadir AS datadir, @@port AS port']);
});
test('termination script validates identities and binds handles before killing', () => {
    const script = ownedTerminationScript(select(processes(), generation()), 'C:\\private-data');
    assert.ok(script.indexOf('$process.Handle') < script.indexOf('$process.Kill()'));
    for (const check of ['PID was reused before termination', 'executable changed before termination', 'datadir changed before termination', 'handle creation time mismatch']) assert.ok(script.includes(check));
    assert.ok(!/Stop-Process|taskkill|Get-Process\s+-Name/.test(script));
});

function aliasFixture() {
    const output = createRunDirectory('endurance-cleanup-unit');
    const runtime = path.join(output, 'runtime'), data = path.join(output, 'mysql-data');
    fs.mkdirSync(runtime); fs.mkdirSync(data);
    fs.writeFileSync(path.join(runtime, 'sentinel'), 'runtime kept'); fs.writeFileSync(path.join(data, 'sentinel'), 'data kept');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-endurance-mysql-'));
    const runtimeAlias = path.join(root, 'runtime'), dataAlias = path.join(root, 'data');
    fs.symlinkSync(runtime, runtimeAlias, 'junction'); fs.symlinkSync(data, dataAlias, 'junction');
    return { output, root, runtime, data, runtimeAlias, dataAlias };
}

test('shared alias creator and disposer agree on namespace and preserve their runtime/data targets', async () => {
    const output = createRunDirectory('endurance-alias-contract');
    const runtime = path.join(output, 'runtime');
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'bin', 'mysqld.exe'), 'never launched');
    const instance = new EnduranceMysql(output, runtime);
    instance.prepareAliases();
    const aliasRoot = instance.aliasRoot;
    assert.match(path.basename(aliasRoot), /^dt-endurance-mysql-[a-zA-Z0-9]+$/);
    assert.equal(instance.dataDir, path.join(output, 'mysql-data'));
    assert.equal(fs.realpathSync(instance.runtimeAlias), fs.realpathSync(runtime));
    assert.equal(fs.realpathSync(instance.dataAlias), fs.realpathSync(instance.dataDir));
    fs.writeFileSync(path.join(instance.dataDir, 'sentinel'), 'data retained');
    assert.throws(() => instance.prepareAliases(), /EEXIST/);
    await instance.dispose();
    assert.equal(fs.existsSync(aliasRoot), false);
    assert.equal(fs.readFileSync(path.join(instance.dataDir, 'sentinel'), 'utf8'), 'data retained');
    assert.equal(fs.readFileSync(path.join(runtime, 'bin', 'mysqld.exe'), 'utf8'), 'never launched');
});

test('partially created aliases can be disposed without deleting runtime or data', async t => {
    const output = createRunDirectory('endurance-alias-partial');
    const runtime = path.join(output, 'runtime');
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'bin', 'mysqld.exe'), 'never launched');
    const instance = new EnduranceMysql(output, runtime);
    const original = fs.symlinkSync;
    let calls = 0;
    t.mock.method(fs, 'symlinkSync', (...args) => {
        if (++calls === 2) throw Object.assign(new Error('injected second junction failure'), { code: 'EIO' });
        return original(...args);
    });
    assert.throws(() => instance.prepareAliases(), /second junction failure/);
    assert.equal(fs.existsSync(instance.runtimeAlias), true);
    assert.equal(fs.existsSync(instance.dataAlias), false);
    await instance.dispose();
    assert.equal(fs.existsSync(instance.aliasRoot), false);
    assert.equal(fs.existsSync(instance.dataDir), true);
    assert.equal(fs.readFileSync(path.join(runtime, 'bin', 'mysqld.exe'), 'utf8'), 'never launched');
});
test('final disposal removes only owned aliases and retains runtime and data', () => {
    const item = aliasFixture();
    removeOwnedAliases(item.root, item.runtimeAlias, item.dataAlias, item.runtime, item.data);
    assert.equal(fs.existsSync(item.root), false);
    assert.equal(fs.readFileSync(path.join(item.runtime, 'sentinel'), 'utf8'), 'runtime kept');
    assert.equal(fs.readFileSync(path.join(item.data, 'sentinel'), 'utf8'), 'data kept');
});
test('changed alias target refuses cleanup before unlinking either alias', () => {
    const item = aliasFixture(); fs.unlinkSync(item.dataAlias); fs.symlinkSync(item.runtime, item.dataAlias, 'junction');
    assert.throws(() => removeOwnedAliases(item.root, item.runtimeAlias, item.dataAlias, item.runtime, item.data), /target changed/);
    assert.equal(fs.existsSync(item.runtimeAlias), true);
    assert.equal(fs.existsSync(item.dataAlias), true);
    fs.unlinkSync(item.dataAlias); fs.symlinkSync(item.data, item.dataAlias, 'junction');
    removeOwnedAliases(item.root, item.runtimeAlias, item.dataAlias, item.runtime, item.data);
});
test('failed process disposal retains all aliases for later recovery', async () => {
    const item = aliasFixture();
    await assert.rejects(EnduranceMysql.prototype.dispose.call({ stop: async () => { throw new Error('Cannot verify owned server exited'); }, aliasRoot: item.root, runtimeAlias: item.runtimeAlias, dataAlias: item.dataAlias, runtimeDir: item.runtime, dataDir: item.data }), /Cannot verify/);
    assert.ok(fs.existsSync(item.runtimeAlias) && fs.existsSync(item.dataAlias));
    removeOwnedAliases(item.root, item.runtimeAlias, item.dataAlias, item.runtime, item.data);
});
test('restart uses stop and start without final alias disposal', async () => {
    const actions = [];
    await EnduranceMysql.prototype.restart.call({ stop: async () => actions.push('stop'), start: async () => actions.push('start'), dispose: async () => { throw new Error('Aliases must survive restart'); } });
    assert.deepEqual(actions, ['stop', 'start']);
});
