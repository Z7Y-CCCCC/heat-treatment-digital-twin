'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const {fixture,root}=require('./installer-test-fixtures.cjs');
const {sourceProof,buildInstallerNsExec,validateDll}=require('./build-installer-nsexec.cjs');

test('installer execution plugin is source-pinned and retains the original license',()=>{
  const hashes=sourceProof();assert.equal(Object.keys(hashes).length,6);
  assert.match(fs.readFileSync(path.join(root,'.gitattributes'),'utf8'),
    /desktop\/vendor\/nsis-nsexec\/\*\* text eol=lf/, 'pinned sources need identical checkout bytes on Windows and Linux');
  const preparation=fs.readFileSync(path.join(root,'desktop/scripts/create-installer-ui.cjs'),'utf8');
  const buildCall=preparation.indexOf('buildInstallerNsExec()');
  assert.ok(buildCall>=0&&buildCall<preparation.indexOf('process.env.NSIS_UI_SEED'),
    'cold packaging must prepare the plugin even when an external UI seed is supplied');
  const source=fs.readFileSync(path.join(root,'desktop/vendor/nsis-nsexec/nsexec.c'),'utf8');
  assert.match(source,/Local downstream of NSIS 3.12/);
  assert.match(source,/Permission is granted to anyone/);
  assert.match(source,/if \(cbSrc && pSrc != bufSrc\) MoveMemory\(bufSrc, pSrc, cbSrc\)/);
  assert.match(source,/utfSource < 0 && cbSrc < 4 && waitResult != WAIT_OBJECT_0/);
  assert.match(source,/Incomplete encoded character at EOF/);
  for(const rel of ['desktop/collector-installer.nsh','desktop/display-installer.nsh']){
    assert.match(fs.readFileSync(path.join(root,rel),'utf8'),/installer-exec\.nsh/);
  }
  for(const rel of ['desktop/collector-installer.nsh','desktop/display-installer.nsh','desktop/display-installer-ui.nsh','desktop/fast-program-directory.nsh']){
    const text=fs.readFileSync(path.join(root,rel),'utf8');
    assert.match(text,/InstallerExec::ExecTo/);
    assert.doesNotMatch(text,/nsExec::/,'our Unicode log boundaries must not silently use the legacy decoder');
  }
});

test('native installer plugin builds without a warm cache and reuses only source-matched, hash-verified x86 output',{
  skip:process.platform!=='win32',timeout:60000
},()=>{
  const first=buildInstallerNsExec({force:true}),second=buildInstallerNsExec();
  assert.equal(second.reused,true);
  assert.equal(first.sha256,second.sha256);
  assert.equal(validateDll(second.file),second.sha256);
});

async function runStreamFixture(t,{malformed=false,exitCode=37}={}){
  const f=fixture(t,'installer-unicode-pipe-');
  const expected='\uFEFF[fixture] Chinese stream\r\n警告：中文分片不能乱码。\r\nWarning: 保留警告内容 🧪\r\n错误：设备 PLC 配置未修改。\r\n结束。\r\n';
  const valid=Buffer.from(expected,'utf16le'),bytes=malformed?valid.subarray(0,valid.length-1):valid;
  // These odd writes cross BOM, UTF-16 code units and a surrogate pair. The
  // 150ms pauses exceed nsExec's polling period and force separate pipe reads.
  const child=[
    '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue"',
    "$bytes=[Convert]::FromBase64String('"+bytes.toString('base64')+"')",
    '$stream=[Console]::OpenStandardOutput();$offset=0;$parts=@(1,1,1,1,3,7,2,31,5,23)',
    'for($i=0;$offset -lt $bytes.Length;$i++){',
    ' $count=[Math]::Min($parts[$i % $parts.Length],$bytes.Length-$offset)',
    ' $stream.Write($bytes,$offset,$count);$stream.Flush();$offset+=$count;[Threading.Thread]::Sleep(150)',
    '}','exit '+exitCode
  ].join('\n');
  const command=Buffer.from(child,'utf16le').toString('base64');
  const output=path.join(f.directory,'stdout.utf16'),status=path.join(f.directory,'status.txt'),exe=path.join(f.directory,'fixture.exe');
  const source=[
    'Unicode true','Name "Isolated Unicode execution fixture"','OutFile "'+exe+'"',
    'RequestExecutionLevel user','!include LogicLib.nsh',
    '!include "'+path.join(root,'desktop/installer-exec.nsh')+'"',
    'Section',
    'InstallerExec::ExecToStack /TIMEOUT=5000 \'"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand '+command+'\'',
    'Pop $0','Pop $1',
    'FileOpen $2 "'+output+'" w','FileWriteUTF16LE $2 "$1"','FileClose $2',
    'FileOpen $2 "'+status+'" w','FileWrite $2 "$0"','FileClose $2',
    '\u0024{If} $0 == "error"','SetErrorLevel 2','\u0024{Else}','SetErrorLevel $0','\u0024{EndIf}',
    'SectionEnd'
  ].join('\n');
  const file=path.join(f.directory,'fixture.nsi');fs.writeFileSync(file,source,'utf8');
  const tool=await require('./nsis-toolchain.cjs').nsisToolchain();
  execFileSync(tool.path,['/WX','/INPUTCHARSET','UTF8',file],{windowsHide:true,env:{...process.env,...tool.env},stdio:'pipe'});
  const result=spawnSync(exe,['/S'],{windowsHide:true,timeout:15000});
  return {exitCode:result.status,status:fs.readFileSync(status,'utf8'),text:fs.readFileSync(output).toString('utf16le'),expected,error:result.error};
}

test('actual NSIS execution recovers exact Chinese/emoji/warning/error text from odd UTF-16 pipe fragments',{
  skip:process.platform!=='win32',timeout:30000
},async t=>{
  const result=await runStreamFixture(t);
  assert.equal(result.exitCode,37,result.error?.message);
  assert.equal(result.status,'37','the real child error code is retained');
  assert.equal(result.text,result.expected,'no missing, duplicated, byte-swapped or stray characters');
});

test('actual NSIS execution fails an incomplete final UTF-16 character instead of concealing corrupted output',{
  skip:process.platform!=='win32',timeout:30000
},async t=>{
  const result=await runStreamFixture(t,{malformed:true,exitCode:0});
  assert.equal(result.exitCode,2,result.error?.message);
  assert.equal(result.status,'error');
});
