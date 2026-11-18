'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw Error('Release version must be X.Y.Z');
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw Error('Release version exceeds the safe integer range');
  return parts;
}
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function advance(version, count = 1) {
  const parts = parseVersion(version);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(parts[2] + count)) throw Error('Invalid release commit distance');
  parts[2] += count;
  return parts.join('.');
}
function planVersion({event, ref, commit, sourceVersion, message = '', tags = []}) {
  parseVersion(sourceVersion);
  if (!/^[a-f0-9]{40}$/.test(commit || '') || !['push', 'workflow_dispatch'].includes(event)
    || !(ref === 'refs/heads/main' || /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref || ''))) throw Error('Only verified main or version tags may plan a release');
  if (!Array.isArray(tags)) throw Error('Invalid verified tag list');
  for (const item of tags) {
    parseVersion(item.version);
    if (item.tag !== 'v' + item.version || !/^[a-f0-9]{40}$/.test(item.commit || '')
      || !(item.distance === null || (Number.isSafeInteger(item.distance) && item.distance >= 0))) throw Error('Invalid verified tag provenance');
    if ((item.commit === commit) !== (item.distance === 0)) throw Error('Tag commit distance does not match its source');
  }
  let version;
  if (ref.startsWith('refs/tags/')) {
    const tag = ref.slice('refs/tags/'.length);
    const exact = tags.find(item => item.tag === tag && item.commit === commit);
    if (!exact || compareVersions(exact.version, sourceVersion) < 0) throw Error('Version tag must identify this source and not downgrade its source version');
    version = exact.version;
  } else {
    // Same-source retries are idempotent, including a reserved draft tag.
    const sameSource = tags.filter(item => item.commit === commit && compareVersions(item.version, sourceVersion) >= 0)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (sameSource) version = sameSource.version;
    else {
      const base = tags.filter(item => item.distance !== null).sort((a, b) => compareVersions(b.version, a.version))[0];
      const inferred = base ? advance(base.version, Math.max(1, base.distance)) : sourceVersion;
      version = compareVersions(sourceVersion, inferred) > 0 ? sourceVersion : inferred;
      // Tags outside this source's ancestry still reserve their version name.
      while (tags.some(item => item.tag === 'v' + version && item.commit !== commit)) version = advance(version);
    }
  }
  const skip = event === 'push' && ref === 'refs/heads/main' && /(?:^|\s)\[skip release\](?=\s|$)/i.test(message);
  return {version, tag:'v' + version, commit, sourceVersion, skip,
    reason: skip ? 'Explicit [skip release]: validate CI configuration only; do not build or publish an installer.' : 'Automatic version ' + version + ' for verified main source ' + commit + '.'};
}
function planFromGit(env = process.env, git = args => execFileSync('git', args, {encoding:'utf8', windowsHide:true})) {
  const commit = env.BUILD_COMMIT || env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Verified source commit is required');
  // Never issue a release from an unmerged branch, including manual retries.
  git(['merge-base', '--is-ancestor', commit, 'origin/main']);
  const desktop = JSON.parse(git(['show', commit + ':desktop/package.json']).replace(/^\uFEFF/, ''));
  const tags = git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags']).trim().split(/\r?\n/)
    .filter(tag => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)).map(tag => {
      const tagCommit = git(['rev-parse', tag + '^{commit}']).trim();
      let distance = null;
      try { git(['merge-base', '--is-ancestor', tagCommit, commit]);
        distance = Number(git(['rev-list', '--count', tagCommit + '..' + commit]).trim());
      } catch (error) { if (error.status !== 1) throw error; }
      return {tag, version:tag.slice(1), commit:tagCommit, distance};
    });
  return planVersion({event:env.GITHUB_EVENT_NAME, ref:env.GITHUB_REF, commit, sourceVersion:desktop.version,
    message:git(['show', '-s', '--format=%B', commit]), tags});
}
function main(env = process.env, git) {
  if (!env.GITHUB_OUTPUT) throw Error('GITHUB_OUTPUT is required');
  const plan = planFromGit(env, git);
  for (const [key, value] of Object.entries({version:plan.version, tag:plan.tag, source_version:plan.sourceVersion, skip:plan.skip})) fs.appendFileSync(env.GITHUB_OUTPUT, key + '=' + value + '\n');
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, '### Automatic installer version\n\n' + plan.reason + '\n');
  console.log(plan.reason);
  return plan;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = {parseVersion, compareVersions, planVersion, planFromGit, main};
