const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-twin-license-'));
process.env.APP_DATA_DIR = dataDir;
process.env.LICENSE_MACHINE_STATE_FILE = path.join(dataDir, 'machine-identity.json');
process.env.LICENSE_ENFORCE = 'true';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
process.env.LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });

const {
    LICENSE_FILE,
    evaluateLicense,
    getLicenseStatus,
    installLicense,
    signLicensePayload,
    assertLicenseForWrite,
    getLocalMachineId
} = require('../services/license');

function payload(overrides = {}) {
    const issuedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return {
        licenseId: 'LIC-TEST-001',
        customer: '测试客户',
        issuedAt,
        expiresAt,
        features: ['dashboard', 'business-readonly'],
        ...overrides
    };
}

try {
    const signed = signLicensePayload(payload(), privateKey);
    const valid = evaluateLicense(signed);
    assert.equal(valid.status, 'valid');
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.features, ['business-readonly', 'dashboard']);

    const localMachine = getLocalMachineId();
    assert.equal(localMachine.available, true);
    assert.equal(getLocalMachineId().id, localMachine.id);
    fs.writeFileSync(process.env.LICENSE_MACHINE_STATE_FILE, '{ interrupted write', 'utf8');
    const recoveredMachineId = execFileSync(process.execPath, ['-e', "console.log(require('./services/license').getLocalMachineId().id)"], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env },
        encoding: 'utf8'
    }).trim();
    assert.equal(recoveredMachineId, localMachine.id);
    const machineBound = signLicensePayload(payload({ machineId: localMachine.id }), privateKey);
    assert.equal(evaluateLicense(machineBound).status, 'valid');
    if (localMachine.aliases?.length) {
        const legacyBound = signLicensePayload(payload({ machineId: localMachine.aliases[0] }), privateKey);
        assert.equal(evaluateLicense(legacyBound).status, 'valid');
    }
    const mismatchedMachine = signLicensePayload(payload({ machineId: 'machine-00000000000000000000000000000000' }), privateKey);
    assert.equal(evaluateLicense(mismatchedMachine).status, 'machine_mismatch');

    const tampered = { ...signed, payload: { ...signed.payload, customer: '篡改客户' } };
    assert.equal(evaluateLicense(tampered).status, 'invalid');

    const expired = signLicensePayload(payload({
        issuedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    }), privateKey);
    assert.equal(evaluateLicense(expired).status, 'expired');

    const installed = installLicense(signed);
    assert.equal(installed.status, 'valid');
    assert(fs.existsSync(LICENSE_FILE));
    assert.doesNotThrow(() => assertLicenseForWrite());

    process.env.LICENSE_PUBLIC_KEY = '';
    assert.equal(getLicenseStatus().status, 'unverified');
    let blocked = false;
    try { assertLicenseForWrite(); } catch (error) { blocked = error.code === 'LICENSE_REQUIRED'; }
    assert.equal(blocked, true);

    console.log(JSON.stringify({
        success: true,
        format: signed.format,
        algorithm: signed.algorithm,
        installed: installed.licenseId,
        tamperRejected: true,
        expiryRejected: true,
        anchorBackupRecovery: true,
        strictModeBlocksUnverified: true
    }, null, 2));
} finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
}
