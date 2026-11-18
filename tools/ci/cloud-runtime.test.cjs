'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateManifest,readCloudRuntime,requireUnityLicense}=require('./cloud-runtime.cjs');
const root=path.resolve(__dirname,'../..');
const config=JSON.parse(fs.readFileSync(path.join(__dirname,'cloud-runtime.json'),'utf8'));
const version=fs.readFileSync(path.join(root,'unity-client/ProjectSettings/ProjectVersion.txt'),'utf8').replace(/\r\n/g,'\n');
const pem=fs.readFileSync(path.join(root,config.publicKey.file),'utf8');
test('cloud runtime pins the exact editor revision, MySQL bytes and existing public issuer identity',()=>{
 assert.equal(readCloudRuntime().config.unity.version,'2022.3.34f1c1');
 assert.equal(readCloudRuntime().publicKeyFingerprint,config.publicKey.spkiSha256);
 assert.equal(config.mysql.sha256,'9ee202d6daa040b82aeea8a867b25360f7644851b68b31f8b1230132e4464d93');
});
test('different editors, redirected downloads, incomplete digests and changed keys fail closed',()=>{
 for(const patch of [{unity:{...config.unity,url:'https://fixture.invalid/editor.exe'}},{unity:{...config.unity,revision:'bad'}},{unity:{...config.unity,signerThumbprint:''}},{mysql:{...config.mysql,sha256:''}},{mysql:{...config.mysql,url:'http://cdn.mysql.com/mysql.zip'}},{publicKey:{...config.publicKey,file:'../private.key'}}])assert.throws(()=>validateManifest({...config,...patch},version,pem),/Unverified|anchor/);
 assert.throws(()=>validateManifest(config,version.replace(config.unity.version,'2022.3.1f1c1'),pem),/does not match/);
 const other=crypto.generateKeyPairSync('ed25519');
 assert.throws(()=>validateManifest(config,version,other.publicKey.export({type:'spki',format:'pem'})),/differs/);
 assert.throws(()=>validateManifest(config,version,other.privateKey.export({type:'pkcs8',format:'pem'})),/public key only/);
});
test('Unity authorization is an explicit secret and is never extracted from this computer',()=>{
 assert.throws(()=>requireUnityLicense({}),/One-time setup required/);
 assert.throws(()=>requireUnityLicense({UNITY_LICENSE:'not a license'}),/One-time setup/);
 assert.equal(requireUnityLicense({UNITY_LICENSE:'<?xml version="1.0"?><root><License /></root>'}),true);
 const script=fs.readFileSync(path.join(__dirname,'setup-cloud-runner.ps1'),'utf8');
 assert.match(script,/RUNNER_ENVIRONMENT -ne 'github-hosted'/);assert.match(script,/Resolve-ContainedPath/);assert.match(script,/Get-AuthenticodeSignature/);assert.match(script,/SignerCertificate\.Thumbprint/);assert.match(script,/Get-FileHash[^\n]+SHA256/);
 assert.doesNotMatch(script,/C:\\ProgramData\\Unity|Unity_lic\.ulf|PRIVATE KEY|Stop-Process|taskkill|Remove-Item[^\n]+-Recurse/);
 for(const call of script.split('\n').filter(line=>line.includes('Start-Process -FilePath')))assert.match(call,/-WindowStyle Hidden/);
 assert.match(script,/Activation logs stay private/);assert.match(script,/Remove-Item -LiteralPath \$license/);
});

test('cloud release stages into runner temp and uploads failed component evidence without exposing activation logs', () => {
 const workflow=fs.readFileSync(path.join(__dirname,'../../.github/workflows/release.yml'),'utf8');
 const build=workflow.split('- name: Build, verify first launch and restart, then package')[1].split('- name: Verify native overlay')[0];
 assert.match(build, /Join-Path \$runnerTemp 'cloud-build-output-v1'/);
 assert.match(build, /\$buildRoot\.StartsWith\(\$runnerTemp \+ '\\'/);
 assert.match(build, /生成安装包\.ps1 -StarterTemplate -NoPause -BuildOutputRoot \$buildRoot/);
 const diagnostics=workflow.split('name: windows-build-logs-')[1].split('- name: Report diagnostic upload failure')[0];
 for(const suffix of ['构建日志-*.txt','component-build-logs/*.log','component-build-timings.json','build-timings.json'])
   assert.ok(diagnostics.includes('${{ runner.temp }}/cloud-build-output-v1/release-*/'+suffix));
 assert.doesNotMatch(diagnostics,/private\/|Unity\.ulf|account-(?:activate|return)-(?:stdout|stderr)|UNITY_(?:EMAIL|PASSWORD)/);
 assert.match(workflow,/needs\.package\.result == 'success'/);
});
