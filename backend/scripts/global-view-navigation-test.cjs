'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {createSmokeSandbox,stopOwnedSmokeProcess}=require('../../desktop/scripts/smoke-sandbox.cjs');
const {startLoggedProcess,waitForHttp,findFreePort,BACKEND_DIR}=require('./integration-test-utils.cjs');
const Database=require('better-sqlite3');
const {GLOBAL_VIEWS,normalizeGlobalViews}=require('../../shared/viewNavigation.mjs');
let server,db;
(async()=>{
  const sandbox=await createSmokeSandbox('global-view-navigation'),port=await findFreePort(),origin=`http://127.0.0.1:${port}`;
  db=new Database(sandbox.filename);
  db.prepare('INSERT INTO factories(id,name,location_json) VALUES(?,?,?)').run('factory_b','第二工厂',JSON.stringify({country:'CHN',regionCode:'120000',cityCode:'120000',districtCode:'120101'}));
  db.prepare('UPDATE factories SET location_json=? WHERE id=?').run(JSON.stringify({country:'CHN',regionCode:'610000',cityCode:'610100',districtCode:'610112'}),'factory_default');
  const injected=normalizeGlobalViews();Object.keys(injected.enabled).forEach(id=>injected.enabled[id]=false);
  db.prepare('INSERT INTO factory_settings(factory_id,`key`,value) VALUES(?,?,?)').run('factory_b','global_view_navigation',JSON.stringify(injected));
  server=startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...sandbox.env,PORT:String(port),HOST:'127.0.0.1'},logFile:path.join(sandbox.directory,'backend.log')});
  await waitForHttp(origin+'/api/health');
  const api=async(route,method='GET',body,factoryId='factory_default',expected=200)=>{
    const response=await fetch(origin+'/api'+route,{method,headers:{'X-Admin-Token':sandbox.env.ADMIN_API_TOKEN,'X-Factory-ID':factoryId,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();assert.equal(response.status,expected,`${route}: ${JSON.stringify(data)}`);return data;
  };
  let saved=await api('/view-navigation');assert.equal(saved.configured,false);
  assert.equal(Object.values(saved.config.enabled).every(Boolean),true);
  assert.deepEqual((await api('/view-navigation','GET',null,'factory_b')).config,saved.config);
  await api('/view-navigation','PUT',{config:{version:1,enabled:{}},revision:saved.revision},'factory_default',400);
  const originalRevision=saved.revision;
  saved=await api('/view-navigation','PUT',{config:injected,revision:saved.revision});
  await api('/view-navigation','PUT',{config:normalizeGlobalViews(),revision:originalRevision},'factory_b',409);
  await api('/settings','PUT',{global_view_navigation:normalizeGlobalViews()},'factory_b',400);
  for(const factoryId of ['factory_default','factory_b']){
    const config=await api('/config','GET',null,factoryId);
    assert.deepEqual(JSON.parse(config.settings.global_view_navigation),injected,'factory override must never mask global policy');
    for(const view of config.platform.document.scene.views.filter(v=>GLOBAL_VIEWS.some(g=>g.id===v.id))) assert.equal(view.metadata.runtimeHidden,true);
  }
  const first=await api('/view-navigation/resolve?viewId=map_world&factoryId=factory_default');
  assert.equal(first.route.path,'/overlay');assert.equal(first.route.query.factoryId,'factory_default');assert.ok(first.route.query.entryViewId);
  // Every start/next combination terminates at an enabled global view or a local entry.
  for(let mask=0;mask<128;mask++){
    const config=normalizeGlobalViews();GLOBAL_VIEWS.forEach((v,i)=>config.enabled[v.id]=!!(mask&(1<<i)));
    saved=await api('/view-navigation','PUT',{config,revision:saved.revision});
    const resolved=await api('/view-navigation/resolve?viewId=map_world&factoryId=factory_default');
    if(config.enabled.map_world)assert.equal(resolved.allowed,true);
    else{
      assert.equal(resolved.allowed,false);
      const next=resolved.route.path==='/group'?`map_${resolved.route.query.level}`:resolved.route.path==='/site'?`site_${resolved.route.query.stage}`:'';
      if(next)assert.equal(config.enabled[next],true);else assert.equal(resolved.route.path,'/overlay');
    }
  }
  saved=await api('/view-navigation','PUT',{config:injected,revision:saved.revision});
  db.prepare('UPDATE factories SET is_enabled=0').run();
  const empty=await api('/view-navigation/resolve?viewId=map_world');assert.equal(empty.route.query.noVisibleFactory,'1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM settings WHERE `key`=?').get('global_view_navigation').n,1);
  fs.writeFileSync(path.join(sandbox.directory,'result.json'),JSON.stringify({success:true,combinations:128,crossFactory:true,conflictProtection:true,emptyState:true},null,2));
  console.log('PASS global navigation: 128 policies, global scope, runtime projection, conflict/invalid saves and empty installation. '+sandbox.directory);
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{db?.close();await stopOwnedSmokeProcess(server)});
