const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
function issuerDataDirectory(env = process.env) {
    if (env.LICENSE_ISSUER_DATA_DIR) return path.resolve(env.LICENSE_ISSUER_DATA_DIR);
    // Keep an existing issuer identity; never silently generate a replacement.
    if (['license-private-key.pem', 'license-public-key.pem'].some(name => fs.existsSync(path.join(__dirname, name)))) return __dirname;
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'HeatTreatmentDigitalTwinIssuer');
}
module.exports = { issuerDataDirectory };
