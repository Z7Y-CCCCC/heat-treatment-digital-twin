'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { COLLECTOR_FILES } = require('./prepare-display-distribution.cjs');
const { RESOURCE_NAMES, prepareCollectorPlugin } = require('./prepare-collector-plugin.cjs');
const { collectorAvailable } = require('../../backend/services/runtimeEngine');
const root = path.resolve(__dirname, '../..');
test('main installer excludes the collector implementation, binaries and service registration', () => {
    const build = require('../package.json').build;
    const backend = build.extraResources.find(r => r.to === 'backend');
    for (const name of COLLECTOR_FILES) assert.ok(backend.filter.includes(`!services/${name}`));
    for (const name of ['collector-center','collector-service']) assert.ok(!build.extraResources.some(r => r.to === name));
    assert.ok(!build.extraFiles.some(r => r.to === '安装采集服务.ps1'));
    assert.equal(build.nsis.include, 'display-installer.nsh');
    assert.equal(require('../assets/display-distribution.json').collector, false);
    const guard = fs.readFileSync(path.join(root,'desktop','display-install-preflight.ps1'),'utf8');
    assert.doesNotMatch(guard, /Stop-Service|Start-Service|New-Service|sc\.exe/);
});
test('capability is fail-closed even if stale driver files remain or environment claims collector', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'display-capability-'));
    t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
    fs.mkdirSync(path.join(directory,'services'));
    for (const name of COLLECTOR_FILES) fs.writeFileSync(path.join(directory,'services',name),'');
    fs.writeFileSync(path.join(directory,'distribution.json'),'{"collector":false}');
    assert.equal(collectorAvailable(path.join(directory,'services')),false);
    fs.writeFileSync(path.join(directory,'distribution.json'),'{"collector":true}');
    assert.equal(collectorAvailable(path.join(directory,'services')),true);
    fs.unlinkSync(path.join(directory,'services','plcReader.js'));
    assert.throws(() => collectorAvailable(path.join(directory,'services')),/不完整/);
});
test('collector plugin gets an independent, complete resource tree without Unity or Electron', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'plugin-stage-'));
    t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
    const source = path.join(directory,'source'), display = path.join(directory,'display');
    for (const name of RESOURCE_NAMES) {
        const target = path.join(display,name);
        if (name.endsWith('.tar')) fs.writeFileSync(target,'dependencies fixture');
        else { fs.mkdirSync(target,{recursive:true}); fs.writeFileSync(path.join(target,'fixture.txt'),name); }
    }
    fs.mkdirSync(path.join(display,'prerequisites'));
    fs.writeFileSync(path.join(display,'prerequisites','RuntimePrerequisites.ps1'),'fixture');
    fs.writeFileSync(path.join(display,'prerequisites','vc_redist.x64.exe'),'fixture');
    fs.writeFileSync(path.join(display,'prerequisites','manifest.json'),JSON.stringify({files:[{name:'vc_redist.x64.exe'}]}));
    fs.mkdirSync(path.join(display,'backend','services'));
    fs.mkdirSync(path.join(display,'native-client')); fs.writeFileSync(path.join(display,'native-client','UnityPlayer.dll'),'must not copy');
    for (const name of ['collector-center','collector-service']) {
        const target=path.join(source,'desktop','.cache',name); fs.mkdirSync(target,{recursive:true}); fs.writeFileSync(path.join(target,'native.exe'),'fixture');
    }
    fs.mkdirSync(path.join(source,'backend','services'),{recursive:true});
    for (const name of COLLECTOR_FILES) fs.writeFileSync(path.join(source,'backend','services',name),name);
    fs.writeFileSync(path.join(source,'desktop','package.json'),'{"version":"2.3.2"}');
    for (const name of ['安装采集服务.ps1','采集运行中心.cmd','collector-operations.ps1']) fs.copyFileSync(path.join(root,'desktop',name),path.join(source,'desktop',name));
    fs.cpSync(path.join(root,'desktop','collector-plugin'),path.join(source,'desktop','collector-plugin'),{recursive:true});
    const target=prepareCollectorPlugin(display,path.join(directory,'plugin'),source);
    assert.equal(fs.existsSync(path.join(target,'resources','native-client')),false);
    assert.equal(fs.existsSync(path.join(target,'resources','frontend')),false,'Collector package must not include display/admin UI');
    assert.equal(collectorAvailable(path.join(target,'resources','backend','services')),true);
    const manifest=JSON.parse(fs.readFileSync(path.join(target,'plugin-manifest.json')));
    assert.ok(manifest.files.length>10); assert.ok(manifest.files.every(f => f.sha256.length===64 && !f.path.includes('..')));
    assert.throws(() => prepareCollectorPlugin(display,target,source),/must be new/);
});

test('the packaging-only ZIP step has its declared archiver and preserves Chinese file names', t => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'plugin-archive-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const source=path.join(directory,'source');fs.mkdirSync(source);
    fs.writeFileSync(path.join(source,'安装说明.txt'),'packaging fixture only');
    const {archivePlugin}=require('./archive-collector-plugin.cjs');
    const result=archivePlugin(source,path.join(directory,'plugin.zip'));
    assert.ok(result.size>0);assert.equal(result.sha256.length,64);
    const list=spawnSync(require('7zip-bin').path7za,['l','-sccUTF-8',path.join(directory,'plugin.zip')],{encoding:'utf8',windowsHide:true});
    assert.equal(list.status,0);assert.match(list.stdout,/安装说明\.txt/);
});
test('plugin installer PowerShell is valid in Windows PowerShell 5.1, not only PowerShell 7', {skip:process.platform!=='win32'}, () => {
    for (const file of ['collector-plugin/Install-CollectorPlugin.ps1','display-install-preflight.ps1']) {
        const filename=path.join(root,'desktop',file).replace(/'/g,"''");
        const script=`$e=$null;[Management.Automation.Language.Parser]::ParseFile('${filename}',[ref]$null,[ref]$e)|Out-Null;if($e){$e|Format-List;exit 1}`;
        const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});
        assert.equal(result.status,0,result.stdout+result.stderr);
    }
});
test('display upgrade guard blocks the legacy bundled service without stopping it', {skip:process.platform!=='win32'}, t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(),'display-upgrade-'));
    t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
    const file = path.join(root,'desktop','display-install-preflight.ps1');
    for (const [name,service,expected] of [['absent','$null',0],['separate',"[pscustomobject]@{PathName='C:\\Program Files\\HeatTreatmentCollectorPlugin\\service.exe'}",0],['legacy',"[pscustomobject]@{PathName='C:\\Display\\resources\\collector-service\\HeatTreatmentCollector.exe'}",1]]) {
        const script=`$env:ProgramData='${temp}';function Get-Process { return $null };function Get-CimInstance { return ${service} }; & '${file}' -InstallRoot 'C:\\Display'`;
        const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});
        assert.equal(result.status,expected,`${name}: ${result.stdout} ${result.stderr}`);
    }
});
