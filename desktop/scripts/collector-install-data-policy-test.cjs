'use strict';
const { test }=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const { fixture,quote,root }=require('./installer-test-fixtures.cjs');
const windows={skip:process.platform!=='win32'};
function resolve(f,requested,existing,newEmpty) {
    const machine=path.join(f.programData,'HeatTreatmentDigitalTwin');fs.mkdirSync(machine,{recursive:true});
    const r=f.runPowerShell(f.helper+'Initialize-InstallerOutput\n[Console]::WriteLine((Resolve-CollectorDataRoot '+quote(machine)+' '+quote(requested)+' '+quote(existing)+(newEmpty?' -NewEmptyData':'')+'))');
    assert.equal(r.status,0,r.text+r.errorText);return r.text.trim();
}
test('default upgrade keeps the existing data root, without reading/copying/deleting its business files',windows,t=>{
    const f=fixture(t),old=path.join(f.directory,'old-project');fs.mkdirSync(old);fs.writeFileSync(path.join(old,'factory.db'),'keep');
    const requested=path.join(f.directory,'different-root');assert.equal(resolve(f,requested,old,false),old);
    assert.equal(fs.readFileSync(path.join(old,'factory.db'),'utf8'),'keep');assert.equal(fs.existsSync(requested),false);
});
test('explicit empty installation selects a never-existing machine sibling and keeps the previous project unchanged',windows,t=>{
    const f=fixture(t),old=path.join(f.directory,'old-project');fs.mkdirSync(old);fs.writeFileSync(path.join(old,'plc.json'),'keep');
    const selected=resolve(f,old,old,true);
    assert.match(path.basename(selected),/^collector-empty-[a-f0-9]{32}$/);
    assert.equal(path.dirname(selected),path.join(f.programData,'HeatTreatmentDigitalTwin'));
    assert.equal(fs.existsSync(selected),false,'selection is pure, not a data reset');
    assert.equal(fs.readFileSync(path.join(old,'plc.json'),'utf8'),'keep');
});
test('fresh installation cannot silently restore orphaned data when no service configuration exists',windows,t=>{
    const f=fixture(t),orphan=path.join(f.programData,'HeatTreatmentDigitalTwin','collector');fs.mkdirSync(orphan,{recursive:true});fs.writeFileSync(path.join(orphan,'factory.db'),'keep');
    const selected=resolve(f,orphan,'',false);assert.notEqual(selected,orphan);assert.match(path.basename(selected),/^collector-empty-/);
    assert.equal(fs.readFileSync(path.join(orphan,'factory.db'),'utf8'),'keep');
});
test('a genuinely new first-install directory remains empty and is not initialized by the selection helper',windows,t=>{
    const f=fixture(t),requested=path.join(f.programData,'HeatTreatmentDigitalTwin','collector');
    assert.equal(resolve(f,requested,'',false),requested);assert.equal(fs.existsSync(requested),false);
});
test('standalone service CheckOnly preserves JSON, does not create data, and propagates the empty-v1 requirement',windows,t=>{
    const f=fixture(t),install=path.join(f.directory,'plugin');
    const files=['collector-service/HeatTreatmentCollector.exe','collector-service/worker.cjs','runtime/node.exe','backend/server.js','backend-dependencies.tar','templates/factory-template.db','mysql/bin/mysqld.exe'];
    for(const name of files){const file=path.join(install,'resources',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture; never executed');}
    const distribution=path.join(install,'resources/backend/distribution.json');fs.mkdirSync(path.dirname(distribution),{recursive:true});fs.writeFileSync(distribution,JSON.stringify({product:'collector-plugin',contentPolicy:'empty-v1'}));
    const machine=path.join(f.programData,'HeatTreatmentDigitalTwin');fs.mkdirSync(machine);const old=path.join(machine,'old-project');fs.mkdirSync(old);fs.writeFileSync(path.join(old,'factory.db'),'keep');
    fs.writeFileSync(path.join(machine,'collector-service.json'),JSON.stringify({root:old,port:3001}));
    const source='function Get-Service { return $null }\n& '+quote(path.join(root,'desktop/安装采集服务.ps1'))+' -InstallRoot '+quote(install)+' -CheckOnly -NewEmptyData\nexit $LASTEXITCODE';
    const r=f.runPowerShell(source);assert.equal(r.status,0,r.text+r.errorText);
    const result=JSON.parse(r.text.trim());assert.equal(result.resourcesReady,true);assert.match(path.basename(result.dataRoot),/^collector-empty-[a-f0-9]{32}$/);
    assert.equal(path.dirname(result.dataRoot),machine,'preflight must only inspect the fixture machine configuration');
    assert.equal(fs.existsSync(result.dataRoot),false);assert.equal(fs.readFileSync(path.join(old,'factory.db'),'utf8'),'keep');
    fs.writeFileSync(distribution,JSON.stringify({product:'collector-plugin',contentPolicy:'legacy-full'}));
    const rejected=f.runPowerShell(source);assert.notEqual(rejected.status,0,rejected.text+rejected.errorText);
    assert.equal(fs.readFileSync(path.join(old,'factory.db'),'utf8'),'keep');
});
test('installer makes the retain/new-empty choice explicit, keeps repair idempotent, and forwards it through every layer',()=>{
    const read=name=>fs.readFileSync(path.join(root,name),'utf8');
    const ui=read('desktop/collector-installer.nsh'),payload=read('desktop/Install-CollectorPayload.ps1'),plugin=read('desktop/collector-plugin/Install-CollectorPlugin.ps1'),service=read('desktop/安装采集服务.ps1');
    assert.match(ui,/NSD_CreateCheckbox.*新建空白现场/);assert.match(ui,/\/NEWEMPTY=/);assert.match(ui,/\/WITHCOLLECTOR=1/);
    assert.match(ui,/collectorNewEmptyApplied != "1"[\s\S]*StrCpy \$R3 "-NewEmptyData"/);
    assert.match(ui,/StrCpy \$collectorNewEmptyApplied "1"/);
    assert.match(ui,/Function CollectorDataChanged\s+Pop \$0\s+Call CollectorDataToggle/);
    assert.match(ui,/EnableWindow \$collectorEmptyCheckbox 0[\s\S]*NSD_Uncheck/);
    assert.match(payload,/\$installArguments.*UsePreparedPayload/);assert.match(payload,/\$NewEmptyData.*\$installArguments\+='-NewEmptyData'/);
    assert.match(plugin,/\[string\]\$ImportDataDirectory = ''/);assert.match(plugin,/\$ImportDataDirectory -and \(Test-Path/);
    assert.doesNotMatch(plugin,/ImportDataDirectory = \(Join-Path \$env:APPDATA/);
    assert.match(plugin,/\$NewEmptyData.*\$arguments\+='-NewEmptyData'/);
    assert.match(service,/Resolve-CollectorDataRoot.*-NewEmptyData:\$NewEmptyData/);
    assert.match(service,/empty-v1/);assert.doesNotMatch(service,/Remove-Item.*dataDirectory/);
});

test('prepared collector staging keeps a verified same-parent directory, but rejects data overlap and linked ancestors',windows,t=>{
    const f=fixture(t),parent=path.join(f.directory,'programs');fs.mkdirSync(parent);
    const source=path.join(parent,'HeatTreatmentCollectorPayload-'+ 'a'.repeat(32)),target=path.join(parent,'HeatTreatmentCollectorPlugin');fs.mkdirSync(source);
    const select=f.helper+'Initialize-InstallerOutput\n[Console]::WriteLine((Get-CollectorPayloadStage '+quote(source)+' '+quote(target)+' -UsePreparedPayload))';
    const good=f.runPowerShell(select);assert.equal(good.status,0,good.text+good.errorText);assert.equal(good.text.trim(),source);
    const machine=path.join(f.programData,'HeatTreatmentDigitalTwin');fs.mkdirSync(machine);
    for (const data of [target,path.join(target,'site-data'),parent,source,path.join(source,'site-data')]) {
        fs.writeFileSync(path.join(machine,'collector-service.json'),JSON.stringify({root:data}));
        const overlap=f.runPowerShell(select);assert.notEqual(overlap.status,0,overlap.text+overlap.errorText);assert.match(overlap.errorText,/程序目录与现场数据重叠/);assert.equal(fs.existsSync(source),true);
    }
    fs.unlinkSync(path.join(machine,'collector-service.json'));
    const alias=path.join(f.directory,'linked-programs');fs.symlinkSync(parent,alias,'junction');
    const linked=f.runPowerShell(f.helper+'Initialize-InstallerOutput\nGet-CollectorPayloadStage '+quote(path.join(alias,path.basename(source)))+' '+quote(path.join(alias,'HeatTreatmentCollectorPlugin'))+' -UsePreparedPayload');
    assert.notEqual(linked.status,0);assert.equal(fs.existsSync(source),true);
    fs.mkdirSync(path.join(parent,'.git'));
    const workspace=f.runPowerShell(select);assert.notEqual(workspace.status,0);assert.match(workspace.errorText,/源码工作区/);assert.equal(fs.existsSync(source),true);
});

test('standalone elevation forwards only explicit import paths, never an empty native argument, without launching a process',windows,t=>{
    const f=fixture(t),plugin=fs.readFileSync(path.join(root,'desktop/collector-plugin/Install-CollectorPlugin.ps1'),'utf8');
    const start=plugin.indexOf('$elevatedArguments=@('),end=plugin.indexOf('    $child = Start-Process',start);
    assert.ok(start>=0&&end>start);const assignment=plugin.slice(start,end);
    const imported=path.join(f.directory,'explicit old project');
    for(const scenario of [{imported:'',skip:false,empty:true,prepared:true},{imported:'',skip:true,empty:false,prepared:false},
        {imported,skip:false,empty:false,prepared:false},{imported,skip:false,empty:false,prepared:true,resume:true}]){
        const source=f.helper+'Initialize-InstallerOutput\n$InstallRoot='+quote(path.join(f.directory,'programs'))+
            '\n$ImportDataDirectory='+quote(scenario.imported)+'\n$SkipUserDataImport=$'+scenario.skip+
            '\n$NewEmptyData=$'+scenario.empty+'\n$UsePreparedPayload=$'+scenario.prepared+
            '\n$ResumeImportedData=$'+Boolean(scenario.resume)+'\n'+assignment+
            '\n[Console]::WriteLine((ConvertTo-Json -InputObject @($elevatedArguments) -Compress))';
        const result=f.runPowerShell(source);assert.equal(result.status,0,result.text+result.errorText);const args=JSON.parse(result.text.trim());
        assert.equal(args.includes('-ImportDataDirectory'),Boolean(scenario.imported&&!scenario.skip));
        assert.equal(args.includes('""'),false);assert.equal(args.includes('-SkipUserDataImport'),scenario.skip);
        assert.equal(args.includes('-NewEmptyData'),scenario.empty);assert.equal(args.includes('-UsePreparedPayload'),scenario.prepared);
        assert.equal(args.includes('-ResumeImportedData'),Boolean(scenario.resume));
        if(scenario.imported&&!scenario.skip)assert.equal(args[args.indexOf('-ImportDataDirectory')+1],'"'+scenario.imported+'"');
    }
});
