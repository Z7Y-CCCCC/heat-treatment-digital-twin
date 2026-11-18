'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const os=require('node:os');
const {readinessPaths,runReadiness}=require('./cloud-readiness.cjs');
const temp=path.resolve(__dirname,'../../output/readiness-fixture-paths');
const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REF:'refs/heads/main',RUNNER_TEMP:temp,UNITY_EDITOR_PATH:path.join(temp,'cloud-release-v1','unity','Editor','Unity.exe'),DESKTOP_MYSQL_RUNTIME_SOURCE:path.join(temp,'cloud-release-v1','mysql','mysql-9.2.0-winx64')};
test('readiness paths are restricted to a cloud temp fixture, never local tools',()=>{
 assert.equal(readinessPaths(env).fixture,path.join(temp,'cloud-release-v1','readiness-fixture'));
 for(const patch of [{GITHUB_ACTIONS:undefined},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_REF:'refs/heads/feature'},{RUNNER_TEMP:'relative'},{UNITY_EDITOR_PATH:path.resolve('C:/Program Files/Unity/Unity.exe')}])assert.throws(()=>readinessPaths({...env,...patch}),/Readiness/);
});
test('cloud verification cannot package the application or publish a release and keeps raw logs private',()=>{
 const source=fs.readFileSync(path.join(__dirname,'cloud-readiness.cjs'),'utf8');
 const workflow=fs.readFileSync(path.join(__dirname,'../../.github/workflows/cloud-readiness.yml'),'utf8');
 assert.doesNotMatch(source+workflow,/BuildWindowsClient|生成安装包\.ps1|electron-builder|gh release|self-hosted/);
 assert.match(source,/CLOUD_UNITY_READINESS_OK/);assert.match(source,/installerBuilt:false/);assert.match(source,/releasePublished:false/);
 assert.match(workflow,/GITHUB_REF -ne 'refs\/heads\/main'/);assert.match(workflow,/runs-on: windows-2022/);
 const upload=workflow.slice(workflow.indexOf('actions/upload-artifact'));
 assert.match(upload,/readiness\.json/);assert.doesNotMatch(upload,/\.log|\.ulf|UNITY_LICENSE/);
});

function executionFixture(t) {
 const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'cloud-readiness-test-'));
 const parent=path.resolve(os.tmpdir())+path.sep;
 assert.ok(path.resolve(tempRoot).startsWith(parent));
 t.after(()=>{
  const resolved=path.resolve(tempRoot);
  assert.ok(resolved.startsWith(parent)&&path.basename(resolved).startsWith('cloud-readiness-test-'));
  fs.rmSync(resolved,{recursive:true,force:true});
 });
 const localEnv={...env,RUNNER_TEMP:tempRoot,
  UNITY_EDITOR_PATH:path.join(tempRoot,'cloud-release-v1','unity','Editor','Unity.exe'),
  DESKTOP_MYSQL_RUNTIME_SOURCE:path.join(tempRoot,'cloud-release-v1','mysql','mysql-9.2.0-winx64'),
  GITHUB_STEP_SUMMARY:path.join(tempRoot,'summary.md')};
 const paths=readinessPaths(localEnv),calls=[];
 const execute=(file,args)=>{
  calls.push({file,args});
  if(file===paths.editor){
   const log=args[args.indexOf('-logFile')+1];
   fs.writeFileSync(log,'fixture-private-license-data\nCLOUD_UNITY_READINESS_OK\n');
   return {status:0,stdout:'',stderr:''};
  }
  return {status:0,stdout:'mysqld  Ver 9.2.0 for Win64 on x86_64',stderr:''};
 };
 return {localEnv,paths,calls,execute,resultFile:path.join(paths.root,'readiness.json')};
}
test('empty cloud fixture executes the exact editor and MySQL, recording only credential-free proof',t=>{
 const f=executionFixture(t),result=runReadiness(f.localEnv,f.execute);
 assert.deepEqual(result,{success:true,unityVersion:'2022.3.34f1c1',mysqlVersion:'9.2.0',licenseValidated:true,installerBuilt:false,releasePublished:false,fixtureOnly:true});
 assert.deepEqual(JSON.parse(fs.readFileSync(f.resultFile,'utf8')),result);
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].file,f.paths.editor);
 assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-projectPath')+1],f.paths.fixture);
 assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-executeMethod')+1],'CloudProbe.Run');
 assert.deepEqual(f.calls[1],{file:f.paths.mysql,args:['--no-defaults','--version']});
 assert.doesNotMatch(fs.readFileSync(f.resultFile,'utf8')+fs.readFileSync(f.localEnv.GITHUB_STEP_SUMMARY,'utf8'),/fixture-private-license-data|private-unity-check/);
 assert.match(fs.readFileSync(path.join(f.paths.fixture,'Assets','Editor','CloudProbe.cs'),'utf8'),/Application.unityVersion/);
});
test('Unity exit zero alone, missing marker/log, nonzero exit and timeout all fail closed',t=>{
 for(const scenario of ['no-marker','missing-log','nonzero','timeout']){
  const f=executionFixture(t);
  assert.throws(()=>runReadiness(f.localEnv,(file,args)=>{
   if(file!==f.paths.editor)throw Error('MySQL must not run after failed Unity verification');
   const log=args[args.indexOf('-logFile')+1];
   if(scenario!=='missing-log')fs.writeFileSync(log,scenario==='no-marker'?'fixture-private-license-data':'CLOUD_UNITY_READINESS_OK');
   return {status:scenario==='nonzero'?1:0,error:scenario==='timeout'?Error('fixture timeout'):undefined,stdout:'',stderr:''};
  }),/Cloud Unity authorization or empty-fixture execution failed/);
  assert.equal(fs.existsSync(f.resultFile),false);
 }
});
test('wrong MySQL version, nonzero exit or timeout cannot produce a successful readiness receipt',t=>{
 for(const scenario of ['wrong-version','nonzero','timeout']){
  const f=executionFixture(t);
  assert.throws(()=>runReadiness(f.localEnv,(file,args)=>file===f.paths.editor?f.execute(file,args):{
   status:scenario==='nonzero'?1:0,error:scenario==='timeout'?Error('fixture timeout'):undefined,
   stdout:'mysqld  Ver 8.0.0 for Win64 on x86_64',stderr:''
  }),/Cloud MySQL runtime version check failed/);
  assert.equal(fs.existsSync(f.resultFile),false);
 }
});
test('existing readiness fixture is never reused or overwritten',t=>{
 const f=executionFixture(t);fs.mkdirSync(f.paths.fixture,{recursive:true});
 const sentinel=path.join(f.paths.fixture,'keep.txt');fs.writeFileSync(sentinel,'existing fixture');
 assert.throws(()=>runReadiness(f.localEnv,()=>{throw Error('must not execute')}),/must be new and empty/);
 assert.equal(fs.readFileSync(sentinel,'utf8'),'existing fixture');
});
