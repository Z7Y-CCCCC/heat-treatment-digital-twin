'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { fixture, root } = require('./installer-test-fixtures.cjs');
const { layout } = require('./installer-layout.cjs');
const { collectorPreviewEvidenceSource, parseChoiceEvidence } = require('./installer-choice-preview.cjs');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const body = (text, name) => text.split('Function ' + name + '\n')[1].split('FunctionEnd')[0];

test('collector controls fit their actual page, above the action, at every supported dialog scale', () => {
  const ui = read('desktop/display-installer-ui.nsh');
  const moves = [...body(ui, 'DisplayCollectorLayout').matchAll(/DisplayMoveControl (\d+) (\d+) (\d+) (\d+) (\d+)/g)];
  const frames = Object.fromEntries(moves.map(m => [m[1], m.slice(2).map(Number)]));
  assert.deepEqual(frames[1018], [24, 182, 412, 112]);
  assert.ok(frames[1036][1] + frames[1036][3] < frames[1018][1], 'artwork must not cover the choices');
  assert.ok(frames[1018][1] + frames[1018][3] < frames[1][1], 'the install action belongs below every choice');
  const dialog = layout.dialogs.find(d => d.id === 105);
  const footer = dialog.controls.find(c => c.id === 1220);
  assert.ok(frames[1][1] + frames[1][3] < footer.y);
  const page = body(read('desktop/collector-installer.nsh'), 'CollectorChoicePage');
  assert.match(page, /Call DisplayCollectorLayout[\s\S]*nsDialogs::Create 1018/);
  const controls = [...page.matchAll(/(?:NSD_Create(?:RadioButton|Checkbox|Label)\}|DisplayLabel) (\d+)(?:u)? (\d+)(?:u)? (\d+)u (\d+)u/g)];
  assert.equal(controls.length, 5, 'both radios, policy, blank checkbox and factory-data notice must be covered');
  for (const scale of [1, 1.25, 1.5, 2]) {
    for (const c of controls) {
      const [x,y,w,h] = c.slice(1).map(Number);
      assert.ok(x >= 0 && y >= 0 && w > 0 && h >= 16, 'controls need a legible native font height');
      assert.ok(Math.round((x+w)*scale) <= Math.round(frames[1018][2]*scale));
      assert.ok(Math.round((y+h)*scale) <= Math.round(frames[1018][3]*scale), 'no clipped blank checkbox or notice');
    }
  }
  for (const pageName of ['DisplaySettingsPage','DisplayInstallingShow','DisplayFinishPage']) {
    assert.match(body(ui, pageName), /Call DisplayStandardLayout/, pageName + ' must restore normal geometry');
  }
  assert.match(ui, /MapDialogRect/);
});

test('display-only mode has no collector I/O, while empty creation remains explicit and repair-idempotent', () => {
  const ui = read('desktop/collector-installer.nsh');
  const install = body(ui, 'InstallSelectedCollector');
  const prefix = install.slice(0, install.indexOf('Call DisplayCheckCancel'));
  assert.match(prefix, /\$collectorChoice != "1"[\s\S]*Return/);
  assert.doesNotMatch(prefix, /ReadReg|FileExists|nsExec|InstallerExec|InitPluginsDir|File\s|NewEmptyData/);
  assert.match(install, /collectorNewEmptyApplied != "1"[\s\S]*-NewEmptyData/);
  assert.match(install, /COLLECTOR_PAYLOAD_SHA256/);
  assert.match(install, /COLLECTOR_BUILD_COMMIT/);
  assert.match(body(ui, 'VerifySelectedCollector'), /\$collectorChoice != "1"[\s\S]*Return/);
  assert.doesNotMatch(ui, /EnableWindow \$collectorDisplayRadio 0|必须同步更新/);
  const toggle = body(ui, 'CollectorDataToggle');
  assert.match(toggle, /collectorEmptySelection == "1"[\s\S]*NSD_Check/);
  assert.match(toggle, /EnableWindow \$collectorEmptyCheckbox 0[\s\S]*NSD_Uncheck/);
  assert.doesNotMatch(toggle, /StrCpy \$collectorEmptySelection/, 'mode switching must remember the user choice');
  const leave = body(ui, 'CollectorChoiceLeave');
  assert.match(leave, /collectorServiceRadio[\s\S]*BST_CHECKED[\s\S]*collectorEmptyCheckbox[\s\S]*collectorNewEmpty "1"/);
});

