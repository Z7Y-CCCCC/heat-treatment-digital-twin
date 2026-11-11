'use strict';
const fs=require('node:fs'),path=require('node:path');
function collectorCenterExecutable({projectRoot,env=process.env}={}){
    const machine=env.DIGITAL_TWIN_COLLECTOR_CONFIG||path.join(env.ProgramData||env.PROGRAMDATA||'C:\\ProgramData','HeatTreatmentDigitalTwin','collector-service.json');
    const roots=[];
    if(fs.existsSync(machine)){
        const config=JSON.parse(fs.readFileSync(machine,'utf8').replace(/^\uFEFF/,''));
        if(!path.isAbsolute(String(config.resourcesRoot||'')))throw Error('采集服务资源目录配置无效');
        roots.push(path.dirname(config.resourcesRoot));
    }else{
        roots.push(path.join(env.ProgramFiles||'C:\\Program Files','HeatTreatmentCollectorPlugin'));
        if(projectRoot)roots.push(path.join(projectRoot,'collector-runtime'));
    }
    for(const root of roots){
        const exe=path.join(root,'resources','collector-center','HeatTreatmentCollectorCenter.exe');
        if(!fs.existsSync(exe))continue;
        const manifest=path.join(root,'plugin-manifest.json');
        if(!fs.existsSync(manifest)||JSON.parse(fs.readFileSync(manifest,'utf8')).product!=='collector-plugin')throw Error('采集运行中心不是完整的独立安装包');
        return exe;
    }
    throw Error('未找到独立采集运行中心。请安装完整的采集运行中心包；大屏安装目录不包含采集服务。');
}
module.exports={collectorCenterExecutable};
