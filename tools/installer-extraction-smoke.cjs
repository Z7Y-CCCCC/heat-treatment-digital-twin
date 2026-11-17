'use strict';
// Run the SAME x86 NSIS decoder used at install time, not just desktop 7-Zip.
// The fixture only extracts into its owned temp directory. No installer hooks,
// registry writes, services, application launch or elevation are permitted.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {fileDigest}=require('../desktop/scripts/file-digest.cjs');
const {snapshotTree}=require('./package-resource-integrity.cjs');
// 7za is the reduced encoder bundle: it has no NSIS handler and can mistake
// the verbatim collector ZIP for the outer installer. Read the stored 7z span
// directly, validating BOTH header CRCs and bounds before native decoding.
// Format: https://github.com/ip7z/7zip/blob/main/DOC/7zFormat.txt
function crc32(bytes,seed=0) {
  let crc=(seed^0xffffffff)>>>0;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function extractStored7z(installer,destination) {
  const input=fs.openSync(installer,'r'),buffer=Buffer.alloc(1024*1024),signature=Buffer.from('377abcaf271c','hex');
  const length=fs.fstatSync(input).size,candidates=new Map();
  let offset=0,tail=Buffer.alloc(0);
  try {
    for(;;){
      const count=fs.readSync(input,buffer,0,buffer.length,offset);if(!count)break;
      const chunk=Buffer.concat([tail,buffer.subarray(0,count)]);let index=-1;
      while((index=chunk.indexOf(signature,index+1))>=0){
        const position=offset-tail.length+index,header=Buffer.alloc(32);
        if(fs.readSync(input,header,0,32,position)!==32||header[6]!==0||header[7]!==4||crc32(header.subarray(12))!==header.readUInt32LE(8))continue;
        const nextOffset=header.readBigUInt64LE(12),nextSize=header.readBigUInt64LE(20),size=32n+nextOffset+nextSize;
        if(nextSize===0n||nextSize>16n*1024n*1024n||size>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(position)+size>BigInt(length))continue;
        let remaining=Number(nextSize),readPosition=position+32+Number(nextOffset),digest=0;
        while(remaining){const n=fs.readSync(input,buffer,0,Math.min(buffer.length,remaining),readPosition);if(!n)throw Error('Truncated 7z next header');digest=crc32(buffer.subarray(0,n),digest);remaining-=n;readPosition+=n;}
        if(digest===header.readUInt32LE(28))candidates.set(position,{offset:position,size:Number(size)});
      }
      tail=Buffer.from(chunk.subarray(Math.max(0,chunk.length-31)));offset+=count;
    }
    if(candidates.size!==1)throw Error(`Expected exactly one bounded, CRC-valid stored application archive; found ${candidates.size}`);
    const found=[...candidates.values()][0],output=fs.openSync(destination,'wx');let remaining=found.size,position=found.offset;
    try {while(remaining){const n=fs.readSync(input,buffer,0,Math.min(buffer.length,remaining),position);if(!n)throw Error('Truncated application archive');let written=0;while(written<n){const count=fs.writeSync(output,buffer,written,n-written);if(!count)throw Error('Incomplete application archive write');written+=count;}remaining-=n;position+=n;}}
    finally {fs.closeSync(output);}
    return found;
  } finally {fs.closeSync(input);}
}
function assertExtractionProof(manifest) {
  if(!require('./installer-startup-smoke.cjs').requiresStartupProof(manifest.version))return;
  const proof=manifest.installerExtraction;
  if(!proof||proof.status!=='passed'||proof.sha256!==manifest.sha256||proof.nativeNsisDecoder!==true||proof.installed!==false||!Number.isInteger(proof.filesVerified)||proof.filesVerified<1||!/^[a-f0-9]{64}$/.test(proof.payloadSha256||'')||!/^[a-f0-9]{64}$/.test(proof.treeSha256||'')||!/^[a-f0-9]{64}$/.test(proof.decoderSha256||''))throw Error('Missing or invalid native installer extraction proof');
}
async function decodeArchive(archive,destination,stage) {
  const root=path.resolve(__dirname,'..'),config=require('../desktop/package.json').build;
  const tool=await require('../desktop/scripts/nsis-toolchain.cjs').nsisToolchain();
  const plugins=await require('../desktop/node_modules/app-builder-lib/out/toolsets/windows.js').getNsisPluginsPath(config.toolsets?.nsis,config.nsis?.customNsisResources);
  const decoder=path.join(plugins,'x86-unicode/nsis7z.dll');
  for(const file of [archive,destination,stage,plugins])if(/["\r\n$]/.test(file))throw Error('Unsafe NSIS extraction fixture path');
  const exe=path.join(stage,'DecoderFixture.exe'),script=path.join(stage,'decoder.nsi');
  const source=`Unicode true
Name "Isolated NSIS decoder verification"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
!addplugindir /x86-unicode "${path.join(plugins,'x86-unicode')}"
Section
SetOutPath "${destination}"
Nsis7z::Extract "${archive}"
SectionEnd
`;
  assert.doesNotMatch(source,/WriteReg|ExecShell|Start-Service|RunAs|customInstall/);
  fs.writeFileSync(script,source);
  execFileSync(tool.path,['/INPUTCHARSET','UTF8',script],{windowsHide:true,env:{...process.env,...tool.env},stdio:'pipe',timeout:60000});
  execFileSync(exe,[],{windowsHide:true,stdio:'pipe',timeout:300000});
  return fileDigest(decoder).sha256;
}
async function verifyArchive(archive,unpacked,stage) {
  const extracted=path.join(stage,'decoded');
  // Tool resolvers write raw pretty-log bytes, which can corrupt Node 22's
  // Windows test IPC frames. Capture them in a normal child, not the reporter.
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const output=execFileSync(process.execPath,[__filename,'--decode',archive,extracted,stage],{windowsHide:true,env,stdio:'pipe',encoding:'utf8',timeout:420000});
  const decoded=/^NSIS_DECODER_SHA256=([a-f0-9]{64})$/m.exec(output);
  if(!decoded)throw Error('Native decoder did not report its verified identity');
  const decoderSha256=decoded[1];
  const [expected,actual]=await Promise.all([snapshotTree(unpacked),snapshotTree(extracted)]);
  assert.deepEqual(actual.entries,expected.entries,'Native NSIS decoder omitted or corrupted application files');
  return {nativeNsisDecoder:true,installed:false,filesVerified:actual.entries.filter(e=>e.type==='file').length,
    payloadSha256:fileDigest(archive).sha256,treeSha256:actual.sha256,decoderSha256};
}
async function verifyInstallerExtraction(installer,unpacked,report) {
  const started=performance.now(),stage=fs.mkdtempSync(path.join(os.tmpdir(),'installer-extraction-'));
  const before=fileDigest(installer),evidence={success:false,sha256:before.sha256};
  try {
    const archive=path.join(stage,'app.7z');
    evidence.archiveSpan=extractStored7z(installer,archive);
    Object.assign(evidence,await verifyArchive(archive,unpacked,stage));
    assert.deepEqual(fileDigest(installer),before,'Installer changed during extraction verification');
    evidence.success=true;
    return evidence;
  } catch(error) {evidence.error=error.message;throw error;}
  finally {
    evidence.seconds=+((performance.now()-started)/1000).toFixed(3);
    fs.writeFileSync(report,JSON.stringify(evidence,null,2),{flag:'wx'});
    const relative=path.relative(fs.realpathSync(os.tmpdir()),path.resolve(stage));
    if(!/^installer-extraction-[^\\/]+$/.test(relative))throw Error('Unsafe decoder fixture cleanup');
    fs.rmSync(stage,{recursive:true,force:true});
  }
}
if(require.main===module){
  const operation=process.argv[2]==='--decode'
    ? decodeArchive(...process.argv.slice(3)).then(sha=>console.log('NSIS_DECODER_SHA256='+sha))
    : verifyInstallerExtraction(...process.argv.slice(2)).then(p=>console.log(JSON.stringify(p)));
  operation.catch(e=>{console.error(e.stack);process.exitCode=1;});
}
module.exports={verifyArchive,verifyInstallerExtraction,assertExtractionProof,extractStored7z,crc32};
