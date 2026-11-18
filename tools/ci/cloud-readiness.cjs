'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {readCloudRuntime}=require('./cloud-runtime.cjs');
function readinessPaths(env=process.env) {
 if(env.GITHUB_ACTIONS!=='true'||env.RUNNER_ENVIRONMENT!=='github-hosted'||env.GITHUB_REF!=='refs/heads/main'||!path.isAbsolute(env.RUNNER_TEMP||''))throw Error('Readiness requires the disposable GitHub-hosted main environment');
 const root=path.resolve(env.RUNNER_TEMP,'cloud-release-v1');
 const fixture=path.join(root,'readiness-fixture');
 if(!root.startsWith(path.resolve(env.RUNNER_TEMP)+path.sep))throw Error('Readiness path escapes runner temp');
 if(!path.isAbsolute(env.UNITY_EDITOR_PATH||'')||!path.isAbsolute(env.DESKTOP_MYSQL_RUNTIME_SOURCE||''))throw Error('Provisioned cloud tool paths are missing');
 for(const file of [env.UNITY_EDITOR_PATH,env.DESKTOP_MYSQL_RUNTIME_SOURCE])if(!path.resolve(file).startsWith(root+path.sep))throw Error('Readiness must not run tools from the operator computer');
 return {root,fixture,editor:env.UNITY_EDITOR_PATH,mysql:path.join(env.DESKTOP_MYSQL_RUNTIME_SOURCE,'bin','mysqld.exe')};
}
function runReadiness(env=process.env, run=(file,args)=>spawnSync(file,args,{encoding:'utf8',windowsHide:true,stdio:'pipe',timeout:300000})) {
 const paths=readinessPaths(env),{config}=readCloudRuntime();
 if(fs.existsSync(paths.fixture))throw Error('Readiness fixture must be new and empty');
 fs.mkdirSync(path.join(paths.fixture,'Assets','Editor'),{recursive:true});
 fs.mkdirSync(path.join(paths.fixture,'ProjectSettings'));
 fs.writeFileSync(path.join(paths.fixture,'ProjectSettings','ProjectVersion.txt'),'m_EditorVersion: '+config.unity.version+'\n');
 fs.writeFileSync(path.join(paths.fixture,'Assets','Editor','CloudProbe.cs'),'using UnityEditor; using UnityEngine; public static class CloudProbe { public static void Run() { if(Application.unityVersion != "'+config.unity.version+'") { EditorApplication.Exit(2); return; } Debug.Log("CLOUD_UNITY_READINESS_OK"); EditorApplication.Exit(0); } }\n');
 const log=path.join(paths.fixture,'private-unity-check.log');
 const unity=run(paths.editor,['-batchmode','-nographics','-quit','-projectPath',paths.fixture,'-executeMethod','CloudProbe.Run','-logFile',log]);
 // Editor exit codes alone are not sufficient: assert that authorized script
 // execution really happened. Never upload raw license/editor logs.
 if(unity.error||unity.status!==0||!fs.existsSync(log)||!fs.readFileSync(log,'utf8').includes('CLOUD_UNITY_READINESS_OK'))throw Error('Cloud Unity authorization or empty-fixture execution failed; no application build was attempted');
 const mysql=run(paths.mysql,['--no-defaults','--version']);
 if(mysql.error||mysql.status!==0||!new RegExp('\\bVer\\s+'+config.mysql.version.replace(/\./g,'\\.')+'\\b').test(mysql.stdout||''))throw Error('Cloud MySQL runtime version check failed');
 const result={success:true,unityVersion:config.unity.version,mysqlVersion:config.mysql.version,licenseValidated:true,installerBuilt:false,releasePublished:false,fixtureOnly:true};
 fs.writeFileSync(path.join(paths.root,'readiness.json'),JSON.stringify(result,null,2)+'\n');
 if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'### Cloud Windows readiness\n\nAuthorized Unity executed the fresh empty fixture; official MySQL version verified. No installer build or release publication.\n');
 return result;
}
if(require.main===module){try{console.log(JSON.stringify(runReadiness()));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={readinessPaths,runReadiness};
