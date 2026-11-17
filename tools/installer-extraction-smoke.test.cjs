'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {verifyArchive,assertExtractionProof,extractStored7z,crc32}=require('./installer-extraction-smoke.cjs');
test('stored archive selection ignores ZIPs and false signatures, covers chunk boundaries and rejects ambiguity/truncation/CRC corruption',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'installer-span-test-'));
 t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
 assert.equal(crc32(Buffer.from('56789'),crc32(Buffer.from('1234'))),0xcbf43926);
 const input=path.join(root,'input');fs.mkdirSync(input);fs.writeFileSync(path.join(input,'file.txt'),'actual application bytes');
 const seven=require('../desktop/node_modules/7zip-bin').path7za,archive=path.join(root,'app.7z'),zip=path.join(root,'collector.zip');
 for(const [format,file] of [['7z',archive],['zip',zip]])execFileSync(seven,['a','-t'+format,file,'.'],{cwd:input,windowsHide:true,stdio:'pipe'});
 const bytes=fs.readFileSync(archive),prefix=Buffer.alloc(1024*1024-3,0x5a);fs.readFileSync(zip).copy(prefix,64);Buffer.from('377abcaf271c','hex').copy(prefix,512);
 const wrapper=path.join(root,'wrapper.exe');fs.writeFileSync(wrapper,Buffer.concat([prefix,bytes,Buffer.from('trailing bytes')]));
 const extracted=path.join(root,'extracted.7z');assert.deepEqual(extractStored7z(wrapper,extracted),{offset:prefix.length,size:bytes.length});assert.deepEqual(fs.readFileSync(extracted),bytes);
 for(const [name,data] of [['truncated',bytes.subarray(0,bytes.length-1)],['ambiguous',Buffer.concat([bytes,bytes])],['crc',Buffer.from(bytes)]]){
  if(name==='crc')data[data.length-1]^=1;
  const bad=path.join(root,name+'.exe');fs.writeFileSync(bad,data);assert.throws(()=>extractStored7z(bad,path.join(root,name+'.7z')),/exactly one bounded/);
 }
});
test('new releases require exact-EXE-bound native decoding, complete files and an isolated scope',()=>{
 const sha='a'.repeat(64),proof={status:'passed',sha256:sha,nativeNsisDecoder:true,installed:false,filesVerified:2,payloadSha256:'b'.repeat(64),treeSha256:'c'.repeat(64),decoderSha256:'d'.repeat(64)};
 const manifest={version:'2.3.4',sha256:sha,installerExtraction:proof};
 assert.doesNotThrow(()=>assertExtractionProof(manifest));
 for(const patch of [undefined,{...proof,status:'failed'},{...proof,sha256:'0'.repeat(64)},{...proof,installed:true},{...proof,nativeNsisDecoder:false},{...proof,filesVerified:0},{...proof,payloadSha256:'b'.repeat(65)}])assert.throws(()=>assertExtractionProof({...manifest,installerExtraction:patch}),/extraction proof/);
 assert.doesNotThrow(()=>assertExtractionProof({version:'2.3.3'}));
 for(const file of ['collect-release.cjs','verify-release.cjs'])assert.match(fs.readFileSync(path.join(__dirname,'ci',file),'utf8'),/assertExtractionProof\(manifest\)/);
});
test('actual NSIS decoder reproduces every Unicode/binary/empty-directory byte and rejects a missing expected file',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'installer-extraction-test-'));
 t.after(()=>{assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));assert.match(path.basename(root),/^installer-extraction-test-/);fs.rmSync(root,{recursive:true,force:true});});
 const input=path.join(root,'input');fs.mkdirSync(path.join(input,'空目录'),{recursive:true});
 fs.writeFileSync(path.join(input,'中文.txt'),'天津 🏭 runtime decoder fixture');fs.writeFileSync(path.join(input,'binary.exe'),Buffer.from([0,255,17,48]));
 const archive=path.join(root,'app.7z');execFileSync(require('../desktop/node_modules/7zip-bin').path7za,['a','-t7z','-mx=2',archive,'.'],{cwd:input,windowsHide:true,stdio:'pipe'});
 const stage=path.join(root,'positive');fs.mkdirSync(stage);
 const proof=await verifyArchive(archive,input,stage);assert.equal(proof.filesVerified,2);assert.equal(proof.installed,false);assert.equal(proof.nativeNsisDecoder,true);
 fs.writeFileSync(path.join(input,'must-not-be-silently-skipped.exe'),'expected');
 const negative=path.join(root,'negative');fs.mkdirSync(negative);
 await assert.rejects(verifyArchive(archive,input,negative),/omitted or corrupted/);
});
