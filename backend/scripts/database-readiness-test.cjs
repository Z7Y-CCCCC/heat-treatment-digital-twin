const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../db/database.js');
const context = vm.createContext({ require: createRequire(file), __dirname: path.dirname(file),
    process, console, module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval, Buffer });
vm.runInContext(fs.readFileSync(file, 'utf8'), context);
(async () => {
    vm.runInContext(`
        activeConfig = { type: 'mysql' };
        let releaseInit;
        initDb = async () => {
            pool = {};
            await new Promise(resolve => { releaseInit = resolve; });
            databaseReady = true;
        };
        const starting = getDb();
    `, context);
    assert.equal(vm.runInContext('getDbStatus().connected', context), false, 'open pool is not a completed migration');
    assert.equal(vm.runInContext('getDbStatus().initializing', context), true);
    vm.runInContext('releaseInit()', context);
    await vm.runInContext('starting', context);
    assert.equal(vm.runInContext('getDbStatus().connected', context), true);
    vm.runInContext('databaseReady = false', context);
    assert.equal(vm.runInContext('getDbStatus().connected', context), false);
    console.log('PASS health readiness waits for schema and document migration completion');
})().catch(error => { console.error(error); process.exitCode = 1; });
