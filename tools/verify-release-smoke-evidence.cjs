'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { snapshotTree } = require('./package-resource-integrity.cjs');
(async () => {
    const [filename, resources, kind] = process.argv.slice(2);
    assert.ok(['collector', 'mysql'].includes(kind));
    const report = JSON.parse(fs.readFileSync(filename));
    assert.equal(report.success, true); assert.equal(report.resourceIntegrity.success, true);
    assert.equal(report.resourceIntegrity.beforeSha256, report.resourceIntegrity.afterSha256);
    const real = fs.realpathSync(resources), snapshot = await snapshotTree(real);
    assert.equal(fs.realpathSync(report.resourceIntegrity.root).toLowerCase(), real.toLowerCase());
    assert.equal(snapshot.sha256, report.resourceIntegrity.afterSha256, '验证之后资源已改变，必须重新测试');
    assert.equal(report.launches.length, 2);
    if (kind === 'mysql') {
        assert.equal(path.resolve(path.dirname(report.executable), 'resources').toLowerCase(), path.resolve(real).toLowerCase());
        assert.deepEqual(report.launches.map(r => r.phase), ['first-install', 'restart']);
        for (const launch of report.launches) {
            assert.equal(launch.success, true); assert.equal(launch.mysqlStopped, true);
            for (const n of Object.values(launch.configurationCounts)) assert.equal(n, 0, '已验证的包不是空系统');
        }
    } else {
        assert.equal(fs.realpathSync(report.source).toLowerCase(), real.toLowerCase());
        assert.deepEqual(report.launches.map(r => r.phase), ['first-start', 'restart']);
        for (const launch of report.launches) { assert.equal(launch.zeroUnityClients, true); assert.equal(launch.mysqlStopped, true); assert.equal(launch.graceful, true); }
    }
    console.log(JSON.stringify({ success: true, kind, evidence: path.resolve(filename), resources: real, sha256: snapshot.sha256 }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
