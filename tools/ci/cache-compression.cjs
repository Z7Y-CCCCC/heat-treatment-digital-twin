'use strict';
// actions/cache prefers Git's GNU tar on Windows. tar invokes gzip through
// its POSIX shell, so finding tar.exe alone is not a sufficient prerequisite.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
function compressionDirectory(gitPaths) {
  for(const git of gitPaths) {
    if(!path.isAbsolute(git)||/[\r\n\0]/.test(git))continue;
    for(const directory of [path.dirname(git),path.resolve(path.dirname(git),'../usr/bin')])
      if(['tar.exe','gzip.exe','sh.exe'].every(name=>fs.existsSync(path.join(directory,name))&&fs.statSync(path.join(directory,name)).isFile()))return directory;
  }
  throw Error('Git GNU tar/gzip/sh are required for Windows CI cache compression');
}
function configureCacheCompression(env=process.env) {
  for(const key of ['RUNNER_TEMP','GITHUB_PATH'])if(!path.isAbsolute(env[key]||''))throw Error('Absolute runner temp and GITHUB_PATH are required');
  const directory=compressionDirectory(execFileSync('where.exe',['git.exe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/));
  const stage=fs.mkdtempSync(path.join(env.RUNNER_TEMP,'cache-codec-'));
  try {
    const input=path.join(stage,'input'),output=path.join(stage,'output'),archive=path.join(stage,'cache.tgz');
    fs.mkdirSync(input);fs.mkdirSync(output);
    const bytes=Buffer.from('Cache codec verification: 天津 🏭\n\0\xff','utf8');fs.writeFileSync(path.join(input,'probe.bin'),bytes);
    const childEnv={...env,PATH:directory+path.delimiter+(env.PATH||env.Path||'')};
    const tar=path.join(directory,'tar.exe'),posix=file=>file.replace(/\\/g,'/');
    execFileSync(tar,['--posix','-czf',posix(archive),'--force-local','-C',posix(input),'.'],{env:childEnv,windowsHide:true,stdio:'pipe',timeout:30000});
    assert.equal(fs.readFileSync(archive).readUInt16BE(0),0x1f8b,'Cache must actually be gzip encoded');
    execFileSync(tar,['-xzf',posix(archive),'--force-local','-C',posix(output)],{env:childEnv,windowsHide:true,stdio:'pipe',timeout:30000});
    assert.deepEqual(fs.readFileSync(path.join(output,'probe.bin')),bytes,'Cache compression changed fixture bytes');
    // Only export after the real tar -> sh -> gzip -> tar roundtrip succeeds.
    fs.appendFileSync(env.GITHUB_PATH,directory+'\n','utf8');
    return {directory,roundtripPassed:true};
  } finally {
    assert.equal(path.dirname(stage).toLowerCase(),fs.realpathSync(env.RUNNER_TEMP).toLowerCase());
    assert.match(path.basename(stage),/^cache-codec-[^\\/]+$/);
    fs.rmSync(stage,{recursive:true,force:true});
  }
}
if(require.main===module)console.log(JSON.stringify(configureCacheCompression()));
module.exports={compressionDirectory,configureCacheCompression};
