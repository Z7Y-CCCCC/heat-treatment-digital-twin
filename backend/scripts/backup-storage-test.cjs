const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GiB, resolveBackupBudget, copyAndHash, ensureDiskSpace, shouldStore } = require('../utils/backupStorage');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const root = createRunDirectory('backup-storage');
const checks = {};
function policyOptions(name, extra = {}) {
    const dataDir = path.join(root, name);
    return { dataDir, directory: path.join(dataDir, 'backups'), kind: 'database', defaultBytes: 2 * GiB, matches: name => name.endsWith('.db'), ...extra };
}
function savePolicy(options, policy) {
    fs.mkdirSync(options.dataDir, { recursive: true });
    fs.writeFileSync(path.join(options.dataDir, `backup-storage-${options.kind}.json`), JSON.stringify(policy));
}

async function main() {
    const fresh = policyOptions('fresh');
    assert.equal(resolveBackupBudget(fresh).maxTotalBytes, 2 * GiB);
    const site = policyOptions('site', { kind: 'site', defaultBytes: 4 * GiB });
    assert.equal(resolveBackupBudget(site).maxTotalBytes, 4 * GiB);
    checks.newCombinedDefaultIsSixGiB = true;

    const legacy = policyOptions('legacy');
    fs.mkdirSync(legacy.directory, { recursive: true });
    const oldBackup = path.join(legacy.directory, 'old.db');
    fs.writeFileSync(oldBackup, 'keep this recovery point');
    assert.equal(resolveBackupBudget(legacy).maxTotalBytes, 2 * GiB);
    savePolicy(legacy, { maxTotalBytes: 20 * GiB, source: 'legacy-preserved' });
    assert.equal(resolveBackupBudget(legacy).maxTotalBytes, 2 * GiB);
    assert.equal(fs.readFileSync(oldBackup, 'utf8'), 'keep this recovery point');
    checks.legacyDefaultMigratesWithoutDeletingBackups = true;

    const explicit = policyOptions('explicit', { envValue: String(7 * GiB) });
    assert.equal(resolveBackupBudget(explicit).maxTotalBytes, 7 * GiB);
    assert.equal(resolveBackupBudget({ ...explicit, envValue: undefined }).maxTotalBytes, 7 * GiB);
    savePolicy(explicit, { maxTotalBytes: 9 * GiB, source: 'operator' });
    assert.equal(resolveBackupBudget({ ...explicit, envValue: undefined }).maxTotalBytes, 9 * GiB);
    checks.explicitBudgetsSurviveRestartAndUpgrade = true;

    const broken = policyOptions('broken');
    savePolicy(broken, { maxTotalBytes: -1 });
    const protectedPolicy = resolveBackupBudget(broken);
    assert.equal(protectedPolicy.source, 'policy-error-preserved');
    assert.ok(protectedPolicy.warning);
    checks.invalidPolicyDoesNotSilentlyLowerOperatorBudget = true;

    // Simulated volumes exercise combined peak accounting without filling disks.
    const diskA = path.join(root, 'disk-a');
    const diskB = path.join(root, 'disk-b');
    const fakeIo = {
        realpath: async value => {
            if (value.endsWith('missing')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return value;
        },
        stat: async value => ({ dev: value.startsWith(diskA) ? 1 : 2 }),
        statfs: async () => ({ bavail: 1000, bsize: 1 })
    };
    await assert.rejects(ensureDiskSpace([
        { directory: diskA, bytes: 450 }, { directory: path.join(diskA, 'missing'), bytes: 500 }
    ], 100, fakeIo), /可用空间不足/);
    await ensureDiskSpace([{ directory: diskA, bytes: 500 }, { directory: diskB, bytes: 500 }], 100, fakeIo);
    await assert.rejects(ensureDiskSpace([{ directory: diskA, bytes: -1 }], 100, fakeIo), /预计空间无效/);
    await assert.rejects(ensureDiskSpace([{ directory: diskA, bytes: 1 }], 100, {
        ...fakeIo, statfs: async () => { throw new Error('unavailable'); }
    }), /无法确认备份磁盘/);
    checks.combinedSameVolumePeaksAndMissingDirectories = true;
    checks.unknownDiskSpaceAndInvalidEstimatesFailClosed = true;

    const source = path.join(root, 'source.glb');
    const destination = path.join(root, 'snapshot.glb');
    const payload = Buffer.alloc(16 * 1024 * 1024, 0x5a);
    fs.writeFileSync(source, payload);
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 1);
    let copied;
    try { copied = await copyAndHash(source, destination, payload.length); }
    finally { clearInterval(timer); }
    assert.ok(heartbeats > 0, 'streaming snapshot must let backend timers run');
    assert.equal(copied.size, payload.length);
    assert.equal(copied.sha256, crypto.createHash('sha256').update(payload).digest('hex'));
    assert.ok(fs.readFileSync(destination).equals(payload));
    checks.streamingSnapshotRetainsBytesAndAllowsTimers = true;

    await assert.rejects(copyAndHash(source, destination, payload.length), { code: 'EEXIST' });
    assert.ok(fs.readFileSync(destination).equals(payload));
    await assert.rejects(copyAndHash(source, path.join(root, 'wrong-size.glb'), payload.length - 1), /快照期间发生变化/);
    assert.equal(fs.existsSync(path.join(root, 'wrong-size.glb')), false);
    checks.failedCopyPreservesExistingDestinationAndRemovesPartialFiles = true;

    // Mutate in place during the first read, retaining its length. A size-only
    // check would accept a torn snapshot and claim it was coherent.
    const originalCreateReadStream = fs.createReadStream;
    fs.createReadStream = function(filename, ...args) {
        const stream = originalCreateReadStream.call(this, filename, ...args);
        if (filename === source) stream.once('data', () => {
            const descriptor = fs.openSync(source, 'r+');
            try { fs.writeSync(descriptor, Buffer.from([0x33]), 0, 1, payload.length - 1); }
            finally { fs.closeSync(descriptor); }
            const changed = new Date(Date.now() + 2000);
            fs.utimesSync(source, changed, changed);
        });
        return stream;
    };
    const changedDestination = path.join(root, 'changed.glb');
    try { await assert.rejects(copyAndHash(source, changedDestination, payload.length), /快照期间发生变化/); }
    finally { fs.createReadStream = originalCreateReadStream; }
    assert.equal(fs.existsSync(changedDestination), false);
    checks.sameLengthConcurrentMutationRejected = true;

    assert.equal(shouldStore('texture.PNG'), true);
    assert.equal(shouldStore('database.sql.gz'), true);
    assert.equal(shouldStore('scene.glb'), false);
    assert.equal(shouldStore('manifest.json'), false);
    checks.compressedAssetsStoredAndRawGeometryStillCompressed = true;
    return { success: true, checks, artifactDirectory: root };
}

main().then(result => {
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
