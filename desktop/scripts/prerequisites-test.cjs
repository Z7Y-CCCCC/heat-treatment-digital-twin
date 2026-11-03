'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ensurePrerequisites,evaluatePrerequisites,runPrerequisiteCheck,LINKS}=require('../prerequisites.cjs');
const {execFileSync}=require('node:child_process');
const ready={supported:true,build:19045,architecture:'AMD64',webView2:{ready:true,version:'120.0'},vcRedist:{ready:true,version:'14.40'}};
test('supported environment does not ask to install anything or contact a download site',async()=>{
    const result=await ensurePrerequisites({run:async()=>ready,dialog:{showMessageBox(){throw Error('unexpected prompt')}},shell:{openExternal(){throw Error('unexpected network')}}});assert.equal(result,ready);
});
test('missing runtimes are listed, installed only with consent, then rechecked',async()=>{
    let calls=0,opened=0;
    const run=async(_script,_root,action)=>++calls===1?{...ready,webView2:{ready:false},vcRedist:{ready:false}}:(assert.equal(action,'Install'),ready);
    await ensurePrerequisites({run,dialog:{showMessageBox:async options=>(assert.match(options.detail,/WebView2/),{response:0})},shell:{openExternal(){opened++}}});assert.equal(calls,2);assert.equal(opened,0);
});
test('cancel/download choices never execute an installer or clear application data',async()=>{
    for(const response of [1,2]){let installed=0,url;
        await assert.rejects(ensurePrerequisites({run:async(_s,_r,action)=>{if(action)installed++;return {...ready,webView2:{ready:false}}},dialog:{showMessageBox:async()=>({response})},shell:{openExternal:async value=>{url=value}}}),/尚未准备/);
        assert.equal(installed,0);assert.equal(url,response===1?LINKS.WebView2:undefined);
    }
});
test('an unsupported OS/architecture fails before database or renderer initialization',async()=>{
    assert.equal(evaluatePrerequisites({supported:false}).supported,false);
    await assert.rejects(ensurePrerequisites({run:async()=>({supported:false}),dialog:{showMessageBox(){throw Error('no install')}}}),/x64/);
});
test('the product baseline distinguishes Win10 1809+, Win11, x86 and ARM64 instead of promising all Windows',()=>{
    for(const build of [17763,19045,22000,22631,26200])assert.equal(evaluatePrerequisites({...ready,build}).supported,true);
    for(const value of [{...ready,build:17134},{...ready,architecture:'ARM64'},{...ready,architecture:'x86'},{supported:true}])assert.equal(evaluatePrerequisites(value).supported,false);
});
test('reboot-required and failed repairs remain actionable, never automatically reboot',async()=>{
    for(const result of [{...ready,restartRequired:true},{...ready,webView2:{ready:false}}]){
        let n=0;await assert.rejects(ensurePrerequisites({run:async()=>++n===1?{...ready,webView2:{ready:false}}:result,dialog:{showMessageBox:async()=>({response:0})}}),/重启|未就绪/);
    }
});
test('real Windows inspection is read-only and works with a PowerShell 7 parent module path',{skip:process.platform!=='win32'},async()=>{
    const result=await runPrerequisiteCheck(path.resolve(__dirname,'../RuntimePrerequisites.ps1'),path.resolve(__dirname,'../resources/prerequisites'));
    assert.equal(typeof result.build,'number');assert.equal(result.success,true);assert.equal(typeof result.webView2.ready,'boolean');
});
test('the installed app ships offline dependencies and performs a preflight before database initialization',()=>{
    const pkg=require('../package.json');assert.ok(pkg.build.extraResources.some(r=>r.to==='prerequisites'));assert.ok(pkg.build.files.includes('prerequisites.cjs'));
    const source=fs.readFileSync(path.resolve(__dirname,'../main.cjs'),'utf8').split('async function launchApplication()')[1];
    assert.ok(source.indexOf('ensurePrerequisites')<source.indexOf('await initializeWritableData()'));
    const ps=fs.readFileSync(path.resolve(__dirname,'../RuntimePrerequisites.ps1'),'utf8');assert.match(ps,/Get-AuthenticodeSignature/);assert.match(ps,/Get-FileHash/);assert.doesNotMatch(ps,/Restart-Computer|shutdown\.exe/);
    assert.match(ps,/if\(\$ProvisionDisplayLinks\)\{Prepare-DisplayLinkDirectory\}/);
    assert.match(fs.readFileSync(path.resolve(__dirname,'../display-installer.nsh'),'utf8'),/-Action Install -ProvisionDisplayLinks/);
    assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname,'../prerequisites.cjs'),'utf8'),/ProvisionDisplayLinks/);
});
test('an unsigned dependency never executes, and display-link ACL grants only creator-owned children',{skip:process.platform!=='win32'},()=>{
    const directory=fs.mkdtempSync(path.resolve(__dirname,'../../output/prerequisite-policy-'));
    fs.writeFileSync(path.join(directory,'fake.exe'),'not executable, not signed');
    const proof=require('./file-digest.cjs').fileDigest(path.join(directory,'fake.exe'));
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({files:[{name:'fake.exe',...proof}]}));
    const source=fs.readFileSync(path.resolve(__dirname,'../RuntimePrerequisites.ps1'),'utf8').replace(/\r\n/g,'\n');
    const functions=source.slice(source.indexOf('function Install-VerifiedRuntime'),source.indexOf('\ntry {\n    $before=Inspect-Environment'));
    const script=`$env:PSModulePath=Join-Path $PSHOME 'Modules';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';$RuntimeRoot='${directory}';$env:ProgramData='${directory}';$called=0;${functions};function Start-Process{$script:called++;throw 'must not execute'};try{Install-VerifiedRuntime 'fixture' 'fake.exe' @()}catch{};if($called -ne 0){throw 'unsigned runtime executed'};function Set-Acl{param($LiteralPath,$AclObject);$script:acl=$AclObject};Prepare-DisplayLinkDirectory;$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);$user=$rules|Where-Object {$_.IdentityReference.Value -eq 'S-1-5-32-545'};if(($user.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Modify) -eq [Security.AccessControl.FileSystemRights]::Modify){throw 'users may change other users links'};[Console]::WriteLine('PASS_UNSIGNED_AND_ACL')`;
    const file=path.join(directory,'check.ps1');fs.writeFileSync(file,'\uFEFF'+script);
    const out=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.match(out,/PASS_UNSIGNED_AND_ACL/);
});
