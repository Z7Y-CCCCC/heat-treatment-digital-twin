const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
function reusableRelease(run, jobs, id, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  if (!/^\d+$/.test(String(id)) || String(run.id) !== String(id)) throw new Error('Invalid source run');
  if (run.path !== '.github/workflows/release.yml' || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
    || run.status !== 'completed' || !/^[a-f0-9]{40}$/.test(run.head_sha) || !Number.isInteger(run.run_number)) throw new Error('Only completed main release builds may be reused');
  for (const name of ['preflight', 'package', 'quality / Frontend production build', 'quality / Backend contract and integration tests', 'quality / Windows desktop and native runtime regressions', 'quality / Isolated MQTT simulator regressions']) {
    if (!jobs.jobs?.some(job => job.name === name && job.conclusion === 'success' && job.status === 'completed')) throw new Error(`Source build did not pass: ${name}`);
  }
  git(['merge-base', '--is-ancestor', run.head_sha, 'HEAD']);
  const changed = git(['diff', '--name-only', run.head_sha, 'HEAD']).trim().split(/\r?\n/).filter(Boolean);
  if (changed.some(name => name !== '.github/workflows/release.yml' && name !== 'docs/CI-CD-runner.md' && !name.startsWith('tools/ci/'))) throw new Error('Product source changed; rebuild the installer');
  return { commit: run.head_sha, run: String(id), artifact: `windows-installer-${run.run_number}` };
}
if (require.main === module) {
  const result = reusableRelease(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), process.argv[4]);
  for (const [key, value] of Object.entries(result)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`Reusing verified Windows build ${result.run}, commit ${result.commit}`);
}
module.exports = { reusableRelease };
