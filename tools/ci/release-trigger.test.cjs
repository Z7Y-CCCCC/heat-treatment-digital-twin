const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decideRelease, getReleaseState, main } = require('./release-trigger.cjs');

const commit = 'a'.repeat(40);
const context = { event: 'push', ref: 'refs/heads/main', tag: 'v2.3.6', commit };
const draft = { id: 123, tag_name: context.tag, draft: true };
const published = { ...draft, draft: false };
const repository = 'fixture/project';
function reply(status, data) { return { status, ok: status >= 200 && status < 300, json: async () => data }; }
function mockState(release, ref, resolved = { sha: commit }) {
  return async url => {
    if (url.includes('/releases/tags/')) return release;
    if (url.includes('/git/ref/tags/')) return ref;
    if (url.includes('/commits/')) return reply(200, resolved);
    throw new Error('Unexpected API endpoint');
  };
}
const ref = { ref: 'refs/tags/' + context.tag, object: { type: 'commit', sha: commit } };

for (const trigger of [context, { ...context, ref: 'refs/tags/' + context.tag }, { ...context, event: 'workflow_dispatch' }]) {
  test('an unpublished version automatically releases on ' + trigger.event + ' ' + trigger.ref, () => {
    assert.equal(decideRelease(trigger).release, true);
    assert.equal(decideRelease(trigger, { tagCommit: commit }).release, true);
  });
}

test('a published version is a no-op even when later main changes use the same version', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(decideRelease({ ...context, event }, { release: published, tagCommit: 'b'.repeat(40) }).release, false);
  }
  assert.match(decideRelease(context, { release: published }).reason, /already published/);
});

test('only a same-source reserved tag and draft may resume publication', () => {
  assert.equal(decideRelease(context, { release: draft, tagCommit: commit }).release, true);
  assert.throws(() => decideRelease(context, { tagCommit: 'b'.repeat(40) }), /another commit/);
  assert.throws(() => decideRelease(context, { release: draft, tagCommit: 'b'.repeat(40) }), /another commit/);
  assert.throws(() => decideRelease(context, { release: draft }), /no verified version tag/);
});

test('external PRs, feature branches, mismatched tags and unverified source cannot release', () => {
  for (const patch of [
    { event: 'pull_request' }, { event: 'pull_request_target' }, { event: 'schedule' },
    { ref: 'refs/heads/feature' }, { ref: 'refs/tags/v2.3.5' }, { tag: 'v2.3.6;command' },
    { commit: 'unverified' }, { commit: undefined }
  ]) assert.throws(() => decideRelease({ ...context, ...patch }), /verified version|Only main/);
});

test('malformed metadata is never treated as an unpublished version', () => {
  for (const release of [{}, [], { ...published, id: 0 }, { ...published, draft: undefined }, { ...published, tag_name: 'v9.0.0' }]) {
    assert.throws(() => decideRelease(context, { release }), /Invalid release metadata/);
  }
  assert.throws(() => decideRelease(context, { tagCommit: 'not-a-sha' }), /Invalid version tag commit/);
});

test('API lookups recognize genuine 404s and validate lightweight and annotated tag commits', async () => {
  assert.deepEqual(await getReleaseState(repository, context.tag, 'fixture-read-token', mockState(reply(404), reply(404))), { release: null, tagCommit: null });
  assert.deepEqual(await getReleaseState(repository, context.tag, 'fixture-read-token', mockState(reply(200, draft), reply(200, ref))), { release: draft, tagCommit: commit });
  const annotated = { ...ref, object: { type: 'tag', sha: 'c'.repeat(40) } };
  assert.deepEqual(await getReleaseState(repository, context.tag, 'fixture-read-token', mockState(reply(200, draft), reply(200, annotated))), { release: draft, tagCommit: commit });
  await assert.rejects(() => getReleaseState(repository, context.tag, 'fixture-read-token', mockState(reply(404), reply(200, annotated), {})), /Invalid resolved/);
});

for (const status of [401, 403, 429, 500, 502, 503]) {
  test('HTTP ' + status + ' fails closed instead of starting a new build', async () => {
    for (const [release, reference] of [[reply(status), reply(404)], [reply(404), reply(status)]]) {
      await assert.rejects(() => getReleaseState(repository, context.tag, 'fixture-read-token', mockState(release, reference)), new RegExp('HTTP ' + status));
    }
  });
}

