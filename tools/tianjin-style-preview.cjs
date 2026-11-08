// Standalone authoring-style acceptance only: no application server/database,
// controller, session, source API, collector, or user's UI is opened or mutated.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { pathToFileURL } = require('node:url');
const { requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..'), frontend = path.join(root, 'frontend');
const views = ['factory_overview', 'workshop_overview', 'line_overview', 'device_detail', 'device_xray', 'device_exploded', 'device_part'];
const devices = ['Furnace_01', 'Furnace_02', 'Furnace_03', 'h1', 'qxj', '111'];
const visualContent = ['lineColor', 'areaColor', 'lineWidth', 'areaOpacity', 'axisLabelColor', 'gridColor', 'barRadius', 'donutRatio'];
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function documentFrom(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const document = value.document || value.scenes?.[0]?.document || value;
  assert.ok(Array.isArray(document.widgets) && Array.isArray(document.scene?.views), 'Pass a raw dashboard document or a read-only scene snapshot');
  return document;
}
function nonVisual(document) {
  const result = structuredClone(document);
  for (const widget of result.widgets) { delete widget.style; for (const key of visualContent) delete widget.content?.[key]; }
  return result;
}
const entry = `
import { createApp, h, computed, ref, nextTick } from 'vue';
import WidgetRenderer from '/src/runtime/WidgetRenderer.vue';
import { isCanvasWidget, widgetPresentationState } from '/src/runtime/widgetPresentation.js';
import '/src/style.css';
const payload = await fetch('/__tianjin-preview-data.json').then(r => r.json());
const state = ref({stage:'before',viewId:'factory_overview',deviceId:''});
const doc = computed(() => payload[state.value.stage]);
const view = computed(() => doc.value.scene.views.find(v => v.id === state.value.viewId));
const context = computed(() => ({factoryId:'factory_default', viewId:view.value.id, viewMode:view.value.mode,
 workshopId:'ws_1', lineId:'line_a', deviceId:state.value.deviceId, partId:'', sceneReady:true,
 inspectionStage:view.value.metadata?.inspectionStage || (view.value.id==='device_part'?'part':'')}));
const widgets = computed(() => doc.value.widgets.filter(w => isCanvasWidget(w) && widgetPresentationState(w,
 {view:view.value,context:context.value,defaultViewId:doc.value.scene.defaultViewId}).visible)
 .sort((a,b) => Number(a.zIndex||0)-Number(b.zIndex||0)));
const app = createApp({setup(){return () => h('main', {class:'style-preview'}, [
 h('header', {class:'style-preview-heading'}, [h('strong', {}, view.value.name+' · '+(state.value.stage==='before'?'原样式':'统一后样式')),
 h('span', {}, '独占静态组件预览 · 未连接现场数据'+(state.value.deviceId?' · '+state.value.deviceId:''))]),
 h('section', {class:'style-preview-canvas', style:{width:doc.value.canvas.width+'px',height:doc.value.canvas.height+'px'}},
 widgets.value.map(w => h('article',{key:state.value.stage+':'+state.value.viewId+':'+state.value.deviceId+':'+w.id,
 class:['style-preview-widget','hud-widget','widget-type-'+w.type,{'is-panel-heading':String(w.content?.text||'').trim().startsWith('▸')}],
 'data-widget-id':w.id,'data-widget-type':w.type,
 style:{left:w.frame.x+'px',top:w.frame.y+'px',width:w.frame.width+'px',height:w.frame.height+'px',
 transform:'rotate('+(w.frame.rotation||0)+'deg)',zIndex:w.zIndex||0}},
 [h(WidgetRenderer,{widget:w,preview:true,overlayMode:true,interactive:false,dataReady:true,
 runtimeContext:context.value,deviceCatalog:payload.deviceCatalog,selectedPart:{},playbackNow:1794043800000,
 metrics:{},events:[],trendPoints:[],pointValues:{},deviceDataMap:{},deviceStatusMap:{},databaseValues:{},businessData:{}})])))
 ])}});
app.mount('#style-preview-root');
window.__tianjinPreview={ async show(stage,viewId,deviceId=''){ state.value={stage,viewId,deviceId}; await nextTick(); await nextTick();
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); return widgets.value.map(w=>w.id); },
 snapshot(){return [...document.querySelectorAll('.style-preview-widget')].map(el=>{const shell=el.querySelector('.widget-shell'),s=getComputedStyle(shell);
 const decoration=pseudo=>{const c=getComputedStyle(shell,pseudo);return {content:c.content,display:c.display,background:c.background,
 border:c.border,shadow:c.boxShadow,opacity:c.opacity,width:c.width,height:c.height}};
 const typography=[...shell.querySelectorAll('p,strong,small,dt,dd,em,.widget-title')].map(node=>{const c=getComputedStyle(node);return {
 text:(node.innerText||'').replace(/\\s+/g,' ').trim(),fontSize:c.fontSize,fontWeight:c.fontWeight,fontFamily:c.fontFamily,
 color:c.color,lineHeight:c.lineHeight,letterSpacing:c.letterSpacing}});
 return {id:el.dataset.widgetId,type:el.dataset.widgetType,text:(shell.innerText||'').replace(/\\s+/g,' ').trim(),
 css:{background:s.backgroundColor,backgroundImage:s.backgroundImage,color:s.color,borderColor:s.borderTopColor,borderStyle:s.borderTopStyle,
 radius:s.borderRadius,padding:s.padding,fontSize:s.fontSize,shadow:s.boxShadow,opacity:s.opacity,backdropFilter:s.backdropFilter,
 before:decoration('::before'),after:decoration('::after'),typography},
 size:{width:el.clientWidth,height:el.clientHeight},scroll:{width:shell.scrollWidth,height:shell.scrollHeight}}})}};
window.__tianjinReady=true;
`;

async function main() {
  const { values } = parseArgs({options:{before:{type:'string'},after:{type:'string'},manifest:{type:'string'}}});
  assert.ok(values.before && values.after, 'Usage: node tools/tianjin-style-preview.cjs --before ABS_JSON --after ABS_JSON [--manifest ABS_JSON]');
  const before = documentFrom(values.before), after = documentFrom(values.after);
  assert.deepEqual(nonVisual(after), nonVisual(before), 'Only visual widget properties may differ');
  const { resolveWidgetViewStyle, widgetSurfacePresentation } = await import(pathToFileURL(path.join(frontend,'src/runtime/widgetSurfaceSkin.js')).href);
  const afterById = new Map(after.widgets.map(widget=>[widget.id,widget]));
  const prefix = requireTestPath(path.join(root, 'output/playwright', `tianjin-style-preview-${new Date().toISOString().replace(/[-:.]/g,'')}-${process.pid}-`));
  fs.mkdirSync(path.dirname(prefix), {recursive:true});
  const directory = fs.mkdtempSync(prefix);
  const report = {scope:'local raw JSON + current WidgetRenderer SFC; no backend/DB/PLC/Unity/source/session', directory, source:values.before, candidate:values.after,
    beforeSha:sha(before),afterSha:sha(after),nonVisualSha:sha(nonVisual(before)),rawWidgetCount:before.widgets.length,checks:[],screenshots:[],renderStates:[],pageErrors:[],consoleErrors:[],blockedRequests:[],httpFailures:[]};
  let server, vite, browser, page;
  try {
    const { createServer } = await import(pathToFileURL(require.resolve('vite',{paths:[frontend]})).href);
    const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue',{paths:[frontend]})).href);
    const payload = JSON.stringify({before,after,deviceCatalog:devices.map(id=>({id,name:id,workshop_id:'ws_1',line_id:'line_a'}))});
    const style = `html,body{margin:0!important;min-width:1920px!important;background:#101521!important;color:#e8edf6!important;font-family:'Inter Variable','Noto Sans SC Variable','Microsoft YaHei',sans-serif!important}#style-preview-root{width:1920px;margin:auto}.style-preview-heading{height:58px;box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;padding:0 24px;border-bottom:1px solid #31384e;background:#171d2b;font-size:15px}.style-preview-heading span{font-size:12px;color:#9ba8be}.style-preview-canvas{position:relative;overflow:hidden;background-color:#101627;background-image:radial-gradient(circle at center,rgba(76,91,136,.18) 0,transparent 68%),linear-gradient(rgba(113,129,177,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(113,129,177,.055) 1px,transparent 1px);background-size:30px 30px,30px 30px,30px 30px}.style-preview-widget{position:absolute;box-sizing:border-box;overflow:visible}.style-preview-widget>.widget-shell{width:100%;height:100%;box-sizing:border-box}`;
    server=http.createServer((req,res)=>{
      const pathname=new URL(req.url,'http://127.0.0.1').pathname;
      if(pathname==='/__tianjin-preview-data.json'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(payload);return;}
      if(pathname==='/'||pathname==='/favicon.ico'){res.writeHead(200,{'Content-Type':pathname==='/favicon.ico'?'image/x-icon':'text/html'});res.end(pathname==='/favicon.ico'?'':`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>天津视角样式独立验证</title><style>${style}</style></head><body><div id="style-preview-root"></div><script type="module" src="/__tianjin-preview-entry.mjs"></script></body></html>`);return;}
      vite.middlewares(req,res,()=>{res.writeHead(404);res.end('Unknown owned preview asset');});
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
    // Vite 8 imports a client transport even with hmr:false. Bind that internal
    // compiler socket to this exact owned HTTP server; never use shared 24678.
    vite = await createServer({root:frontend,configFile:false,publicDir:false,cacheDir:path.join(directory,'vite-cache'),appType:'custom',logLevel:'warn',
      plugins:[vue(),{name:'owned-tianjin-preview',resolveId(id){if(id==='/__tianjin-preview-entry.mjs')return '\0owned-tianjin-preview'},load(id){if(id==='\0owned-tianjin-preview')return entry}}],
      optimizeDeps:{include:['vue','echarts']},server:{middlewareMode:true,hmr:false,ws:{server,host:'127.0.0.1',clientPort:server.address().port},watch:null,fs:{allow:[root]}}});
    const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
    browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
    const browserContext=await browser.newContext({viewport:{width:1920,height:1138},deviceScaleFactor:1});
    await browserContext.route('**/*',route=>{const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin || /^\/api(?:\/|$)/.test(url.pathname)){report.blockedRequests.push({url:request.url(),method:request.method()});return route.abort();}
      return route.continue();});
    page=await browserContext.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text())});
    page.on('websocket',socket=>{const url=new URL(socket.url());if(url.host!==new URL(origin).host || /^\/api(?:\/|$)/.test(url.pathname))report.blockedRequests.push({url:socket.url(),method:'WS'});});
    page.on('response',response=>{if(response.status()>=400)report.httpFailures.push({url:response.url(),status:response.status()})});
    await page.goto(origin);await page.waitForFunction(()=>window.__tianjinReady,{},{timeout:90000});await page.evaluate(()=>document.fonts.ready);
    report.checks.push('直接渲染原文档，不连接后台/现场数据，原始数据绑定、文字、布局、类型、可见性及其余文档字段完全一致');
    const compare = async (viewId,deviceId,screenshot) => {
      const snapshots={};
      for(const stage of ['before','after']){
        const ids=await page.evaluate(({stage,viewId,deviceId})=>window.__tianjinPreview.show(stage,viewId,deviceId),{stage,viewId,deviceId});
        await page.waitForTimeout(180);snapshots[stage]=await page.evaluate(()=>window.__tianjinPreview.snapshot());
        assert.deepEqual(snapshots[stage].map(row=>row.id),ids);
        if(screenshot){const file=path.join(directory,`${String(views.indexOf(viewId)+1).padStart(2,'0')}-${viewId}-${stage}.png`);await page.screenshot({path:file,animations:'disabled'});report.screenshots.push(file);}
      }
      assert.deepEqual(snapshots.after.map(({id,type,text,size})=>({id,type,text,size})),snapshots.before.map(({id,type,text,size})=>({id,type,text,size})),'visible widget identity, copy and frame are unchanged');
      const textGeometry = rows => rows.map(row=>({id:row.id,typography:row.css.typography.map(({color,...geometry})=>geometry)}));
      assert.deepEqual(textGeometry(snapshots.after),textGeometry(snapshots.before),'existing text font/size/weight/line-height/spacing remain unchanged');
      for(const row of snapshots.after){
        const widget=afterById.get(row.id),style=resolveWidgetViewStyle(widget.style||{},viewId),surface=widgetSurfacePresentation(style,widget.content?.lineColor||'#a2a7ed');
        if(surface.skin==='inline'){
          assert.equal(row.css.backdropFilter,surface.backdrop||'none',`${row.id}: inline child must not retain old backdrop`);
          assert.equal(row.css.before.display,'none',`${row.id}: inline child must not retain a bloom`);
          assert.equal(row.css.after.display,'none',`${row.id}: inline child must not retain a second card edge`);
          assert.equal(row.css.background,'rgba(0, 0, 0, 0)',`${row.id}: inline child must be transparent`);
        }else if(surface.skin==='glass'){
          assert.equal(row.css.before.display,'block',`${row.id}: migrated glass must show source bloom`);
          assert.match(row.css.before.background,/radial-gradient/,`${row.id}: migrated glass bloom must use actual source accent`);
          assert.equal(row.css.after.display,'block',`${row.id}: migrated glass must show source hairline`);
          assert.equal(row.css.after.height,'1px',`${row.id}: migrated glass hairline is one pixel`);
          if(typeof style.borderRadius==='number')assert.equal(row.css.radius,style.borderRadius+'px',`${row.id}: actual authored source radius must win`);
        }
      }
      const changed=snapshots.after.filter((row,index)=>JSON.stringify(row.css)!==JSON.stringify(snapshots.before[index].css)).map(row=>row.id);
      if(viewId==='factory_overview')assert.deepEqual(snapshots.after,snapshots.before,'approved factory overview must remain visually identical');
      const increasedOverflow=snapshots.after.flatMap((row,index)=>{
        const old=snapshots.before[index],axes=['width','height'];
        const increases=axes.filter(axis=>Math.max(0,row.scroll[axis]-row.size[axis])>Math.max(0,old.scroll[axis]-old.size[axis])+2);
        return increases.length?[{id:row.id,axes:increases,before:{size:old.size,scroll:old.scroll},after:{size:row.size,scroll:row.scroll}}]:[];
      });
      report.renderStates.push({viewId,deviceId,widgets:snapshots.after.length,changedVisualWidgets:changed,increasedOverflow,before:snapshots.before,after:snapshots.after});
    };
    for(const viewId of views){
      if(viewId.startsWith('device_')){for(const deviceId of devices)await compare(viewId,deviceId,deviceId===devices[0]);}
      else await compare(viewId,'',true);
    }
    report.checks.push('源全厂总览前后computed样式、文本及组件完全相同');
    report.checks.push('六下属视角及全部六原配置设备上下文，显示组件ID/类型/文字/尺寸前后一致');
    report.checks.push('glass实际圆角/bloom/hairline与inline透明无backdrop生效，原文字字体/字号/字重/行高/字距不变');
    assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.httpFailures,[]);assert.deepEqual(report.blockedRequests,[]);
    report.checks.push('独占预览零浏览器异常、零HTTP失败、零现场接口请求');
    report.success=true;fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({success:true,directory,checks:report.checks.length,renderStates:report.renderStates.length,screenshots:report.screenshots.length},null,2));
  }catch(error){report.success=false;report.error=error.stack;if(page)await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(report,null,2));throw error;}
  finally{await browser?.close();await vite?.close();if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});}
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1});
