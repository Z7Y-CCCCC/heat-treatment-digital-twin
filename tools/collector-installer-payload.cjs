'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {fileDigest}=require('../desktop/scripts/file-digest.cjs');
function preparePayload(archive, output, {version,commit}) {
  if(!/^\d+\.\d+\.\d+$/.test(version)||!/^[a-f0-9]{40}$/.test(commit))throw Error('A version and exact source commit are required');
  archive=path.resolve(archive);output=path.resolve(output);
  if(/["\r\n$]/.test(archive)||/["\r\n$]/.test(output))throw Error('Unsafe NSIS payload path');
  const bytes=execFileSync(require('../desktop/node_modules/7zip-bin').path7za,['x','-so',archive,'plugin-manifest.json'],{windowsHide:true,maxBuffer:8*1024*1024});
  const manifest=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  if(manifest.product!=='collector-plugin'||manifest.version!==version||manifest.buildSourceCommit!==commit)throw Error('Collector payload belongs to another version or source commit');
  const digest=fileDigest(archive),file=path.join(output,'collector-payload.nsh');
  fs.writeFileSync(file,`!define COLLECTOR_PAYLOAD_ZIP "${archive}"\n!define COLLECTOR_PAYLOAD_SHA256 "${digest.sha256}"\n!define COLLECTOR_BUILD_VERSION "${version}"\n!define COLLECTOR_BUILD_COMMIT "${commit}"\n`);
  const proof={version,commit,...digest,installerChoice:true,archive:path.basename(archive)};
  fs.writeFileSync(path.join(output,'collector-installer-proof.json'),JSON.stringify(proof,null,2));
  return {include:file,proof};
}
function verifyEmbeddedPayload(installer, archive, output) {
  const expected=fileDigest(archive),prefix=Buffer.alloc(Math.min(64,expected.size));
  const source=fs.openSync(archive,'r');try {fs.readSync(source,prefix,0,prefix.length,0);}finally{fs.closeSync(source);}
  const fd=fs.openSync(installer,'r'),buffer=Buffer.alloc(1024*1024);let offset=0,tail=Buffer.alloc(0),found=-1;
  try {
    for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,offset);if(!n)break;const chunk=Buffer.concat([tail,buffer.subarray(0,n)]),index=chunk.indexOf(prefix);if(index>=0){found=offset-tail.length+index;break;}tail=Buffer.from(chunk.subarray(Math.max(0,chunk.length-prefix.length+1)));offset+=n;}
    if(found<0||found+expected.size>fs.fstatSync(fd).size)throw Error('Installer is missing the verbatim collector payload');
    const hash=crypto.createHash('sha256');let position=found,remaining=expected.size;
    while(remaining){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,remaining),position);if(!n)throw Error('Truncated embedded collector payload');hash.update(buffer.subarray(0,n));position+=n;remaining-=n;}
    if(hash.digest('hex')!==expected.sha256)throw Error('Installer embedded another collector payload');
  }finally{fs.closeSync(fd);}
  const proof={success:true,offset:found,...expected};fs.writeFileSync(path.join(output,'embedded-collector-verification.json'),JSON.stringify(proof,null,2));return proof;
}
if(require.main===module)console.log(JSON.stringify(verifyEmbeddedPayload(...process.argv.slice(2))));
module.exports={preparePayload,verifyEmbeddedPayload};
