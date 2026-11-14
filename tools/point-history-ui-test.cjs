// Isolated Vue/ECharts + history-policy smoke test; no real collector/site data.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url'),{createRequire}=require('node:module');
const {createRunDirectory}=require('../backend/scripts/integration-test-utils.cjs'),{trendHistory}=require('../backend/services/pointHistory');
const {DEFAULT_POLICY,normalizePolicy,normalizePointPolicy}=require('../backend/services/historyPolicy');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright'),Database=require('../backend/node_modules/better-sqlite3');
const root=path.resolve(__dirname,'..'),front=path.join(root,'frontend'),directory=createRunDirectory('point-history-ui'),frontRequire=createRequire(path.join(front,'package.json'));
const db=new Database(path.join(directory,'samples.db'));let server,browser,page;const errors=[],requests=[],policyWrites=[];
(async()=>{
  db.exec(`CREATE TABLE point_samples(sample_key TEXT PRIMARY KEY,factory_id TEXT,device_id TEXT,point_id TEXT,source_mode TEXT,sampled_at REAL,value_number REAL,quality TEXT,retention_until REAL);
    CREATE INDEX scope ON point_samples(factory_id,device_id,point_id,sampled_at);
    CREATE TABLE policy(factory_id TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE points(id TEXT PRIMARY KEY,factory_id TEXT,device_id TEXT,device_name TEXT,label TEXT,history_mode TEXT,history_days INTEGER);
    INSERT INTO points VALUES ('1','f','a','设备 A','炉温','recent',30),('2','f','b','设备 B','压力','recent',30),('3','g','c','设备 C','温度','recent',30);`);
  const at=Date.now()-3600000,insert=db.prepare('INSERT INTO point_samples VALUES(?,?,?,?,?,?,?,?,?)');
  db.transaction(()=>{for(const id of ['a','b'])for(let i=0;i<=3600;i++)insert.run(id+i,'f',id,id==='a'?'1':'2','simulation',at+i*1000,i===2500?null:id==='a'?i===1700?950:850+i%15:50+i%8,i===2500?'bad':'good',at+i*1000+24*3600000);})();
  const html=path.join(directory,'fixture.html');
  fs.writeFileSync(html,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{font:14px 'Microsoft YaHei',sans-serif;padding:24px;background:#f4f6fa;color:#33445d}#app{display:grid;grid-template-columns:350px 1fr;gap:24px}.chart{height:330px;padding:20px;background:#20273a;border-radius:12px}.chart .widget-shell{height:100%}h1{font-size:20px}button{padding:8px 14px;margin-bottom:12px}.policy-panel{grid-column:1/-1}</style><body><h1>隔离验收：窗口与原始记录分别保留</h1><div id="app"></div><script type="module">
import {createApp,h,reactive,watch,toRef} from 'vue';
import WidgetRenderer from '/src/runtime/WidgetRenderer.vue';
import TrendSettings from '/src/views/admin/components/TrendChartSettings.vue';
import PointHistorySettings from '/src/views/admin/components/PointHistorySettings.vue';
import PointHistoryPolicyCell from '/src/views/admin/components/PointHistoryPolicyCell.vue';
import SaveFeedbackToast from '/src/views/admin/components/SaveFeedbackToast.vue';
import {usePointHistoryColumn} from '/src/views/admin/composables/usePointHistoryColumn.js';
import * as echarts from 'echarts';
const content=reactive(JSON.parse(localStorage.getItem('history-window')||'{"timeWindowSeconds":600,"historyLength":2000,"chartType":"line","xTickMode":"time","xTickIntervalSeconds":30,"yAxisMode":"auto","showAxis":true}'));
watch(content,()=>localStorage.setItem('history-window',JSON.stringify(content)),{deep:true});
const widget=reactive({id:'history-fixture',type:'trend',title:'温度历史',style:{},content,data:{mode:'plc',deviceScope:'fixed',deviceId:'a',pointId:'1',path:'analog.temp',unit:'°C'}});
const points={'1':{id:'1',device_id:'a',value:855,quality:'good',lastReadAt:${at+3600000},sourceMode:'simulation'},'2':{id:'2',device_id:'b',value:55,quality:'good',lastReadAt:${at+3600000},sourceMode:'simulation'}};
// Reproduce first-run/admin direct entry: no saved browser factory preference.
const policyScope=reactive({factoryId:'',deviceId:'all',canEdit:true});
window.inspectCurve=()=>{const element=document.querySelector('.widget-chart');return echarts.getInstanceByDom(element)?.getOption()};
const HistoryTable={setup(){const state=usePointHistoryColumn({factoryId:toRef(policyScope,'factoryId'),deviceId:toRef(policyScope,'deviceId'),canEdit:toRef(policyScope,'canEdit')});return()=>h('section',{class:'policy-panel'},[h('button',{onClick:state.toggle,disabled:state.loading.value||state.anySaving.value},state.visible.value?'收起更多设置':'更多设置'),state.error.value&&h('p',{role:'alert'},state.error.value),h('table',[h('thead',[h('tr',[h('th','点位'),state.visible.value&&h('th','保存策略')])]),h('tbody',Object.entries(state.rows.value).map(([id,policy])=>h('tr',{'data-history-id':id},[h('td',policy.label),state.visible.value&&h('td',[h(PointHistoryPolicyCell,{policy,disabled:!policyScope.canEdit,busy:!!state.saving.value[id],loading:state.loading.value,savePolicy:value=>state.save(id,value)})])])) )])])}};
createApp({render:()=>[h(TrendSettings,{content,unit:'°C'}),h('section',[h('button',{onClick:()=>{widget.data.deviceId='b';widget.data.pointId='2';policyScope.deviceId='b'}},'切换设备 B'),h('div',{class:'chart'},[h(WidgetRenderer,{widget,nativeRealtime:true,pointValues:points,deviceCatalog:[{id:'a',name:'A'},{id:'b',name:'B'}],runtimeContext:{factoryId:'f',deviceId:widget.data.deviceId}})])]),h('section',{class:'policy-panel'},[h('button',{onClick:()=>{policyScope.factoryId='g';policyScope.deviceId='c'}},'切换工厂 G'),h('button',{onClick:()=>policyScope.canEdit=false},'切换为只读'),h(PointHistorySettings,{...policyScope}),h(HistoryTable)]),h(SaveFeedbackToast)]}).mount('#app');
</script></body></html>`);
  // @fs HTML is static; put module code in a JS resource so Vite resolves bare
  // imports exactly as it does for the real SFCs (one Vue/ECharts instance).
  const source=fs.readFileSync(html,'utf8'),entry=path.join(directory,'fixture.mjs');
  fs.writeFileSync(entry,source.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
  // Pin API_BASE before the SFC modules load. Vite can select the normal dev
  // port, which otherwise redirects API calls to the real collector on :3001.
  fs.writeFileSync(html,source.replace(/<script type="module">[\s\S]*?<\/script>/,`<script>window.__DIGITAL_TWIN_BACKEND_ORIGIN__=location.origin</script><script type="module" src="/@fs/${entry.replaceAll('\\','/')}"></script>`));
  const {createServer}=await import(pathToFileURL(frontRequire.resolve('vite')).href);
  server=await createServer({root:front,cacheDir:path.join(directory,'.vite'),resolve:{dedupe:['vue','echarts']},optimizeDeps:{include:['vue','echarts']},configFile:path.join(front,'vite.config.js'),server:{host:'127.0.0.1',port:0,fs:{allow:[root]}},plugins:[{name:'owned-history-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
    if(req.url.startsWith('/api/datapoints/history-policy')){
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      const factoryId=req.headers['x-factory-id'] || (req.method==='GET' ? 'f' : ''),url=new URL(req.url,'http://fixture');
      try{
        assert.ok(['f','g'].includes(factoryId));
        if(req.method==='GET'){
          const saved=db.prepare('SELECT value FROM policy WHERE factory_id=?').get(factoryId),deviceId=url.searchParams.get('device_id');
          const points=deviceId ? db.prepare('SELECT * FROM points WHERE factory_id=? AND device_id=? ORDER BY id').all(factoryId,deviceId)
            : db.prepare('SELECT * FROM points WHERE factory_id=? ORDER BY id').all(factoryId);
          res.end(JSON.stringify({success:true,factoryId,policy:saved?JSON.parse(saved.value):DEFAULT_POLICY,points}));return;
        }
        assert.equal(req.method,'PUT');let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);
        const pointId=url.pathname.split('/points/')[1];
        const policy=pointId?normalizePointPolicy(input):normalizePolicy(input);
        if(pointId){assert.ok(db.prepare('SELECT id FROM points WHERE id=? AND factory_id=?').get(pointId,factoryId));db.prepare('UPDATE points SET history_mode=?,history_days=? WHERE id=?').run(policy.mode,policy.days,pointId);}
        else db.prepare('INSERT OR REPLACE INTO policy VALUES (?,?)').run(factoryId,JSON.stringify(policy));
        policyWrites.push({factoryId,pointId,policy});res.end(JSON.stringify({success:true,factoryId,pointId,policy,futureSamplesOnly:true}));
      }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
      return;
    }
    if(!req.url.startsWith('/api/datapoints/history?'))return next();
    const query=Object.fromEntries(new URL(req.url,'http://fixture').searchParams);requests.push(query);
    try{assert.equal(req.headers['x-factory-id'],'f');const result=await trendHistory({all:async(sql,args)=>db.prepare(sql).all(...args)},{factoryId:'f',deviceId:query.device_id,pointId:query.point_id,sourceMode:'simulation'},query);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...result,factoryId:'f',deviceId:query.device_id,pointId:query.point_id,storage:{status:'healthy'}}));}catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}));}
  });}}]});await server.listen();
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await playwright.chromium.launch({channel:'chrome',headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  page=await browser.newPage({viewport:{width:1300,height:820}});page.setDefaultTimeout(90000);page.on('pageerror',error=>{errors.push(error.message);console.error('Browser:',error.message)});
  // Isolation is a hard boundary, not just an assumption about API_BASE.
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(['http:','https:'].includes(url.protocol) && url.origin!==origin){
      errors.push(`Blocked non-fixture request: ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  // Keep the sample fixture and browser window clock identical even when Vite prebundling is slow.
  await page.addInitScript(now => { Date.now = () => now }, at + 3600000);
  await page.goto(origin+'/@fs/'+html.replaceAll('\\','/'));
  await page.getByRole('spinbutton',{name:'实时窗口分钟'}).waitFor();
  const setWindow=async(minutes)=>{await page.getByRole('spinbutton',{name:'实时窗口分钟'}).fill(String(minutes));await page.getByRole('spinbutton',{name:'实时窗口分钟'}).blur();await page.waitForFunction(seconds=>{const data=window.inspectCurve()?.series?.[0]?.data;return data?.length>20 && Array.isArray(data[0]) && data.at(-1)[0]-data[0][0]>seconds*1000},minutes*60-60);};
  await setWindow(30);await page.waitForTimeout(300);await page.screenshot({path:path.join(directory,'thirty-minutes.png'),fullPage:true});
  await setWindow(60);await page.waitForTimeout(300);await page.screenshot({path:path.join(directory,'one-hour.png'),fullPage:true});
  const hour=await page.evaluate(()=>window.inspectCurve().series[0].data);assert.equal(hour.filter(row=>row[1]===950).length,1);assert.ok(hour.some(row=>row[1]===null));
  await page.reload();await page.getByRole('spinbutton',{name:'实时窗口分钟'}).waitFor();assert.equal(await page.getByRole('spinbutton',{name:'实时窗口分钟'}).inputValue(),'60');
  await page.waitForFunction(()=>{const data=window.inspectCurve()?.series?.[0]?.data;return data?.length>20 && data.at(-1)[0]-data[0][0]>3500000});
  const historyPanel=page.getByTestId('point-history-settings');await historyPanel.locator('summary').click();
  await page.getByRole('spinbutton',{name:'近期趋势保留小时',exact:true}).waitFor();
  assert.equal(await page.getByRole('spinbutton',{name:'近期趋势保留小时',exact:true}).inputValue(),'24');
  await page.getByRole('spinbutton',{name:'近期趋势保留小时',exact:true}).fill('2');
  await page.getByRole('combobox',{name:'全厂指标历史模式'}).selectOption('off');
  await page.getByRole('button',{name:'保存工厂历史策略'}).click();await page.getByTestId('save-feedback-toast').filter({hasText:'工厂历史策略已保存'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'当前点位 · 长期历史'}).count(),0);
  assert.equal(await page.getByRole('columnheader',{name:'保存策略',exact:true}).count(),0,'column starts hidden');
  await page.getByRole('button',{name:'更多设置',exact:true}).click();
  const row=id=>page.locator('[data-history-id="'+id+'"]');
  await row('1').getByRole('combobox',{name:'点位保存策略'}).selectOption('finite');
  await row('1').getByRole('spinbutton',{name:'点位保留天数'}).fill('7');
  await row('1').getByRole('spinbutton',{name:'点位保留天数'}).press('Tab');
  await page.waitForFunction(()=>document.querySelector('[data-history-id="1"] input')?.value==='7' && !document.querySelector('[data-history-id="1"] input')?.disabled);
  assert.equal(db.prepare("SELECT history_days FROM points WHERE id='1'").get().history_days,7);
  await page.route('**/api/datapoints/history-policy/points/1',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'隔离保存失败'})}));
  await row('1').getByRole('combobox',{name:'点位保存策略'}).selectOption('permanent');
  await page.getByTestId('save-feedback-toast').filter({hasText:'隔离保存失败'}).waitFor();
  assert.equal(await row('1').getByRole('combobox',{name:'点位保存策略'}).inputValue(),'finite','failed autosave restores confirmed row');
  await page.unroute('**/api/datapoints/history-policy/points/1');
  await page.screenshot({path:path.join(directory,'history-policy.png'),fullPage:true});
  await page.reload();await historyPanel.locator('summary').click();
  await page.getByRole('spinbutton',{name:'近期趋势保留小时',exact:true}).waitFor();
  assert.equal(await page.getByRole('spinbutton',{name:'近期趋势保留小时',exact:true}).inputValue(),'2');
  assert.equal(await page.getByRole('combobox',{name:'全厂指标历史模式'}).inputValue(),'off');
  assert.equal(await page.getByRole('columnheader',{name:'保存策略',exact:true}).count(),0,'column remains hidden by default after reload');
  await page.getByRole('button',{name:'更多设置',exact:true}).click();
  await row('1').getByRole('spinbutton',{name:'点位保留天数'}).waitFor();
  assert.equal(await row('1').getByRole('combobox',{name:'点位保存策略'}).inputValue(),'finite');
  assert.equal(await row('1').getByRole('spinbutton',{name:'点位保留天数'}).inputValue(),'7');
  await page.getByRole('button',{name:'切换设备 B'}).click();await page.waitForFunction(()=>{const data=window.inspectCurve()?.series?.[0]?.data;return data?.length>20 && data.filter(row=>row[1]!==null).every(row=>row[1]<100)});
  await row('2').getByRole('combobox',{name:'点位保存策略'}).waitFor();
  assert.equal(await row('2').getByRole('combobox',{name:'点位保存策略'}).inputValue(),'recent','new device does not inherit A-specific long-term policy');
  assert.equal(await page.getByRole('spinbutton',{name:'近期趋势保留小时',exact:true}).inputValue(),'2');
  await page.screenshot({path:path.join(directory,'device-b.png'),fullPage:true});
  await page.getByRole('button',{name:'切换工厂 G'}).click();await row('3').getByRole('combobox',{name:'点位保存策略'}).waitFor();
  assert.equal(await page.getByRole('spinbutton',{name:'近期趋势保留小时',exact:true}).inputValue(),'24');
  await row('3').getByRole('combobox',{name:'点位保存策略'}).selectOption('permanent');
  await page.getByTestId('save-feedback-toast').filter({hasText:'保存策略已保存'}).waitFor();
  await page.getByRole('button',{name:'切换为只读'}).click();assert.equal(await page.getByRole('button',{name:'保存工厂历史策略'}).isDisabled(),true);
  assert.equal(await row('3').getByRole('combobox',{name:'点位保存策略'}).isDisabled(),true);
  assert.equal(policyWrites.length,4);assert.equal(db.prepare("SELECT history_mode FROM points WHERE id='1'").get().history_mode,'finite');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM point_samples').get().n,7202);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({success:true,currentFactoryWithoutPreference:true,oneHour:true,reloadHistory:true,deviceIsolation:true,configurablePolicy:true,policyReload:true,factoryIsolation:true,readOnly:true,rawSamples:7202,drawingPoints:hour.length,requests:requests.length,directory}));
})().catch(async error=>{console.error(error);console.error(JSON.stringify({errors,requests}));await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}).finally(async()=>{await browser?.close();await server?.close();db.close();});
