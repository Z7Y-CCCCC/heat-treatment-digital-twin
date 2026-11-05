'use strict';
// Fast path for installer-artwork-only changes. Reuse a FULLY verified app,
// never an unfinished candidate, changed application or unverified payload.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyTree } = require('./package-resource-integrity.cjs');
const { verifyNsisTree } = require('./package-nsis-integrity.cjs');
const { fileDigest } = require('../desktop/scripts/file-digest.cjs');
function installerOnlyFile(name) {
  return /^(?:docs\/|tools\/|\.github\/)/.test(name)
    || /(?:^|\/)README[^/]*\.md$/i.test(name)
    || name === '生成安装包.ps1'
    || /^desktop\/scripts\/[^/]+(?:-test|\.test)\.cjs$/.test(name)
    || /^desktop\/(?:display-installer(?:-ui)?\.nsh|assets\/installer-[^/]+\.(?:bmp|bin|json)|scripts\/(?:installer-[^/]+|create-installer-[^/]+|release-frontend-cache(?:-test)?|runtime-cache(?:-test)?)\.cjs)$/.test(name);
}
function assertRepackable(root, manifest) {
  if (manifest.smokeTest !== 'passed' || manifest.collectorPlugin?.smokeTest !== 'passed'
      || manifest.emptySystem !== true || manifest.contentPolicy !== 'empty-v1'
      || !/^[a-f0-9]{40}$/.test(manifest.buildSourceCommit || '')) throw Error('Only a source-bound, fully verified empty-system release can be repacked');
  const git = args => execFileSync('git', ['-C',root,...args], {encoding:'utf8',windowsHide:true});
  const changed = git(['diff','--name-only',manifest.buildSourceCommit,'--']).trim().split(/\r?\n/).filter(Boolean);
  const untracked = git(['ls-files','--others','--exclude-standard']).trim().split(/\r?\n/).filter(Boolean);
  const unsafe = [...changed,...untracked].filter(name => {
    if (installerOnlyFile(name)) return false;
    // The normal build regenerates this tracked legal document. It is safe
    // only when it already equals the verified installed copy byte-for-byte.
    if (name === 'desktop/THIRD_PARTY_NOTICES.txt') {
      try {
        const installed = path.join(manifest.stagingDirectory, 'win-unpacked/resources/THIRD_PARTY_NOTICES.txt');
        return fileDigest(path.join(root,name)).sha256 !== fileDigest(installed).sha256;
      } catch { return true; }
    }
    return true;
  });
  if (unsafe.length) throw Error('Application sources changed; use the full build: '+unsafe.join(', '));
  if (manifest.version !== require(path.join(root,'desktop/package.json')).version) throw Error('Version changed; use the full build');
}
async function repackInstaller(root, sourceRelease) {
  const read = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const manifest = read(path.join(sourceRelease,'release-manifest.json'));
  const timings = read(path.join(sourceRelease,'build-timings.json'));
  if (!timings.success) throw Error('Source release did not finish successfully');
  assertRepackable(root,manifest);
  const stageRoot = manifest.stagingDirectory || sourceRelease;
  const unpacked = path.join(stageRoot,'win-unpacked');
  const plugin = path.join(sourceRelease,manifest.collectorPlugin.file);
  const actual = fileDigest(plugin);
  if (actual.size !== manifest.collectorPlugin.size || actual.sha256 !== manifest.collectorPlugin.sha256) throw Error('Collector archive changed');
  const name='release-ui-'+new Date().toISOString().replace(/[^0-9]/g,'');
  const output=path.join(path.dirname(stageRoot),name);fs.mkdirSync(output,{recursive:false});
  const stages=[], beginning=performance.now();
  async function stage(name, action) { const start=performance.now();await action();stages.push({name,seconds:+((performance.now()-start)/1000).toFixed(3),exitCode:0}); }
  let packaged;
  await stage('重新核验原始安装资源及 NSIS 工具助手',async()=>{
    packaged = await verifyNsisTree(root,unpacked,read(manifest.packagingResourceBaseline || manifest.resourceBaseline));
  });
  await stage('确认复用资源仍为空系统',()=>execFileSync(process.execPath,[path.join(root,'desktop/scripts/verify-empty-install.cjs'),path.join(unpacked,'resources')],{windowsHide:true,stdio:'inherit'}));
  await stage('只重压 NSIS 安装界面',()=>execFileSync(process.execPath,[path.join(root,'desktop/node_modules/electron-builder/out/cli/cli.js'),
    '--projectDir',path.join(root,'desktop'),'--prepackaged',unpacked,'--win','nsis','--x64',`--config.directories.output=${output}`,'--config.compression=normal'],
    {windowsHide:true,stdio:'inherit',env:{...process.env,ELECTRON_BUILDER_COMPRESSION_LEVEL:'1'}}));
  const installerName=`热处理数字孪生大屏-安装包-${manifest.version}-x64.exe`, installer=path.join(output,installerName), digest=fileDigest(installer);
  // Check the immutable source again after packaging, not merely beforehand.
  await stage('确认重压没有改写已验证程序',()=>verifyTree(unpacked,packaged.snapshot));
  const packagingResourceBaseline=path.join(output,'packaging-resource-baseline.json');
  fs.writeFileSync(packagingResourceBaseline,JSON.stringify(packaged.snapshot,null,2));
  fs.writeFileSync(path.join(output,'packaging-resource-verification.json'),JSON.stringify(packaged.proof,null,2));
  fs.copyFileSync(plugin,path.join(output,manifest.collectorPlugin.file));
  fs.writeFileSync(installer+'.sha256.txt',`${digest.sha256}  ${installerName}\n`);
  const newManifest={...manifest,installer,size:digest.size,sha256:digest.sha256,createdAt:new Date().toISOString(),mode:'installer-ui-only',
    installerSourceCommit:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
    stagingDirectory:stageRoot,packagingResourceBaseline,fullSmokeTestReused:true,compressionLevel:'1'};
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
if(require.main===module)repackInstaller(path.resolve(__dirname,'..'),path.resolve(process.argv[2] || '')).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={installerOnlyFile,assertRepackable,repackInstaller};
