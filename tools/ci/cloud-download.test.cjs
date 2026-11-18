'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');
const helper=path.resolve(__dirname,'cloud-download.ps1');
const shell=fs.existsSync('C:/Program Files/PowerShell/7/pwsh.exe')?'C:/Program Files/PowerShell/7/pwsh.exe':'powershell.exe';
const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";
const winTest=(name,fn)=>test(name,{skip:process.platform!=='win32',timeout:45000},fn);
function temporary(t){
 const parent=fs.realpathSync.native(os.tmpdir()),root=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'cloud-download-test-')));
 assert.ok(root.startsWith(parent+path.sep));
 t.after(()=>{const resolved=fs.realpathSync.native(root);assert.equal(resolved,root);assert.ok(resolved.startsWith(parent+path.sep)&&path.basename(resolved).startsWith('cloud-download-test-'));fs.rmSync(resolved,{recursive:true,force:true});});
 return root;
}
async function serverFixture(t,handler){
 const server=http.createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return 'http://127.0.0.1:'+server.address().port+'/fixture';
}
async function download(root,url,size,{partial=path.join(root,'payload.partial'),env={},attempts=2}={}){
 const script=path.join(root,'download-probe.ps1');
 fs.writeFileSync(script,'\uFEFF'+[
  "$ErrorActionPreference='Stop'",
  '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)',
  '. '+quote(helper),
  'Save-ResumableCloudDownload -Partial '+quote(partial)+' -Url '+quote(url)+' -Size '+size+' -MaxAttempts '+attempts+' -MaxTimeSeconds 5'
 ].join('\n'),'utf8');
 return new Promise((resolve,reject)=>{
  const child=spawn(shell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{
   windowsHide:true,env:{...process.env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_TEMP:root,NO_PROXY:'127.0.0.1',...env}
  });
  let stdout='',stderr='';const timeout=setTimeout(()=>child.kill(),40000);
  child.stdout.on('data',bytes=>stdout+=bytes.toString('utf8'));child.stderr.on('data',bytes=>stderr+=bytes.toString('utf8'));
  child.on('error',error=>{clearTimeout(timeout);reject(error);});
  child.on('close',(code,signal)=>{clearTimeout(timeout);resolve({code,signal,stdout,stderr,partial});});
 });
}
winTest('actual curl resumes a reset HTTP response from retained bytes rather than redownloading',async t=>{
 const root=temporary(t),data=Buffer.alloc(32768);for(let i=0;i<data.length;i++)data[i]=i%251;
 const requests=[];
 const url=await serverFixture(t,(req,res)=>{
  requests.push(req.headers.range||'');
  if(requests.length===1){res.writeHead(200,{'Content-Length':data.length});res.write(data.subarray(0,8192));setTimeout(()=>res.destroy(),150);}
  else{const match=/^bytes=(\d+)-$/.exec(req.headers.range||'');if(!match){res.writeHead(400);res.end();return;}const offset=Number(match[1]);res.writeHead(206,{'Content-Range':'bytes '+offset+'-'+(data.length-1)+'/'+data.length,'Content-Length':data.length-offset});res.end(data.subarray(offset));}
 });
 const result=await download(root,url,data.length);
 assert.equal(result.code,0,result.stdout+result.stderr);assert.deepEqual(fs.readFileSync(result.partial),data);
 assert.deepEqual(requests,['','bytes=8192-']);assert.ok(result.stdout.includes('retained 8192/32768 bytes'));
});
winTest('truncated transfers keep progress but cannot exceed the finite attempt budget or claim completion',async t=>{
 const root=temporary(t),data=Buffer.alloc(32768,7);let requests=0;
 const url=await serverFixture(t,(req,res)=>{
  requests++;const match=/^bytes=(\d+)-$/.exec(req.headers.range||''),offset=match?Number(match[1]):0;
  const headers={'Content-Length':data.length-offset};if(offset)headers['Content-Range']='bytes '+offset+'-'+(data.length-1)+'/'+data.length;
  res.writeHead(offset?206:200,headers);res.write(data.subarray(offset,offset+1024));setTimeout(()=>res.destroy(),150);
 });
 const result=await download(root,url,data.length);assert.notEqual(result.code,0);assert.equal(requests,2);
 assert.match(result.stdout+result.stderr,/failed after bounded resumable attempts/);assert.equal(fs.statSync(result.partial).size,2048);
});
winTest('ignored HTTP Range fails without replacing or duplicating the existing partial content',async t=>{
 const root=temporary(t),data=Buffer.alloc(32768,9),partial=path.join(root,'payload.partial');fs.writeFileSync(partial,data.subarray(0,8192));let requests=0;
 const url=await serverFixture(t,(req,res)=>{requests++;res.writeHead(200,{'Content-Length':data.length});res.end(data);});
 const result=await download(root,url,data.length);assert.notEqual(result.code,0);assert.equal(requests,1);
 assert.match(result.stdout+result.stderr,/refused a safe resumable transfer/);assert.deepEqual(fs.readFileSync(partial),data.subarray(0,8192));
});
winTest('unsafe paths, non-cloud environments and oversized partials fail before network or file mutation',async t=>{
 const root=temporary(t);let requests=0;const url=await serverFixture(t,(_req,res)=>{requests++;res.end('not expected');});
 const outside=root+'-outside.partial';assert.equal(fs.existsSync(outside),false);
 const escaped=await download(root,url,8,{partial:outside});assert.notEqual(escaped.code,0);assert.match(escaped.stdout+escaped.stderr,/inside RUNNER_TEMP/);assert.equal(fs.existsSync(outside),false);
 const local=await download(root,url,8,{env:{RUNNER_ENVIRONMENT:'self-hosted'}});assert.notEqual(local.code,0);assert.match(local.stdout+local.stderr,/isolated hosted runner/);
 const injected=await download(root,url+'" --output untrusted',8);assert.notEqual(injected.code,0);assert.match(injected.stdout+injected.stderr,/Unsafe native download argument/);
 const partial=path.join(root,'payload.partial'),bytes=Buffer.alloc(9,3);fs.writeFileSync(partial,bytes);
 const oversized=await download(root,url,8);assert.notEqual(oversized.code,0);assert.match(oversized.stdout+oversized.stderr,/exceeds the pinned byte size/);assert.deepEqual(fs.readFileSync(partial),bytes);assert.equal(requests,0);
});
test('resumption never replaces the fixed size, complete SHA-256 or pinned official signature gates',()=>{
 const setup=fs.readFileSync(path.join(__dirname,'setup-cloud-runner.ps1'),'utf8').replace(/\r\n/g,'\n');
 const block=setup.slice(setup.indexOf('function Download-Verified'),setup.indexOf('if (-not $CheckOnly)'));
 assert.ok(setup.includes(". (Join-Path $workspace 'tools/ci/cloud-download.ps1')"));
 assert.match(block,/Save-ResumableCloudDownload -Partial \$partial -Url \$Url -Size \$Size/);
 for(const gate of ['Length -ne $Size','Get-FileHash -LiteralPath $partial -Algorithm SHA256','Assert-UnityInstaller $partial']){
  assert.ok(block.indexOf(gate)>block.indexOf('Save-ResumableCloudDownload'));
  assert.ok(block.indexOf(gate)<block.indexOf('Move-Item -LiteralPath $partial'));
 }
 const downloadSource=fs.readFileSync(helper,'utf8');for(const call of downloadSource.split('\n').filter(line=>line.includes('Start-Process -FilePath')))assert.match(call,/-WindowStyle Hidden -Wait -PassThru/);
 assert.match(setup,/signature.Status -ne 'Valid'/);assert.match(setup,/SignerCertificate.Thumbprint -ne \$config.unity.signerThumbprint/);
});
