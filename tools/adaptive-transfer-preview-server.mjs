import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from '../frontend/node_modules/vite/dist/node/index.js'
import {createAdaptiveTransferFixture} from './adaptive-transfer-fixture.mjs'
import {createLinkageUsabilityFixture} from './linkage-usability-fixture.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const server=await createServer({root:path.join(root,'frontend'),server:{host:'127.0.0.1',port:Number(process.env.ADAPTIVE_PREVIEW_PORT||3968),strictPort:true,open:false},plugins:[{name:'isolated-adaptive-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/fixture.json'){
  if(req.method!=='GET'){res.statusCode=405;res.end();return}
  res.setHeader('Content-Type','application/json; charset=utf-8');
  try{res.end(JSON.stringify(await (url.searchParams.get('sample')==='eight'?createLinkageUsabilityFixture():createAdaptiveTransferFixture({kind:url.searchParams.get('kind')||'single-negative',micro:Number(url.searchParams.get('micro')||0)}))))}catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}))}return
 }
 if(url.pathname.startsWith('/api/')||url.pathname==='/ws'){res.statusCode=403;res.end('Isolated fixture: no API or PLC access');return}
 if(url.pathname.startsWith('/assets/models/')){
  const name=url.pathname.slice('/assets/models/'.length);if(!/^cad_[a-z0-9_]+\.glb$/.test(name)){res.statusCode=403;res.end();return}
  const file=path.join(root,'backend/assets/models',name);if(!fs.existsSync(file)){res.statusCode=404;res.end();return}
  res.setHeader('Content-Type','model/gltf-binary');fs.createReadStream(file).pipe(res);return
 }
 next()
})}}]})
await server.listen();console.log(JSON.stringify({origin:`http://127.0.0.1:${server.config.server.port}`,page:'/tests/fixtures/adaptive-transfer-preview.html',isolated:true,pid:process.pid}))
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.close();process.exit(0)})
