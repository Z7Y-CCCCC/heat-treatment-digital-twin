'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {applyBuildVersion}=require('./set-build-version.cjs');
const commit='a'.repeat(40);
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-build-version-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^ci-build-version-/);fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'desktop'));fs.mkdirSync(path.join(root,'temp'));
 for(const [name,value]of Object.entries({'desktop/package.json':{version:'2.3.6'},'desktop/package-lock.json':{version:'2.3.6',packages:{'':{version:'2.3.6'},'node_modules/fixture':{version:'1.0.0'}}},'release-manifest.json':{productVersion:'2.3.6',dashboardSchemaVersion:3}}))fs.writeFileSync(path.join(root,name),JSON.stringify(value));
 const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_WORKSPACE:root,RUNNER_TEMP:path.join(root,'temp'),GITHUB_SHA:commit,RELEASE_VERSION:'2.3.7'};
 const git=args=>args[0]==='rev-parse'?commit+'\n':'';
 const bytes=()=>['desktop/package.json','desktop/package-lock.json','release-manifest.json'].map(name=>fs.readFileSync(path.join(root,name),'utf8'));
 return{root,env,git,bytes};
}
test('automatic version is injected only into the disposable build with unchanged dependency/schema data',t=>{
 const f=fixture(t),receipt=applyBuildVersion(f.root,f.env,f.git);
 assert.equal(receipt.sourceVersion,'2.3.6');assert.equal(receipt.version,'2.3.7');assert.equal(receipt.commit,commit);
 const [desktop,lock,manifest]=f.bytes().map(JSON.parse);
 assert.equal(desktop.version,'2.3.7');assert.equal(lock.version,'2.3.7');assert.equal(lock.packages[''].version,'2.3.7');assert.equal(manifest.productVersion,'2.3.7');
 assert.equal(lock.packages['node_modules/fixture'].version,'1.0.0');assert.equal(manifest.dashboardSchemaVersion,3);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.env.RUNNER_TEMP,'installer-build-version.json'))),receipt);
});
test('local workspace, self-hosted runner, dirty checkout and wrong source are rejected before writing',t=>{
 const f=fixture(t),originals=f.bytes();
 for(const patch of [{GITHUB_ACTIONS:undefined},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_WORKSPACE:path.dirname(f.root)},{RUNNER_TEMP:'relative'},{GITHUB_SHA:'b'.repeat(40)},{RELEASE_VERSION:'2.3.5'}])assert.throws(()=>applyBuildVersion(f.root,{...f.env,...patch},f.git),/disposable|commit|downgrade/);
 assert.throws(()=>applyBuildVersion(f.root,f.env,args=>args[0]==='rev-parse'?commit:' M desktop/package.json'),/clean/);
 assert.deepEqual(f.bytes(),originals);
});
test('inconsistent source lock/manifest versions fail without repairing or masking them',t=>{
 const f=fixture(t),file=path.join(f.root,'release-manifest.json');fs.writeFileSync(file,JSON.stringify({productVersion:'1.0.0'}));
 const originals=f.bytes();assert.throws(()=>applyBuildVersion(f.root,f.env,f.git),/inconsistent/);assert.deepEqual(f.bytes(),originals);
});
