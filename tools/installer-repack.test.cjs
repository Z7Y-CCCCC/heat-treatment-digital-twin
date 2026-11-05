'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {installerOnlyFile,assertRepackable}=require('./installer-repack.cjs');
test('only installer assets, audited cache helpers and non-runtime documentation allow repacking',()=>{
  for(const name of ['desktop/assets/installer-sidebar.bmp','desktop/display-installer-ui.nsh','desktop/scripts/installer-layout.cjs','tools/installer-repack.cjs','docs/INSTALLER.md'])assert.equal(installerOnlyFile(name),true,name);
  for(const name of ['frontend/src/views/AdminPanel.vue','backend/services/plcReader.js','desktop/main.cjs','desktop/package.json','desktop/assets/startup.html','desktop/assets/icon.ico','unity-client/Assets/Client.cs','desktop/scripts/build-unity-client.cjs','desktop/scripts/build-frontend.cjs'])assert.equal(installerOnlyFile(name),false,name);
});
test('unfinished, legacy and skipped-smoke candidates are rejected before git or builder runs',()=>{
  for(const manifest of [{},{smokeTest:'skipped'},{smokeTest:'passed',collectorPlugin:{smokeTest:'passed'},emptySystem:true,contentPolicy:'empty-v1'}])assert.throws(()=>assertRepackable('NOT_A_REPO',manifest),/fully verified/);
});
