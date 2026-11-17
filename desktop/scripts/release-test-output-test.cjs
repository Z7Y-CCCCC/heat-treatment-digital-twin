'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {createReleaseTestOutput,validateReleaseTestOutput}=require('../../backend/scripts/release-test-output.cjs');
const repo=path.resolve(__dirname,'../..');
test('release output is private and preserves child containment, including junction rejection',t=>{
  const root=createReleaseTestOutput(repo);
  t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert.match(path.basename(root),/^dt-release-tests-/);fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(validateReleaseTestOutput(root,repo),root);
  const code=`const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict'),u=require(${JSON.stringify(require.resolve('../../backend/scripts/integration-test-utils.cjs'))});const r=u.createRunDirectory('isolated-release');a.equal(p.dirname(r),process.env.RELEASE_TEST_OUTPUT_ROOT);a.throws(()=>u.requireTestPath(p.join(process.env.RELEASE_TEST_OUTPUT_ROOT,'..','escape')));fs.symlinkSync(${JSON.stringify(repo)},p.join(r,'linked'),'junction');a.throws(()=>u.requireTestPath(p.join(r,'linked','README.md')));fs.unlinkSync(p.join(r,'linked'));console.log('containment passed');`;
  const child=spawnSync(process.execPath,['-e',code],{env:{...process.env,RELEASE_TEST_OUTPUT_ROOT:root},windowsHide:true,encoding:'utf8'});
  assert.equal(child.status,0,child.stdout+child.stderr);
  assert.throws(()=>validateReleaseTestOutput(repo,repo),/temporary child/);
  fs.writeFileSync(path.join(root,'.release-test-owner.json'),JSON.stringify({version:1,repo:os.tmpdir()}));
  assert.throws(()=>validateReleaseTestOutput(root,repo),/another workspace/);
});
test('a marker-less reserved temp directory cannot opt into outside-workspace writes',t=>{
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'dt-release-tests-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.throws(()=>validateReleaseTestOutput(root,repo));
});
