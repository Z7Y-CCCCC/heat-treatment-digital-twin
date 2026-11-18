'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function validateManifest(config, projectVersion, pem) {
 if(config?.schema!==1)throw Error('Unsupported cloud runtime configuration');
 const {unity,mysql,publicKey}=config;
 if(!/^2022\.3\.\d+f\d+c\d+$/.test(unity?.version||'')||!/^[a-f0-9]{12}$/.test(unity?.revision||'')
   ||unity.url!=='https://download.unitychina.cn/download_unity/'+unity.revision+'/Windows64EditorInstaller/UnitySetup64-'+unity.version+'.exe'
   ||!Number.isSafeInteger(unity.size)||unity.size<=0||!/^[A-F0-9]{40}$/.test(unity.signerThumbprint||''))throw Error('Unverified Unity cloud download');
 if(!projectVersion.includes('m_EditorVersion: '+unity.version+'\n')||!projectVersion.includes('('+unity.revision+')'))throw Error('Cloud Unity editor does not match project version and revision');
 if(!/^\d+\.\d+\.\d+$/.test(mysql?.version||'')||mysql.url!=='https://cdn.mysql.com/archives/mysql-'+mysql.version.split('.').slice(0,2).join('.')+'/mysql-'+mysql.version+'-winx64.zip'
   ||!Number.isSafeInteger(mysql.size)||mysql.size<=0||!/^[a-f0-9]{64}$/.test(mysql.sha256||''))throw Error('Unverified MySQL cloud download');
 if(publicKey?.file!=='tools/ci/trust/license-public-key.pub'||!/^[a-f0-9]{64}$/.test(publicKey.spkiSha256||''))throw Error('Invalid cloud public trust anchor');
 if(typeof pem!=='string'||!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----')||pem.includes('PRIVATE KEY'))throw Error('Cloud builds may receive the existing public key only');
 const key=crypto.createPublicKey(pem);
 const fingerprint=crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
 if(key.asymmetricKeyType!=='ed25519'||fingerprint!==publicKey.spkiSha256)throw Error('Cloud public key differs from the approved issuer identity');
 return {config,publicKeyFingerprint:fingerprint};
}
function readCloudRuntime(root=path.resolve(__dirname,'../..')) {
 const config=JSON.parse(fs.readFileSync(path.join(root,'tools/ci/cloud-runtime.json'),'utf8'));
 const projectVersion=fs.readFileSync(path.join(root,'unity-client/ProjectSettings/ProjectVersion.txt'),'utf8').replace(/\r\n/g,'\n');
 return validateManifest(config,projectVersion,fs.readFileSync(path.join(root,'tools/ci/trust/license-public-key.pub'),'utf8'));
}
function requireUnityLicense(env=process.env) {
 // Only check the secret supplied to this step. Never read a user's local
 // license file, log its contents, copy credentials or invent a license.
 if(typeof env.UNITY_LICENSE!=='string'||env.UNITY_LICENSE.length<20||env.UNITY_LICENSE.length>262144||!/<License(?:\s|>)/.test(env.UNITY_LICENSE))throw Error('One-time setup required: add your existing authorized Unity .ulf as repository Actions secret UNITY_LICENSE. GitHub standard hosted Windows builds are free for this public repository. No local license or password is uploaded automatically.');
 return true;
}
if(require.main===module){try{const result=readCloudRuntime();if(process.argv.includes('--require-license'))requireUnityLicense();console.log(JSON.stringify({unityVersion:result.config.unity.version,mysqlVersion:result.config.mysql.version,publicKeyFingerprint:result.publicKeyFingerprint,licenseRequired:process.argv.includes('--require-license')}));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={validateManifest,readCloudRuntime,requireUnityLicense};
