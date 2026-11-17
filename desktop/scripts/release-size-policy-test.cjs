'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const {includeRuntimePath}=require('./prepare-mysql-runtime.cjs');
const {compressionOptions}=require('../../tools/package-installer.cjs');
test('minimal MySQL excludes only unused tokenizer dictionaries, not Unicode or engine support',()=>{
  const source=path.resolve(os.tmpdir(),'mysql-source');
  for(const name of ['lib/mecab','lib/mecab/dic/ipadic_utf-8/sys.dic','lib/mecab/dic/ipadic_sjis/sys.dic'])assert.equal(includeRuntimePath(source,path.join(source,name)),false,name);
  for(const name of ['share/charsets/Index.xml','share/charsets/utf8.xml','lib/plugin/authentication_fido_client.dll','lib/private/icuuc.dll','lib/plugin/ha_innodb.dll'])assert.equal(includeRuntimePath(source,path.join(source,name)),true,name);
});
test('production main container uses native 7z/BCJ2 and preserves every extracted byte',t=>{
  assert.equal(require('../package.json').build.nsis.useZip,false);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-7z-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('Unicode 天津 日本語 🏭 compression fixture\n'.repeat(1000));
  fs.writeFileSync(path.join(root,'input.txt'),bytes);
  const options=compressionOptions('3');
  assert.equal(options.env.ELECTRON_BUILDER_7Z_FILTER,'BCJ2');
  const module=require.resolve('../node_modules/app-builder-lib/out/targets/archive.js');
  const args=JSON.parse(execFileSync(process.execPath,['-e',`console.log(JSON.stringify(require(${JSON.stringify(module)}).compute7zCompressArgs('7z',{compression:'normal'})))`],{env:options.env,windowsHide:true,encoding:'utf8'}));
  const archive=path.join(root,'app.7z'),seven=require('7zip-bin').path7za;
  execFileSync(seven,[...args,archive,'input.txt'],{cwd:root,windowsHide:true,stdio:'pipe'});
  assert.deepEqual(execFileSync(seven,['x','-so',archive,'input.txt'],{windowsHide:true}),bytes);
  assert.equal(compressionOptions('0').env.ELECTRON_BUILDER_7Z_FILTER,undefined);
});
test('private MySQL port ranges reject invalid values before writing any fixture data',async()=>{
  const {MysqlRuntime}=require('../mysqlRuntime.cjs');
  for(const port of [0,1023,65487,'33107',NaN])await assert.rejects(new MysqlRuntime({preferredPort:port}).start(),/Invalid private MySQL preferred port/);
  assert.equal(compressionOptions('1').env.ELECTRON_BUILDER_7Z_FILTER,undefined,'low-cost default must not enable the slow BCJ2 profile');
});
