'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const {parseVersion, compareVersions, planVersion, planFromGit, main} = require('./auto-release-version.cjs');
const head = 'a'.repeat(40), previous = 'b'.repeat(40);
const context = {event:'push',ref:'refs/heads/main',commit:head,sourceVersion:'2.3.6'};
const tag = (version, commit = previous, distance = 1) => ({tag:'v'+version, version, commit, distance});
test('main gets a fresh automatic version without editing source version files', () => {
  assert.equal(planVersion({...context,tags:[tag('2.3.6')]}).version,'2.3.7');
  assert.equal(planVersion({...context,tags:[tag('2.3.6',previous,4)]}).version,'2.3.10');
  assert.equal(planVersion({...context,tags:[tag('2.3.10')]}).version,'2.3.11');
  assert.equal(planVersion(context).version,'2.3.6');
});
test('source major/minor bumps are respected and never downgrade later releases', () => {
  assert.equal(planVersion({...context,sourceVersion:'3.0.0',tags:[tag('2.3.6')]}).version,'3.0.0');
  assert.equal(planVersion({...context,tags:[tag('3.0.1')]}).version,'3.0.2');
  assert.equal(compareVersions('2.3.10','2.3.9'),1);
});
test('same-source reruns and explicit version tags reuse the exact version', () => {
  const tags=[tag('2.3.6'),tag('2.3.7',head,0)];
  assert.equal(planVersion({...context,tags}).version,'2.3.7');
  assert.equal(planVersion({...context,event:'workflow_dispatch',tags}).version,'2.3.7');
  assert.equal(planVersion({...context,ref:'refs/tags/v2.3.7',tags}).version,'2.3.7');
  assert.throws(()=>planVersion({...context,ref:'refs/tags/v2.3.8',tags}),/Version tag/);
  assert.throws(()=>planVersion({...context,sourceVersion:'3.0.0',ref:'refs/tags/v2.3.7',tags}),/downgrade/);
});
test('versions on another branch are reserved, not overwritten', () => {
  const plan=planVersion({...context,tags:[tag('2.3.6'),tag('2.3.7','c'.repeat(40),null)]});
  assert.equal(plan.version,'2.3.8');
});
test('only an explicit main push marker suppresses publication, not quality checks', () => {
  assert.equal(planVersion({...context,message:'ci: migrate pipeline [skip release]'}).skip,true);
  assert.equal(planVersion({...context,message:'ci: migrate pipeline [SKIP RELEASE]\n'}).skip,true);
  assert.equal(planVersion({...context,message:'skip release is not a marker'}).skip,false);
  assert.equal(planVersion({...context,event:'workflow_dispatch',message:'[skip release]'}).skip,false);
  assert.equal(planVersion({...context,ref:'refs/tags/v2.3.6',message:'[skip release]',tags:[tag('2.3.6',head,0)]}).skip,false);
});
test('malformed versions, source provenance, PR contexts and tag distances fail closed', () => {
  for(const value of ['2.3','02.3.6','2.3.6-beta','2.3.6;command','9007199254740992.0.0',null])assert.throws(()=>parseVersion(value),/version/);
  for(const patch of [{event:'pull_request'},{ref:'refs/heads/feature'},{commit:'not-a-sha'}])assert.throws(()=>planVersion({...context,...patch}),/Only verified/);
  for(const item of [tag('2.3.6',head,1),tag('2.3.6',previous,0),tag('2.3.6',previous,-1),tag('2.3.6','not-a-sha',1)])assert.throws(()=>planVersion({...context,tags:[item]}),/provenance|distance/);
  assert.throws(()=>planVersion({...context,tags:[tag('2.3.9007199254740991')]}),/distance/);
});
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-auto-version-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^ci-auto-version-/);fs.rmSync(root,{recursive:true,force:true});});
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  git(['init','-b','main']);git(['config','user.email','fixture@example.invalid']);git(['config','user.name','Fixture']);
  fs.mkdirSync(path.join(root,'desktop'));fs.writeFileSync(path.join(root,'desktop','package.json'),JSON.stringify({version:'2.3.6'}));
  git(['add','.']);git(['commit','-m','fixture baseline']);git(['tag','v2.3.6']);
  fs.writeFileSync(path.join(root,'source.txt'),'new source');git(['add','.']);git(['commit','-m','fixture main merge']);
  const commit=git(['rev-parse','HEAD']).trim();git(['update-ref','refs/remotes/origin/main',commit]);
  return {root,git,env:{GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_SHA:commit,GITHUB_OUTPUT:path.join(root,'outputs'),GITHUB_STEP_SUMMARY:path.join(root,'summary')}};
}
test('actual git checkout plans the new version and writes outputs without modifying source',t=>{
  const f=fixture(t),before=f.git(['status','--porcelain']);
  const plan=main(f.env,f.git);assert.equal(plan.version,'2.3.7');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'desktop','package.json'))).version,'2.3.6');
  assert.equal(before,'');assert.match(fs.readFileSync(f.env.GITHUB_OUTPUT,'utf8'),/version=2.3.7\ntag=v2.3.7/);
  f.git(['tag','-a','v2.3.7','-m','same-source draft']);assert.equal(planFromGit(f.env,f.git).version,'2.3.7');
});
test('publish-only retry plans the verified older source, not a later main commit',t=>{
  const f=fixture(t),source=f.env.GITHUB_SHA;
  fs.writeFileSync(path.join(f.root,'config.txt'),'CI follow-up');f.git(['add','config.txt']);f.git(['commit','-m','fixture CI follow-up [skip release]']);
  const current=f.git(['rev-parse','HEAD']).trim();f.git(['update-ref','refs/remotes/origin/main',current]);
  assert.equal(planFromGit({...f.env,GITHUB_SHA:current,BUILD_COMMIT:source,GITHUB_EVENT_NAME:'workflow_dispatch'},f.git).version,'2.3.7');
  assert.equal(planFromGit({...f.env,GITHUB_SHA:current},f.git).skip,true);
});

test('new main source releases automatically even when source version files were not bumped',()=>{
 const {decideRelease}=require('./release-trigger.cjs');
 const first=planVersion({...context,tags:[tag('2.3.6')]});
 assert.equal(decideRelease({event:context.event,ref:context.ref,tag:first.tag,commit:head}).release,true);
 const rerun=planVersion({...context,tags:[tag('2.3.6'),tag(first.version,head,0)]});
 assert.equal(decideRelease({event:context.event,ref:context.ref,tag:rerun.tag,commit:head},{release:{id:1,tag_name:rerun.tag,draft:false},tagCommit:head}).release,false);
 const next=planVersion({...context,commit:'c'.repeat(40),tags:[tag('2.3.6',previous,2),tag(first.version,head,1)]});
 assert.equal(next.version,'2.3.8');assert.equal(decideRelease({event:context.event,ref:context.ref,tag:next.tag,commit:'c'.repeat(40)}).release,true);
});