test('preview includes a real existing-collector fixture and records native, not assumed, bounds', () => {
  const preview = read('desktop/scripts/installer-preview.cjs');
  assert.match(preview, /existing-collector=/);
  assert.match(preview, /DISPLAY_UI_PREVIEW_EXISTING_COLLECTOR/);
  assert.match(preview, /collectorPreviewEvidenceSource\(output\)/);
  const init = body(read('desktop/collector-installer.nsh'), 'CollectorChoiceInit');
  const isolated = init.split('!ifdef DISPLAY_UI_PREVIEW\n')[1].split('  !else')[0];
  assert.doesNotMatch(isolated, /ReadReg|FileExists/);
  assert.match(isolated, /collectorExisting "1"/);
  const evidence = collectorPreviewEvidenceSource('C:/isolated-only');
  for (const method of ['GetClientRect','GetWindowRect','MapWindowPoints','IsWindowEnabled']) assert.ok(evidence.includes(method));
  assert.match(evidence, /collectorDisplayRadio/);
  assert.match(evidence, /collectorEmptyCheckbox/);
  assert.doesNotMatch(evidence, /SendInput|BM_CLICK|WriteReg|Exec|Stop-Service/);
  assert.deepEqual(parseChoiceEvidence('[State]\r\nchoice=1\r\nnewEmpty=1\r\n[Rects]\r\npage=0,0,412,112\r\n'), {
    State:{choice:'1',newEmpty:'1'},Rects:{page:'0,0,412,112'}
  });
});

function compileSource(directory, source, tool, extraEnv={}) {
  const file=path.join(directory,'fixture.nsi');fs.writeFileSync(file,source,'utf8');
  execFileSync(tool.path,['/INPUTCHARSET','UTF8',file],{
    cwd:directory,windowsHide:true,env:{...process.env,...tool.env,...extraEnv},stdio:'pipe'
  });
  return path.join(directory,'fixture.exe');
}
function stubs(directory) {
  return [
    'Unicode true', 'Name "Isolated collector choice policy"',
    'OutFile "'+path.join(directory,'fixture.exe')+'"', 'RequestExecutionLevel user',
    '!include LogicLib.nsh', '!include FileFunc.nsh', '!include nsDialogs.nsh',
    'Var displayFont',
    '!macro DisplayStage TEXT', 'DetailPrint "\u0024{TEXT}"', '!macroend',
    '!macro DisplayAbort TEXT', 'SetErrorLevel 2', 'Abort "\u0024{TEXT}"', '!macroend',
    '!macro DisplayLabel X Y W H TEXT COLOR',
    '\u0024{NSD_CreateLabel} \u0024{X} \u0024{Y} \u0024{W} \u0024{H} \u0024{TEXT}', 'Pop $0', '!macroend',
    'Function DisplayCollectorLayout','FunctionEnd',
    'Function DisplayRefreshFonts','FunctionEnd',
    'Function DisplayShowClose','FunctionEnd',
    'Function DisplayPaintPrimary','FunctionEnd'
  ].join('\n')+'\n';
}

