'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { fixture, quote, root } = require('./installer-test-fixtures.cjs');
const { programManifest, createInstallerIoPolicy, validateStockInstallerTemplates } = require('./installer-io-policy.cjs');
const windows = { skip: process.platform !== 'win32' };
function payload(directory, stamp = 'version-one') {
    const files = ['Display.exe','resources/runtime/node.exe','resources/backend/server.js','resources/backend/distribution.json',
        'resources/backend/defaults/factory-dashboard.v1.json','resources/shared/motionPackages.json','resources/templates/factory-template.db'];
    for (const file of files) {
        const target = path.join(directory,file); fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.writeFileSync(target, file === 'resources/backend/server.js' ? stamp : 'fixture only: ' + file);
    }
    fs.mkdirSync(path.join(directory,'resources/empty-folder'));
    const binary = path.join(directory,'resources/large-runtime.bin'); fs.writeFileSync(binary,Buffer.alloc(2*1024*1024,42));
    return programManifest(directory);
}
function writeManifest(f, value) {
    const file = path.join(f.directory,'manifest-'+crypto.randomBytes(4).toString('hex')+'.json');
    const contents=JSON.stringify(value);fs.writeFileSync(file,contents);
    return { file, hash:crypto.createHash('sha256').update(contents).digest('hex') };
}
function command(action,target,manifest,prepared) {
    return '& '+quote(path.join(root,'desktop/program-directory.ps1'))+' -Action '+action+' -InstallRoot '+quote(target)+
        ' -ManifestFile '+quote(manifest.file)+' -ManifestSha256 '+quote(manifest.hash)+' -UninstallerFilename "Uninstall Fixture.exe"'+
        (prepared ? ' -PreparedRoot '+quote(prepared) : '');
}
function run(f,action,target,manifest,prepared) { return f.runPowerShell(command(action,target,manifest,prepared)+'\nexit $LASTEXITCODE'); }
function passed(r) { assert.equal(r.status,0,r.text+r.errorText); }

test('manifest includes every file and empty directory, hashes configurations, and refuses missing required files', t => {
    const f=fixture(t), target=path.join(f.directory,'payload'), manifest=payload(target);
    assert.ok(manifest.directories.includes('resources/empty-folder'));
    assert.ok(manifest.entries.find(e=>e.path==='resources/backend/distribution.json').sha256);
    assert.equal(manifest.entries.find(e=>e.path==='resources/large-runtime.bin').sha256,undefined);
    fs.unlinkSync(path.join(target,'resources/templates/factory-template.db'));
    assert.throws(()=>programManifest(target),/Missing verified program file/);
});

