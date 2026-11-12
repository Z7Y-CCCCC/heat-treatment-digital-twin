'use strict';
// Fast path for installer-artwork-only changes. Reuse a FULLY verified app,
// never an unfinished candidate, changed application or unverified payload.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyTree } = require('./package-resource-integrity.cjs');
const { verifyNsisTree } = require('./package-nsis-integrity.cjs');
const { fileDigest } = require('../desktop/scripts/file-digest.cjs');
const { installerOnlyFile, verifySource } = require('./release-source-snapshot.cjs');
const { verifyGeneratedNotice } = require('./verify-generated-notice.cjs');
function assertRepackable(root, manifest) {
  if (manifest.smokeTest !== 'passed' || manifest.collectorPlugin?.smokeTest !== 'passed'
      || manifest.emptySystem !== true || manifest.contentPolicy !== 'empty-v1'
      || !/^[a-f0-9]{40}$/.test(manifest.buildSourceCommit || '')) throw Error('Only a source-bound, fully verified empty-system release can be repacked');
  const git = args => execFileSync('git', ['-C',root,...args], {encoding:'utf8',windowsHide:true});
  if (manifest.sourceSnapshot) {
    verifySource(root, JSON.parse(fs.readFileSync(manifest.sourceSnapshot,'utf8').replace(/^\uFEFF/,'')));
    verifyGeneratedNotice(root,path.join(manifest.stagingDirectory,'win-unpacked'));
    if (manifest.version !== require(path.join(root,'desktop/package.json')).version) throw Error('Version changed; use the full build');
    return;
  }
  const changed = git(['diff','--name-only','-z',manifest.buildSourceCommit,'--']).split('\0').filter(Boolean);
  const untracked = git(['ls-files','-z','--others','--exclude-standard']).split('\0').filter(Boolean);
  const unsafe = [...changed,...untracked].filter(name => {
    if (installerOnlyFile(name)) return false;
    // The normal build regenerates this tracked legal document. It is safe
    // only when it already equals the verified installed copy byte-for-byte.
    if (name === 'desktop/THIRD_PARTY_NOTICES.txt') {
      try {
        const installed = path.join(manifest.stagingDirectory, 'win-unpacked/resources/THIRD_PARTY_NOTICES.txt');
        verifyGeneratedNotice(root,path.dirname(path.dirname(installed)));
        return false;
      } catch { return true; }
    }
    return true;
  });
  if (unsafe.length) throw Error('Application sources changed; use the full build: '+unsafe.join(', '));
  if (manifest.version !== require(path.join(root,'desktop/package.json')).version) throw Error('Version changed; use the full build');
}
async function repackInstaller(root, sourceRelease) {
  const beginning=performance.now();
  const read = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const manifest = read(path.join(sourceRelease,'release-manifest.json'));
  const compressionLevel=process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || manifest.compressionLevel || '1';
  if (!/^[0-9]$/.test(compressionLevel)) throw Error('ELECTRON_BUILDER_COMPRESSION_LEVEL must be a digit from 0 to 9');
  const timings = read(path.join(sourceRelease,'build-timings.json'));
  if (!timings.success) throw Error('Source release did not finish successfully');
  assertRepackable(root,manifest);
  execFileSync(process.execPath,[path.join(root,'desktop/scripts/create-installer-brand.cjs')],{windowsHide:true,stdio:'inherit'});
  execFileSync(process.execPath,[path.join(root,'desktop/scripts/create-installer-ui.cjs')],{windowsHide:true,stdio:'inherit'});
  const stageRoot = manifest.stagingDirectory || sourceRelease;
  const unpacked = path.join(stageRoot,'win-unpacked');
  const plugin = path.join(sourceRelease,manifest.collectorPlugin.file);
  const actual = fileDigest(plugin);
  if (actual.size !== manifest.collectorPlugin.size || actual.sha256 !== manifest.collectorPlugin.sha256) throw Error('Collector archive changed');
  const name='release-ui-'+new Date().toISOString().replace(/[^0-9]/g,'');
  const output=path.join(path.dirname(stageRoot),name);fs.mkdirSync(output,{recursive:false});
  const stages=[];
  async function stage(name, action) { const start=performance.now();await action();stages.push({name,seconds:+((performance.now()-start)/1000).toFixed(3),exitCode:0}); }
  let packaged;
  await stage('重新核验原始安装资源及 NSIS 工具助手',async()=>{
    packaged = await verifyNsisTree(root,unpacked,read(manifest.packagingResourceBaseline || manifest.resourceBaseline));
  });
  await stage('确认复用资源仍为空系统',()=>execFileSync(process.execPath,[path.join(root,'desktop/scripts/verify-empty-install.cjs'),path.join(unpacked,'resources')],{windowsHide:true,stdio:'inherit'}));
  await stage('只重压 NSIS 安装界面',()=>execFileSync(process.execPath,[path.join(root,'desktop/node_modules/electron-builder/out/cli/cli.js'),
    '--projectDir',path.join(root,'desktop'),'--prepackaged',unpacked,'--win','nsis','--x64',`--config.directories.output=${output}`,'--config.compression=normal'],
    {windowsHide:true,stdio:'inherit',env:{...process.env,ELECTRON_BUILDER_COMPRESSION_LEVEL:compressionLevel}}));
  const installerName=`热处理数字孪生大屏-安装包-${manifest.version}-x64.exe`, installer=path.join(output,installerName), digest=fileDigest(installer);
  // Check the immutable source again after packaging, not merely beforehand.
  await stage('确认重压没有改写已验证程序',()=>verifyTree(unpacked,packaged.snapshot));
  assertRepackable(root, manifest);
  const packagingResourceBaseline=path.join(output,'packaging-resource-baseline.json');
  fs.writeFileSync(packagingResourceBaseline,JSON.stringify(packaged.snapshot,null,2));
  fs.writeFileSync(path.join(output,'packaging-resource-verification.json'),JSON.stringify(packaged.proof,null,2));
  fs.copyFileSync(plugin,path.join(output,manifest.collectorPlugin.file));
  fs.writeFileSync(installer+'.sha256.txt',`${digest.sha256}  ${installerName}\n`);
  const newManifest={...manifest,installer,size:digest.size,sha256:digest.sha256,createdAt:new Date().toISOString(),mode:'installer-ui-only',
    installerSourceCommit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
    stagingDirectory:stageRoot,packagingResourceBaseline,fullSmokeTestReused:true,compressionLevel};
  const fullBuild = timings.reusedFullBuildTimings || timings;
  const report={success:true,mode:'installer-ui-only',fullSmokeTestReused:true,totalSeconds:+((performance.now()-beginning)/1000).toFixed(3),stages,
    reusedFullBuildTimings:{totalSeconds:fullBuild.totalSeconds,stages:fullBuild.stages}};
  fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify(newManifest,null,2));
  fs.writeFileSync(path.join(output,'build-timings.json'),JSON.stringify(report,null,2));
  const delivery=path.join(root,'安装包',name);fs.mkdirSync(delivery,{recursive:false});
  for(const file of fs.readdirSync(output))fs.copyFileSync(path.join(output,file),path.join(delivery,file));
  newManifest.installer=path.join(delivery,installerName);fs.writeFileSync(path.join(delivery,'release-manifest.json'),JSON.stringify(newManifest,null,2));
  console.log(JSON.stringify({delivery,...report},null,2));return delivery;
}
async function main() {
  const root=path.resolve(__dirname,'..');
  if (process.argv[2] !== '--try-reuse') return repackInstaller(root,path.resolve(process.argv[2] || ''));
  let source;
  try {
    const pointer=JSON.parse(fs.readFileSync(path.join(root,'desktop/.cache/last-verified-release.json'),'utf8').replace(/^\uFEFF/,''));
    source=pointer.directory;
    const manifest=JSON.parse(fs.readFileSync(path.join(source,'release-manifest.json'),'utf8').replace(/^\uFEFF/,''));
    const timings=JSON.parse(fs.readFileSync(path.join(source,'build-timings.json'),'utf8').replace(/^\uFEFF/,''));
    if (!timings.success || !manifest.sourceSnapshot) throw Error('No completed source snapshot');
    assertRepackable(root,manifest);
  } catch(error) {
    console.log('需要完整构建：'+error.message);process.exitCode=10;return;
  }
  // Once eligible, a failed integrity check/build is an error, never silently
  // replaced by a different payload or treated as a successful cached release.
  return repackInstaller(root,source);
}
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={installerOnlyFile,assertRepackable,repackInstaller};
