'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createTreeManifest, sha256 } = require('./runtime-cache.cjs');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');

function fingerprintInputs(inputs, identity = '') {
  const hash = crypto.createHash('sha256').update('native-build-v1\0' + identity + '\0' + sha256(__filename));
  function visit(file) {
    hash.update(file + '\0');
    if (!fs.existsSync(file)) { hash.update('missing\0'); return; }
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error(`Native build input must not be a link: ${file}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!['bin', 'obj', '.git', 'node_modules'].includes(name)) visit(path.join(file, name));
      }
    } else hash.update(sha256(file) + '\0');
  }
  for (const file of [...new Set(inputs)].sort()) visit(file);
  return hash.digest('hex');
}

function buildConfigurationInputs(project) {
  const files = [];
  for (let dir = path.resolve(project); ; dir = path.dirname(dir)) {
    for (const name of ['global.json', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'NuGet.Config']) files.push(path.join(dir, name));
    if (dir === path.dirname(dir)) break;
  }
  return files;
}

// MSBuild imports arbitrary environment properties, not just Version or a
// small DOTNET_* allowlist. Hash the complete environment conservatively and
// pass this same immutable snapshot to every tool invocation. Windows children
// receive one case-insensitive key (matching Node's sorted first-key policy).
// Only its digest belongs in a cache receipt; never persist environment values.
function snapshotBuildEnvironment(environment = process.env, platform = process.platform) {
  const snapshot = Object.create(null);
  for (const name of Object.keys(environment).sort()) {
    if (environment[name] === undefined || environment[name] === null) continue;
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (!Object.hasOwn(snapshot, key)) snapshot[key] = String(environment[name]);
  }
  return Object.freeze(snapshot);
}
function fingerprintBuildEnvironment(environment = process.env, platform = process.platform) {
  const snapshot = snapshotBuildEnvironment(environment, platform);
  return crypto.createHash('sha256').update(JSON.stringify(Object.keys(snapshot).sort().map(name => [name, snapshot[name]]))).digest('hex');
}
function assertBuildEnvironmentUnchanged(snapshot, environment = process.env, platform = process.platform) {
  if (fingerprintBuildEnvironment(snapshot, platform) !== fingerprintBuildEnvironment(environment, platform)) {
    throw Error('Native build environment changed during compilation');
  }
}

async function buildCachedNative({ output, fingerprint, build, required, force = false, restoredState = () => '' }) {
  const marker = output + '.build.json', before = fingerprint();
  let cached;
  try { cached = JSON.parse(fs.readFileSync(marker)); } catch { }
  if (!force && cached?.fingerprint === before && cached.restoredState === restoredState()) {
    try {
      // One full content pass checks corruption, deletions AND unexpected DLLs.
      if (required.every(name => fs.statSync(path.join(output, name)).isFile())
          && JSON.stringify(createTreeManifest(output)) === JSON.stringify(cached.files)
          && fingerprint() === before) return { reused: true };
    } catch { /* An incomplete/corrupt output must be rebuilt. */ }
  }
  let files;
  await prepareResourceDirectory(output, async staging => {
    await build(staging);
    for (const name of required) if (!fs.statSync(path.join(staging, name)).isFile()) throw Error(`Missing native output: ${name}`);
    if (fingerprint() !== before) throw Error('Native build inputs changed during compilation; previous output retained');
    files = createTreeManifest(staging);
  });
  const temporary = marker + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ fingerprint: before, files, restoredState: restoredState() }));
  fs.renameSync(temporary, marker);
  return { reused: false };
}
module.exports = { fingerprintInputs, buildConfigurationInputs, buildCachedNative,
  snapshotBuildEnvironment, fingerprintBuildEnvironment, assertBuildEnvironmentUnchanged };