test('I/O policy uses stock main/uninstaller signing and size gates, with post-include macro overrides only', async t => {
    const f=fixture(t), target=path.join(f.directory,'payload'); payload(target);
    const policy=createInstallerIoPolicy(root,target,path.join(f.directory,'generated'));
    const include=fs.readFileSync(policy.include,'utf8'), contents=fs.readFileSync(policy.manifest);
    assert.match(include,/FAST_PROGRAM_MANIFEST_SHA256/);
    assert.ok(include.includes(crypto.createHash('sha256').update(contents).digest('hex')));
    assert.equal(include.split(/\r?\n/).filter(line=>line.startsWith('!define')).length,5);
    assert.throws(()=>createInstallerIoPolicy(root,target,path.join(f.directory,'generated')),/EEXIST/);
    const packageSource=fs.readFileSync(path.join(root,'tools/package-installer.cjs'),'utf8');
    assert.match(packageSource,/DIGITAL_TWIN_INSTALLER_IO_INCLUDE = io.include/);
    assert.doesNotMatch(packageSource,/--config\.nsis\.script/);
    assert.match(packageSource,/installer-extraction-smoke\.cjs/);
    const hooks=fs.readFileSync(path.join(root,'desktop/display-installer.nsh'),'utf8');
    const remove=hooks.split('!macro customRemoveFiles')[1].split('!macroend')[0];
    assert.ok(remove.indexOf('${LogSet} off') < remove.indexOf('SetOutPath $TEMP'), 'logging must be closed before leaving INSTDIR for directory removal');
    assert.match(hooks,/!ifndef BUILD_UNINSTALLER[\s\S]*FAST_IO_MACROS_LOADED[\s\S]*FAST_PROGRAM_IO_OVERRIDE_SOURCE/);
    const template=path.join(root,'desktop/node_modules/app-builder-lib/templates/nsis');
    const load=name=>fs.readFileSync(path.join(template,name),'utf8');
    assert.doesNotThrow(()=>validateStockInstallerTemplates(load('installer.nsi'),load('installSection.nsh'),load('include/extractAppPackage.nsh'),load('uninstaller.nsh'),load('common.nsh')));
    assert.throws(()=>validateStockInstallerTemplates('changed','changed','changed','changed','changed'),/Unsupported/);
    // Exercise the real builder decision with a bounded mock. Stop before any
    // compiler, EXE, signing, Wine, installer or uninstaller process is run.
    require('../node_modules/app-builder-lib'); // initialize circular packager class exports first
    const { NsisTarget }=require('../node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js');
    let uninstallerPass=false;
    const fake={options:{},outDir:f.directory,computeFinalScript:async script=>script,packager:{getResource:async option=>{assert.equal(option,undefined);return null;}},
        executeMakensis:async defines=>{uninstallerPass='BUILD_UNINSTALLER' in defines;throw Error('bounded mock stops before compilation');}};
    await assert.rejects(NsisTarget.prototype.computeScriptAndSignUninstaller.call(fake,{}, {},path.join(f.directory,'not-created.exe'),'',new Map()),/bounded mock/);
    assert.equal(uninstallerPass,true);
});

test('same-volume publish keeps file identities instead of copying and preserves the uninstaller icon', windows, t => {
    const f=fixture(t), target=path.join(f.directory,'Display'), stage=target+'.preparing-fixture';
    const manifest=writeManifest(f,payload(stage));
    const before=fs.statSync(path.join(stage,'resources/large-runtime.bin'),{bigint:true}).ino;
    fs.mkdirSync(target);fs.writeFileSync(path.join(target,'uninstallerIcon.ico'),'icon fixture');
    passed(run(f,'Publish',target,manifest,stage));
    assert.equal(fs.existsSync(stage),false);
    assert.equal(fs.statSync(path.join(target,'resources/large-runtime.bin'),{bigint:true}).ino,before);
    assert.equal(fs.readFileSync(path.join(target,'uninstallerIcon.ico'),'utf8'),'icon fixture');
});

test('incomplete decode or a missing empty directory cannot publish or overwrite an existing target', windows, t => {
    const f=fixture(t), target=path.join(f.directory,'Display'), stage=target+'.preparing-fixture';
    const manifest=writeManifest(f,payload(stage));fs.rmdirSync(path.join(stage,'resources/empty-folder'));
    const r=run(f,'Publish',target,manifest,stage);assert.equal(r.status,1,r.text);assert.equal(fs.existsSync(target),false);
    fs.mkdirSync(path.join(stage,'resources/empty-folder'));fs.mkdirSync(target);fs.writeFileSync(path.join(target,'customer.txt'),'keep');
    const second=run(f,'Publish',target,manifest,stage);assert.equal(second.status,1,second.text);
    assert.equal(fs.readFileSync(path.join(target,'customer.txt'),'utf8'),'keep');
});

test('upgrade retire and rollback use directory renames, restore the intact old program and clean the failed new program', windows, t => {
    const f=fixture(t), target=path.join(f.directory,'Display'), stage=target+'.preparing-fixture';
    const old=writeManifest(f,payload(target,'old-version')), oldInode=fs.statSync(path.join(target,'resources/large-runtime.bin'),{bigint:true}).ino;
    passed(run(f,'Retire',target,old));assert.equal(fs.existsSync(target),false);
    assert.equal(fs.statSync(path.join(target+'.previous-program','resources/large-runtime.bin'),{bigint:true}).ino,oldInode);
    const next=writeManifest(f,payload(stage,'new-version'));passed(run(f,'Publish',target,next,stage));
    passed(run(f,'Rollback',target,next));
    assert.equal(fs.readFileSync(path.join(target,'resources/backend/server.js'),'utf8'),'old-version');
    assert.equal(fs.existsSync(target+'.previous-program'),false);
    assert.equal(fs.readdirSync(f.directory).some(name=>name.includes('.failed-')),false);
});

