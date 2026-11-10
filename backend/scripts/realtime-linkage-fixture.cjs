'use strict';
// Shared isolated HTTP fixture for real Vue -> API -> persisted configuration
// tests. No live profile, PLC, production database or browser is used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, testFetch, forceStop } = require('./integration-test-utils.cjs');

async function createLinkageFixture(prefix = 'realtime-transfer-link') {
    const directory = createRunDirectory(prefix), dataDir = path.join(directory, 'data'), filename = path.join(dataDir, 'factory.db');
    await createTestDatabase(filename);
    const Database = require('better-sqlite3'), sql = new Database(filename);
    const models = require('../services/builtinModels').getBuiltinModels();
    const cartModel = models.find(model => model.id === 'cad_transfer_cart_101300');
    const targetModel = models.find(model => model.id === 'cad_multipurpose_furnace_082000');
    assert.ok(cartModel?.motion_package && targetModel, 'the real managed CAD motion assets are required');
    const line = sql.prepare('SELECT l.* FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? ORDER BY l.id LIMIT 1').get('factory_default');
    // A fresh installation intentionally seeds only one factory. Add a
    // separately owned scope inside this fixture rather than assuming samples.
    sql.prepare('INSERT INTO factories (id,name) VALUES (?,?)').run('linkage_foreign_factory','Foreign fixture');
    sql.prepare('INSERT INTO workshops (id,factory_id,name) VALUES (?,?,?)').run('linkage_foreign_ws','linkage_foreign_factory','Foreign workshop');
    sql.prepare('INSERT INTO `lines` (id,workshop_id,name) VALUES (?,?,?)').run('linkage_foreign_line','linkage_foreign_ws','Foreign line');
    const foreignLine = sql.prepare('SELECT * FROM `lines` WHERE id=?').get('linkage_foreign_line');
    assert.ok(line && foreignLine, 'the isolated fixture must provide independent factory scopes');
    for (const [model, direction] of [[cartModel, 1], [targetModel, -1]]) {
        const metadata = typeof model.metadata === 'string' ? JSON.parse(model.metadata || '{}') : { ...model.metadata };
        metadata.loadingPorts = { version: 1, inlet: { position:[0,0,0],direction:[direction,0,0],nodeName:'' }, outlet:{ position:[0,0,0],direction:[direction,0,0],nodeName:'' } };
        sql.prepare('INSERT OR REPLACE INTO models (id,name,file_path,metadata,asset_type,placement_level) VALUES (?,?,?,?,?,?)')
            .run(model.id, model.name, model.file_path, JSON.stringify(metadata), 'model', 'device');
    }
    const cartId = 'linkage_cart', targetId = 'linkage_furnace', foreignId = 'linkage_foreign';
    for (const [id, model, lineId, x] of [[cartId, cartModel, line.id,0], [targetId,targetModel,line.id,1], [foreignId,targetModel,foreignLine.id,1]]) {
        sql.prepare('INSERT INTO devices (id,name,line_id,model_type,pos_x,pos_y,pos_z,rotation_y,scale,plc_enabled,instance_config) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(id,id,lineId,model.id,x,0,0,0,1,0,JSON.stringify({marker:'must survive',inspection:{enabled:false},plcMarker:{address:'fixture-only'}}));
    }
    const points = {};
    for (const [key, deviceId, type, role, access] of [
        ['position',cartId,'REAL','actual_position','READ'], ['start',cartId,'WORD','start_action','READ'],
        ['feed',cartId,'REAL','motion_feed','READ'], ['presence',cartId,'BOOL','material_present','READ'],
        ['write',cartId,'BOOL','write_present','WRITE'], ['foreign',foreignId,'BOOL','material_present','READ'],
        ['targetPosition',targetId,'REAL','actual_position','READ']
    ]) points[key] = String(sql.prepare('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(deviceId,role,role,'DB1.DBD'+(Object.keys(points).length*4),type,'mechanisms',role,access,200).lastInsertRowid);
    const origin = `http://127.0.0.1:${await findFreePort()}`;
    let backend;
    try {
        backend = startLoggedProcess(process.execPath, ['server.js'], { cwd:BACKEND_DIR,
            env:{...process.env,APP_DATA_DIR:dataDir,PORT:new URL(origin).port,HOST:'127.0.0.1'},logFile:path.join(directory,'backend.log') });
        await waitForHttp(origin+'/api/health');
    } catch (error) { sql.close(); await forceStop(backend); throw error; }
    const request = async (url, method = 'GET', body, factoryId = 'factory_default') => {
        const response = await testFetch(origin + url, {method,headers:{'Content-Type':'application/json','X-Factory-ID':factoryId},...(body!==undefined?{body:JSON.stringify(body)}:{})});
        return {status:response.status,data:await response.json()};
    };
    const ok = async (...args) => { const response=await request(...args);assert.ok(response.status>=200 && response.status<300,JSON.stringify(response));return response.data; };
    const facade = { get:async (query,parameters=[])=>sql.prepare(query).get(...parameters), all:async (query,parameters=[])=>sql.prepare(query).all(...parameters), run:async(query,parameters=[])=>sql.prepare(query).run(...parameters) };
    return {directory,dataDir,filename,origin,sql,facade,cartId,targetId,foreignId,line,foreignLine,points,cartModel,targetModel,request,ok,
        async close(){ await forceStop(backend); if(sql.open)sql.close(); }};
}
module.exports = { createLinkageFixture };
