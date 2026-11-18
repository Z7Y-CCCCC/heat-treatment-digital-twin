const fs = require('node:fs');

function validateContext(context) {
  if (!/^v\d+\.\d+\.\d+$/.test(context.tag) || !/^[a-f0-9]{40}$/.test(context.commit)) {
    throw new Error('Release automation requires a verified version and source commit');
  }
  if (!['push', 'workflow_dispatch'].includes(context.event)
    || !['refs/heads/main', 'refs/tags/' + context.tag].includes(context.ref)) {
    throw new Error('Only main or its matching version tag may trigger a release');
  }
}

function decideRelease(context, { release = null, tagCommit = null } = {}) {
  validateContext(context);
  if (tagCommit !== null && !/^[a-f0-9]{40}$/.test(tagCommit)) throw new Error('Invalid version tag commit');
  if (release !== null) {
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== context.tag
      || typeof release.draft !== 'boolean') throw new Error('Invalid release metadata; refusing to guess publication state');
    if (!release.draft) {
      // A later main commit may retain the published version. Never rebuild,
      // move its tag or overwrite its assets; only a new version is publishable.
      return { release: false, reason: context.tag + ' is already published; keep its tag and assets unchanged.' };
    }
    if (tagCommit === null) throw new Error('Existing draft has no verified version tag; resolve the reserved draft first');
  }
  if (tagCommit !== null && tagCommit !== context.commit) {
    throw new Error('Version tag belongs to another commit; bump the version instead of overwriting it');
  }
  return { release: true, reason: context.tag + (release ? ' has a same-source draft; resume verified publication.' : ' is not published; build, verify and publish automatically.') };
}

async function getReleaseState(repository, tag, token, fetchImpl = globalThis.fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^v\d+\.\d+\.\d+$/.test(tag || '')) {
    throw new Error('Invalid GitHub repository or version tag');
  }
  if (!token) throw new Error('GitHub read token is required to verify release state');
  const request = async (endpoint, allowMissing = false) => {
    const response = await fetchImpl('https://api.github.com/repos/' + repository + '/' + endpoint, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000)
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error('GitHub release-state lookup failed: HTTP ' + response.status + ' (' + endpoint + ')');
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub release-state response');
    return value;
  };
  const encoded = encodeURIComponent(tag);
  const [release, ref] = await Promise.all([
    request('releases/tags/' + encoded, true),
    request('git/ref/tags/' + encoded, true)
  ]);
  let tagCommit = null;
  if (ref !== null) {
    if (ref.ref !== 'refs/tags/' + tag || !['commit', 'tag'].includes(ref.object?.type)
      || !/^[a-f0-9]{40}$/.test(ref.object?.sha || '')) throw new Error('Invalid GitHub version tag response');
    tagCommit = ref.object.type === 'commit' ? ref.object.sha : (await request('commits/' + encoded)).sha;
    if (!/^[a-f0-9]{40}$/.test(tagCommit || '')) throw new Error('Invalid resolved version tag commit');
  }
  return { release, tagCommit };
}

async function main(env = process.env, fetchImpl = globalThis.fetch) {
  const context = { event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, tag: env.RELEASE_TAG, commit: env.BUILD_COMMIT };
  validateContext(context);
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  const state = await getReleaseState(env.GITHUB_REPOSITORY, context.tag, env.GH_TOKEN, fetchImpl);
  const decision = decideRelease(context, state);
  fs.appendFileSync(env.GITHUB_OUTPUT, 'release=' + decision.release + '\n');
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, '### Automatic Windows Release\n\n' + decision.reason + '\n');
  console.log('Release automation: ' + decision.reason);
  return decision;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { decideRelease, getReleaseState, main };
