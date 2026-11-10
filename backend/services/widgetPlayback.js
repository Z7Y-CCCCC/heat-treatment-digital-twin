const { playbackSelection } = require('../../shared/widgetPlayback.mjs');
const { bindingForDevice } = require('../../shared/widgetBindingWorkflow.mjs');
const externalModes=new Set(['dataset','database','http_api','business']);
const cache=new Map();
async function playbackDevices(db,factoryId) {
    const previous=cache.get(factoryId);
    if(previous && Date.now()-previous.at<2000)return previous.rows;
    const workshops=await db.all('SELECT id FROM workshops WHERE factory_id=?',[factoryId]);
    const lines=await db.all('SELECT l.id,l.workshop_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=?',[factoryId]);
    const ws=new Set(workshops.map(w=>String(w.id))),byLine=new Map(lines.map(l=>[String(l.id),l]));
    const all=await db.all('SELECT id,name,line_id,instance_config FROM devices ORDER BY line_id,sort_order,id');
    const rows=all.flatMap(d=>{let config={};try{config=JSON.parse(d.instance_config || '{}')}catch{}
        if(d.line_id && !byLine.has(String(d.line_id)))return [];
        const line=byLine.get(String(d.line_id)),workshopId=String(line?.workshop_id || config.workshop_id || config.workshopId || '');
        return ws.has(workshopId)?[{id:String(d.id),name:d.name,lineId:String(line?.id || ''),workshopId}]:[];
    }).slice(0,5000);
    if(cache.size>=64)cache.delete(cache.keys().next().value);
    cache.set(factoryId,{at:Date.now(),rows});return rows;
}
async function readPlaybackBindings(widgets,context,read) {
    const result={},groups=new Map(),parents=[],values={},usedIds=new Set(widgets.map(widget=>String(widget.id)));
    const globalDevice={id:'',name:'',lineId:'',workshopId:''};
    const groupFor=device=>{
        if(!groups.has(device.id))groups.set(device.id,{device,widgets:[]});
        return groups.get(device.id);
    };
    let metricId=0;
    for(const widget of widgets) {
        if(widget.data?.deviceScope==='global'){
            groupFor(globalDevice).widgets.push(widget);
            parents.push({widget,device:globalDevice,metrics:{},targets:[]});continue;
        }
        const selection=playbackSelection(widget.data,context,context.playbackDevices,context.playbackAt);
        if(!selection.device){result[widget.id]={value:null,rows:[],series:[],quality:'bad',deviceId:'',error:'当前范围没有可读取的设备'};continue;}
        const id=selection.device.id;
        const binding=bindingForDevice(widget.data,id);
        if(binding.bindingMissing){result[widget.id]={value:null,rows:[],quality:'bad',deviceId:id,error:'该设备未选择对应数据'};continue;}
        groupFor(selection.device).widgets.push({...widget,data:{...binding,deviceScope:'current',deviceId:id}});
        parents.push({widget,device:selection.device,metrics:{},targets:[]});
    }
    for(const parent of parents){
        (parent.widget.content?.items || []).forEach((item,index)=>{
            if(!item.binding)return;
            const metricDeviceId=!parent.device.id && item.binding.deviceScope==='fixed' ? String(item.binding.deviceId || '') : parent.device.id;
            const source=bindingForDevice(item.binding,metricDeviceId);
            if(source.bindingMissing){
                parent.metrics[index]={value:null,rows:[],series:[],quality:'bad',deviceId:metricDeviceId,error:'该设备未选择对应指标数据'};return;
            }
            if(!externalModes.has(source.mode))return;
            let device=source.deviceScope==='global' ? globalDevice : parent.device;
            if(!parent.device.id && source.deviceScope==='fixed'){
                device=(context.playbackDevices || []).find(device=>String(device.id)===String(source.deviceId));
                if(!device){parent.metrics[index]={value:null,rows:[],series:[],quality:'bad',deviceId:String(source.deviceId || ''),error:'指标指定设备不存在或不属于当前工厂'};return;}
            }
            let id;do{id=`__binding_metric_${metricId++}`}while(usedIds.has(id));usedIds.add(id);
            groupFor(device).widgets.push({id,data:source.deviceScope==='global' ? source : {...source,deviceScope:'current',deviceId:device.id}});
            parent.targets.push({id,index,device});
        });
    }
    const jobs=[...groups.values()];let index=0;
    await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(index<jobs.length){
        const job=jobs[index++], next={...context,playbackResolved:true,deviceId:job.device.id,lineId:job.device.lineId,workshopId:job.device.workshopId};
        delete next.playbackDevices;
        // The clock selects a device; it is not part of its data/cache identity.
        delete next.playbackAt;
        if(!job.device.id || job.device.id!==String(context.deviceId || ''))delete next.partId;
        // A <=20-card request can expand into hundreds of HUD metric targets.
        // Keep each device lane sequential and below every lower reader's cap
        // (database/dataset 100, HTTP 30, business 20), without dropping keys.
        for(let offset=0;offset<job.widgets.length;offset+=20)Object.assign(values,await read(job.widgets.slice(offset,offset+20),next));
    }}));
    for(const parent of parents){
        for(const target of parent.targets)parent.metrics[target.index]={...(values[target.id] || {value:null,rows:[],series:[],quality:'bad',error:'指标数据暂不可用'}),deviceId:target.device.id};
        const record={...values[parent.widget.id],metrics:parent.metrics,deviceId:parent.device.id,deviceName:parent.device.name};
        const freshness=[values[parent.widget.id],...Object.values(parent.metrics)].map(value=>value?.refreshAfterMs).filter(value=>Number.isFinite(value));
        if(freshness.length)record.refreshAfterMs=Math.min(...freshness);
        result[parent.widget.id]=record;
    }
    return result;
}
module.exports={playbackDevices,readPlaybackBindings};
