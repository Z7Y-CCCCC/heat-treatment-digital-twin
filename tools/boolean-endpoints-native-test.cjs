'use strict';
// Actual newly built Unity player: two endpoint bits -> real CAD feed transforms.
// --hold keeps this isolated visible fixture alive for parent-controlled screenshots.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createRunDirectory, requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { waitForOwnedHold } = require('./native-hold-session.cjs');
const root = path.resolve(__dirname, '..'), held = process.argv.includes('--hold'), checks = [], evidence = [];
let directory, helper, unity;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = label => { checks.push(label); console.log('PASS ' + label); };
async function main() {
    assert.equal(process.platform, 'win32');
    assert.ok(process.env.MOTION_TEST_UNITY_EXE, 'Set MOTION_TEST_UNITY_EXE to the new output-only player; no installed fallback.');
    const exe = requireTestPath(path.resolve(process.env.MOTION_TEST_UNITY_EXE));
    const assembly = requireTestPath(path.join(path.dirname(exe), path.parse(exe).name + '_Data', 'Managed', 'Assembly-CSharp.dll'));
    const beforeExe = hash(exe), beforeAssembly = hash(assembly);
    const motion = require('../shared/motionPackages.json').models.cad_transfer_cart_101300;
    const sourceAsset = path.join(root, 'backend', '.' + motion.sourcePath), rigAsset = path.join(root, 'backend', '.' + motion.rigPath), clipAsset = path.join(root, 'backend', '.' + motion.clipPath);
    const assetHashes = [sourceAsset, rigAsset, clipAsset].map(file => ({ file, sha256: hash(file) }));
    const packageData = JSON.parse(fs.readFileSync(clipAsset, 'utf8')), feedClip = packageData.clips.find(row => row.id === 'feed');
    assert.ok(feedClip?.tracks.some(row => row.node === 'cad_transfer_cart_v1_feed_carriage' && row.channel === 'p'));
    directory = createRunDirectory('boolean-endpoints-native-player'); const infoFile = path.join(directory, 'server.json');
    helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'boolean-endpoints-native-server.cjs')], { cwd: root,
        env: { ...process.env, BOOLEAN_ENDPOINTS_INFO_FILE: infoFile }, logFile: path.join(directory, 'backend.log') });
    await waitUntil(() => { assert.equal(helper.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'isolated two-endpoint backend');
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    requireTestPath(info.directory); requireTestPath(info.database); requireTestPath(info.env.APP_DATA_DIR);
    for (const url of [info.origin, info.control]) { const parsed = new URL(url); assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.protocol, 'http:'); }
    const headers = { 'Content-Type':'application/json', Origin:info.origin, 'X-Admin-Request':'1', Cookie:info.session.cookie, 'X-CSRF-Token':info.session.csrfToken };
    const api = async (route, method = 'GET', body) => { const response = await fetch(info.origin + route, { method, headers, ...(body === undefined ? {} : { body:JSON.stringify(body) }), signal:AbortSignal.timeout(20000) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
    const modelMetadata = async () => { const models=await api('/api/models'); assert.ok(Array.isArray(models));const model=models.find(row=>row.id===info.modelId);assert.ok(model);return typeof model.metadata==='string'?JSON.parse(model.metadata):model.metadata||{}; };
    const control = async body => { const response = await fetch(info.control, { method:'POST', body:JSON.stringify(body), signal:AbortSignal.timeout(10000) }); assert.ok(response.ok); const state = await response.json(); evidence.push({ event:'source-control', state }); return state; };
    const catalog = await api('/api/data-center/catalog?device_id=' + info.deviceId);
    const itemFor = id => catalog.items.find(item => item.type === 'boolean' && item.binding?.mode === 'plc' && String(item.binding.pointId) === id);
    const extended = itemFor(info.extendedPointId), retracted = itemFor(info.retractedPointId);
    assert.ok(extended && retracted && extended.id !== retracted.id, 'two real distinct BOOL data-center items');
    const deviceRoute = '/api/devices/' + info.deviceId + '/animations', initial = await api(deviceRoute);
    assert.ok(initial.actions.some(action => action.id === 'clip:feed' && action.mode === 'position'), 'actual packaged CAD feed action available');
    const feedBinding = { actionId:'clip:feed', enabled:true, inputMin:0, inputMax:1, invert:false, speed:1, transitionSeconds:2,
        trigger:{mode:'endpoints',extended:{dataItemId:extended.id},retracted:{dataItemId:retracted.id}} };
    await api(deviceRoute, 'PUT', { revision:initial.revision, config:{version:1,staleMs:1000,bindings:[feedBinding]} });
    pass('real CAD transfer cart feed action binds only the two guaranteed read-only BOOL points through the actual data-center save API');
    const log = path.join(directory, 'unity.log');
    unity = spawn(exe, [...(held ? [] : ['-batchmode']),'-force-d3d11','-screen-fullscreen','0','-screen-width','1400','-screen-height','900','-logFile',log], { cwd:path.dirname(exe), windowsHide:!held, stdio:'ignore',
        env:{...info.env,DIGITAL_TWIN_BACKEND_HTTP_URL:info.origin,DIGITAL_TWIN_BACKEND_WEBSOCKET_URL:info.origin.replace('http:','ws:')+'/ws',DIGITAL_TWIN_ADMIN_URL:info.origin+'/admin',DIGITAL_TWIN_APPLICATION_CHROME:'false',DIGITAL_TWIN_MAXIMIZE_WINDOW:'false',DIGITAL_TWIN_DISABLE_NATIVE_ADMIN_HOST:'1',DEVICE_ANIMATION_DIAGNOSTICS:'1',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'} });
    await authorizeSmokeUnity(info.origin, unity, info.session);
    const readLog = () => fs.existsSync(log) ? fs.readFileSync(log,'utf8') : '';
    const snapshots = () => readLog().split(/\r?\n/).flatMap(line => { if(!line.startsWith('[DeviceAnimation] '))return [];try{const sample=JSON.parse(line.slice(18));return sample.deviceId===info.deviceId?[sample]:[]}catch{return []} });
    const refreshes = () => readLog().split(/\r?\n/).flatMap(line => { if(!line.startsWith('[ModelRefresh] '))return [];try{return [JSON.parse(line.slice(15))];}catch{return []} });
    async function refreshed(at,label,requireAffected=true){let row;await waitUntil(()=>{row=refreshes().find(value=>value.timestamp>=at&&(!requireAffected||value.affected.includes(info.deviceId)));return row},30000,label,50);evidence.push({event:label,refresh:row});return row;}
    const actionOf = sample => sample.actions.find(action => action.clipId === 'feed');
    const partOf = sample => sample.partActions?.find(action => action.actionId === 'part:endpoint_sync_hook');
    async function observe(predicate, label, from = 0, timeout = 90000) { let sample; await waitUntil(() => { assert.equal(unity.exitCode,null,readLog().slice(-4000)); assert.equal(helper.exitCode,null,'owned backend exited'); sample=snapshots().slice(from).find(row=>actionOf(row)&&predicate(row));return sample; },timeout,label,50); evidence.push({event:label,sample});return sample; }
    function poseMatches(sample, progress) {
        const action = actionOf(sample); assert.equal(action.tracks.length,feedClip.tracks.length);
        for(const row of action.tracks){const track=feedClip.tracks.find(value=>value.node===row.node&&value.channel===row.channel);assert.ok(track);const offset=Math.max(0,Math.min(1,progress))*(feedClip.count-1),left=Math.floor(offset),right=Math.min(feedClip.count-1,left+1),ratio=track.channel==='v'?0:offset-left;let sign=1;
            if(track.channel==='q'){const dot=Array.from({length:track.size},(_,i)=>track.values[left*track.size+i]*track.values[right*track.size+i]).reduce((a,b)=>a+b,0);if(dot<0)sign=-1;}
            const expected=Array.from({length:track.size},(_,i)=>track.values[left*track.size+i]*(1-ratio)+sign*track.values[right*track.size+i]*ratio);
            if(track.channel==='p')expected[0]*=-1;if(track.channel==='q'){expected[1]*=-1;expected[2]*=-1;const length=Math.hypot(...expected);expected.forEach((value,i)=>expected[i]=value/length);}
            expected.forEach((value,i)=>assert.ok(Math.abs(value-row.actual[i])<.0004,`${row.node}/${row.channel}/${i}: expected ${value}, actual ${row.actual[i]}`));
        }
    }
    function frozen(before, after) { assert.equal(actionOf(after).position,actionOf(before).position);assert.equal(actionOf(after).seconds,actionOf(before).seconds);assert.deepEqual(actionOf(after).tracks,actionOf(before).tracks); }
    const back = await observe(sample=>actionOf(sample).usable&&actionOf(sample).endpointStage==='retracted'&&actionOf(sample).position===0,'initial true retracted endpoint');poseMatches(back,0);
    pass('native initialization shows the actually confirmed retracted CAD pose, without replaying a fictitious stroke');
    let from=snapshots().length;await control({extended:false,retracted:false});
    const waiting=await observe(sample=>!actionOf(sample).usable&&actionOf(sample).endpointStage==='waiting','both off waiting',from);
    const waitingStill=await observe(sample=>sample.capturedAt>waiting.capturedAt+650&&!actionOf(sample).usable,'both off stays frozen',snapshots().length);frozen(waiting,waitingStill);poseMatches(waitingStill,0);
    pass('both-off only waits; no timer invents intermediate position or confirms a successful transfer');
    from=snapshots().length;await control({extended:true,retracted:false});
    const moving=await observe(sample=>actionOf(sample).usable&&actionOf(sample).target===1&&actionOf(sample).position>0&&actionOf(sample).position<1,'healthy confirmed extension display transition',from);poseMatches(moving,actionOf(moving).position);
    const front=await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===1&&actionOf(sample).endpointStage==='extended','confirmed extension endpoint',from);poseMatches(front,1);
    pass('healthy endpoint confirmation drives the actual CAD carriage, gear and return-chain channels using the same sampled package as the management preview');
    from=snapshots().length;await control({extended:false,retracted:false});
    const frontWait=await observe(sample=>!actionOf(sample).usable&&actionOf(sample).endpointStage==='waiting','waiting after front confirmation',from);poseMatches(frontWait,1);
    from=snapshots().length;await control({extended:true,retracted:true});
    const conflict=await observe(sample=>!actionOf(sample).usable&&actionOf(sample).endpointStage==='conflict','both on feedback conflict',from);poseMatches(conflict,1);
    const conflictStill=await observe(sample=>sample.capturedAt>conflict.capturedAt+600&&!actionOf(sample).usable,'conflict stays frozen',snapshots().length);frozen(conflict,conflictStill);
    pass('both-on feedback conflict freezes actual geometry and is not interpreted as two successful stages');
    from=snapshots().length;await control({extended:false,retracted:true});
    const conflictRecovery=await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===0,'conflict recovery aligns latest endpoint',from);poseMatches(conflictRecovery,0);
    from=snapshots().length;await control({extended:true,retracted:false});await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===1,'front endpoint before disconnection',from);
    from=snapshots().length;await control({offline:true,extended:false,retracted:true});
    const bad=await observe(sample=>!actionOf(sample).usable&&actionOf(sample).endpointStage==='invalid','bad endpoint quality',from);poseMatches(bad,1);
    from=snapshots().length;await control({offline:false});const recovered=await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===0,'bad-quality recovery follows current back feedback',from);poseMatches(recovered,0);
    from=snapshots().length;await control({paused:true});
    const stale=await observe(sample=>!actionOf(sample).usable&&actionOf(sample).reason==='数据超时','source observation timeout',from);poseMatches(stale,0);
    const staleStill=await observe(sample=>sample.capturedAt>stale.capturedAt+600&&!actionOf(sample).usable,'source timeout stays frozen',snapshots().length);frozen(stale,staleStill);
    from=snapshots().length;await control({paused:false,extended:true,retracted:false});const staleRecovery=await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===1,'timeout recovery aligns current front feedback',from);poseMatches(staleRecovery,1);
    pass('bad/stale sources freeze geometry; fresh recovery reads the latest endpoint directly rather than continuing a disconnected display timer');

    // Current supported UI API: model component action definitions, not the removed authoring editor.
    from=snapshots().length;await control({extended:false,retracted:false});await observe(sample=>!actionOf(sample).usable&&actionOf(sample).endpointStage==='waiting','frozen endpoint before model action addition',from);
    const modelRoute='/api/models/'+info.modelId+'/bindings';
    const oldBindings=(await modelMetadata()).partBindings||[];
    const component={id:'endpoint_sync_hook',name:'验收新增 · 推拉钩偏转',node_name:'cad_transfer_cart_v1_hook_latch',node_path:'',source_group:'mechanisms',source_key:'feed_extended',action:'rotate_angle',axis:'x',input_min:0,input_max:1,output_min:0,output_max:30,speed_factor:1,transition_duration:0};
    const addedAt=Date.now();await api(modelRoute,'PUT',{partBindings:[...oldBindings,component],expectedBindings:oldBindings});
    const addedRefresh=await refreshed(addedAt,'model component addition applies with no factory rebuild');
    const reloaded=await observe(sample=>sample.capturedAt>addedAt&&actionOf(sample).endpointStage==='waiting','model action addition preserves frozen cart endpoint through configuration reload',snapshots().length);poseMatches(reloaded,1);
    const available=await api(deviceRoute);assert.ok(available.actions.some(action=>action.id==='part:endpoint_sync_hook'),'new component action exposed by management API');
    const newBinding={actionId:'part:endpoint_sync_hook',enabled:true,dataItemId:extended.id,trigger:{mode:'condition',operator:'eq',value:true,hysteresis:0},inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:0};
    const bindAt=Date.now();await api(deviceRoute,'PUT',{revision:available.revision,config:{version:1,staleMs:1000,bindings:[feedBinding,newBinding]}});
    from=snapshots().length;await control({extended:true,retracted:false});
    const angleMatches=(row,degrees)=>row?.usable&&Math.abs(Math.abs(row.actualRotation[0])-Math.sin(degrees*Math.PI/360))<.0005&&Math.abs(Math.abs(row.actualRotation[3])-Math.cos(degrees*Math.PI/360))<.0005;
    const newlyBound=await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===1&&angleMatches(partOf(sample),30),'new component action plays in same native process',from);
    const configAdditionMs=addedRefresh.timestamp-addedAt, configBindingMs=newlyBound.capturedAt-bindAt;
    pass('adding a current model component action and binding existing data makes it play in the same Unity process without recompile or restart');
    const bindingsNow=(await modelMetadata()).partBindings;
    assert.ok(bindingsNow?.find(binding=>binding.id===component.id),'new component definition saved in model metadata');
    const updatedBindings=bindingsNow.map(binding=>binding.id===component.id?{...binding,output_max:60}:binding), editedAt=Date.now();
    await api(modelRoute,'PUT',{partBindings:updatedBindings,expectedBindings:bindingsNow});
    const edited=await observe(sample=>sample.capturedAt>editedAt&&angleMatches(partOf(sample),60),'edited component action hot reloads in same player',snapshots().length);poseMatches(edited,1);
    const configEditMs=edited.capturedAt-editedAt;
    pass('editing the component action output updates its actual native transform live, while the existing CAD feed remains correct');

    const beforeDelete=(await modelMetadata()).partBindings, deletedAt=Date.now();
    await api(modelRoute,'PUT',{partBindings:beforeDelete.filter(binding=>binding.id!==component.id),expectedBindings:beforeDelete});
    await refreshed(deletedAt,'component deletion refreshes only its model');
    await observe(sample=>sample.capturedAt>deletedAt&&!partOf(sample)&&actionOf(sample).position===1,'deleted component action does not remain in native driver',snapshots().length);
    const afterDelete=(await modelMetadata()).partBindings, restoredAt=Date.now();
    await api(modelRoute,'PUT',{partBindings:[...afterDelete,{...component,output_max:60}],expectedBindings:afterDelete});
    await refreshed(restoredAt,'component re-add uses same player and preserved endpoint');
    const rebound=await api(deviceRoute);await api(deviceRoute,'PUT',{revision:rebound.revision,config:{version:1,staleMs:1000,bindings:[feedBinding,newBinding]}});
    await observe(sample=>sample.capturedAt>restoredAt&&angleMatches(partOf(sample),60),'re-added component plays only after explicit data binding',snapshots().length);
    const firstRapid=(await modelMetadata()).partBindings;
    await api(modelRoute,'PUT',{partBindings:firstRapid.map(binding=>binding.id===component.id?{...binding,output_max:45}:binding),expectedBindings:firstRapid});
    const secondRapid=(await modelMetadata()).partBindings, rapidAt=Date.now();
    await api(modelRoute,'PUT',{partBindings:secondRapid.map(binding=>binding.id===component.id?{...binding,output_max:60}:binding),expectedBindings:secondRapid});
    await refreshed(rapidAt,'rapid model edits apply authoritative final version',false);
    await observe(sample=>sample.capturedAt>rapidAt&&angleMatches(partOf(sample),60),'rapid edits cannot publish stale component definition',snapshots().length);
    pass('component deletion removes the actual native action; explicit re-add/rebind and rapid edits apply only the final authoritative definition');

    const fast=await api(deviceRoute);feedBinding.transitionSeconds=.25;await api(deviceRoute,'PUT',{revision:fast.revision,config:{version:1,staleMs:1000,bindings:[feedBinding,newBinding]}});
    if(process.env.MOTION_LATENCY_READY_FILE){const readyFile=requireTestPath(path.resolve(process.env.MOTION_LATENCY_READY_FILE));console.log('Waiting for isolated performance gate: '+readyFile);await waitUntil(()=>fs.existsSync(readyFile),300000,'other verification work completes before native latency sampling',250);}
    await pause(1500);let target=0;const latencies=[];
    for(let index=0;index<16;index++){
        from=snapshots().length;const changed=await control({extended:target===1,retracted:target===0});
        const first=await observe(sample=>actionOf(sample).usable&&actionOf(sample).target===target&&actionOf(sample).firstTransformAt>=changed.changedAt&&actionOf(sample).firstTransformAt>=actionOf(sample).sourceTimestamp,'latency first transform '+index,from);
        const action=actionOf(first);latencies.push({target,sourceReadAt:action.sourceTimestamp,sourceToTransformMs:action.firstTransformAt-action.sourceTimestamp,controlToTransformMs:action.firstTransformAt-changed.changedAt,receiveToTransformMs:action.firstTransformAt-action.signalChangedAt});
        await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===target,'latency terminal pose '+index,from);target=1-target;
    }
    const stats=key=>{const values=latencies.map(row=>row[key]).sort((a,b)=>a-b);return {samples:values.length,p50:values[Math.floor((values.length-1)*.5)],p95:values[Math.ceil((values.length-1)*.95)],max:values.at(-1)};};
    pass('sixteen real native source/receive/first-transform observations measure latency separately from the intentional display transition');
    const finalConfig=await api(deviceRoute);feedBinding.transitionSeconds=2;await api(deviceRoute,'PUT',{revision:finalConfig.revision,config:{version:1,staleMs:1000,bindings:[feedBinding,newBinding]}});
    from=snapshots().length;await control({extended:false,retracted:true,offline:false,paused:false});await observe(sample=>actionOf(sample).usable&&actionOf(sample).position===0,'final back endpoint for screenshot fixture',from);
    assert.equal(hash(exe),beforeExe);assert.equal(hash(assembly),beforeAssembly);for(const row of assetHashes)assert.equal(hash(row.file),row.sha256);
    assert.ok(readLog().includes('[FactoryRuntime] Native factory ready:'));assert.equal(/fallback=[1-9]|Exception:|Motion rig node missing|Motion clip missing|Motion material renderer missing/.test(readLog()),false,readLog().slice(-5000));
    assert.equal((readLog().match(/\[FactoryRuntime\] Native factory ready:/g)||[]).length,1,'model/action changes must not rebuild the hall/factory');
    assert.equal((readLog().match(/\[RuntimeModelLibrary\] Loaded cad_transfer_cart_101300:/g)||[]).length,1,'first/last action flags and edited bindings must reuse the preserved CAD rig geometry');
    const refreshEvidence=refreshes();assert.ok(refreshEvidence.length>=7);
    for(const row of refreshEvidence){assert.equal(row.before.factoryRoot,row.after.factoryRoot);assert.deepEqual(row.before.environmentRoots,row.after.environmentRoots);assert.equal(row.before.deviceRoots.endpoint_furnace,row.after.deviceRoots.endpoint_furnace);assert.deepEqual(row.before.cameraPosition,row.after.cameraPosition);assert.deepEqual(row.before.cameraRotation,row.after.cameraRotation);assert.equal(row.before.viewId,row.after.viewId);assert.equal(row.before.loadingId,row.after.loadingId);assert.equal(row.after.sceneReady,true);assert.ok(row.affected.length===0||JSON.stringify(row.affected)===JSON.stringify([info.deviceId]));if(row.affected.length===0)assert.deepEqual(row.before.deviceRoots,row.after.deviceRoots);}
    pass('targeted model/action refresh preserves the same factory, hall, camera, current view and unrelated furnace roots; paired specific/generic events do not cause a full reload');
    pass('adding, editing and deleting component actions never re-download/import the unchanged all-node-preserved CAD rig; independent renderers and the actual endpoint clip remain available');
    let visibleWindowHandle=null;if(held){await waitUntil(()=>{const r=spawnSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${unity.pid} -ErrorAction Stop).MainWindowHandle.ToInt64()`],{windowsHide:true,encoding:'utf8'});visibleWindowHandle=Number(r.stdout?.trim());return r.status===0&&visibleWindowHandle>0},30000,'held native Unity window is visible',500);}
    const result={success:true,checks,directory,log,executable:exe,unityPid:unity.pid,backendPid:helper.pid,exeSha256:beforeExe,assemblySha256:beforeAssembly,assetHashes,unchangedExecutable:true,unchangedAssets:true,displayOnly:true,noCollectorOrPhysicalPlc:true,installedRuntimeUsed:false,sourceItems:{extended:extended.id,retracted:retracted.id},latencies,latencyStats:{sourceReadToFirstTransform:stats('sourceToTransformMs'),controlToFirstTransform:stats('controlToTransformMs'),receiveToFirstTransform:stats('receiveToTransformMs')},latencyScope:'100ms isolated read-only injection -> backend motion inputs -> real Unity transform; not a PLC/collector end-to-end measurement',displayTransitionSeconds:2,configurationReload:{additionMs:configAdditionMs,bindingMs:configBindingMs,editMs:configEditMs,targeted:true,factoryBuilds:1},refreshEvidence,visibleWindowHandle,snapshots:snapshots().length,evidence,held};
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));
    fs.writeFileSync(path.join(directory,'held-session.json'),JSON.stringify({directory,origin:info.origin,control:info.control,serverInfo:infoFile,unityPid:unity.pid,backendPid:helper.pid,scriptPid:process.pid,log,held,finishFile:path.join(directory,'finish.request'),finishCommand:'create finish.request or send finish newline to this owned script stdin',componentActionId:'endpoint_sync_hook',displayTransitionSeconds:2},null,2));
    console.log(JSON.stringify({success:true,directory,checks:checks.length,unityPid:unity.pid,held,latencyStats:result.latencyStats,configurationReload:result.configurationReload},null,2));
    if(held){console.log('HELD_READY '+path.join(directory,'held-session.json'));await waitForOwnedHold({finishFile:path.join(directory,'finish.request')});}
}
main().catch(error=>{if(directory)fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:false,checks,directory,error:error.stack||error.message,evidence},null,2));console.error(error);process.exitCode=1;}).finally(async()=>{await stopOwnedSmokeProcess(unity);await stopOwnedSmokeProcess(helper);});
