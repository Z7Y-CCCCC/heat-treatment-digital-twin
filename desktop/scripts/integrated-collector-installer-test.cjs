'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),read=f=>fs.readFileSync(path.join(root,f),'utf8').replace(/\r\n/g,'\n');
test('offline selection is visible and existing collectors cannot silently retain old code',()=>{
 const ui=read('desktop/collector-installer.nsh'),hooks=read('desktop/display-installer.nsh');
 assert.match(hooks,/Page custom CollectorChoicePage CollectorChoiceLeave/);
 assert.match(hooks,/Call CollectorChoiceInit/);assert.match(ui,/NSD_CreateRadioButton.*仅展示/);assert.match(ui,/NSD_CreateRadioButton.*展示＋本机采集/);
 assert.match(ui,/collectorExisting == "1"[\s\S]*EnableWindow \$collectorDisplayRadio 0/);
 assert.match(ui,/WITHCOLLECTOR=/);assert.match(ui,/COLLECTOR_PAYLOAD_SHA256/);assert.match(ui,/COLLECTOR_BUILD_COMMIT/);
 const guard=hooks.split('!macro customCheckAppRunning')[1];assert.ok(guard.indexOf('Call InstallSelectedCollector')<guard.indexOf('display-install-preflight.ps1'));
 assert.match(ui,/\$collectorChoice != "1"[\s\S]*Return/);assert.match(ui,/\$0 != 0[\s\S]*!insertmacro DisplayAbort/);
 const common=read('desktop/display-installer-ui.nsh');assert.match(common,/!macro DisplayAbort TEXT[\s\S]*SetErrorLevel 2[\s\S]*Abort "\$displayFailure"/);
 assert.doesNotMatch(ui,/https?:|Download|Uninstall|Delete-Service/);
});
test('the verified collector ZIP is created before NSIS and the actual embedded bytes are checked',()=>{
 const build=read('生成安装包.ps1');assert.ok(build.indexOf('scripts/archive-collector-plugin.cjs')<build.indexOf('tools/package-installer.cjs'));
 assert.match(build,/\$effectiveCompressionLevel, \$pluginPath/);assert.match(build,/tools\/collector-installer-payload.cjs/);assert.match(build,/collectorInstaller =.*offline-selectable/);
 const helper=read('desktop/Install-CollectorPayload.ps1');assert.match(helper,/ExpectedSha256/);assert.match(helper,/manifest.buildSourceCommit -ne \$ExpectedCommit/);
 assert.match(helper,/SkipUserDataImport/);assert.doesNotMatch(helper,/Invoke-WebRequest|DownloadFile|ADMIN_API_TOKEN|MCP_API_TOKEN/);
 assert.match(helper,/ExternalAttributes/);assert.match(helper,/StartsWith\(\$stage/);
 assert.match(helper,/ProgramW6432/);assert.match(helper,/Assert-InstalledPayload/);assert.match(helper,/VerifyInstalledOnly/);
 assert.match(read('desktop/display-installer.nsh'),/Call VerifySelectedCollector/);
});
test('payload preparation refuses stale version/commit and binds a synthetic ZIP hash',t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'integrated-collector-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const input=path.join(tmp,'input');fs.mkdirSync(input);const commit='a'.repeat(40);
 fs.writeFileSync(path.join(input,'plugin-manifest.json'),JSON.stringify({product:'collector-plugin',version:'2.3.3',buildSourceCommit:commit,files:[]}));
 const archive=path.join(tmp,'collector.zip');execFileSync(require('7zip-bin').path7za,['a','-tzip',archive,'plugin-manifest.json'],{cwd:input,windowsHide:true,stdio:'ignore'});
 const {preparePayload}=require('../../tools/collector-installer-payload.cjs');
 assert.throws(()=>preparePayload(archive,tmp,{version:'2.3.2',commit}),/another version/);
 assert.throws(()=>preparePayload(archive,tmp,{version:'2.3.3',commit:'b'.repeat(40)}),/another version/);
 const result=preparePayload(archive,tmp,{version:'2.3.3',commit});assert.equal(result.proof.sha256,crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
 assert.match(fs.readFileSync(result.include,'utf8'),/COLLECTOR_BUILD_COMMIT/);
 if(process.platform==='win32') {
  const script=path.join(root,'desktop/Install-CollectorPayload.ps1');
  const invoke=extra=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ArchivePath',archive,'-ExpectedSha256',extra.sha||result.proof.sha256,'-ExpectedVersion','2.3.3','-ExpectedCommit',extra.commit||commit,'-VerifyOnly'],{windowsHide:true,encoding:'utf8'});
  const good=invoke({});assert.equal(good.status,0,good.stdout+good.stderr);assert.notEqual(invoke({sha:'0'.repeat(64)}).status,0);assert.notEqual(invoke({commit:'b'.repeat(40)}).status,0);
 }
});
test('Windows PowerShell parses the shipped payload installer and independent migration script', {skip:process.platform!=='win32'},()=>{
 for(const rel of ['desktop/Install-CollectorPayload.ps1','desktop/collector-plugin/Install-CollectorPlugin.ps1']){
  const f=path.join(root,rel).replace(/'/g,"''");const script=`$errors=$null;[Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$null,[ref]$errors)|Out-Null;if($errors){$errors|Out-String|Write-Output;exit 1}`;
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
 }
});
test('real NSIS compilation embeds exactly the version-bound ZIP, independently of display resources', {skip:process.platform!=='win32'},async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'collector-nsis-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const archive=path.join(tmp,'payload.zip'),commit='a'.repeat(40);
 fs.writeFileSync(path.join(tmp,'plugin-manifest.json'),JSON.stringify({product:'collector-plugin',version:'2.3.3',buildSourceCommit:commit,files:[]}));
 execFileSync(require('7zip-bin').path7za,['a','-tzip',archive,'plugin-manifest.json'],{cwd:tmp,windowsHide:true,stdio:'ignore'});
 const {preparePayload,verifyEmbeddedPayload}=require('../../tools/collector-installer-payload.cjs');const payload=preparePayload(archive,tmp,{version:'2.3.3',commit});
 const source=`Unicode true\nName "Collector compile fixture"\nOutFile "${path.join(tmp,'fixture.exe')}"\nRequestExecutionLevel user\n!include LogicLib.nsh\n!include FileFunc.nsh\n!include nsDialogs.nsh\n!macro DisplayStage TEXT\nDetailPrint "\u0024{TEXT}"\n!macroend\n!macro DisplayAbort TEXT\nSetErrorLevel 2\nAbort "\u0024{TEXT}"\n!macroend\nFunction DisplayCheckCancel\nFunctionEnd\n!macro DisplayLabel X Y W H TEXT COLOR\n\u0024{NSD_CreateLabel} \u0024{X} \u0024{Y} \u0024{W} \u0024{H} \u0024{TEXT}\nPop $0\n!macroend\n!include "${path.join(root,'desktop/collector-installer.nsh')}"\nFunction DisplayRefreshFonts\nFunctionEnd\nFunction DisplayShowClose\nFunctionEnd\nFunction DisplayPaintPrimary\nFunctionEnd\nSection\nCall CollectorChoiceInit\nCall CollectorChoicePage\nCall CollectorChoiceLeave\nCall InstallSelectedCollector\nCall VerifySelectedCollector\nSectionEnd\n`;
 const file=path.join(tmp,'fixture.nsi');fs.writeFileSync(file,source);
 const tool=await require('./nsis-toolchain.cjs').nsisToolchain();const compiled=spawnSync(tool.path,['/WX','/INPUTCHARSET','UTF8',file],{windowsHide:true,env:{...process.env,...tool.env,DIGITAL_TWIN_COLLECTOR_PAYLOAD_INCLUDE:payload.include},encoding:'utf8'});assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 assert.equal(verifyEmbeddedPayload(path.join(tmp,'fixture.exe'),archive,tmp).success,true);
});

test('the real shared app-running hook compiles in the uninstaller namespace without installing a collector', {skip:process.platform!=='win32'},async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'collector-uninstall-nsis-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const include=path.join(root,'desktop/node_modules/app-builder-lib/templates/nsis/include');
 const source=`Unicode true\nName "Uninstall hook compile fixture"\nOutFile "${path.join(tmp,'fixture.exe')}"\nRequestExecutionLevel user\n!define BUILD_UNINSTALLER\n!define PRODUCT_NAME "Fixture"\n!define VERSION "2.3.3"\n!include LogicLib.nsh\nVar PowerShellPath\n!macro IS_POWERSHELL_AVAILABLE\nStrCpy $PowerShellPath "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"\n!macroend\n!macro _CHECK_APP_RUNNING\nDetailPrint "Underlying app-running guard remains present"\n!macroend\n!addincludedir "${include}"\n!include "${path.join(root,'desktop/display-installer.nsh')}"\n!insertmacro MUI_LANGUAGE "English"\nSection\nSectionEnd\nSection "Uninstall"\n!insertmacro customCheckAppRunning\nSectionEnd\n`;
 const file=path.join(tmp,'fixture.nsi');fs.writeFileSync(file,source);
 const tool=await require('./nsis-toolchain.cjs').nsisToolchain();
 execFileSync(tool.path,['/INPUTCHARSET','UTF8',file],{windowsHide:true,env:{...process.env,...tool.env},stdio:'pipe'});
 assert.ok(fs.statSync(path.join(tmp,'fixture.exe')).size>0);
 const hook=read('desktop/display-installer.nsh').split('!macro customCheckAppRunning')[1].split('!macroend')[0];
 assert.match(hook,/!ifndef BUILD_UNINSTALLER[^!]*Call DisplayCheckCancel[\s\S]*Call InstallSelectedCollector[\s\S]*!endif/);
 assert.match(hook,/!insertmacro _CHECK_APP_RUNNING/);
});
