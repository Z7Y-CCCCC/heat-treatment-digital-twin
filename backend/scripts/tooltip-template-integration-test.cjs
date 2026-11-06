// All writes are confined to a freshly seeded output/ database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');

async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
async function main() {
    const root = createRunDirectory('tooltip-template-integration');
    const filename = path.join(root, 'factory.db');
    await createTestDatabase(filename);
    Object.assign(process.env,{APP_DATA_DIR:root,DB_TYPE:'sqlite',SQLITE_FILE:filename,DB_BACKUP_DIR:path.join(root,'backups'),DB_RECOVERY_DIR:path.join(root,'recovery'),DATA_SOURCE_BACKUP_DIR:path.join(root,'data-source-backups')});
    fs.writeFileSync(path.join(root,'database-config.json'),JSON.stringify({type:'sqlite',filename}));
    const database = require('../db/database');
    const documents = require('../services/dashboardDocuments');
    const { normalizeDocument } = require('../utils/dashboardDocument');
    let server, upstream;
    const requests=[];
    try {
        const db=await database.getDb();
        const initial=await documents.loadDesignerState(db);
        const factoryId=initial.project.factory_id || 'factory_default';
        const devices=await require('../services/widgetPlayback').playbackDevices(db,factoryId);
        assert.ok(devices.length>=2,'fixture requires two registered devices');
        upstream=http.createServer((req,res)=>{
            const url=new URL(req.url,'http://fixture');
            const deviceId=url.searchParams.get('device');
            requests.push(deviceId);
            res.writeHead(200,{'Content-Type':'application/json'});
            res.end(JSON.stringify({value:deviceId===devices[0].id?101:202,part:url.searchParams.get('part')}));
        });
        const origin=await listen(upstream);
        require('../services/dataSources').saveDataSource({id:'tooltip_api',name:'Tooltip fixture',sourceType:'http_api',baseUrl:origin,authType:'none',healthPath:'/',requestTimeoutMs:1000,factoryId});
        const doc=normalizeDocument(initial.document);
        for (const template of doc.tooltipTemplates.templates) {
            template.widgets=[{...template.widgets.find(widget=>widget.type==='text'),id:'same_nested_id',data:{mode:'http_api',connectionId:'tooltip_api',apiPath:'/state?device={deviceId}&part={partId}',jsonPath:'value',refreshMs:10000,deviceScope:'current',readOnly:true}}];
        }
        doc.scene.views.find(view=>view.mode==='factory').metadata.tooltipTemplates={device:doc.tooltipTemplates.defaults.device,part:'inherit'};
        doc.scene.views.find(view=>view.mode==='workshop').metadata.tooltipTemplates={device:'disabled',part:'inherit'};
        const saved=await documents.saveDraft(db,{sceneId:doc.sceneId,document:doc,expectedRevision:initial.revision});
        assert.equal(saved.document.tooltipTemplates.templates[0].widgets[0].data.connectionId,'tooltip_api');
        const published=await documents.publishDraft(db,{sceneId:doc.sceneId});
        assert.equal(published.document.tooltipTemplates.templates[0].widgets[0].id,'same_nested_id');
        const legacyRows=await db.all('SELECT id FROM widgets WHERE scene_id=?',[doc.sceneId]);
        assert.ok(!legacyRows.some(row=>row.id==='same_nested_id'),'nested widgets must not enter the main widget table');
        const invalid=JSON.parse(JSON.stringify(saved.document));
        invalid.tooltipTemplates.templates[0].widgets[0].data={mode:'dataset',datasetId:'missing',datasetField:'value'};
        await assert.rejects(documents.saveDraft(db,{sceneId:doc.sceneId,document:invalid,expectedRevision:saved.revision}),/数据集不存在/);
        const express=require('express'),app=express();
        app.use((req,res,next)=>{req.factoryId=factoryId;next();});
        app.use('/api/data-sources',require('../routes/dataSources'));
        server=http.createServer(app);
        const base=await listen(server);
        const get=async changes=>{
            const params=new URLSearchParams({view_id:doc.scene.views.find(view=>view.mode==='factory').id,scene_id:doc.sceneId,tooltip_template_id:doc.tooltipTemplates.defaults.device,device_id:devices[0].id,widget_ids:'same_nested_id',...changes});
            const response=await fetch(`${base}/api/data-sources/runtime-values?${params}`);
            return {response,body:await response.json()};
        };
        const a=await get({device_id:devices[0].id});
        assert.equal(a.response.status,200,JSON.stringify(a.body));
        assert.equal(a.body.values.same_nested_id.value,101);
        const b=await get({device_id:devices[1].id});
        assert.equal(b.response.status,200,JSON.stringify(b.body));
        assert.equal(b.body.values.same_nested_id.value,202,'changing hover must change HTTP request/cache scope, not rotate');
        assert.deepEqual(requests.slice(-2),[devices[0].id,devices[1].id]);
        const off=await get({view_id:doc.scene.views.find(view=>view.mode==='workshop').id});
        assert.equal(off.response.status,400,'disabled view cannot read the template');
        const foreign=await get({device_id:'foreign_device'});
        assert.equal(foreign.response.status,400,'hover cannot access another factory device');
        const wrongKind=await get({tooltip_template_id:doc.tooltipTemplates.defaults.part});
        assert.equal(wrongKind.response.status,400,'part template is not a factory device tooltip');
        const mainCanvas=await get({tooltip_template_id:''});
        assert.deepEqual(mainCanvas.body.values,{},'nested IDs are not main-canvas bindings');
        console.log(JSON.stringify({success:true,checks:['nested save/publish','main-canvas isolation','nested binding validation','hover-specific HTTP parameters/cache','disabled/kind/factory guard'],directory:root},null,2));
    } finally { await close(server); await close(upstream); await database.closeDb(); }
}
main().catch(error=>{console.error(error.stack || error);process.exitCode=1;});
