'use strict';
const { test }=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const { spawnSync }=require('node:child_process');
const tar=require('tar');
const { fixture,root }=require('./installer-test-fixtures.cjs');
const { dependencyRuntimePlan,runtimeFile,POLICY_VERSION }=require('./dependency-runtime-policy.cjs');
function put(source,name,value='fixture'){const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
test('runtime pruning keeps licenses, binary/config/certificate assets and explicit runtime exports, not TypeScript declarations',t=>{
    const f=fixture(t),source=path.join(f.directory,'modules');
    put(source,'example/package.json',JSON.stringify({main:'entry.ts',bin:{tool:'bin/tool.cts'},exports:{'./other':{types:'./other.d.ts',default:'./runtime/*.ts'}}}));
    for(const name of ['entry.ts','bin/tool.cts','runtime/used.ts','other.d.ts','README.md','debug.js.map','unreferenced.ts','LICENSE.md','COPYING.markdown','NOTICE','NOTICE.md','ThirdPartyNotices.md','code.js','tls/certificate.pem','config.json','native.node','ca.der'])put(source,'example/'+name);
    const plan=dependencyRuntimePlan(source);assert.equal(plan.policy,POLICY_VERSION);
    for(const name of ['entry.ts','bin/tool.cts','runtime/used.ts','LICENSE.md','COPYING.markdown','NOTICE','code.js','tls/certificate.pem','config.json','native.node','ca.der'])assert.ok(plan.files.includes('example/'+name),name);
    for(const name of ['other.d.ts','README.md','debug.js.map','unreferenced.ts'])assert.equal(plan.files.includes('example/'+name),false,name);
    assert.equal(plan.filter('./example/runtime'),true);assert.equal(plan.filter('./example/other.d.ts'),false);
    assert.equal(runtimeFile('LICENSE.md'),true);assert.equal(runtimeFile('foo.mjs'),true);
});
test('filtered dependency tar is deterministic across checkout mtimes and contains only the runtime plan',async t=>{
    const f=fixture(t),source=path.join(f.directory,'modules');
    put(source,'pkg/package.json','{"main":"index.js"}');put(source,'pkg/index.js','module.exports=1');put(source,'pkg/types.d.ts');put(source,'pkg/LICENSE.md');
    const plan=dependencyRuntimePlan(source),a=path.join(f.directory,'a.tar'),b=path.join(f.directory,'b.tar');
    const build=file=>tar.c({file,cwd:source,portable:true,mtime:new Date(0),jobs:32,filter:plan.filter},['.']);
    await build(a);fs.utimesSync(path.join(source,'pkg/index.js'),new Date(),new Date());await build(b);
    assert.deepEqual(fs.readFileSync(a),fs.readFileSync(b));
    const names=[];await tar.t({file:a,onReadEntry:entry=>names.push(entry.path)});
    assert.ok(names.some(name=>name.endsWith('LICENSE.md')));assert.equal(names.some(name=>name.endsWith('types.d.ts')),false);
});
test('all installed production dependencies still load from a pruned, isolated tar without opening network connections', {timeout:240000},async t=>{
    const f=fixture(t,'runtime-prune-load-'),source=path.join(root,'backend/node_modules'),plan=dependencyRuntimePlan(source);
    const archive=path.join(f.directory,'runtime-test.tar'),modules=path.join(f.directory,'node_modules');fs.mkdirSync(modules);
    const before=Date.now();await tar.c({file:archive,cwd:source,portable:true,mtime:new Date(0),jobs:32,filter:plan.filter},['.']);
    const packedMs=Date.now()-before,extractStart=Date.now();await tar.x({file:archive,cwd:modules,strict:true});
    const extractMs=Date.now()-extractStart;
    const names=Object.keys(JSON.parse(fs.readFileSync(path.join(root,'backend/package.json'))).dependencies);
    const script=path.join(f.directory,'load.cjs');
    fs.writeFileSync(script,[
        'const fs=require("node:fs"),path=require("node:path");',
        'require("node:net").Socket.prototype.connect=function(){throw Error("No network in dependency load tests")};',
        'require("node:tls").connect=function(){throw Error("No TLS in dependency load tests")};',
        'const names='+JSON.stringify(names)+';',
        '(async()=>{const loaded=[];for(const name of names){const specifier=name==="read-excel-file"?"read-excel-file/node":name; const resolved=require.resolve(specifier);if(!resolved.startsWith('+JSON.stringify(modules+path.sep)+'))throw Error("Dependency borrowed outside fixture: "+resolved);',
        'try{require(specifier)}catch(error){if(error.code!=="ERR_REQUIRE_ESM")throw error;await import(specifier)}loaded.push(name);}',
        'const Database=require("better-sqlite3"),db=new Database(":memory:");if(db.prepare("SELECT 7 AS value").get().value!==7)throw Error("Native sqlite runtime failed");db.close();',
        'console.log(JSON.stringify({loaded,nativeSqlite:true}));})().catch(error=>{console.error(error);process.exitCode=1;});'
    ].join('\n'));
    const child=spawnSync(process.execPath,[script],{cwd:f.directory,windowsHide:true,encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024,env:{...process.env,NODE_PATH:'',PROGRAMDATA:f.programData}});
    assert.equal(child.status,0,child.stdout+child.stderr);
    const result=JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));assert.deepEqual(result.loaded,names);assert.equal(result.nativeSqlite,true);
    assert.ok(plan.retainedFiles<plan.sourceFiles);assert.equal(fs.existsSync(path.join(modules,'better-sqlite3/LICENSE')),true);
    t.diagnostic(JSON.stringify({sourceFiles:plan.sourceFiles,retainedFiles:plan.retainedFiles,omittedFiles:plan.omittedFiles,productionModules:names.length,packedMs,extractMs,testOnly:true}));
});
