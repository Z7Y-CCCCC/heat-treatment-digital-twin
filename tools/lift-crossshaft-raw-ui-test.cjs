'use strict';
// Pure GLTFLoader visual acceptance, no application pose helper, backend or DB.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), id = 'cad_lifting_load_table_111400';
const directory = path.join(root, 'output/playwright', 'lift-crossshaft-' + Date.now());
const sourceFile = path.join(root, 'backend/assets/models', id + '.glb');
const beforeFile = process.env.LIFT_BEFORE_GLB;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const three = path.join(root, 'frontend/node_modules/three');
fs.mkdirSync(directory, { recursive: true });
const errors = [], checks = [], shots = [];
let browser, server;
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js"}}</script></head>
<body data-state="loading"><script type="module">
import * as T from 'three';
import {GLTFLoader} from '/three/examples/jsm/loaders/GLTFLoader.js';
try {
 const query=new URLSearchParams(location.search),before=query.get('asset')==='before';
 const gltf=await new GLTFLoader().loadAsync(before?'/before.glb':'/source.glb'),root=gltf.scene;
 const scene=new T.Scene();scene.background=new T.Color('#eef4f8');scene.add(root);
 scene.add(new T.HemisphereLight(0xffffff,0x677a7b,1.8));
 for(const position of [[6,8,5],[-5,3,-6]]){const light=new T.DirectionalLight(0xffffff,2);light.position.fromArray(position);scene.add(light)}
 const grid=new T.GridHelper(8,40,0xa9c3d5,0xd4e1ea);grid.position.y=-.01;scene.add(grid);
 root.updateMatrixWorld(true);
 const shaft=root.getObjectByName('${'cad_lifting_staging_table_v1_crossshaft_metal'}'),box=shaft?new T.Box3().setFromObject(shaft):null;
 document.body.dataset.shaft=JSON.stringify(box?{center:box.getCenter(new T.Vector3()).toArray(),size:box.getSize(new T.Vector3()).toArray()}:null);
 const camera=new T.PerspectiveCamera(38,innerWidth/innerHeight,.01,100);
 const view=query.get('view');
 if(view==='front'){camera.position.set(3,.8,0);camera.lookAt(0,.65,0)}
 else if(view==='close'){camera.position.set(1.05,.65,.7);camera.lookAt(0,.57,0)}
 else{camera.position.set(2.6,1.85,2.5);camera.lookAt(0,.63,0)}
 const renderer=new T.WebGLRenderer({antialias:true});renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=T.SRGBColorSpace;document.body.appendChild(renderer.domElement);renderer.render(scene,camera);
 document.body.dataset.state='loaded';
}catch(error){document.body.dataset.state='error';document.body.dataset.error=error.message;throw error}
</script></body></html>`;
(async () => {
 const current = process.env.LIFT_ACTUAL_ORIGIN
  ? Buffer.from(await (await fetch(process.env.LIFT_ACTUAL_ORIGIN + '/assets/models/' + id + '.glb?raw-verify=' + Date.now())).arrayBuffer())
  : fs.readFileSync(sourceFile);
 assert.equal(sha(current), sha(fs.readFileSync(sourceFile)), 'actual service must return the exact new source');
 const before = beforeFile ? fs.readFileSync(path.resolve(beforeFile)) : null;
 server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if(url.pathname==='/viewer'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(html)}
  if(url.pathname==='/source.glb'){res.writeHead(200,{'Content-Type':'model/gltf-binary'});return res.end(current)}
  if(url.pathname==='/before.glb'&&before){res.writeHead(200,{'Content-Type':'model/gltf-binary'});return res.end(before)}
  if(url.pathname.startsWith('/three/')){
   const file=path.resolve(three,decodeURIComponent(url.pathname.slice(7))),relative=path.relative(three,file);
   if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&fs.existsSync(file)){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(fs.readFileSync(file))}
  }
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,channel:'chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 for(const label of before?['before','after']:['after'])for(const view of ['front','oblique','close']){
  const page=await browser.newPage({viewport:{width:1000,height:850}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/viewer?asset='+label+'&view='+view);await page.waitForFunction(()=>document.body.dataset.state!=='loading');
  assert.equal(await page.locator('body').getAttribute('data-state'),'loaded',await page.locator('body').getAttribute('data-error'));
  const shaft=JSON.parse(await page.locator('body').getAttribute('data-shaft'));
  if(label==='after'){assert.ok(shaft,'raw source shaft must exist before any rig is constructed');assert.ok(Math.abs(shaft.center[0])<1e-6&&Math.abs(shaft.center[1]-.57)<1e-6&&Math.abs(shaft.center[2])<1e-6);assert.ok(Math.abs(shaft.size[2]-.78)<1e-6)}
  else assert.equal(shaft,null,'previous source reproduces the missing solid');
  const file=path.join(directory,label+'-'+view+'.png');await page.locator('canvas').screenshot({path:file});assert.ok(fs.statSync(file).size>5000);shots.push(file);checks.push(label+' '+view+' pure source rendering');await page.close();
 }
 assert.deepEqual(errors,[]);assert.equal(sha(fs.readFileSync(sourceFile)),sha(current),'viewer must not rewrite the source');
 const result={success:true,sourceSha256:sha(current),actualOrigin:process.env.LIFT_ACTUAL_ORIGIN||null,applicationPoseCodeUsed:false,databaseStarted:false,checks,errors,shots,directory};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve))});
