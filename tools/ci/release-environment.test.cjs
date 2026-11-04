'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRunDirectory } = require('../../backend/scripts/integration-test-utils.cjs');
const { readReleaseEnvironment, configureReleaseEnvironment } = require('./release-environment.cjs');
function fixture() {
  const directory = createRunDirectory('release-environment-test');
  const key = crypto.generateKeyPairSync('ed25519');
  const config = { publicKey: path.join(directory, 'public.pem'), unityEditor: path.join(directory, 'Unity.exe'), mysqlRuntime: path.join(directory, 'mysql') };
  fs.writeFileSync(config.publicKey, key.publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(config.unityEditor, 'owned prerequisite marker; never executed'); fs.mkdirSync(config.mysqlRuntime);
  const filename = path.join(directory, 'release-environment.json');
  const save = () => fs.writeFileSync(filename, JSON.stringify(config)); save();
  const temp = path.join(directory, '_work', '_temp'); fs.mkdirSync(temp, { recursive: true });
  const env = { RUNNER_TEMP: temp, GITHUB_ENV: path.join(directory, 'github-env.txt'), LICENSE_ISSUER_PUBLIC_KEY_FILE: 'wrong inherited path', LOCALAPPDATA: 'wrong inherited profile' };
  return { directory, key, config, filename, save, env };
}
test('runner explicitly exports only the provisioned public identity, not inherited profiles', () => {
  const f = fixture(), result = configureReleaseEnvironment(f.env);
  const expected = crypto.createHash('sha256').update(f.key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  assert.equal(result.fingerprint, expected);
  const content = fs.readFileSync(f.env.GITHUB_ENV, 'utf8');
  assert.match(content, /LICENSE_ISSUER_PUBLIC_KEY_FILE=/); assert.ok(content.includes(f.config.publicKey));
  assert.doesNotMatch(content, /PRIVATE KEY|BEGIN PUBLIC KEY|wrong inherited/);
  assert.equal(content.trim().split('\n').length, 3);
});
for (const [label, change] of [
  ['missing key', f => fs.unlinkSync(f.config.publicKey)],
  ['private key supplied', f => fs.writeFileSync(f.config.publicKey, f.key.privateKey.export({ type: 'pkcs8', format: 'pem' }))],
  ['wrong key algorithm', f => fs.writeFileSync(f.config.publicKey, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }))],
  ['relative resource path', f => { f.config.publicKey = 'relative.pem'; f.save(); }],
  ['environment line injection', f => { f.config.publicKey += '\nINJECTED=1'; f.save(); }],
  ['file used as MySQL directory', f => { f.config.mysqlRuntime = f.config.unityEditor; f.save(); }],
  ['missing provisioning file', f => fs.unlinkSync(f.filename)]
]) test(label + ' fails before exporting anything', () => {
  const f = fixture(); change(f);
  assert.throws(() => configureReleaseEnvironment(f.env)); assert.equal(fs.existsSync(f.env.GITHUB_ENV), false);
});
test('workflow loads trust after Node setup and before any costly build; no key generation or enforcement bypass', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const start = source.indexOf('      - name: Load and validate provisioned release environment');
  assert.ok(start > source.indexOf('      - uses: actions/setup-node@v4', source.indexOf('  package:')));
  assert.ok(start < source.indexOf('      - name: Check native build prerequisites'));
  assert.match(source.slice(start, source.indexOf('      - name: Check native build prerequisites')), /node tools\/ci\/release-environment.cjs/);
  const loader = fs.readFileSync(path.join(__dirname, 'release-environment.cjs'), 'utf8');
  assert.doesNotMatch(loader, /generateKeyPair|LICENSE_ENFORCE|license-private-key\.pem/);
});
