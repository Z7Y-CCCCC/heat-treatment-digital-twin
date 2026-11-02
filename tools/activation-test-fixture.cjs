// Test-only issuer and package view. Never writes through a junction into the
// original installer resources, never reads a real vendor private key.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { encodeActivationCode } = require('../shared/activationCode.cjs');
const { signLicensePayload } = require('../backend/services/license');
const { createActivationClient } = require('../desktop/activation.cjs');
function createTestIssuer(resources) {
    requireTestPath(resources);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const trust = path.join(resources, 'licensing'); fs.mkdirSync(trust, { recursive: true });
    fs.writeFileSync(path.join(trust, 'license-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    return privateKey;
}
async function activateFixture(origin, privateKey) {
    const client = createActivationClient(origin), status = await client.status();
    if (!status.required) return;
    if (!status.machineId) throw new Error('Fixture machine fingerprint unavailable');
    const signed = signLicensePayload({ licenseId: 'OWNED-SMOKE-ONLY', customer: '隔离验收', bindingVersion: 2, machineId: status.machineId,
        issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), features: ['dashboard'] }, privateKey);
    await client.activate(encodeActivationCode(signed));
}
function createPackageView(sourceExecutable, directory) {
    requireTestPath(directory);
    const source = path.dirname(sourceExecutable), target = path.join(directory, 'package-view');
    fs.mkdirSync(target);
    function immutableEntry(from, to) {
        if (fs.statSync(from).isDirectory()) fs.symlinkSync(from, to, 'junction');
        else { try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } }
    }
    for (const entry of fs.readdirSync(source)) {
        if (entry !== 'resources') immutableEntry(path.join(source, entry), path.join(target, entry));
    }
    const resources = path.join(target, 'resources'); fs.mkdirSync(resources);
    for (const entry of fs.readdirSync(path.join(source, 'resources'))) {
        if (entry !== 'licensing') immutableEntry(path.join(source, 'resources', entry), path.join(resources, entry));
    }
    const privateKey = createTestIssuer(resources);
    return { executable: path.join(target, path.basename(sourceExecutable)), resources, privateKey };
}
module.exports = { createTestIssuer, activateFixture, createPackageView };
