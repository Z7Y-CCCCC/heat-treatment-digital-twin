'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRunDirectory, createTestDatabase, BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, testFetch, forceStop } = require('./integration-test-utils.cjs');
const { getBuiltinModels } = require('../services/builtinModels');
const author = require('../services/motionAuthoring');
const directory = createRunDirectory('motion-authoring'), uploads = path.join(directory, 'uploads'), data = path.join(directory, 'data');
let server;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const row = (nodeId, operation = 'translate') => ({ nodeId, operation, axis: 'y', from: 0, to: operation === 'rotate' ? 90 : .6, start: 0, end: 1, easing: 'linear', pivot: [0,0,0], fromColor:'#111111', toColor:'#ffffff' });
const action = (nodes, id = 'user_door_lift') => ({ id, label: '门升降与转臂', mode: 'position', duration: 2, cycle: 'forward', tracks: [row(nodes[0].id), row(nodes[1].id, 'rotate')] });
(async () => {
    await createTestDatabase(path.join(data, 'factory.db')); fs.mkdirSync(path.join(uploads, 'models'), { recursive: true });
    const document = { asset: { version:'2.0' }, scene:0, scenes:[{ nodes:[0] }], nodes:[{name:'duplicate',children:[1,2],translation:[1,2,3]}, {name:'duplicate',translation:[0,1,0],scale:[2,3,4]},{name:'user_motion_node_1'},{name:'unused_other_scene'}] };
    const fixture = author.encodeGlb(document, [{type:0x4e4f534a,bytes:Buffer.from('{}')}]); fs.writeFileSync(path.join(uploads,'models/fixture.glb'), fixture);
    const priorUploads = process.env.UPLOADS_DIR; process.env.UPLOADS_DIR = uploads;
    try {
        const prepared = author.prepare({ id:'write_fixture',file_path:'/uploads/models/fixture.glb',metadata:'{}' }), compiled = author.compile({ id:'write_fixture',file_path:'/uploads/models/fixture.glb' },prepared,[action(prepared.nodes)]);
        const originalWrite = fs.writeFileSync;
        try {
            fs.writeFileSync = function(file,bytes,...args) { if(String(file).endsWith('.tmp')) { originalWrite.call(fs,file,bytes.subarray(0,4),...args);throw Object.assign(new Error('owned disk-full fixture'),{code:'ENOSPC'}); } return originalWrite.call(fs,file,bytes,...args); };
            assert.throws(()=>author.storeCompiled(prepared,compiled),/disk-full/);
        } finally { fs.writeFileSync = originalWrite; }
        const folder = path.join(uploads,compiled.folder); assert.deepEqual(fs.readdirSync(folder),[],'interrupted file writes leave no published partial blob');
        author.storeCompiled(prepared,compiled);const file=path.join(folder,compiled.clipName);fs.writeFileSync(file,'interrupted old output');author.storeCompiled(prepared,compiled);assert.equal(hash(fs.readFileSync(file)),compiled.bundle.clipSha256,'retry repairs an old corrupt generated file without changing model data');
        const rename = fs.renameSync;
        fs.writeFileSync(file, 'old complete snapshot during transient lock'); let attempts = 0;
        fs.renameSync = function(from, to) {
            if (to === file && attempts++ < 2) {
                assert.equal(fs.readFileSync(file, 'utf8'), 'old complete snapshot during transient lock');
                throw Object.assign(new Error('transient compiled sharing violation'), { code: 'EPERM' });
            }
            return rename(from, to);
        };
        try { author.storeCompiled(prepared, compiled); }
        finally { fs.renameSync = rename; }
        assert.ok(attempts >= 3 && attempts <= 4, 'compiled publication retries are bounded');
        assert.equal(hash(fs.readFileSync(file)), compiled.bundle.clipSha256);
        for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EIO']) {
            const previous = `previous complete snapshot ${code}`; fs.writeFileSync(file, previous);
            const failure = Object.assign(new Error(`injected compiled ${code}`), { code }); let calls = 0;
            fs.renameSync = function(from, to) { if (to === file) { calls++; throw failure; } return rename(from, to); };
            try { assert.throws(() => author.storeCompiled(prepared, compiled), error => error === failure); }
            finally { fs.renameSync = rename; }
            assert.equal(calls, code === 'EIO' ? 1 : 4);
            assert.equal(fs.readFileSync(file, 'utf8'), previous, 'failed replacement must never remove or truncate the old target');
            assert.deepEqual(fs.readdirSync(folder).filter(name => name.endsWith('.tmp')), [], 'failed publication cleans only its owned temporary');
        }
        // Another publisher can independently complete this exact hash. That
        // idempotent race does not justify swallowing an unrelated disk failure.
        fs.writeFileSync(file, 'concurrent publisher fixture');
        const ioFailure = Object.assign(new Error('compiled EIO after another publisher'), { code: 'EIO' }); let ioCalls = 0;
        fs.renameSync = function(from, to) {
            if (to === file) { ioCalls++; fs.writeFileSync(file, compiled.bytes); throw ioFailure; }
            return rename(from, to);
        };
        try { assert.throws(() => author.storeCompiled(prepared, compiled), error => error === ioFailure); }
        finally { fs.renameSync = rename; }
        assert.equal(ioCalls, 1); assert.equal(hash(fs.readFileSync(file)), compiled.bundle.clipSha256);
        fs.writeFileSync(file, 'concurrent valid sharing-lock fixture');
        const lockFailure = Object.assign(new Error('concurrent complete compiled blob is held'), { code: 'EPERM' }); let lockCalls = 0;
        fs.renameSync = function(from, to) {
            if (to === file) { lockCalls++; fs.writeFileSync(file, compiled.bytes); throw lockFailure; }
            return rename(from, to);
        };
        try { author.storeCompiled(prepared, compiled); }
        finally { fs.renameSync = rename; }
        assert.equal(lockCalls, 4); assert.equal(hash(fs.readFileSync(file)), compiled.bundle.clipSha256);
        fs.writeFileSync(file, 'cleanup failure must preserve old target');
        const publicationFailure = Object.assign(new Error('original compiled publication EIO'), { code: 'EIO' });
        const remove = fs.rmSync;
        fs.renameSync = function(from, to) { if (to === file) throw publicationFailure; return rename(from, to); };
        fs.rmSync = function(filename, ...options) {
            if (path.dirname(filename) === folder && filename.endsWith('.tmp')) throw Object.assign(new Error('secondary temporary cleanup failure'), { code: 'EPERM' });
            return remove(filename, ...options);
        };
        try { assert.throws(() => author.storeCompiled(prepared, compiled), error => error === publicationFailure); }
        finally { fs.renameSync = rename; fs.rmSync = remove; }
        assert.equal(fs.readFileSync(file, 'utf8'), 'cleanup failure must preserve old target');
        const ownedTemporary = fs.readdirSync(folder).filter(name => name.startsWith(compiled.clipName + '.') && name.endsWith('.tmp'));
        assert.equal(ownedTemporary.length, 1);
        for (const name of ownedTemporary) remove(path.join(folder, name), { force: true });
    } finally { if(priorUploads === undefined) delete process.env.UPLOADS_DIR; else process.env.UPLOADS_DIR = priorUploads; }
    let originalClips = 0;
    for (const builtin of getBuiltinModels().filter(model => model.motion_package)) {
        const prepared = author.prepare(builtin), compiled = author.compile(builtin, prepared, []), original = JSON.parse(fs.readFileSync(author.localFile(builtin.motion_package.clipPath)));
        assert.deepEqual(compiled.data.clips, original.clips, 'existing CAD tracks must survive without numerical changes'); originalClips += original.clips.length;
    }
    assert.ok(originalClips >= 37, 'existing 37 CAD/process clips stay available; this is not a maximum for future additions');
    const Database = require('better-sqlite3'), db = new Database(path.join(data,'factory.db'));
    db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run(); db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run(); db.prepare('UPDATE devices SET plc_enabled=0').run();
    const template = getBuiltinModels().find(m=>m.id==='cad_multipurpose_furnace_082000');
    const insert = db.prepare('INSERT INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)');
    insert.run('author_test','动作测试','/uploads/models/fixture.glb',JSON.stringify({unrelated:{keep:1},inspection:{enabled:false},partBindings:[]}), 'device','model');
    insert.run(template.id,template.name,template.file_path,template.metadata,'device','model');
    const device = db.prepare('SELECT id FROM devices LIMIT 1').get(); db.prepare('UPDATE devices SET model_type=? WHERE id=?').run('author_test',device.id);
    const point = db.prepare('SELECT id FROM data_points WHERE device_id=? LIMIT 1').get(device.id); db.prepare("UPDATE data_points SET category='analog',value_role='stroke',access_type='READ' WHERE id=?").run(point.id); db.close();
    const origin = `http://127.0.0.1:${await findFreePort()}`;
    server = startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...process.env,APP_DATA_DIR:data,UPLOADS_DIR:uploads,PORT:new URL(origin).port,HOST:'127.0.0.1'},logFile:path.join(directory,'backend.log')}); await waitForHttp(origin+'/api/health');
    const request = async (route, method='GET', body, factory) => { const res = await testFetch(origin+route,{method,headers:{'Content-Type':'application/json',...(factory?{'X-Factory-ID':factory}:{})},...(body?{body:JSON.stringify(body)}:{})}); return {status:res.status,data:await res.json()}; };
    const ok = async (...args) => { const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r));return r.data; };
    const route='/api/models/author_test/motion-actions', initial=await ok(route), draft=action(initial.nodes), before=await ok('/api/config');
    assert.equal(initial.nodes.length,3,'unreachable nodes must not become selectable or required native targets');assert.equal(new Set(initial.nodes.map(n=>n.name)).size,3,'generated aliases cannot collide with authored names');
    assert.notEqual(initial.nodes[0].name,initial.nodes[1].name,'duplicate source names become stable independent motion targets');
    const preview=await ok(route+'/preview','POST',{revision:initial.revision,actions:[draft]});
    assert.deepEqual((await ok('/api/config')).models.find(m=>m.id==='author_test').metadata,before.models.find(m=>m.id==='author_test').metadata,'preview never publishes metadata');
    const saved=await ok(route,'PUT',{revision:initial.revision,actions:[draft]});assert.notEqual(saved.revision,initial.revision);
    const metadata=JSON.parse(saved.model.metadata);assert.deepEqual(metadata.unrelated,{keep:1});assert.deepEqual(metadata.inspection,{enabled:false});
    assert.equal(saved.model.motion_package.clipSha256,saved.bundle.clipSha256);assert.equal(saved.bundle.clipSha256,preview.bundle.clipSha256);
    const bytes=Buffer.from(await (await fetch(origin+saved.bundle.clipPath)).arrayBuffer()), packageData=JSON.parse(bytes);assert.equal(hash(bytes),saved.bundle.clipSha256);
    assert.deepEqual(fs.readFileSync(path.join(uploads,'models/fixture.glb')),fixture,'source GLB is immutable');
    const clip=packageData.clips.find(c=>c.id===draft.id), translation=clip.tracks.find(t=>t.channel==='p');
    assert.deepEqual(translation.values.slice(0,3),[1,2,3]);assert.deepEqual(translation.values.slice(-3),[1,2.6,3]);assert.equal(clip.count,49);
    const rotate=clip.tracks.find(t=>t.channel==='q');assert.ok(Math.abs(rotate.values.at(-2)-0)<1e-7);assert.ok(Math.abs(rotate.values.at(-1)-Math.SQRT1_2)<1e-7);
    assert.equal((await request(route,'PUT',{revision:initial.revision,actions:[draft]})).status,409,'old editors cannot overwrite newer actions');
    for(const changed of [{...draft,tracks:[{...draft.tracks[0],nodeId:'-1'}]},{...draft,tracks:[{...draft.tracks[0],to:Infinity}]},{...draft,tracks:[draft.tracks[0],draft.tracks[0]]},{...draft,duration:60},{...draft,id:'door'}]) assert.equal((await request(route,'PUT',{revision:saved.revision,actions:[changed]})).status,400);
    const deviceRoute=`/api/devices/${device.id}/animations`, animation=await ok(deviceRoute);
    assert.ok(animation.actions.some(a=>a.id==='clip:'+draft.id));
    const binding={actionId:'clip:'+draft.id,enabled:true,pointId:String(point.id),inputMin:0,inputMax:100,invert:false,speed:1,transitionSeconds:0};
    const beforeRejectedBinding=await ok(`/api/devices/${device.id}`);
    const rejectedBinding=await request(deviceRoute,'PUT',{revision:animation.revision,config:{version:1,staleMs:1500,bindings:[binding]}});
    assert.equal(rejectedBinding.status,400,'retired custom clips cannot acquire newly enabled device bindings');
    assert.match(rejectedBinding.data.error,/旧自定义动画.*不能再启用/);
    assert.deepEqual(await ok(`/api/devices/${device.id}`),beforeRejectedBinding,'rejected activation cannot mutate any stored device fields');
    // Seed only this owned output database to represent a pre-retirement device.
    // The public API must never create that enabled legacy state now.
    const historicalBinding={...binding,kind:'clip',mode:'position',clipId:draft.id,partId:'',sourceGroup:'analog',sourceKey:'stroke'};
    const historicalInstance={...JSON.parse(beforeRejectedBinding.instance_config||'{}'),animationBindings:{version:1,staleMs:1500,bindings:[historicalBinding]}};
    const historyDb=new Database(path.join(data,'factory.db'));
    try { historyDb.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(historicalInstance),device.id); }
    finally { historyDb.close(); }
    assert.equal((await request(route,'PUT',{revision:saved.revision,actions:[]})).status,409,'cannot delete a bound action');
    assert.equal((await request(route,'PUT',{revision:saved.revision,actions:[{...draft,mode:'running'}]})).status,409,'cannot silently alter bound driving mode');
    const edited={...draft,tracks:[{...draft.tracks[0],to:1.2},draft.tracks[1]]}, editedSaved=await ok(route,'PUT',{revision:saved.revision,actions:[edited]});assert.notEqual(editedSaved.bundle.clipSha256,saved.bundle.clipSha256);
    const historical=await ok(deviceRoute),disabled=await ok(deviceRoute,'PUT',{revision:historical.revision,config:{...historical.config,bindings:historical.config.bindings.map(row=>({...row,enabled:false}))}});
    assert.equal(disabled.config.bindings[0].enabled,false);
    const afterRetirement=JSON.parse((await ok(`/api/devices/${device.id}`)).instance_config);
    assert.deepEqual(afterRetirement,{...historicalInstance,animationBindings:{...historicalInstance.animationBindings,bindings:[{...historicalBinding,enabled:false}]}},'explicit retirement changes only the legacy enabled flag, not its stored definition or other device fields');
    assert.equal((await request(route,'GET',null,'factory_pit_furnaces_v1')).status,404);
    const cadRoute=`/api/models/${template.id}/motion-actions`, cad=await ok(cadRoute), cadDraft=action(cad.nodes,'user_extra');
    const originalCadClips=JSON.parse(fs.readFileSync(author.localFile(template.motion_package.clipPath))).clips;
    assert.ok(originalCadClips.some(clip=>clip.id==='process_cycle'),'the complete multipurpose process must be included');
    const expectedCadIds=[...originalCadClips.map(clip=>clip.id),cadDraft.id].sort();
    const assertPreservedCadClips=async bundle=>{
        assert.deepEqual(bundle.actions.map(clip=>clip.id).sort(),expectedCadIds,'editing preserves all built-in actions and exactly one custom action');
        const response=await fetch(origin+bundle.clipPath);assert.equal(response.status,200);
        const bytes=Buffer.from(await response.arrayBuffer());assert.equal(hash(bytes),bundle.clipSha256);
        const compiled=JSON.parse(bytes);assert.deepEqual(compiled.clips.map(clip=>clip.id).sort(),expectedCadIds,'compiled clips cannot be missing or duplicated');
        for(const original of originalCadClips)assert.deepEqual(compiled.clips.find(clip=>clip.id===original.id),original,'original CAD duration and tracks survive custom editing unchanged');
    };
    const cadSaved=await ok(cadRoute,'PUT',{revision:cad.revision,actions:[cadDraft]});await assertPreservedCadClips(cadSaved.bundle);
    const cadAgain=await ok(cadRoute), cadResaved=await ok(cadRoute,'PUT',{revision:cadAgain.revision,actions:[{...cadDraft,label:'修改动作名称'}]});await assertPreservedCadClips(cadResaved.bundle);
    const exportResponse=await testFetch(origin+'/api/project-bundles/export');assert.equal(exportResponse.status,200,await exportResponse.clone().text());const zip=await exportResponse.arrayBuffer();
    const inspectForm=new FormData();inspectForm.append('file',new Blob([zip],{type:'application/zip'}),'motion-project.zip');const inspectedResponse=await testFetch(origin+'/api/project-bundles/inspect',{method:'POST',body:inspectForm}), inspected=await inspectedResponse.json();assert.equal(inspectedResponse.status,200,JSON.stringify(inspected));
    const form=new FormData();form.append('file',new Blob([zip],{type:'application/zip'}),'motion-project.zip');form.append('name','动作迁移验收');form.append('inspectedSha256',inspected.sha256);
    const importedResponse=await testFetch(origin+'/api/project-bundles/import',{method:'POST',body:form});const imported=await importedResponse.json();assert.equal(importedResponse.status,201,JSON.stringify(imported));
    const migratedConfig=await ok('/api/config','GET',null,imported.factoryId), migrated=migratedConfig.models.find(m=>m.name==='动作测试');assert.ok(migrated.motion_package);
    const migratedBytes=Buffer.from(await (await fetch(origin+migrated.motion_package.clipPath)).arrayBuffer());assert.equal(hash(migratedBytes),migrated.motion_package.clipSha256);assert.equal(JSON.parse(migratedBytes).modelId,migrated.id);
    const reopened=await ok(`/api/models/${migrated.id}/motion-actions`,'GET',null,imported.factoryId);assert.equal(reopened.actions[0].id,draft.id);
    await ok(`/api/models/${migrated.id}/motion-actions`,'PUT',{revision:reopened.revision,actions:reopened.actions},imported.factoryId);
    const result={success:true,directory,checks:['generic GLB including duplicate names','atomic compiled publication retries transient locks within a bounded old-target-preserving window','persistent compiled locks and EIO retain the original error without partial publication','concurrent complete blobs remain idempotent but never mask EIO','temporary cleanup cannot replace the original publication error','preview cannot publish','immutable source and hash verified assets','sampled position/rotation','CAS, invalid targets/timing/duplicate channel validation','retired custom clip activation denied without stored changes','explicit retirement preserves the historical binding and other device fields','existing bound history deletion/mode protection','editing changes portable hash without Unity code changes','preserves all built-in CAD clips','factory isolation','project export/import preserves clips, rewrites model identity and hashes, and permits re-editing']};
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>forceStop(server));