test('completed upgrade removes only the manifest-owned old program and never deletes sibling customer data', windows, t => {
    const f=fixture(t), target=path.join(f.directory,'Display'), stage=target+'.preparing-fixture';
    const old=writeManifest(f,payload(target,'old-version')), sentinel=path.join(f.directory,'customer-data');fs.mkdirSync(sentinel);fs.writeFileSync(path.join(sentinel,'factory.db'),'keep');
    passed(run(f,'Retire',target,old));const next=writeManifest(f,payload(stage,'new-version'));passed(run(f,'Publish',target,next,stage));
    passed(run(f,'Complete',target,next));
    assert.equal(fs.existsSync(target+'.previous-program'),false);
    assert.equal(fs.readFileSync(path.join(sentinel,'factory.db'),'utf8'),'keep');
    assert.equal(fs.readFileSync(path.join(target,'resources/backend/server.js'),'utf8'),'new-version');
});

test('a locked old file leaves committed recovery metadata; retry cleans it without restoring a partial old version', windows, t => {
    const f=fixture(t), target=path.join(f.directory,'Display'), stage=target+'.preparing-fixture';
    const old=writeManifest(f,payload(target,'old-version'));passed(run(f,'Retire',target,old));
    const next=writeManifest(f,payload(stage,'new-version'));passed(run(f,'Publish',target,next,stage));
    const lock=quote(path.join(target+'.previous-program','resources/large-runtime.bin'));
    const source='$handle=[IO.File]::Open('+lock+',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\n'+
        'try { '+command('Complete',target,next)+'; $code=$LASTEXITCODE } finally { $handle.Dispose() }\nexit $code';
    const blocked=f.runPowerShell(source);assert.equal(blocked.status,1,blocked.text+blocked.errorText);
    assert.ok(fs.existsSync(target+'.previous-program.cleanup-record.json'));
    assert.equal(JSON.parse(fs.readFileSync(target+'.previous-program.cleanup-record.json')).committed,true);
    const rollback=run(f,'Rollback',target,next);assert.equal(rollback.status,1,rollback.text);
    assert.equal(fs.readFileSync(path.join(target,'resources/backend/server.js'),'utf8'),'new-version');
    passed(run(f,'Complete',target,next));assert.equal(fs.existsSync(target+'.previous-program'),false);
    assert.equal(fs.existsSync(target+'.previous-program.cleanup-record.json'),false);
});

test('bulk remove and partial-cleanup retry delete only verified program files', windows, t => {
    const f=fixture(t), target=path.join(f.directory,'Display'), manifest=writeManifest(f,payload(target));
    fs.unlinkSync(path.join(target,'Display.exe')); // exact known file deleted on an earlier cleanup attempt
    passed(run(f,'Remove',target,manifest));assert.equal(fs.existsSync(target),false);
    passed(run(f,'Remove',target,manifest));assert.equal(fs.existsSync(target),false,'an already-complete cleanup can be retried safely');
});

