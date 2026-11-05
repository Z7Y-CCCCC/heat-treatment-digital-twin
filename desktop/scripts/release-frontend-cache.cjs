'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createTreeManifest, verifyFileManifest, sha256 } = require('./runtime-cache.cjs');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');
function inputFingerprint(frontend, env) {
  const hash = crypto.createHash('sha256');
  hash.update('release-vite-v2\0' + process.version + '\0' + fs.readFileSync(__filename));
  function visit(file) {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file,name));
    } else hash.update(path.relative(frontend,file) + '\0' + sha256(file) + '\0');
  }
  // Test screenshots, running dev logs and editor output are NOT Vite inputs.
  // Traversing all of frontend/ made a cache check cost tens of seconds and
  // diagnostic output alone invalidated an otherwise identical release.
  for (const name of ['src','public','scripts']) visit(path.join(frontend,name));
  visit(path.resolve(frontend,'../shared'));
  for (const name of fs.readdirSync(frontend).sort()) {
    if (/^(?:index\.html|package(?:-lock)?\.json|vite\.config\.[cm]?[jt]s|(?:postcss|tailwind)\.config\.[cm]?[jt]s|tsconfig.*\.json|\.env(?:\..*)?|\.npmrc)$/.test(name)) visit(path.join(frontend,name));
  }
  for (const name of ['.package-lock.json','vite/package.json','vite/bin/vite.js']) visit(path.join(frontend,'node_modules',name));
  hash.update(JSON.stringify(Object.keys(env).filter(k=>/^(VITE_|NODE_ENV$|NODE_OPTIONS$)/.test(k)).sort().map(k=>[k,env[k]])));
  return hash.digest('hex');
}
async function buildReleaseFrontend(frontend, destination, build, { force = false, env = process.env } = {}) {
  const marker = destination + '.json';
  const fingerprint = inputFingerprint(frontend, env);
  let proof;
  try { proof = JSON.parse(fs.readFileSync(marker)); } catch { }
  if (!force && proof?.fingerprint === fingerprint && verifyFileManifest(destination, proof.files)
      && JSON.stringify(createTreeManifest(destination)) === JSON.stringify(proof.files)) return { reused: true };
  await prepareResourceDirectory(destination, async staging => {
    await build(staging);
    if (inputFingerprint(frontend, env) !== fingerprint) throw new Error('Frontend inputs changed during release build');
  });
  const temporary = marker + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ fingerprint, files: createTreeManifest(destination) }));
  fs.renameSync(temporary, marker);
  return { reused: false };
}
module.exports = { buildReleaseFrontend, inputFingerprint };
