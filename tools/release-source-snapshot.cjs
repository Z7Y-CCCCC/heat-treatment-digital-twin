'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fileDigest } = require('../desktop/scripts/file-digest.cjs');
function installerOnlyFile(name) {
  return /^(?:docs\/|tools\/|\.github\/)/.test(name)
    || /(?:^|\/)README[^/]*\.md$/i.test(name)
    || name === '生成安装包.ps1'
    || /^desktop\/scripts\/[^/]+(?:-test|\.test)\.cjs$/.test(name)
    || /^desktop\/(?:display-installer(?:-ui)?\.nsh|assets\/installer-[^/]+\.(?:bmp|bin|json)|scripts\/(?:installer-[^/]+|create-installer-[^/]+|nsis-toolchain)\.cjs)$/.test(name);
}
function sourceSnapshot(root) {
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
  const files = [];
  for (const name of [...names].sort()) {
    if (installerOnlyFile(name)) continue;
    // This file is derived from installed dependencies and prepared runtimes.
    // Check it against the verified payload separately, after resource staging.
    if (name === 'desktop/THIRD_PARTY_NOTICES.txt') continue;
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue; // deletions change the complete file set
    if (!fs.statSync(file).isFile()) throw Error('Unsupported source input: '+name);
    files.push({name, ...fileDigest(file)});
  }
  const env=Object.keys(process.env).filter(k=>/^(VITE_|NODE_OPTIONS$|NODE_ENV$)/.test(k)).sort().map(k=>[k,process.env[k]]);
  if(env.length) {
    const data=Buffer.from(JSON.stringify(env));
    files.push({name:'<frontend-build-environment>',size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});
  }
  return {schema:1, files, sha256:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')};
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
  if (mode === 'record') fs.writeFileSync(file, JSON.stringify(sourceSnapshot(root),null,2));
  else if (mode === 'verify') verifySource(root, JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
  else throw Error('Expected record or verify');
}
module.exports = {installerOnlyFile, sourceSnapshot, verifySource};
