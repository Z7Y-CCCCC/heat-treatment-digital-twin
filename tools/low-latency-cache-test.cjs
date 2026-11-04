'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createSmokeSandbox}=require('../desktop/scripts/smoke-sandbox.cjs');
const {createLatencyHttpFixture}=require('./latency-http-fixture.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const sandbox=await createSmokeSandbox('low-latency-cache');Object.assign(process.env,sandbox.env);
 const fixture=await createLatencyHttpFixture();const sources=require('../backend/services/dataSources'),sets=require('../backend/services/dataSets');const checks=[];
 try{
  const source=sources.saveDataSource({name:'Loopback cache regression',sourceType:'http_api',connector:'http',baseUrl:fixture.origin+'/',authType:'none',enabled:true},'factory_default');
  const definition={id:'latency_cache',name:'latency cache',connectionId:source.id,source:'http',refreshMs:250,request:{method:'GET',path:'/read',readOnly:true,parameters:[]},rootPath:'rows',columns:[{name:'value',path:'value',type:'number',role:'value'}]};
  const {normalizeWidget,DEFAULT_CANVAS}=require('../backend/utils/dashboardDocument');
  assert.equal(normalizeWidget({id:'http',type:'value',data:{mode:'http_api',refreshMs:250}},DEFAULT_CANVAS).data.refreshMs,250);
  assert.equal(normalizeWidget({id:'db',type:'value',data:{mode:'database',refreshMs:250}},DEFAULT_CANVAS).data.refreshMs,1000);
  checks.push('published document normalization preserves 250ms HTTP period; SQL minimum unchanged');
  assert.equal(sets.normalizeDataSet(definition).refreshMs,250);
  assert.equal(sets.normalizeDataSet({...definition,source:'database',database:{table:'devices'}}).refreshMs,1000);checks.push('HTTP 250ms allowed; SQL retains 1000ms minimum');
  fixture.state.delayMs=20;const parallel=await Promise.all(Array.from({length:13},()=>sets.readDefinition(definition,{widgetRefreshMs:250},'factory_default')));
  assert.equal(fixture.requests.length,1);assert.ok(parallel.every(r=>r.rows[0].value===7000));checks.push('13 same-source reads share one in-flight upstream request');
  const first=parallel[0];fixture.state.epoch=1;await sleep(65);const cached=await sets.readDefinition(definition,{widgetRefreshMs:250},'factory_default');
  assert.equal(cached.rows[0].value,7000);assert.equal(fixture.requests.length,1);assert.ok(cached.refreshAfterMs<first.refreshAfterMs-40);assert.ok(cached.refreshAfterMs>0);checks.push('cache hit exposes decreasing remaining freshness rather than full interval');
  await sleep(270);const next=await sets.readDefinition(definition,{widgetRefreshMs:250},'factory_default');assert.equal(next.rows[0].value,7001);assert.equal(fixture.requests.length,2);checks.push('expired 250ms dataset refetches current value');
  const w={id:'legacy',data:{mode:'http_api',connectionId:source.id,apiPath:'/read',jsonPath:'rows',refreshMs:250}};
  const a=(await sources.readRuntimeBindings([w],{factoryId:'factory_default'})).legacy;
  await sleep(70);const b=(await sources.readRuntimeBindings([w],{factoryId:'factory_default'})).legacy;
  assert.equal(a.quality,'good');assert.equal(b.fetchedAt,a.fetchedAt);assert.ok(b.refreshAfterMs<a.refreshAfterMs-40);assert.ok(b.refreshAfterMs>=0);checks.push('legacy HTTP cache exposes decreasing remaining freshness');
  fixture.state.fail=true;await sleep(270);const bad=(await sources.readRuntimeBindings([w],{factoryId:'factory_default'})).legacy;assert.equal(bad.quality,'bad');checks.push('failed upstream read is not reported as healthy cached data');
  fs.writeFileSync(path.join(sandbox.directory,'result.json'),JSON.stringify({success:true,checks},null,2));console.log(JSON.stringify({success:true,directory:sandbox.directory,checks},null,2));
 }finally{await fixture.close();await sources.stopDataSourceMaintenance({backup:false});await require('../backend/db/database').closeDb();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
