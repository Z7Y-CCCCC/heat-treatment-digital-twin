'use strict';
// Real Vue + isolated HTTP API/database. Only the model-preview renderer is
// stubbed: this acceptance checks signal authoring, not already-tested picking.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module'), { pathToFileURL } = require('node:url');
const { createLinkageFixture } = require('../backend/scripts/realtime-linkage-fixture.cjs');
const root = path.resolve(__dirname, '..'), front = path.join(root, 'frontend');
let fixture, server, browser;
(async () => {
    fixture = await createLinkageFixture('loading-port-signals-ui');
    const { directory, sql, cartId, targetId } = fixture, points = {};
    for (const id of [cartId, targetId]) {
        points[id] = ['inlet', 'outlet'].map(kind => String(sql.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(id, kind, kind === 'inlet' ? '开始取料／进料中' : '开始送料／出料中', 'fixture-only', 'BOOL', 'status', kind, 'READ', 1000).lastInsertRowid));
    }
    const url = name => '/@fs/' + path.join(root, name).replaceAll('\\', '/');
    const entry = path.join(directory, 'entry.mjs'), html = path.join(directory, 'index.html');
    fs.writeFileSync(entry, `import {createApp,h,ref} from 'vue';
import Workspace from ${JSON.stringify(url('frontend/src/views/admin/components/LoadingPortWorkspace.vue'))};
import {adminApi} from ${JSON.stringify(url('frontend/src/config/factoryConfig.js'))};
import {adminSession} from ${JSON.stringify(url('frontend/src/runtime/adminSession.js'))};
import {normalizePagePermissions} from ${JSON.stringify(url('shared/pagePermissions.mjs'))};
Object.assign(adminSession,{authenticated:true,user:{role:'owner'},pagePermissions:normalizePagePermissions({},{owner:true})});
async function request(id,body){const r=await fetch('/fixture/ports?id='+encodeURIComponent(id),{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error),{status:r.status,code:data.code});return data;}
adminApi.getDeviceLoadingPorts=id=>request(id);adminApi.saveDeviceLoadingPorts=(id,body)=>request(id,body);
const rows=await Promise.all(${JSON.stringify([cartId,targetId])}.map(id=>request(id)));const selected=ref(0);
adminApi.getModelLoadingPorts=async id=>{const row=rows.find(row=>row.model.id===id),metadata=typeof row.model.metadata==='string'?JSON.parse(row.model.metadata):row.model.metadata;return {success:true,model:row.model,ports:metadata.loadingPorts,revision:'fixture-model-read'};};
createApp({render:()=>h('div',[h('nav',rows.map((row,i)=>h('button',{onClick:()=>selected.value=i},i?'固定设备':'小车'))),h(Workspace,{key:selected.value,model:rows[selected.value].model,devices:rows.map(row=>row.device),confirm:async()=>false})])}).mount('#app');`);
    fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#f7f9fc;font:14px 'Microsoft YaHei',sans-serif}button{padding:8px 14px;margin:3px}#app{max-width:1200px;margin:auto}</style><div id="app"></div><script>window.__DIGITAL_TWIN_BACKEND_ORIGIN__=location.origin</script><script type="module" src="${'/@fs/' + entry.replaceAll('\\', '/')}"></script></html>`);
    const frontRequire = createRequire(path.join(front, 'package.json'));
    const { createServer } = await import(pathToFileURL(frontRequire.resolve('vite')).href);
    let saves = 0;
    server = await createServer({ root: front, configFile: path.join(front, 'vite.config.js'), cacheDir: path.join(directory, '.vite'), resolve: { dedupe: ['vue'] }, optimizeDeps: { include: ['vue'] },
        server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }, plugins: [{ name: 'isolated-port-signal-acceptance', enforce: 'pre',
            load(id) { if (id.replaceAll('\\','/').endsWith('/frontend/src/three/LoadingPortPreview.js')) return 'export class LoadingPortPreview{async load(){return []}setPorts(){}setPicking(){}selectNode(){}dispose(){}}'; },
            configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
                if (req.url.startsWith('/api/')) { res.statusCode=503;return res.end('live API blocked'); }
                if (!req.url.startsWith('/fixture/')) return next();
                try {
                    const id = new URL(req.url,'http://fixture').searchParams.get('id'); assert.ok([cartId,targetId].includes(id));
                    let raw='';for await(const chunk of req)raw+=chunk;
                    const result = await fixture.request('/api/devices/'+id+'/loading-ports',req.method==='POST'?'PUT':'GET',raw?JSON.parse(raw):undefined);
                    if(req.method==='POST'&&result.status===200)saves++;
                    res.statusCode=result.status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(result.data));
                } catch(error) {res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
            }); } }] });
    await server.listen(); const origin='http://127.0.0.1:'+server.httpServer.address().port;
    browser=await require(process.env.PLAYWRIGHT_MODULE||'playwright').chromium.launch({headless:true,
        ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
    const page=await browser.newPage({viewport:{width:1360,height:950}}), errors=[];page.setDefaultTimeout(60000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{const request=new URL(route.request().url());return ['http:','https:'].includes(request.protocol)&&request.origin!==origin?route.abort():route.continue();});
    assert.equal((await page.request.get(origin+'/api/health')).status(),503);
    await page.goto(origin+'/@fs/'+html.replaceAll('\\','/'));
    for (const [label,id] of [['小车',cartId],['固定设备',targetId]]) {
        if(label!=='小车')await page.getByRole('button',{name:label,exact:true}).click();
        await page.getByLabel('选择进出料配置设备',{exact:true}).selectOption(id);
        if (id===cartId) await page.getByLabel('小车机构',{exact:true}).selectOption('simple');
        else assert.equal(await page.getByLabel('小车机构',{exact:true}).count(),0);
        const inlet=page.getByLabel('进料取料信号',{exact:true}),outlet=page.getByLabel('出料送料信号',{exact:true});
        await inlet.waitFor();await inlet.selectOption(points[id][0]);await outlet.selectOption(points[id][1]);
        await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByRole('status').filter({hasText:'已保存'}).waitFor();
        const config=JSON.parse(sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(id).instance_config);
        assert.deepEqual(config.loadingPortSignals,{version:1,inletPointId:points[id][0],outletPointId:points[id][1]});
        assert.equal(config.marker,'must survive');assert.deepEqual(config.loadingPortOverrides,{version:1,inlet:null,outlet:null});
        if(id===cartId)assert.deepEqual(config.cartTransfer,{version:1,kind:'rotating',presentation:'simple',turntableNodeName:''});
    }
    await page.reload();await page.getByLabel('选择进出料配置设备',{exact:true}).selectOption(cartId);await page.getByLabel('进料取料信号',{exact:true}).waitFor();assert.equal(await page.getByLabel('进料取料信号',{exact:true}).inputValue(),points[cartId][0]);assert.equal(await page.getByLabel('小车机构',{exact:true}).inputValue(),'simple');
    await page.screenshot({path:path.join(directory,'port-signals-desktop.png'),fullPage:true});await page.setViewportSize({width:760,height:950});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(directory,'port-signals-narrow.png'),fullPage:true});
    assert.equal(saves,2);assert.deepEqual(errors,[]);
    const result={success:true,modelManagementDevicePicker:true,simpleRotatingCartSaved:true,cartAndFixedSignalsSaved:true,realIsolatedApi:true,positionsReused:true,reopened:true,narrowLayout:true,liveApiBlocked:true,previewStubbed:true,directory};
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await server?.close();await fixture?.close();});