for (const fault of ['unknown file','unknown directory','modified configuration','traversal manifest','system root','x86 program-files root','source workspace','source ancestor','customer-data overlap','customer-data child','customer-data parent','junction']) {
    test('destructive operations refuse '+fault+' and leave sentinels intact', windows, t => {
        const f=fixture(t), target=path.join(f.directory,'Display'), original=payload(target), manifest=writeManifest(f,original);
        const sentinel=path.join(f.directory,'customer-data');fs.mkdirSync(sentinel);fs.writeFileSync(path.join(sentinel,'factory.db'),'keep');
        let selected=target, proof=manifest;
        if(fault==='unknown file')fs.writeFileSync(path.join(target,'factory.db'),'user data');
        if(fault==='unknown directory')fs.mkdirSync(path.join(target,'customer-uploads'));
        if(fault==='modified configuration')fs.writeFileSync(path.join(target,'resources/backend/distribution.json'),'modified configuration');
        if(fault==='traversal manifest'){original.entries.push({path:'../customer-data/factory.db',size:4});proof=writeManifest(f,original);}
        if(fault==='system root')selected=process.env.SystemRoot;
        if(fault==='x86 program-files root')selected=process.env['ProgramFiles(x86)'];
        if(fault==='source workspace')fs.mkdirSync(path.join(target,'.git'));
        if(fault==='source ancestor')fs.mkdirSync(path.join(f.directory,'.git'));
        if(fault.startsWith('customer-data ')){
            const data=fault==='customer-data child'?path.join(target,'resources'):fault==='customer-data parent'?f.directory:target;
            const machine=path.join(f.programData,'HeatTreatmentDigitalTwin');fs.mkdirSync(machine);fs.writeFileSync(path.join(machine,'collector-service.json'),JSON.stringify({root:data}));
        }
        if(fault==='junction')fs.symlinkSync(sentinel,path.join(target,'linked-data'),'junction');
        const r=run(f,'Remove',selected,proof);assert.equal(r.status,1,r.text+r.errorText);
        assert.equal(fs.readFileSync(path.join(sentinel,'factory.db'),'utf8'),'keep');
        assert.equal(fs.readFileSync(path.join(target,'Display.exe'),'utf8'),'fixture only: Display.exe');
    });
}

test('early rollback macro compiles before the stock uninstaller filename definition in both builder passes, and the old ordering fails', windows, async t => {
    const f=fixture(t), target=path.join(f.directory,'early-macro-payload');payload(target);
    const io=createInstallerIoPolicy(root,target,path.join(f.directory,'early-macro-io'));
    const ui=fs.readFileSync(path.join(root,'desktop/display-installer-ui.nsh'),'utf8');
    const start=ui.indexOf('!macro DisplayAbort TEXT'), macro=ui.slice(start,ui.indexOf('!macroend',start)+9);
    const productName='Uninstall '+String.fromCharCode(36)+'{PRODUCT_FILENAME}.exe';
    const lateName=String.fromCharCode(36)+'{UNINSTALL_FILENAME}';
    assert.ok(macro.includes(productName));
    const broken=macro.replace(productName,lateName);assert.notEqual(broken,macro);
    const tool=await require('./nsis-toolchain.cjs').nsisToolchain();
    const {spawnSync}=require('node:child_process');
    for(const uninstallerPass of [false,true]) {
        function compile(label,body) {
            const tag=label+(uninstallerPass?'-uninstaller':'-installer'),file=path.join(f.directory,tag+'.nsi');
            const source=['Unicode true','Name "CompileOnly"','OutFile "'+path.join(f.directory,tag+'.exe')+'"',
                'RequestExecutionLevel user','SilentInstall silent','InstallDir "'+path.join(f.directory,'never-installed')+'"',
                'Var displayFailure','!define PRODUCT_FILENAME "CompileOnly"',
                ...(uninstallerPass?['!define BUILD_UNINSTALLER']:[]),'!include "'+io.include+'"',body,
                'Function .onInit','  !insertmacro DisplayAbort "compile fixture only"','FunctionEnd',
                '!define UNINSTALL_FILENAME "'+productName+'"','Section','  DetailPrint "compile fixture only"','SectionEnd'].join('\n');
            fs.writeFileSync(file,source,'utf8');
            return spawnSync(tool.path,['/WX','/INPUTCHARSET','UTF8',file],{cwd:f.directory,windowsHide:true,encoding:'utf8',timeout:60000,env:{...process.env,...tool.env}});
        }
        const good=compile('fixed',macro);assert.equal(good.status,0,good.stdout+good.stderr);assert.doesNotMatch(good.stdout+good.stderr,/warning 6000/);
        const bad=compile('old-ordering',broken);assert.notEqual(bad.status,0,'the actual compiler must reject the old ordering with warnings as errors');
        assert.match(bad.stdout+bad.stderr,/UNINSTALL_FILENAME/);assert.match(bad.stdout+bad.stderr,/warning treated as error|warning 6000/i);
    }
});