test('network failures, malformed responses and invalid tag objects fail closed', async () => {
  await assert.rejects(() => getReleaseState(repository, context.tag, 'fixture-read-token', async () => { throw new Error('network offline'); }), /network offline/);
  for (const body of [null, [], 'not metadata']) {
    await assert.rejects(() => getReleaseState(repository, context.tag, 'fixture-read-token', mockState(reply(200, body), reply(404))), /Invalid GitHub release-state response/);
  }
  for (const body of [{}, { ...ref, ref: 'refs/tags/v2.3.5' }, { ...ref, object: { type: 'tree', sha: commit } }, { ...ref, object: { type: 'commit', sha: 'bad' } }]) {
    await assert.rejects(() => getReleaseState(repository, context.tag, 'fixture-read-token', mockState(reply(404), reply(200, body))), /Invalid GitHub version tag response/);
  }
  await assert.rejects(() => getReleaseState(repository, context.tag, '', async () => assert.fail('must not query without auth')), /token is required/);
  await assert.rejects(() => getReleaseState('../not/a/repo', context.tag, 'fixture-read-token', async () => assert.fail('invalid endpoint')), /Invalid GitHub repository/);
});

function outputFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-release-trigger-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { env: { GITHUB_EVENT_NAME: context.event, GITHUB_REF: context.ref, RELEASE_TAG: context.tag, BUILD_COMMIT: commit,
    GITHUB_REPOSITORY: repository, GH_TOKEN: 'fixture-read-token', GITHUB_OUTPUT: path.join(directory, 'output'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary') } };
}

test('the command exports explicit true/false outputs and explains its no-op decision', async t => {
  const { env } = outputFixture(t);
  assert.equal((await main(env, mockState(reply(404), reply(404)))).release, true);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'release=true\n');
  fs.writeFileSync(env.GITHUB_OUTPUT, '');
  assert.equal((await main(env, mockState(reply(200, published), reply(200, { ...ref, object: { type: 'commit', sha: 'b'.repeat(40) } })))).release, false);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'release=false\n');
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /already published/);
});

test('a failed state lookup writes no build authorization to GITHUB_OUTPUT', async t => {
  const { env } = outputFixture(t);
  await assert.rejects(() => main(env, mockState(reply(403), reply(404))), /HTTP 403/);
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
  await assert.rejects(() => main({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, async () => assert.fail('no PR API lookup')), /Only main/);
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
});

test('the workflow automatically listens on main and gates every release job without weakening verification', () => {
  const root = path.resolve(__dirname, '../..');
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(workflow, /push:\n    branches: \[main\]\n    tags: \['v\*'\]/);
  assert.doesNotMatch(workflow.split('jobs:')[0], /pull_request/);
  assert.match(workflow, /release: \$\{\{ steps\.release\.outputs\.release \}\}/);
  const quality = workflow.split('\n  quality:\n')[1].split('\n  package:')[0];
  assert.match(quality, /if: needs\.preflight\.outputs\.release == 'true'/);
  const packageJob = workflow.split('\n  package:\n')[1].split('\n  publish-release:')[0];
  assert.match(packageJob, /if: needs\.preflight\.outputs\.release == 'true' && inputs\.verified_run_id == ''/);
  assert.match(packageJob, /生成安装包\.ps1 -StarterTemplate -NoPause/);
  assert.match(packageJob, /native-overlay-tests/);
  assert.match(packageJob, /if-no-files-found: error/);
  const publish = workflow.split('\n  publish-release:\n')[1];
  assert.match(publish, /needs\.preflight\.outputs\.release == 'true'/);
  assert.match(publish, /needs\.quality\.result == 'success'/);
  assert.match(publish, /needs\.package\.result == 'success'/);
  assert.match(publish, /verify-release\.cjs/);
  assert.match(publish, /portable-release\.cjs --uploaded/);
  assert.match(publish, /--draft=false --latest/);
  const preflight = workflow.split('\n  preflight:\n')[1].split('\n  quality:')[0];
  assert.ok(preflight.indexOf('node tools/ci/release-trigger.cjs') < preflight.indexOf('node tools/ci/cloud-runtime.cjs --require-license'));
  assert.doesNotMatch(preflight, /WINDOWS_RELEASE_RUNNER_ENABLED|setup-windows-runner/);
  assert.match(packageJob, /runs-on: windows-2022/);
  assert.doesNotMatch(packageJob, /self-hosted|release-environment\.cjs|setup-windows-runner/);
  assert.match(packageJob, /setup-dotnet@/);
  assert.match(packageJob, /setup-cloud-runner\.ps1/);
  assert.match(packageJob, /set-build-version\.cjs/);
  assert.match(preflight, /auto-release-version\.cjs/);
  assert.match(preflight, /SKIP_RELEASE:/);
  assert.match(publish, /\"\$RELEASE_VERSION\"/);
  assert.match(preflight, /if: steps\.release\.outputs\.release == 'true' && inputs\.verified_run_id == ''/);
  assert.match(fs.readFileSync(path.join(root, '.github/workflows/quality.yml'), 'utf8'), /node --test[^\n]+release-trigger\.test\.cjs/);
});
