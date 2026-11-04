'use strict';
// Load the provisioned runner identity explicitly; never rely on whichever
// LOCALAPPDATA or issuer test environment the listener happened to inherit.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function readReleaseEnvironment(filename) {
  const config = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  const values = {};
  for (const [field, name, directory] of [
    ['publicKey', 'LICENSE_ISSUER_PUBLIC_KEY_FILE', false],
    ['unityEditor', 'UNITY_EDITOR_PATH', false],
    ['mysqlRuntime', 'DESKTOP_MYSQL_RUNTIME_SOURCE', true]
  ]) {
    const value = config[field];
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`Invalid runner ${field} path`);
    const stat = fs.statSync(value);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Invalid runner ${field} resource`);
    values[name] = path.resolve(value);
  }
  const pem = fs.readFileSync(values.LICENSE_ISSUER_PUBLIC_KEY_FILE, 'utf8');
  if (!/^-----BEGIN PUBLIC KEY-----/.test(pem.trim()) || /PRIVATE KEY/.test(pem)) throw new Error('Runner must receive a public key only');
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Runner public key must be Ed25519');
  const fingerprint = crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  return { values, fingerprint };
}
function configureReleaseEnvironment(env = process.env) {
  if (!path.isAbsolute(env.RUNNER_TEMP || '') || !path.isAbsolute(env.GITHUB_ENV || '')) throw new Error('GitHub runner paths are required');
  const config = path.resolve(env.RUNNER_TEMP, '..', '..', 'release-environment.json');
  const result = readReleaseEnvironment(config);
  // Validation is atomic with respect to export: a broken identity must fail
  // before the expensive build, without partially writing the environment.
  fs.appendFileSync(env.GITHUB_ENV, Object.entries(result.values).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
  return result;
}
if (require.main === module) {
  const result = configureReleaseEnvironment();
  console.log(`Release environment verified; public key SHA-256: ${result.fingerprint}`);
}
module.exports = { readReleaseEnvironment, configureReleaseEnvironment };
