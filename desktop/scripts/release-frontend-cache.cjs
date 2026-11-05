'use strict';
const fs = require('node:fs'), path = require('node:path');
const { inputFingerprint } = require('./ensure-workspace-frontend.cjs');
const { createTreeManifest, verifyFileManifest } = require('./runtime-cache.cjs');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');
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
module.exports = { buildReleaseFrontend };
