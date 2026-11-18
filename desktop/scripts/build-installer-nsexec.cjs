'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const vendor=path.join(root,'desktop/vendor/nsis-nsexec');
const upstream='e3f60402bcdf7be822d159b531c6e38ddf32de12';
const files=['nsexec.c','pluginapi.c','nsis/pluginapi.h','nsis/nsis_tchar.h','nsis/api.h','COPYING'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function sourceProof(){
  const metadata=JSON.parse(fs.readFileSync(path.join(vendor,'provenance.json'),'utf8'));
  if(metadata.upstream.commit!==upstream || metadata.upstream.version!=='3.12')throw Error('Unexpected installer nsExec upstream');
  const actual={};
  for(const file of files){
    actual[file]=sha(fs.readFileSync(path.join(vendor,file)));
    if(metadata.sha256[file]!==actual[file])throw Error('Installer nsExec source/provenance mismatch: '+file);
  }
  return actual;
}
function validateDll(file){
  const b=fs.readFileSync(file),pe=b.readUInt32LE(0x3c);
  if(b.toString('ascii',0,2)!=='MZ'||b.toString('ascii',pe,pe+4)!=='PE\0\0'||b.readUInt16LE(pe+4)!==0x14c||!(b.readUInt16LE(pe+22)&0x2000)){
    throw Error('Expected an x86 Unicode installer execution plugin');
  }
  if(!b.includes(Buffer.from('ExecToLog\0'))||!b.includes(Buffer.from('ExecToStack\0')))throw Error('Missing installer execution exports');
  if(b.toString('ascii').toLowerCase().includes('vcruntime140.dll')||b.toString('ascii').toLowerCase().includes('msvcp140.dll'))throw Error('Installer plugin must not require an uninstalled VC runtime');
  return sha(b);
}
function buildInstallerNsExec({force=false}={}){
  if(process.platform!=='win32')throw Error('Build installer nsExec on Windows');
  const sources=sourceProof();
  const vswhere=path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft Visual Studio/Installer/vswhere.exe');
  const found=JSON.parse(execFileSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json'],{windowsHide:true,encoding:'utf8'}));
  if(found.length!==1)throw Error('The installer requires an unambiguous MSVC x86 toolchain');
  const vs=found[0],toolVersion=fs.readFileSync(path.join(vs.installationPath,'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'),'utf8').trim();
  const fingerprint=sha(JSON.stringify({sources,vs:vs.installationVersion,toolVersion,script:sha(fs.readFileSync(__filename))}));
  const output=path.join(root,'desktop/.cache/installer-nsexec'),target=path.join(output,'InstallerExec.dll'),record=path.join(output,'build.json');
  if(!force&&fs.existsSync(target)&&fs.existsSync(record)){
    try {const old=JSON.parse(fs.readFileSync(record,'utf8'));if(old.fingerprint===fingerprint&&old.sha256===validateDll(target))return {file:target,sha256:old.sha256,reused:true};} catch {}
  }
  const temporary=fs.realpathSync.native(os.tmpdir());
  const stage=fs.realpathSync.native(fs.mkdtempSync(path.join(temporary,'dt-installer-nsexec-')));
  if(!stage.startsWith(temporary+path.sep))throw Error('Unsafe installer compiler staging');
  try {
    for(const rel of files){const dest=path.join(stage,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(vendor,rel),dest);}
    const def=path.join(stage,'exports.def'),dll=path.join(stage,'InstallerExec.dll');
    fs.writeFileSync(def,'LIBRARY InstallerExec\nEXPORTS\n Exec\n ExecToLog\n ExecToStack\n','utf8');
    const quote=value=>{if(/["\r\n]/.test(value))throw Error('Unsafe compiler path');return '"'+value+'"';};
    const command=[
      '@echo off',
      'call '+quote(path.join(vs.installationPath,'VC/Auxiliary/Build/vcvars32.bat'))+' >nul',
      'if errorlevel 1 exit /b 1',
      'cl.exe /nologo /utf-8 /TC /LD /O2 /MT /DUNICODE /D_UNICODE /I'+quote(stage)+' /I'+quote(path.join(stage,'nsis'))+' nsexec.c pluginapi.c /link /DLL /MACHINE:X86 /DEF:'+quote(def)+' /OUT:'+quote(dll)+' advapi32.lib user32.lib kernel32.lib',
      'exit /b %errorlevel%',''
    ].join('\r\n');
    const script=path.join(stage,'build.cmd');fs.writeFileSync(script,command,'utf8');
    execFileSync(process.env.ComSpec||process.env.COMSPEC||'cmd.exe',['/d','/c',script],{cwd:stage,windowsHide:true,stdio:'pipe'});
    const digest=validateDll(dll);fs.mkdirSync(output,{recursive:true});fs.copyFileSync(dll,target);
    fs.writeFileSync(record,JSON.stringify({fingerprint,sha256:digest,sources,upstream,toolVersion},null,2)+'\n','utf8');
    return {file:target,sha256:digest,reused:false};
  } finally {
    const actual=fs.realpathSync.native(stage);
    if(actual!==stage||!actual.startsWith(temporary+path.sep)||!path.basename(actual).startsWith('dt-installer-nsexec-'))throw Error('Refusing unsafe installer compiler cleanup');
    fs.rmSync(actual,{recursive:true,force:true});
  }
}
if(require.main===module)console.log(JSON.stringify(buildInstallerNsExec()));
module.exports={buildInstallerNsExec,sourceProof,validateDll};
