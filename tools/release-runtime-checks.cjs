'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
async function runChecks(executable, pluginResources, output) {
  fs.mkdirSync(output,{recursive:true});
  const stages=[],started=performance.now();
  function check(name,script,args) {
    console.log('验证开始：'+name);
    return new Promise(resolve=>{
      const log=fs.createWriteStream(path.join(output,name+'.log'));
      const start=performance.now();
      const child=spawn(process.execPath,[path.join(__dirname,script),...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
      let launchError;
      child.once('error',error=>{launchError=error.message;});
      child.once('close',(code,signal)=>{
        log.end();
        const result={name,exitCode:code??-1,signal,error:launchError,seconds:+((performance.now()-start)/1000).toFixed(3)};
        stages.push(result);console.log(`验证结束：${name}，${result.seconds} 秒，退出码 ${result.exitCode}`);resolve(result);
      });
    });
  }
  // Migration chooses an ephemeral port. Collector and first-launch both use
  // the production private-MySQL port search, so keep those two serial to avoid
  // a check-then-bind race. Each fixture owns separate data and cleanup paths.
  const results=await Promise.allSettled([
    (async()=>{await check('collector','collector-service-smoke-test.cjs',[pluginResources]);await check('first-launch','packaged-mysql-smoke-test.cjs',[executable]);})(),
    check('project-migration','packaged-project-bundle-mysql-test.cjs',[executable])
  ]);
  const success=results.every(r=>r.status==='fulfilled') && stages.length===3 && stages.every(r=>r.exitCode===0);
  const report={success,totalSeconds:+((performance.now()-started)/1000).toFixed(3),stages};
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
  if(!success)throw Error('运行验证失败，请查看 '+output);
  return report;
}
if(require.main===module)runChecks(...process.argv.slice(2)).catch(error=>{console.error(error.stack);process.exitCode=1;});
module.exports={runChecks};
