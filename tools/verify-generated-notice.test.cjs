'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verifyGeneratedNotice}=require('./verify-generated-notice.cjs');
test('notice verification allows Git line ending conversion but rejects changed or missing license text',t=>{
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'notice-proof-'));
  t.after(()=>{const r=path.relative(os.tmpdir(),fixture);if(!r.startsWith('notice-proof-')||r.includes(path.sep))throw Error('Unsafe cleanup');fs.rmSync(fixture,{recursive:true,force:true});});
  const source=path.join(fixture,'source'),payload=path.join(fixture,'payload');fs.mkdirSync(path.join(source,'desktop'),{recursive:true});fs.mkdirSync(path.join(payload,'resources'),{recursive:true});
  const original=path.join(source,'desktop/THIRD_PARTY_NOTICES.txt'),installed=path.join(payload,'resources/THIRD_PARTY_NOTICES.txt');
  fs.writeFileSync(original,'license A\r\nlicense B\r\n');fs.writeFileSync(installed,'license A\nlicense B\n');assert.equal(verifyGeneratedNotice(source,payload).success,true);
  fs.writeFileSync(original,'license A\r\n');assert.throws(()=>verifyGeneratedNotice(source,payload),/notice differs/);
  fs.unlinkSync(installed);assert.throws(()=>verifyGeneratedNotice(source,payload),/ENOENT/);
});
