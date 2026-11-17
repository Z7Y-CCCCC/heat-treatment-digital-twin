'use strict';
const fs=require('node:fs'),path=require('node:path');
function releaseFrontend(executable) {
  return path.join(path.dirname(path.resolve(executable)),'resources','frontend');
}
function resolveSmokeFrontend(resources,explicit) {
  const directory=path.resolve(explicit||path.join(resources,'frontend'));
  if(!fs.existsSync(path.join(directory,'index.html')))throw Error('采集验收必须使用本次大屏发行版的完整前端；请通过 --frontend 指定，不能回退到开发目录：'+directory);
  return directory;
}
module.exports={releaseFrontend,resolveSmokeFrontend};
