'use strict';
const fs = require('node:fs'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const {parseVersion,compareVersions} = require('./auto-release-version.cjs');
function applyBuildVersion(root, env = process.env, git = args => execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true})) {
  root=path.resolve(root);
  if(env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'
    ||path.resolve(env.GITHUB_WORKSPACE||'.')!==root||!path.isAbsolute(env.RUNNER_TEMP||'')) throw Error('Version injection is restricted to the disposable GitHub-hosted checkout');
  if(!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')||git(['rev-parse','HEAD']).trim()!==env.GITHUB_SHA) throw Error('Build checkout does not match the verified source commit');
  if(git(['status','--porcelain']).trim()) throw Error('Version injection requires a clean source checkout');
  parseVersion(env.RELEASE_VERSION);
  const names=['desktop/package.json','desktop/package-lock.json','release-manifest.json'];
  const originals=names.map(name=>fs.readFileSync(path.join(root,name)));
  const documents=originals.map(bytes=>JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  const [desktop,lock,manifest]=documents, sourceVersion=desktop.version;
  parseVersion(sourceVersion);
  if(lock.version!==sourceVersion||lock.packages?.['']?.version!==sourceVersion||manifest.productVersion!==sourceVersion) throw Error('Source version files are inconsistent');
  if(compareVersions(env.RELEASE_VERSION,sourceVersion)<0) throw Error('Automatic build version must not downgrade source');
  desktop.version=lock.version=lock.packages[''].version=manifest.productVersion=env.RELEASE_VERSION;
  const temporary=names.map(name=>path.join(root,name)+'.ci-version-'+process.pid);
  try {
    for(let i=0;i<names.length;i++) fs.writeFileSync(temporary[i],JSON.stringify(documents[i],null,2)+'\n',{flag:'wx'});
    for(let i=0;i<names.length;i++) fs.renameSync(temporary[i],path.join(root,names[i]));
  } catch(error) {
    for(let i=0;i<names.length;i++) fs.writeFileSync(path.join(root,names[i]),originals[i]);
    throw error;
  } finally {for(const file of temporary)if(fs.existsSync(file))fs.unlinkSync(file);}
  const receipt={strategy:'git-main-v1',sourceVersion,version:env.RELEASE_VERSION,commit:env.GITHUB_SHA,files:names};
  fs.writeFileSync(path.join(env.RUNNER_TEMP,'installer-build-version.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
if(require.main===module){try{console.log(JSON.stringify(applyBuildVersion(path.resolve(__dirname,'../..'))));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={applyBuildVersion};
