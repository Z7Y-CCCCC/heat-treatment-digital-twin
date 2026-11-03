const { playbackSelection } = require('../../shared/widgetPlayback.mjs');
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
    const result={},groups=new Map();
    for(const widget of widgets) {
        const selection=playbackSelection(widget.data,context,context.playbackDevices,context.playbackAt);
        if(!selection.device){result[widget.id]={value:null,rows:[],series:[],quality:'bad',deviceId:'',error:'当前范围没有可读取的设备'};continue;}
        const id=selection.device.id;
        if(!groups.has(id))groups.set(id,{device:selection.device,widgets:[]});
        groups.get(id).widgets.push({...widget,data:{...widget.data,deviceScope:'current',deviceId:id}});
    }
    const jobs=[...groups.values()];let index=0;
    await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(index<jobs.length){
        const job=jobs[index++], next={...context,playbackResolved:true,deviceId:job.device.id,lineId:job.device.lineId,workshopId:job.device.workshopId};
        delete next.playbackDevices;
        // The clock selects a device; it is not part of its data/cache identity.
        delete next.playbackAt;
        const values=await read(job.widgets,next);
        for(const [key,value] of Object.entries(values))result[key]={...value,deviceId:job.device.id,deviceName:job.device.name};
    }}));return result;
}
module.exports={playbackDevices,readPlaybackBindings};
