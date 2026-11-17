'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const MARKER = '.release-test-owner.json';
function createReleaseTestOutput(repo) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dt-release-tests-'));
  fs.writeFileSync(path.join(directory, MARKER), JSON.stringify({ version: 1, repo: fs.realpathSync(repo) }), { flag: 'wx' });
  return directory;
}
function validateReleaseTestOutput(directory, repo) {
  const root = path.resolve(directory), temp = fs.realpathSync(os.tmpdir());
  if (path.dirname(root).toLowerCase() !== temp.toLowerCase() || !/^dt-release-tests-[a-zA-Z0-9]{6}$/.test(path.basename(root)))
    throw Error('Release test output must be a uniquely owned temporary child');
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root).toLowerCase() !== root.toLowerCase())
    throw Error('Linked release test output rejected');
  const marker = path.join(root, MARKER);
  if (fs.lstatSync(marker).isSymbolicLink()) throw Error('Linked release test owner rejected');
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (owner.version !== 1 || owner.repo !== fs.realpathSync(repo)) throw Error('Release test output belongs to another workspace');
  return root;
}
module.exports = { createReleaseTestOutput, validateReleaseTestOutput };
