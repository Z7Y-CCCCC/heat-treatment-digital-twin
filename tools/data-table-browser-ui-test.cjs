// Real browser + real read-only records API in one collector:false SQLite fixture.
// Only owned loopback source records and owned runtime frames are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname,'..');
const prefix = requireTestPath(path.join(root,'output','playwright',`data-table-browser-${new Date().toISOString().replace(/[-:.]/g,'')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix),{recursive:true}); const directory=fs.mkdtempSync(prefix);
const checks=[],screenshots=[],pageErrors=[],consoleErrors=[],writes=[],audits=[],reads=[];
let server,browser,page,info,catalog,expectedFailure=false;
const pass=label=>{checks.push(label);console.log('PASS '+label);fs.appendFileSync(path.join(directory,'run.log'),'PASS '+label+'\n')};
const panel=()=>page.getByTestId('data-table-browser');
const row=field=>panel().locator(`tbody tr[data-field-id="${field}"]`);
async function api(route,method='GET',data){
  const session=await page.request.get(info.origin+'/api/admin-auth/session').then(r=>r.json());
  const response=await page.request.fetch(info.origin+'/api'+route,{method,headers:{Origin:info.origin,'X-Factory-ID':info.factoryId,'X-Admin-Request':'1','X-CSRF-Token':session.csrfToken},...(data===undefined?{}:{data})});
  assert.equal(response.status(),200,await response.text());return response.json();
}
async function controls(state){assert.match(info.sourceOrigin,/^http:\/\/127\.0\.0\.1:\d+$/);const response=await fetch(info.sourceOrigin+'/controls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});assert.equal(response.status,200);return response.json()}
async function loaded(){await panel().waitFor();await waitUntil(()=>panel().getAttribute('aria-busy').then(v=>v==='false'),20000,'read-only records loaded')}
async function chooseTable(table){await page.locator('.table-card').filter({hasText:table.name}).first().click();await page.locator('.fields-section h4').filter({hasText:table.name}).waitFor();await page.getByRole('group',{name:'数据表查看方式',exact:true}).getByRole('button',{name:'数据浏览',exact:true}).click();await loaded();const current=panel().getByRole('button',{name:'当前数据',exact:true});if(await current.getAttribute('aria-pressed')!=='true'){await current.click();await loaded()}}
async function field(id){await panel().getByLabel('浏览数据项',{exact:true}).selectOption(id);await loaded()}
async function search(q){await panel().getByLabel('搜索数据记录',{exact:true}).fill(q);await panel().getByRole('button',{name:'搜索',exact:true}).click();await loaded()}
async function refresh(){await panel().getByRole('button',{name:'刷新数据',exact:true}).click();await loaded()}
async function shot(name){await panel().scrollIntoViewIfNeeded();const filename=path.join(directory,name+'.png');await page.screenshot({path:filename,fullPage:false});screenshots.push(filename);return filename}
async function audit(name,width,height){
  await page.setViewportSize({width,height});await panel().scrollIntoViewIfNeeded();
  const result=await panel().evaluate((section,name)=>{
    const table=section.querySelector('.browser-records'),scroll=section.querySelector('.browser-records-scroll');
    const box=section.getBoundingClientRect();const headers=[...table.querySelectorAll('th')].map(cell=>({text:cell.textContent.trim(),scroll:cell.scrollWidth,client:cell.clientWidth}));
    const rows=[...table.querySelectorAll('tbody tr')].map(tr=>{const cells=[...tr.children],valueCell=tr.querySelector('.record-value'),unit=valueCell?.querySelector('small'),value=unit?.previousElementSibling;return{height:tr.getBoundingClientRect().height,children:cells.map(cell=>{const css=getComputedStyle(cell),badge=cell.querySelector('.record-quality');return{height:cell.getBoundingClientRect().height,text:cell.textContent.trim(),right:cell.getBoundingClientRect().right,singleLineHeight:Math.max(parseFloat(css.lineHeight)||parseFloat(css.fontSize)*1.6,badge?.getBoundingClientRect().height||0)+parseFloat(css.paddingTop)+parseFloat(css.paddingBottom)+parseFloat(css.borderTopWidth)+parseFloat(css.borderBottomWidth)}}),unitLine:unit&&value?{valueCenter:value.getBoundingClientRect().top+value.getBoundingClientRect().height/2,unitCenter:unit.getBoundingClientRect().top+unit.getBoundingClientRect().height/2,unitText:unit.textContent.trim()}:null,quality:tr.querySelector('.record-quality')?{width:tr.querySelector('.record-quality').getBoundingClientRect().width,cell:cells.at(-1).clientWidth}:null}});
    return{name,width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,section:{left:box.left,right:box.right},scroll:{width:scroll.scrollWidth,client:scroll.clientWidth},headers,rows,fieldSize:parseFloat(getComputedStyle(table).fontSize)};
  },name);audits.push(result);
  assert.ok(result.pageWidth<=width+2,'page has no horizontal overflow');assert.ok(result.scroll.width<=result.scroll.client+2,'records do not require horizontal scrolling');
  assert.ok(result.section.left>=-1&&result.section.right<=width+1);assert.ok(result.headers.every(h=>h.scroll<=h.client+1),'all column captions fit in a single row');
  assert.ok(result.rows.every(r=>r.children.every(c=>Math.abs(c.height-r.height)<1)));assert.ok(result.rows.every(r=>r.height<=Math.max(...r.children.map(c=>c.singleLineHeight))+5),'actual values and badges occupy one text row rather than wrapping to a second line');assert.ok(result.rows.every(r=>!r.unitLine||Math.abs(r.unitLine.valueCenter-r.unitLine.unitCenter)<=3),'numeric value and its unit stay on the same visual line');assert.ok(result.fieldSize>=13);
  await shot(name);return result;
}
async function baseline(){return{items:(await api('/data-center/catalog')).items.map(({previewValue,quality,...item})=>item),datasets:await api('/data-sources/datasets'),sources:await api('/data-sources')}}
(async()=>{
  const infoFile=path.join(directory,'server.json');server=startLoggedProcess(process.execPath,[path.join(__dirname,'data-table-browser-ui-server.cjs')],{cwd:root,env:{...process.env,DATA_BROWSER_UI_INFO_FILE:infoFile,UI_FRONTEND_DIST:path.join(root,'frontend','dist')},logFile:path.join(directory,'server.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);try{info=JSON.parse(fs.readFileSync(infoFile,'utf8'));return !!info.origin&&!!info.database}catch{return false}},60000,'complete private data browser fixture');requireTestPath(info.database);assert.equal(info.collectorFalse,true);
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1});
  await context.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'data-center',dataCenterSection:'tables'})));
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push({text:message.text(),expected:expectedFailure})});
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/data-center/')&&request.method()==='GET'&&url.pathname.endsWith('/records'))reads.push(request.url());if(url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(request.method()))writes.push({method:request.method(),path:url.pathname,body:request.postDataJSON()})});
  await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();await page.locator('.catalog-layout[aria-busy="false"]').waitFor();
  const connection=(await api('/data-sources/connections','POST',{name:'数据浏览自有记录源',sourceType:'http_api',baseUrl:info.sourceOrigin,authType:'none',enabled:true,timeoutMs:5000})).connection;
  assert.ok(connection?.id);const definitions={};
  for(const [key,name,sourcePath] of [['records','生产订单浏览验收','/records'],['empty','空数据表浏览验收','/empty'],['failure','失败数据表浏览验收','/failure']]){
    definitions[key]=(await api('/data-sources/datasets','POST',{name,connectionId:connection.id,source:'http',enabled:true,refreshMs:250,rootPath:'records',request:{method:'GET',path:sourcePath,parameters:[]},columns:[{name:'batch',label:'生产批次',path:'batch',type:'string'},{name:'amount',label:'订单数量',path:'amount',type:'number',unit:'件'},{name:'ready',label:'完成状态',path:'ready',type:'boolean'},{name:'time',label:'记录时间',path:'time',type:'string',role:'time'}]})).dataset;
  }
  await page.getByRole('button',{name:'刷新',exact:true}).click();await page.locator('.catalog-layout[aria-busy="false"]').waitFor();catalog=await api('/data-center/catalog');
  const tables=Object.fromEntries(['records','empty','failure'].map(key=>[key,catalog.tables.find(t=>catalog.items.some(i=>i.tableId===t.id&&i.datasetId===definitions[key].id))]));
  const initial=await baseline(),writeStart=writes.length;
  assert.equal(await panel().count(),0);assert.equal(await page.locator('[data-field-id="internal_device_name"] .field-edit').count(),1);pass('默认仍为字段目录，保留原有行内铅笔编辑入口');
  await chooseTable(catalog.tables.find(t=>t.id==='internal_devices'));await field('internal_device_name');
  assert.equal(await row('internal_device_name').count(),20);assert.ok((await panel().locator('.browser-pagination').innerText()).includes('共 27 条'));
  assert.equal(await panel().getByRole('button',{name:'历史记录',exact:true}).count(),0);assert.equal(await panel().getByText('当前表没有可用的历史存储，只展示实际读取的当前数据。',{exact:true}).count(),1);
  const firstPath=await row('internal_device_name').first().locator('.record-object').getAttribute('title');assert.ok(firstPath.includes('/'));assert.equal(await row('internal_device_name').locator('input,select').count(),0);
  pass('设备资料是真实27台对象的记录，不是单个样本；名称一行显示、完整层级路径悬停可查，无历史伪入口');
  await audit('01-devices-1920',1920,1080);await audit('02-devices-1366',1366,768);
  await panel().getByRole('button',{name:'下一页',exact:true}).click();await loaded();assert.equal(await row('internal_device_name').count(),7);assert.ok((await panel().locator('.page-indicator').innerText()).startsWith('2 /'));
  await panel().getByRole('button',{name:'上一页',exact:true}).click();await loaded();await search('03# 浏览验收炉');assert.equal(await row('internal_device_name').count(),1);
  await search('');await panel().getByLabel('浏览对象',{exact:true}).selectOption(info.devices[0].id);await loaded();assert.equal(await row('internal_device_name').count(),1);await panel().getByLabel('浏览对象',{exact:true}).selectOption('');await loaded();
  pass('按字段／对象／实际文本搜索和分页均由真实records API返回，不漏第二页记录');
  await panel().getByLabel('数据浏览每页条数',{exact:true}).selectOption('50');await loaded();assert.equal(await row('internal_device_name').count(),27);pass('每页20／50／100选项正确读取服务分页，50条能一次浏览27台设备');
  await page.getByRole('group',{name:'数据表查看方式',exact:true}).getByRole('button',{name:'字段目录',exact:true}).click();await page.locator('[data-field-id="internal_device_name"] .field-edit').click();await page.getByLabel('数据项显示名称',{exact:true}).waitFor();await page.getByLabel('数据项显示名称',{exact:true}).press('Escape');assert.equal(await page.getByLabel('数据项显示名称',{exact:true}).count(),0);pass('浏览与字段目录可直接切换，原有行内编辑取消仍不写数据或冻结绑定');
  const parts=catalog.tables.find(t=>t.id==='internal_parts');assert.ok(parts,'packaged model supplies actual parts');await chooseTable(parts);await field('internal_part_name');
  const partsResult=await api(`/data-center/tables/${parts.id}/records?field_id=internal_part_name&page_size=100`);assert.ok(partsResult.total>27);assert.equal(await panel().locator('.record-object').count(),20);assert.ok(partsResult.records.every(r=>r.objectId&&r.objectName&&r.value));await shot('03-parts-1366');pass('部件资料按设备实例的实际部件展开，不把第一部件样本冒充整表');
  const point=catalog.items.find(i=>i.binding?.pointId===info.points.temp),bad=catalog.items.find(i=>i.binding?.pointId===info.points.bad),bool=catalog.items.find(i=>i.binding?.pointId===info.points.ready);assert.ok(point&&bad&&bool);
  const plc=catalog.tables.find(t=>t.id===point.tableId);await chooseTable(plc);assert.equal(await panel().locator('tbody tr').count(),3);assert.equal(await row(point.id).locator('.record-value').innerText(),'501');assert.equal(await row(bool.id).locator('.record-value').innerText(),'否');assert.equal(await row(bad.id).locator('.record-value').innerText(),'—');
  assert.ok(await row(point.id).locator('.record-time time').getAttribute('datetime'));assert.equal(await row(bad.id).locator('.record-quality').innerText(),'异常');
  const plcRecords=await api(`/data-center/tables/${plc.id}/records`);assert.ok(plcRecords.records.every(r=>r.fieldName!=='写入控制'));assert.equal(plcRecords.capabilities.history,false);pass('实时点位使用自有只读frame：正常数值／false／异常空值、真实更新时间和质量均正确；写点位不列入');
  await controls({pointOffset:32});await refresh();assert.equal(await row(point.id).locator('.record-value').innerText(),'533');
  await panel().getByLabel('自动刷新当前数据',{exact:true}).check();await controls({pointOffset:45});await waitUntil(()=>row(point.id).locator('.record-value').innerText().then(v=>v==='546'),10000,'5s real current data refresh');await panel().getByLabel('自动刷新当前数据',{exact:true}).uncheck();await shot('04-realtime-1366');pass('手动刷新和每5秒自动刷新取到frame新值，不保存成常量或沿用目录预览');
  await chooseTable(tables.records);const quantity=catalog.items.find(i=>i.datasetId===definitions.records.id&&i.binding.datasetField==='amount');assert.ok(quantity);await field(quantity.id);
  assert.equal(await row(quantity.id).count(),20);assert.ok((await panel().locator('.browser-pagination').innerText()).includes('共 37 条'));assert.equal(await panel().getByRole('button',{name:'历史记录',exact:true}).count(),1);
  const values=await row(quantity.id).locator('.record-value').allInnerTexts();assert.ok(values.includes('700件')||values.includes('700 件')||values.some(v=>/^700\s*件$/.test(v)));await controls({valueOffset:100});await page.waitForTimeout(350);await refresh();assert.ok((await row(quantity.id).first().locator('.record-value').innerText()).startsWith('800'));
  await audit('05-external-1366',1366,768);await audit('05b-external-1920',1920,1080);pass('外部数据表读取真实loopback源37条记录并映射实际字段；源值变化后浏览结果同步更新，不是固定预览值；值和单位在两种桌面尺寸均保持一行');
  expectedFailure=true;await controls({fail:true});await page.waitForTimeout(350);await refresh();await panel().getByRole('alert').waitFor();assert.equal(await row(quantity.id).count(),20);assert.equal(await panel().getByRole('columnheader',{name:'上次成功读取值',exact:true}).count(),1);await controls({fail:false});await page.waitForTimeout(350);await refresh();expectedFailure=false;pass('同范围刷新失败保留上次成功读数时明确标注旧结果，恢复连接后重新读取成功');
  await panel().getByRole('button',{name:'历史记录',exact:true}).click();await loaded();
  const localInput=iso=>{const d=new Date(iso),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`};
  await panel().getByLabel('历史开始时间',{exact:true}).fill(localInput(info.historyStart));await panel().getByLabel('历史结束时间',{exact:true}).fill(localInput(info.historyEnd));await panel().getByRole('button',{name:'查询历史',exact:true}).click();await loaded();
  assert.equal(await row(quantity.id).count(),20);assert.equal(await panel().getByLabel('自动刷新当前数据',{exact:true}).count(),0);assert.equal(await panel().getByLabel('本页数值历史趋势',{exact:true}).count(),1);assert.equal(await panel().locator('.browser-trend circle').count(),20);
  await audit('06-history-1366',1366,768);await audit('07-history-1920',1920,1080);pass('只有实际时间列的记录源提供历史时间筛选；图中20个点对应本页真实记录，无模拟采样或假PLC历史');
  const requestCount=reads.length;await panel().getByLabel('历史开始时间',{exact:true}).fill(localInput(info.historyEnd));await panel().getByLabel('历史结束时间',{exact:true}).fill(localInput(info.historyStart));await panel().getByRole('button',{name:'查询历史',exact:true}).click();await panel().getByRole('alert').filter({hasText:'结束时间必须晚于开始时间'}).waitFor();assert.equal(reads.length,requestCount);assert.equal(await panel().locator('tbody tr').count(),0);pass('错误历史范围在界面直接校验，不发错误查询，也不把旧记录误显示为新范围结果');
  await chooseTable(tables.records);await field(quantity.id);assert.ok(await row(quantity.id).count()>0);expectedFailure=true;await controls({fail:true});await page.waitForTimeout(350);await search('800');await panel().getByRole('alert').waitFor();assert.equal(await panel().locator('tbody tr').count(),0);await controls({fail:false});expectedFailure=false;pass('同表切换筛选后真实源读取失败时清空旧结果，旧值不冒充新筛选结果');
  await chooseTable(tables.empty);assert.equal(await panel().locator('tbody tr').count(),0);await panel().getByText('暂无实际记录',{exact:true}).waitFor();await shot('08-empty');pass('空数据表显示实际零记录，不填入常量、样本或不存在的记录');
  expectedFailure=true;await chooseTable(tables.failure);await waitUntil(async()=>await panel().getByRole('alert').count()>0||await panel().locator('.record-quality.bad').count()>0||await panel().locator('.browser-message').count()>0,15000,'actual unavailable source UI');assert.equal(await panel().locator('.record-value').filter({hasText:/^\d/}).count(),0);await shot('09-source-failure');expectedFailure=false;pass('真实外部源503明确显示读取失败／异常，切表后不遗留上张表的成功读数');
  await controls({delayMs:2000});const started=page.waitForRequest(request=>new URL(request.url()).pathname===`/api/data-center/tables/${tables.records.id}/records`);await page.locator('.table-card').filter({hasText:tables.records.name}).click();await started;await chooseTable(catalog.tables.find(t=>t.id==='internal_devices'));await field('internal_device_name');await page.waitForTimeout(2500);assert.equal(await row(quantity.id).count(),0);assert.equal(await row('internal_device_name').count(),20);await controls({delayMs:0});pass('慢源读取中切换数据表，旧请求取消或被丢弃，不把旧表记录回填新表');
  assert.deepEqual(await baseline(),initial);const mutations=writes.slice(writeStart).filter(w=>!['/api/admin-auth/touch','/api/native-preview'].includes(w.path));assert.deepEqual(mutations,[]);pass('浏览、筛选、刷新、翻页和历史查询没有配置写入；设备字段bindings、点位与外部dataset definitions完全不变');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(consoleErrors.filter(e=>!e.expected),[]);pass('两个桌面尺寸无横向拖动／列标题截断，浏览器无pageerror或非预期console error');
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,screenshots,audits,reads,writes,pageErrors,consoleErrors,directory,fixtureDatabase:info.database,fixtureBackendPid:info.backendPid,helperPid:server.pid,sourcePid:info.sourcePid,scope:'private SQLite + real loopback dataset HTTP records + owned runtime frame; collector false; no physical PLC or Unity'},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory,screenshots:screenshots.length}));
})().catch(async error=>{console.error(error);if(page&&!page.isClosed())await shot('failure').catch(()=>{});fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:false,error:error.stack,checks,screenshots,audits,reads,writes,pageErrors,consoleErrors,directory,fixtureDatabase:info?.database},null,2));process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);fs.appendFileSync(path.join(directory,'run.log'),'Stopped only owned fixture helper/backend/source process tree.\n')});
