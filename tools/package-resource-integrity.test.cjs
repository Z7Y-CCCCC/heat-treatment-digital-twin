'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {snapshotTree,verifyTree}=require('./package-resource-integrity.cjs');
test('bounded parallel hashing preserves deterministic tree order and catches modified/added files',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'resource-proof-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['a','b']){fs.mkdirSync(path.join(root,dir));for(let i=0;i<12;i++)fs.writeFileSync(path.join(root,dir,i+'.bin'),Buffer.alloc(200000,i));}
  const before=await snapshotTree(root),again=await snapshotTree(root);
  assert.deepEqual(again,before);assert.equal(before.sha256,crypto.createHash('sha256').update(JSON.stringify(before.entries)).digest('hex'));
  assert.equal((await verifyTree(root,before)).filesVerified,24);
  fs.writeFileSync(path.join(root,'a/0.bin'),'changed');await assert.rejects(verifyTree(root,before),/modified/);
  fs.writeFileSync(path.join(root,'a/0.bin'),Buffer.alloc(200000,0));fs.writeFileSync(path.join(root,'extra'),'added');await assert.rejects(verifyTree(root,before),/added extra/);
});
