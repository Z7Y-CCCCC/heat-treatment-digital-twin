'use strict';
// Run the SAME x86 NSIS decoder used at install time, not just desktop 7-Zip.
// The fixture only extracts into its owned temp directory. No installer hooks,
// registry writes, services, application launch or elevation are permitted.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {fileDigest}=require('../desktop/scripts/file-digest.cjs');
const {snapshotTree}=require('./package-resource-integrity.cjs');
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
  const decoderSha256=await decodeArchive(archive,extracted,stage);
  const [expected,actual]=await Promise.all([snapshotTree(unpacked),snapshotTree(extracted)]);
  assert.deepEqual(actual.entries,expected.entries,'Native NSIS decoder omitted or corrupted application files');
  return {nativeNsisDecoder:true,installed:false,filesVerified:actual.entries.filter(e=>e.type==='file').length,
    payloadSha256:fileDigest(archive).sha256,treeSha256:actual.sha256,decoderSha256};
}
async function verifyInstallerExtraction(installer,unpacked,report) {
  const started=performance.now(),stage=fs.mkdtempSync(path.join(os.tmpdir(),'installer-extraction-'));
  const before=fileDigest(installer),evidence={success:false,sha256:before.sha256};
  try {
    const seven=await require('../desktop/node_modules/app-builder-lib/out/toolsets/7zip.js').getPath7za();
    execFileSync(seven,['x','-y',path.resolve(installer),'$PLUGINSDIR/app-64.7z','-o'+stage],{windowsHide:true,stdio:'pipe',timeout:120000});
    const embedded=path.join(stage,'$PLUGINSDIR/app-64.7z'),archive=path.join(stage,'app.7z');
    if(!fs.existsSync(embedded))throw Error('Final installer has no expected x64 application archive');
    fs.renameSync(embedded,archive);
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
if(require.main===module)verifyInstallerExtraction(...process.argv.slice(2)).then(p=>console.log(JSON.stringify(p))).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={verifyArchive,verifyInstallerExtraction,assertExtractionProof};
