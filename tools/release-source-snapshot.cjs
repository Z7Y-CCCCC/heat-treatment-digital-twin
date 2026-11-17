'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fileDigest } = require('../desktop/scripts/file-digest.cjs');
function installerOnlyFile(name) {
  return /^(?:docs\/|tools\/|\.github\/)/.test(name)
    || /(?:^|\/)README[^/]*\.md$/i.test(name)
    || name === '生成安装包.ps1'
    || /^desktop\/scripts\/[^/]+(?:-test|\.test)\.cjs$/.test(name)
    || /^desktop\/(?:display-installer(?:-ui)?\.nsh|assets\/installer-[^/]+\.(?:bmp|bin|json|png)|scripts\/(?:installer-[^/]+|create-installer-[^/]+|nsis-toolchain)\.cjs)$/.test(name);
}
function sourceNames(root) {
  const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {windowsHide:true, encoding:'utf8', maxBuffer:16*1024*1024});
  const names = new Set(listed.split('\0').filter(Boolean));
  function visit(relative) {
    const absolute=path.join(root,relative);
    if(!fs.existsSync(absolute))return;
    if(fs.statSync(absolute).isDirectory())for(const child of fs.readdirSync(absolute))visit(relative+'/'+child);
    else names.add(relative);
  }
  // Vite also consumes ignored local environment files and public assets.
  // Their contents must invalidate reuse just like tracked source edits.
  for(const dir of ['frontend/src','frontend/public','frontend/scripts'])visit(dir);
  if(fs.existsSync(path.join(root,'frontend')))for(const name of fs.readdirSync(path.join(root,'frontend')))if(/^\.env(?:\..*)?$/.test(name))names.add('frontend/'+name);
  return [...names].sort().filter(name => {
    if (installerOnlyFile(name)) return false;
    // This file is derived from installed dependencies and prepared runtimes.
    // Check it against the verified payload separately, after resource staging.
    if (name === 'desktop/THIRD_PARTY_NOTICES.txt') return false;
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return false; // deletions change the complete file set
    if (!fs.statSync(file).isFile()) throw Error('Unsupported source input: '+name);
    return true;
  });
}
function snapshotResult(files) {
  const env=Object.keys(process.env).filter(k=>/^(VITE_|NODE_OPTIONS$|NODE_ENV$)/.test(k)).sort().map(k=>[k,process.env[k]]);
  if(env.length) {
    const data=Buffer.from(JSON.stringify(env));
    files.push({name:'<frontend-build-environment>',size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});
  }
  return {schema:1, files, sha256:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
function sourceSnapshot(root) {
  return snapshotResult(sourceNames(root).map(name=>({name,...fileDigest(path.join(root,name))})));
}
async function digestSourceFile(file) {
  const before=await fs.promises.stat(file,{bigint:true}),hash=crypto.createHash('sha256');
  let size=0;
  for await(const chunk of fs.createReadStream(file,{highWaterMark:1024*1024})) {hash.update(chunk);size+=chunk.length;}
  const after=await fs.promises.stat(file,{bigint:true});
  for(const key of ['size','mtimeNs','ctimeNs','ino','dev'])if(before[key]!==after[key])throw Error('Source input changed while hashing: '+file);
  if(BigInt(size)!==after.size)throw Error('Source input size changed while hashing: '+file);
  return {size,sha256:hash.digest('hex')};
}
async function sourceSnapshotAsync(root,{concurrency=8}={}) {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw Error('Source hashing concurrency must be 1-16');
  const names=sourceNames(root),files=new Array(names.length);let next=0;
  await Promise.all(Array.from({length:Math.min(concurrency,names.length)},async()=>{
    while(next<names.length){const index=next++,name=names[index];files[index]={name,...await digestSourceFile(path.join(root,name))};}
  }));
  if(JSON.stringify(sourceNames(root))!==JSON.stringify(names))throw Error('Source input file set changed while hashing');
  return snapshotResult(files);
}
function verifySource(root, expected) {
  if (expected?.schema !== 1 || !Array.isArray(expected.files)) throw Error('Missing source snapshot');
  const actual = sourceSnapshot(root);
  if (actual.sha256 !== expected.sha256 || JSON.stringify(actual.files) !== JSON.stringify(expected.files)) {
    throw Error('Application inputs changed; a full build is required');
  }
  return actual;
}
if (require.main === module) {
  const [mode, root, file] = process.argv.slice(2);
  (async()=>{
    if(!['record','verify'].includes(mode))throw Error('Expected record or verify');
    const actual=await sourceSnapshotAsync(root);
    if(mode==='record')fs.writeFileSync(file,JSON.stringify(actual,null,2));
    else {
      const expected=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
      if(expected?.schema!==1||actual.sha256!==expected.sha256||JSON.stringify(actual.files)!==JSON.stringify(expected.files))throw Error('Application inputs changed; a full build is required');
    }
  })().catch(error=>{console.error(error.stack);process.exitCode=1;});
}
module.exports = {installerOnlyFile, sourceSnapshot, sourceSnapshotAsync, digestSourceFile, verifySource};
