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
test('workflow loads the pinned existing public identity after Node setup and before any costly application build', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const start = source.indexOf('      - name: Provision the exact cloud editor, MySQL and public trust anchor');
  const check = source.indexOf('      - name: Check the provisioned cloud prerequisites without changing authorization');
  const build = source.indexOf('      - name: Build, verify first launch and restart, then package');
  assert.ok(start > source.indexOf('      - uses: actions/setup-node@v4', source.indexOf('  package:')));
  assert.ok(start < check && check < build);
  assert.match(source.slice(start, check), /setup-cloud-runner\.ps1/);
  assert.match(source.slice(check, build), /setup-cloud-runner\.ps1 -CheckOnly/);
  assert.doesNotMatch(source.slice(source.indexOf('  package:'), build), /release-environment\.cjs|self-hosted/);
  for (const filename of ['release-environment.cjs', 'cloud-runtime.cjs', 'setup-cloud-runner.ps1']) {
    const loader = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.doesNotMatch(loader, /generateKeyPair|LICENSE_ENFORCE|license-private-key\.pem/);
  }
  const cloud = fs.readFileSync(path.join(__dirname, 'cloud-runtime.cjs'), 'utf8');
  assert.match(cloud, /key.asymmetricKeyType!==\x27ed25519\x27/);
  assert.match(cloud, /fingerprint!==publicKey.spkiSha256/);
});

test('Windows cache compression requires the complete Git toolchain and precedes both cache consumers',t=>{
  const {compressionDirectory}=require('./cache-compression.cjs');
  const root=createRunDirectory('cache-tools-test'),git=path.join(root,'Git with spaces','cmd','git.exe'),bin=path.resolve(path.dirname(git),'../usr/bin');
  fs.mkdirSync(path.dirname(git),{recursive:true});fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(git,'fixture');
  for(const name of ['tar.exe','sh.exe'])fs.writeFileSync(path.join(bin,name),'fixture');
  assert.throws(()=>compressionDirectory([git]),/tar\/gzip\/sh/);fs.writeFileSync(path.join(bin,'gzip.exe'),'fixture');
  assert.equal(compressionDirectory(['relative/git.exe',git]),bin);
  const source=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/release.yml'),'utf8').split('  package:')[1];
  const start=source.indexOf('node tools/ci/cache-compression.cjs');assert.ok(start>=0);
  for(const consumer of ['uses: actions/setup-node@v4','uses: actions/cache@v4'])assert.ok(start<source.indexOf(consumer));
});

test('actual Git tar invokes gzip on a minimal Windows PATH and restores binary/Unicode content',{skip:process.platform!=='win32'},()=>{
  const {configureCacheCompression}=require('./cache-compression.cjs');
  const directory=createRunDirectory('cache-codec-real-test'),githubPath=path.join(directory,'github-path.txt');
  const env={...process.env,RUNNER_TEMP:directory,GITHUB_PATH:githubPath};
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  env.PATH=path.join(process.env.SystemRoot,'System32');
  const result=configureCacheCompression(env);
  assert.equal(result.roundtripPassed,true);assert.equal(fs.readFileSync(githubPath,'utf8'),result.directory+'\n');
});
