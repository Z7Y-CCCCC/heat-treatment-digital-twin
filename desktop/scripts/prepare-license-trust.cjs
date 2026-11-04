const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function prepareLicenseTrust(destination, source) {
    if (!source) {
        const issuer = path.join(require('../../tools/license-generator/issuer-paths.cjs').issuerDataDirectory(), 'license-public-key.pem');
        const existing = path.resolve(__dirname, '../resources/licensing/license-public-key.pem');
        // Reuse an already configured public trust root, not a newly generated
        // signing identity. Never copy private keys or silently rotate licenses.
        source = process.env.LICENSE_ISSUER_PUBLIC_KEY_FILE || (fs.existsSync(issuer) ? issuer : existing);
    }
    if (!fs.existsSync(source)) throw new Error('尚未配置厂商公钥。请运行根目录“厂商激活码工具.cmd”初始化密钥，并备份私钥后再打包。');
    const key = crypto.createPublicKey(fs.readFileSync(source));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('厂商公钥必须为 Ed25519');
    fs.mkdirSync(destination, { recursive: true });
    // Export only the public key even if a key container was accidentally supplied.
    fs.writeFileSync(path.join(destination, 'license-public-key.pem'), key.export({ type: 'spki', format: 'pem' }));
    return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}
module.exports = { prepareLicenseTrust };
