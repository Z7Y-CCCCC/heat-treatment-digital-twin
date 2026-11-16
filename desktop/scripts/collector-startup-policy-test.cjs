'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { selectCollectorStartupPolicy, resolveCollectorStartupPolicy } = require('../collectorStartupPolicy.cjs');

const client = { mode: 'client', backendOrigin: 'http://127.0.0.1:3001' };
const installed = { version: 1, serviceName: 'HeatTreatmentCollector', port: 3001, backendOrigin: client.backendOrigin };
const options = { platform: 'win32', serviceConfig: installed };

test('only the matching installed Windows loopback collector receives a five-minute hard startup budget', () => {
    assert.deepEqual(selectCollectorStartupPolicy(client, options),
        { timeoutMs: 300000, installedLocalCollector: true, hardBudget: true });
    assert.deepEqual(selectCollectorStartupPolicy({ ...client, backendOrigin: ' HTTP://127.0.0.1:3001/ ' }, options),
        { timeoutMs: 300000, installedLocalCollector: true, hardBudget: true });
});

test('remote clients, mismatching machine origins and non-Windows clients retain the original fifteen seconds', () => {
    for (const backendOrigin of ['http://192.0.2.1:3001', 'https://collector.example',
        'http://127.0.0.1:3002', 'http://localhost:3001', 'http://127.0.0.1.evil:3001']) {
        assert.deepEqual(selectCollectorStartupPolicy({ ...client, backendOrigin }, options),
            { timeoutMs: 15000, installedLocalCollector: false, hardBudget: false }, backendOrigin);
    }
    for (const platform of ['linux', 'darwin'])
        assert.equal(selectCollectorStartupPolicy(client, { ...options, platform }).timeoutMs, 15000);
});

test('missing, malformed or inconsistent installed-service records cannot extend startup', () => {
    for (const serviceConfig of [null, {}, { ...installed, version: '1' }, { ...installed, version: 2 },
        { ...installed, serviceName: 'OtherService' }, { ...installed, port: '3001' },
        { ...installed, port: 3002 }, { ...installed, backendOrigin: 'http://192.0.2.1:3001' },
        { ...installed, backendOrigin: 'http://USER:TOKEN@127.0.0.1:3001' },
        { ...installed, backendOrigin: 'http://127.0.0.1:3001/api' }]) {
        assert.deepEqual(selectCollectorStartupPolicy(client, { platform: 'win32', serviceConfig }),
            { timeoutMs: 15000, installedLocalCollector: false, hardBudget: false });
    }
    for (const backendOrigin of ['NOT_URL', 'http://USER:TOKEN@127.0.0.1:3001',
        'http://127.0.0.1:3001/?token=TOKEN', 'file:///collector'])
        assert.equal(selectCollectorStartupPolicy({ ...client, backendOrigin }, options).timeoutMs, 15000);
});

test('ordinary local/display startup keeps sixty seconds and policy resolution never reads their machine record', () => {
    for (const mode of ['local', 'display']) {
        assert.deepEqual(resolveCollectorStartupPolicy({ mode }, { platform: 'win32',
            readFileSync: () => { throw Error('must not read installed config'); } }),
        { timeoutMs: 60000, installedLocalCollector: false, hardBudget: false });
    }
});

test('record resolution reads only the authoritative machine file, accepts BOM and never mutates inputs', () => {
    const reads = [], beforeClient = JSON.stringify(client), beforeRecord = JSON.stringify(installed);
    const result = resolveCollectorStartupPolicy(client, { platform: 'win32', env: { ProgramData: 'C:\\FixtureProgramData' },
        readFileSync: (file, encoding) => { reads.push([file, encoding]); return '\uFEFF' + beforeRecord; } });
    assert.deepEqual(reads, [[path.join('C:\\FixtureProgramData', 'HeatTreatmentDigitalTwin', 'collector-service.json'), 'utf8']]);
    assert.equal(result.timeoutMs, 300000);
    assert.equal(JSON.stringify(client), beforeClient); assert.equal(JSON.stringify(installed), beforeRecord);
    const file = 'C:\\Fixture\\collector-service.json';
    resolveCollectorStartupPolicy(client, { platform: 'win32', env: { DIGITAL_TWIN_COLLECTOR_CONFIG: file },
        readFileSync: selected => { assert.equal(selected, file); return beforeRecord; } });
});

test('unreadable/malformed records fail closed to the original budget and remote lookup does no file I/O', () => {
    for (const readFileSync of [() => { throw Error('denied'); }, () => '{invalid'])
        assert.equal(resolveCollectorStartupPolicy(client, { platform: 'win32', env: {}, readFileSync }).timeoutMs, 15000);
    assert.equal(resolveCollectorStartupPolicy({ ...client, backendOrigin: 'https://collector.example' },
        { platform: 'win32', readFileSync: () => { throw Error('remote clients must not read machine config'); } }).timeoutMs, 15000);
});

test('new required runtime policy is included in the existing delivery whitelist without changing factory defaults', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    assert.ok(manifest.build.files.includes('collectorStartupPolicy.cjs'));
    assert.ok(manifest.scripts['test:deployment'].includes('scripts/collector-startup-policy-test.cjs'));
});