test('real NSIS CLI accepts display-only on an existing collector and rejects incoherent blank-data requests', {
  skip:process.platform!=='win32', timeout:60000
}, async t => {
  const f=fixture(t,'collector-choice-cli-');
  const tool=await require('./nsis-toolchain.cjs').nsisToolchain();
  for(const existing of [false,true]) {
    const dir=path.join(f.directory,existing?'existing':'fresh');fs.mkdirSync(dir);
    const result=path.join(dir,'choice.ini');
    const source=stubs(dir)+[
      '!define DISPLAY_UI_PREVIEW',existing?'!define DISPLAY_UI_PREVIEW_EXISTING_COLLECTOR':'',
      '!include "'+path.join(root,'desktop/collector-installer.nsh')+'"',
      'Page custom CollectorChoicePage CollectorChoiceLeave',
      'Function .onInit','Call CollectorChoiceInit','FunctionEnd',
      'Section',
      'WriteINIStr "'+result+'" "State" "choice" "$collectorChoice"',
      'WriteINIStr "'+result+'" "State" "newEmpty" "$collectorNewEmpty"',
      'SetErrorLevel 0','SectionEnd'
    ].join('\n');
    const exe=compileSource(dir,source,tool);
    const scenarios=[
      {args:[],code:0,choice:existing?'1':'0',empty:'0'},
      {args:['/WITHCOLLECTOR=0'],code:0,choice:'0',empty:'0'},
      {args:['/WITHCOLLECTOR=1','/NEWEMPTY=1'],code:0,choice:'1',empty:'1'},
      {args:['/WITHCOLLECTOR=0','/NEWEMPTY=1'],code:2},
      {args:['/WITHCOLLECTOR=2'],code:2},
      {args:['/WITHCOLLECTOR=1','/NEWEMPTY=2'],code:2}
    ];
    for(const scenario of scenarios) {
      fs.rmSync(result,{force:true});
      const child=spawnSync(exe,['/S',...scenario.args],{windowsHide:true,timeout:10000,env:f.env});
      assert.equal(child.status,scenario.code,JSON.stringify({existing,args:scenario.args,error:child.error?.message}));
      if(scenario.code===0)assert.deepEqual(parseChoiceEvidence(fs.readFileSync(result,'utf8')).State,
        {choice:scenario.choice,newEmpty:scenario.empty});
      else assert.equal(fs.existsSync(result),false,'invalid options must never enter installation');
    }
  }
});

test('the production collector install and verify functions return without any I/O in display-only mode', {
  skip:process.platform!=='win32', timeout:60000
}, async t => {
  const f=fixture(t,'collector-display-only-');
  const dir=f.directory, result=path.join(dir,'choice.ini');
  const archive=path.join(dir,'payload.zip'),commit='a'.repeat(40);
  fs.writeFileSync(path.join(dir,'plugin-manifest.json'),JSON.stringify({product:'collector-plugin',version:'2.3.3',buildSourceCommit:commit,files:[]}));
  execFileSync(require('7zip-bin').path7za,['a','-tzip',archive,'plugin-manifest.json'],{cwd:dir,windowsHide:true,stdio:'ignore'});
  const payload=require('../../tools/collector-installer-payload.cjs').preparePayload(archive,dir,{version:'2.3.3',commit});
  const source=stubs(dir)+[
    '!include "'+path.join(root,'desktop/collector-installer.nsh')+'"',
    'Function DisplayCheckCancel',
    'SetErrorLevel 3','Abort "Display-only unexpectedly entered collector work"','FunctionEnd',
    'Section','StrCpy $collectorExisting "1"','StrCpy $collectorChoice "0"',
    'StrCpy $collectorNewEmpty "0"','Call InstallSelectedCollector','Call VerifySelectedCollector',
    'WriteINIStr "'+result+'" "State" "returned" "1"',
    'SetErrorLevel 0','SectionEnd'
  ].join('\n');
  const tool=await require('./nsis-toolchain.cjs').nsisToolchain();
  const exe=compileSource(dir,source,tool,{DIGITAL_TWIN_COLLECTOR_PAYLOAD_INCLUDE:payload.include});
  const child=spawnSync(exe,['/S'],{windowsHide:true,timeout:10000});
  assert.equal(child.status,0,child.error?.message);
  assert.equal(parseChoiceEvidence(fs.readFileSync(result,'utf8')).State.returned,'1');
});
