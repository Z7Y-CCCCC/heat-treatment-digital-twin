// Owned empty-install backend + actual Vue component; no operator profile/PLC.
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {createServer} from '../frontend/node_modules/vite/dist/node/index.js'
const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const {createLinkageFixture}=require('../backend/scripts/realtime-linkage-fixture.cjs')
const fixture=await createLinkageFixture('device-action-binding-browser',{emptyInstallation:true})
const {sql,targetId,ok}=fixture
sql.prepare('UPDATE devices SET name=? WHERE id=?').run('2号多用炉',targetId)
sql.prepare('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES (?,?,?,?,?,?,?,?,?)')
 .run(targetId,'door','炉门到位','DB1.DBX0.0','BOOL','doors','door','READ',1000)
const route='/api/devices/'+targetId+'/animations'
const server=await createServer({root:path.join(root,'frontend'),server:{host:'127.0.0.1',port:Number(process.env.BINDING_PREVIEW_PORT||3971),strictPort:true,open:false},plugins:[{
 name:'owned-binding-fixture',enforce:'pre',
 transform(code,id){if(id.replaceAll('\\','/').endsWith('/DeviceAnimationLink.vue'))return code.replace(/import \{ createDashboardDataStore \} from [^\n]+/,'const createDashboardDataStore=()=>({wsConnected:ref(false),connect(){},dispose(){},setDeviceDataHandler(){},setMotionInputHandler(){}})')},
 configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,'http://127.0.0.1')
  if(url.pathname.startsWith('/__binding-')){
   res.setHeader('Content-Type','application/json; charset=utf-8')
   try{
    if(url.pathname==='/__binding-fixture'&&req.method==='GET')return res.end(JSON.stringify({device:await ok('/api/devices/'+targetId),models:await ok('/api/models'),points:await ok('/api/datapoints?device_id='+targetId),catalog:await ok('/api/data-center/catalog?device_id='+targetId)}))
    if(url.pathname==='/__binding-state'&&req.method==='GET')return res.end(JSON.stringify(await ok(route)))
    if(url.pathname==='/__binding-save'&&req.method==='POST'){
     let body='';for await(const chunk of req){body+=chunk;if(body.length>131072)throw Error('Fixture body too large')}
     return res.end(JSON.stringify(await ok(route,'PUT',JSON.parse(body))))
    }
    if(url.pathname==='/__binding-close'&&req.method==='POST'){res.end('{"closing":true}');setTimeout(()=>close(),30);return}
    res.statusCode=405;return res.end('{"error":"Fixture route/method not allowed"}')
   }catch(error){res.statusCode=400;return res.end(JSON.stringify({error:error.message}))}
  }
  if(url.pathname.startsWith('/api/')||url.pathname==='/ws'){res.statusCode=403;res.end('No operator API/PLC access from this fixture');return}
  next()
 })}
}]})
let closing=false
async function close(){if(closing)return;closing=true;await server.close();await fixture.close();process.exit(0)}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,close)
await server.listen()
console.log(JSON.stringify({origin:`http://127.0.0.1:${server.config.server.port}`,page:'/tests/fixtures/device-action-binding-preview.html',isolated:true,pid:process.pid,directory:fixture.directory}))
