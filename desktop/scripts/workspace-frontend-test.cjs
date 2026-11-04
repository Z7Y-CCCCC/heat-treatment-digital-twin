'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createRunDirectory}=require('../../backend/scripts/integration-test-utils.cjs');
const {ensureWorkspaceFrontend,inputFingerprint}=require('./ensure-workspace-frontend.cjs');
function fixture(){
    const root=createRunDirectory('workspace-frontend'),frontend=path.join(root,'frontend'),cacheFile=path.join(root,'cache/proof.json');
    const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
    write('frontend/src/main.js','source');write('frontend/package-lock.json','lock');write('shared/bindings.mjs','shared');write('frontend/public/logo.svg','logo');
    let builds=0;
    const build=async()=>{builds++;write('frontend/dist/index.html','entry');write('frontend/dist/assets/main.js','main');write('frontend/dist/assets/lazy.js','lazy');
        write('frontend/dist/logo.svg',fs.readFileSync(path.join(frontend,'public/logo.svg')));
        write('frontend/dist/.vite/manifest.json',JSON.stringify({entry:{file:'assets/main.js'},lazy:{file:'assets/lazy.js'}}));};
    const run=options=>ensureWorkspaceFrontend(frontend,{cacheFile,build,env:{},...options});
    return {root,frontend,cacheFile,write,build,run,get builds(){return builds;}};
}
test('unchanged source reuses only a fully verified build; missing lazy chunks rebuild',async()=>{
    const f=fixture();assert.equal((await f.run()).reused,false);assert.equal((await f.run()).reused,true);assert.equal(f.builds,1);
    fs.unlinkSync(path.join(f.frontend,'dist/assets/lazy.js'));assert.equal((await f.run()).reused,false);assert.equal(f.builds,2);
});
for(const [name,file]of[['source','frontend/src/main.js'],['shared binding','shared/bindings.mjs'],['public asset','frontend/public/logo.svg'],['dependency lock','frontend/package-lock.json']]){
    test(name+' changes invalidate without relying on timestamps',async()=>{
        const f=fixture();await f.run();const target=path.join(f.root,file),stat=fs.statSync(target);f.write(file,'changed');fs.utimesSync(target,stat.atime,stat.mtime);
        assert.equal((await f.run()).reused,false);assert.equal(f.builds,2);
    });
}
test('Vite environment changes rebuild; unrelated desktop settings do not',async()=>{
    const f=fixture();await f.run({env:{VITE_API_URL:'A'}});assert.equal((await f.run({env:{VITE_API_URL:'B'}})).reused,false);
    assert.equal((await f.run({env:{VITE_API_URL:'B',UNRELATED:'x'}})).reused,true);
});
test('corrupt output or cache rebuilds; failed builds never get a reusable success marker',async()=>{
    const f=fixture();await f.run();f.write('frontend/dist/assets/main.js','corrupt');assert.equal((await f.run()).reused,false);
    fs.writeFileSync(f.cacheFile,'invalid');assert.equal((await f.run()).reused,false);
    f.write('frontend/src/main.js','new');await assert.rejects(f.run({build:async()=>{throw Error('build failed');}}),/build failed/);
    assert.equal((await f.run()).reused,false);
});
test('source changes during build fail closed rather than marking a stale interface current',async()=>{
    const f=fixture();await assert.rejects(f.run({build:async()=>{await f.build();f.write('shared/bindings.mjs','mid-build edit');}}),/源码发生变化/);
    assert.equal(fs.existsSync(f.cacheFile),false);assert.equal((await f.run()).reused,false);
});
test('concurrent launches share one build and do not delete chunks held by existing WebViews',async()=>{
    const f=fixture();f.write('frontend/dist/assets/old-session.js','retained');
    await Promise.all([f.run(),f.run()]);assert.equal(f.builds,1);assert.equal(fs.existsSync(path.join(f.frontend,'dist/assets/old-session.js')),true);
    assert.equal((await f.run({force:true})).reused,false);
});
test('cache cannot validate output paths outside dist',async()=>{
    const f=fixture();await f.run();const value=JSON.parse(fs.readFileSync(f.cacheFile));value.outputs[0].name='../outside';fs.writeFileSync(f.cacheFile,JSON.stringify(value));
    assert.equal((await f.run()).reused,false);
    assert.equal(inputFingerprint(f.frontend,{}).length,64);
});
