'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createRunDirectory, requireTestPath } = require('./integration-test-utils.cjs');
const { createSuiteTestEnvironment } = require('./test-suite-environment.cjs');

test('suite children remove inherited production inputs and get separate owned machine/ProgramData paths', () => {
    const directory = createRunDirectory('suite-environment');
    const inherited = Object.freeze({ ProgramData: 'PRODUCTION_PROGRAMDATA', PROGRAMDATA: 'OTHER_PRODUCTION_PROGRAMDATA',
        LICENSE_MACHINE_STATE_FILE: 'PRODUCTION_IDENTITY', LICENSE_MACHINE_ID: 'PRODUCTION_MACHINE_ID',
        LICENSE_FILE: 'PRODUCTION_LICENSE', MYSQL_PASSWORD: 'PRODUCTION_PASSWORD', DB_HOST: 'PRODUCTION_DB',
        SQLITE_FILE: 'PRODUCTION_SQLITE', APP_DATA_DIR: 'PRODUCTION_DATA', APP_USER_DATA_DIR: 'PRODUCTION_PROFILE',
        APP_RUNTIME_OWNER: 'windows-service', TEST_BASE_URL: 'PRODUCTION_URL', NODE_PATH: 'fixture-node-modules', PATH: 'fixture-path' });
    const first = createSuiteTestEnvironment(directory, 'first-test.cjs', inherited);
    const second = createSuiteTestEnvironment(directory, 'second-test.cjs', inherited);
    assert.equal(requireTestPath(first.LICENSE_MACHINE_STATE_FILE), first.LICENSE_MACHINE_STATE_FILE);
    assert.equal(requireTestPath(first.ProgramData), first.ProgramData);
    assert.notEqual(first.LICENSE_MACHINE_STATE_FILE, second.LICENSE_MACHINE_STATE_FILE);
    assert.notEqual(first.ProgramData, second.ProgramData);
    assert.equal(first.NODE_PATH, inherited.NODE_PATH); assert.equal(first.PATH, inherited.PATH);
    for (const key of ['LICENSE_MACHINE_ID', 'LICENSE_FILE', 'MYSQL_PASSWORD', 'DB_HOST', 'SQLITE_FILE', 'APP_DATA_DIR',
        'APP_USER_DATA_DIR', 'APP_RUNTIME_OWNER', 'TEST_BASE_URL', 'PROGRAMDATA']) assert.equal(first[key], undefined, key);
    assert.equal(inherited.LICENSE_MACHINE_STATE_FILE, 'PRODUCTION_IDENTITY', 'input environment is never mutated');
    assert.throws(() => createSuiteTestEnvironment(directory, '../escape.cjs', inherited));
    assert.throws(() => createSuiteTestEnvironment(path.resolve(directory, '../../backend/data'), 'first.cjs', inherited));
});

test('actual Windows license identity writes stay in the test anchor, including ProgramData fallback', () => {
    const directory = createRunDirectory('suite-identity-regression');
    const foreign = path.join(directory, 'commissioned-fixture'); fs.mkdirSync(foreign);
    const sentinel = path.join(foreign, 'machine-identity.json'); const original = '{"fixture":"must remain unchanged"}';
    fs.writeFileSync(sentinel, original);
    const inherited = { ProgramData: foreign, LICENSE_MACHINE_STATE_FILE: sentinel };
    const env = createSuiteTestEnvironment(directory, 'license-path-test.cjs', inherited);
    const filename = path.resolve(__dirname, '../services/license.js');
    const load = createRequire(filename); let hardwareQueries = 0;
    function identity(environment) {
        // Mimic Windows' case-insensitive process environment. Registry and OS
        // identity access are mocked; no real machine identity is read or changed.
        const windowsEnvironment = new Proxy(environment, { get(target, key) {
            if (typeof key !== 'string') return target[key];
            return target[Object.keys(target).find(name => name.toLowerCase() === key.toLowerCase())];
        } });
        const module = { exports: {} };
        const sandboxRequire = name => {
            if (name === 'child_process') return { execFileSync(command) {
                assert.equal(command, 'reg'); hardwareQueries++;
                return 'MachineGuid    REG_SZ    isolated-hardware-fixture';
            } };
            if (name === 'os') return { hostname: () => 'isolated-fixture', platform: () => 'win32', arch: () => 'x64', homedir: () => directory };
            return load(name);
        };
        const wrapper = vm.runInNewContext('(function(require,module,exports,process,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', {}, { filename });
        wrapper(sandboxRequire, module, module.exports, { env: windowsEnvironment, platform: 'win32', pid: process.pid }, path.dirname(filename));
        const first = module.exports.getLocalMachineId();
        assert.equal(module.exports.getLocalMachineId().id, first.id, 'cached identity remains stable');
        return first;
    }
    assert.equal(identity(env).available, true);
    for (const suffix of ['', '.bak', '.hardware']) assert.ok(fs.existsSync(env.LICENSE_MACHINE_STATE_FILE + suffix), suffix || 'primary');
    const fallbackEnv = { ...env }; delete fallbackEnv.LICENSE_MACHINE_STATE_FILE;
    assert.equal(identity(fallbackEnv).available, true);
    const fallback = path.join(env.ProgramData, 'HeatTreatmentDigitalTwin', 'machine-identity.json');
    for (const suffix of ['', '.bak', '.hardware']) assert.ok(fs.existsSync(fallback + suffix), suffix || 'fallback primary');
    assert.equal(hardwareQueries, 2, 'only deterministic mock registry queries ran');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(foreign), ['machine-identity.json'], 'no commissioned fixture backup/cache created');
});
