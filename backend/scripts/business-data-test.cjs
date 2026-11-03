const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heat-treatment-business-data-'));
    const database = path.join(root, 'schedule.db');
    const Database = require('better-sqlite3');
    const seed = new Database(database);
    seed.exec(`
        CREATE TABLE produce_batch (
            id INTEGER PRIMARY KEY, batch_no TEXT, batch_name TEXT, product_name TEXT,
            operator TEXT, workpiece_count INTEGER, workpiece_weight REAL, template_id INTEGER,
            status TEXT, current_step INTEGER, progress INTEGER, plan_start_time TEXT,
            actual_start_time TEXT, actual_finish_time TEXT, update_time TEXT, create_time TEXT
        );
        CREATE TABLE produce_batch_step (
            id INTEGER PRIMARY KEY, batch_id INTEGER, step_index INTEGER, step_name TEXT,
            furnace_id TEXT, furnace_type_id INTEGER, technology_id INTEGER,
            actual_begin_time TEXT, actual_end_time TEXT, status TEXT, create_time TEXT
        );
        CREATE TABLE rc_furnace_attr_history (
            id INTEGER PRIMARY KEY, device_id TEXT, signal_id INTEGER, signal_name TEXT,
            actual_value TEXT, batch_id INTEGER, record_time TEXT, create_time TEXT
        );
        CREATE TABLE device_statistics_daily (
            id INTEGER PRIMARY KEY, furnace_id TEXT, stat_date TEXT, total_runtime INTEGER,
            idle_time INTEGER, alarm_time INTEGER, offline_time INTEGER, batch_count INTEGER,
            alarm_count INTEGER, utilization_rate REAL
        );
        CREATE TABLE template (id INTEGER PRIMARY KEY, code TEXT, name TEXT, description TEXT, steps TEXT);
    `);
    seed.prepare(`INSERT INTO produce_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        101, 'B-20260830-001', '齿轮渗碳批次', '齿轮', '张工', 120, 860.5, 7,
        'RUNNING', 2, 48, '2026-08-30 08:00:00', '2026-08-30 08:12:00', null,
        '2026-08-30 10:00:00', '2026-08-30 07:50:00'
    );
    seed.prepare(`INSERT INTO produce_batch_step VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        1, 101, 1, '渗碳', 'FURNACE-01', 1, 7, '2026-08-30 08:12:00', null, 'RUNNING', '2026-08-30 08:00:00'
    );
    seed.prepare(`INSERT INTO rc_furnace_attr_history VALUES (?,?,?,?,?,?,?,?)`).run(
        1, 'FURNACE-01', 13, '实际温度', '920.5', 101, '2026-08-30 10:00:00', '2026-08-30 10:00:00'
    );
    seed.prepare(`INSERT INTO rc_furnace_attr_history VALUES (?,?,?,?,?,?,?,?)`).run(
        2, 'FURNACE-01', 14, '碳势值', '1.12', 101, '2026-08-30 10:00:00', '2026-08-30 10:00:00'
    );
    seed.prepare(`INSERT INTO device_statistics_daily VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        1, 'FURNACE-01', '2026-08-30', 480, 60, 5, 0, 3, 1, 88.5
    );
    seed.close();

    process.env.APP_DATA_DIR = root;
    const dataSources = require('../services/dataSources');
    const businessData = require('../services/businessData');
    const connection = dataSources.saveDataSource({
        id: 'schedule_readonly', name: '排产系统只读库', type: 'sqlite', filename: database, enabled: true
    });
    const snapshot = await businessData.readBusinessSnapshot(connection.id, {
        deviceId: 'FURNACE-01', limit: 20
    });
    if (snapshot.readOnly !== true) throw new Error('业务快照没有声明只读');
    if (!snapshot.sections.batches.available || snapshot.sections.batches.rows[0].batchNo !== 'B-20260830-001') {
        throw new Error(`批次读取失败：${JSON.stringify(snapshot.sections.batches)}`);
    }
    if (!snapshot.sections.compliance.available || snapshot.sections.compliance.rows.length !== 2) {
        throw new Error(`温度/碳势读取失败：${JSON.stringify(snapshot.sections.compliance)}`);
    }
    if (!snapshot.sections.oee.available || snapshot.sections.oee.rows[0].utilizationRate !== 88.5) {
        throw new Error(`设备统计读取失败：${JSON.stringify(snapshot.sections.oee)}`);
    }
    if (snapshot.sections.energy.available || snapshot.sections.maintenance.available) {
        throw new Error('缺失的可选业务表不应被伪造为可用');
    }
    const assert=require('node:assert/strict');
    const widget={id:'business_rotating',type:'business_summary',content:{section:'batches'},data:{mode:'business',connectionId:connection.id,deviceScope:'rotation',rotationDeviceIds:['FURNACE-01','FURNACE-02'],rotationIntervalMs:2000,refreshMs:1000}};
    const context={factoryId:'factory_default',viewMode:'factory',playbackDevices:[{id:'FURNACE-01',name:'一号炉'},{id:'FURNACE-02',name:'二号炉'}]};
    const first=(await dataSources.readRuntimeBindings([widget],{...context,playbackAt:0}))[widget.id];
    const second=(await dataSources.readRuntimeBindings([widget],{...context,playbackAt:2000}))[widget.id];
    assert.equal(first.rows[0].batchNo,'B-20260830-001');assert.equal(first.deviceId,'FURNACE-01');
    assert.equal(second.deviceId,'FURNACE-02');assert.deepEqual(second.rows,[]);
    const detail=(await dataSources.readRuntimeBindings([widget],{...context,playbackAt:2000,viewMode:'device',deviceId:'FURNACE-01'}))[widget.id];
    assert.equal(detail.rows[0].batchNo,'B-20260830-001');assert.equal(detail.deviceId,'FURNACE-01');
    const more=new Database(database);
    more.exec("CREATE TABLE energy_consumption(id INTEGER,device_id TEXT,energy REAL); INSERT INTO energy_consumption VALUES(1,'FURNACE-01',0),(2,'FURNACE-02',850)");more.close();
    const energy=await businessData.readBusinessSection(connection.id,'energy',{deviceId:'FURNACE-01'});
    assert.deepEqual(energy.rows.map(r=>r.energy),[0]);
    let writeRejected = false;
    try { await dataSources.executeReadOnlyQuery(connection.id, 'UPDATE produce_batch SET status = ? WHERE id = ?', ['DONE', 101]); }
    catch (error) { writeRejected = /只允许|禁止/.test(error.message); }
    if (!writeRejected) throw new Error('只读查询边界未拒绝 UPDATE');

    // 真实排产系统（js_robot）使用 sd_ 前缀，并把温度/碳势历史拆成
    // signal_history + rc_signal。保留一份 SQLite fixture，确保现场适配
    // 不会因为表名差异退化为“暂无数据”。
    const sdDatabase = path.join(root, 'schedule-sd.db');
    const sdSeed = new Database(sdDatabase);
    sdSeed.exec(`
        CREATE TABLE sd_produce_batch (
            id INTEGER PRIMARY KEY, batch_no TEXT, batch_name TEXT, product_name TEXT,
            operator TEXT, workpiece_count INTEGER, workpiece_weight REAL, template_id INTEGER,
            status TEXT, current_step INTEGER, progress INTEGER, plan_start_time TEXT,
            actual_start_time TEXT, actual_finish_time TEXT, update_time TEXT, create_time TEXT
        );
        CREATE TABLE sd_produce_batch_step (
            id INTEGER PRIMARY KEY, batch_id INTEGER, step_index INTEGER, step_name TEXT,
            furnace_id TEXT, furnace_type_id INTEGER, technology_id INTEGER,
            actual_begin_time TEXT, actual_end_time TEXT, status TEXT, create_time TEXT
        );
        CREATE TABLE signal_history (
            id INTEGER PRIMARY KEY, signal_id INTEGER, furnace_id TEXT, value TEXT, record_time TEXT
        );
        CREATE TABLE rc_signal (
            id INTEGER PRIMARY KEY, name TEXT, signal_category TEXT
        );
        CREATE TABLE device_statistics_daily (
            id INTEGER PRIMARY KEY, furnace_id TEXT, stat_date TEXT, total_runtime INTEGER,
            idle_time INTEGER, alarm_time INTEGER, offline_time INTEGER, batch_count INTEGER,
            alarm_count INTEGER, utilization_rate REAL
        );
    `);
    sdSeed.prepare(`INSERT INTO sd_produce_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        202, 'SD-20260830-001', '前缀批次', '齿轮', '现场工程师', 12, 88.2, 9,
        'RUNNING', 1, 20, '2026-08-30 08:00:00', '2026-08-30 08:10:00', null,
        '2026-08-30 10:00:00', '2026-08-30 07:50:00'
    );
    sdSeed.prepare(`INSERT INTO sd_produce_batch_step VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        1, 202, 1, '渗碳', 'FURNACE-SD-01', 1, 9, '2026-08-30 08:10:00', null, 'RUNNING', '2026-08-30 08:00:00'
    );
    sdSeed.prepare(`INSERT INTO rc_signal VALUES (?,?,?)`).run(1, '实际温度', 'TEMPERATURE');
    sdSeed.prepare(`INSERT INTO signal_history VALUES (?,?,?,?,?)`).run(1, 1, 'FURNACE-SD-01', '921.5', '2026-08-30 10:00:00');
    sdSeed.prepare(`INSERT INTO device_statistics_daily VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        1, 'FURNACE-SD-01', '2026-08-30', 480, 60, 5, 0, 3, 1, 88.5
    );
    sdSeed.close();
    const sdConnection = dataSources.saveDataSource({
        id: 'schedule_sd_alias', name: '排产系统 sd_ 兼容测试', type: 'sqlite', filename: sdDatabase, enabled: true
    });
    const sdSnapshot = await businessData.readBusinessSnapshot(sdConnection.id, {
        deviceId: 'FURNACE-SD-01', limit: 20
    });
    if (!sdSnapshot.sections.batches.available || sdSnapshot.sections.batches.rows[0].batchNo !== 'SD-20260830-001') {
        throw new Error(`sd_ 前缀批次读取失败：${JSON.stringify(sdSnapshot.sections.batches)}`);
    }
    if (!sdSnapshot.sections.compliance.available || sdSnapshot.sections.compliance.rows[0].value !== 921.5) {
        throw new Error(`signal_history 温度读取失败：${JSON.stringify(sdSnapshot.sections.compliance)}`);
    }
    if (!sdSnapshot.sections.oee.available || sdSnapshot.sections.oee.rows[0].utilizationRate !== 88.5) {
        throw new Error(`sd_ 设备统计读取失败：${JSON.stringify(sdSnapshot.sections.oee)}`);
    }

    console.log(JSON.stringify({
        success: true,
        contractVersion: snapshot.contractVersion,
        batch: snapshot.sections.batches.rows[0].batchNo,
        complianceRows: snapshot.sections.compliance.rows.length,
        utilizationRate: snapshot.sections.oee.rows[0].utilizationRate,
        sdPrefixAlias: sdSnapshot.sections.batches.rows[0].batchNo,
        signalHistoryAliasValue: sdSnapshot.sections.compliance.rows[0].value,
        optionalSectionsExplicitlyUnavailable: true,
        writesRejected: true
    }, null, 2));
    fs.rmSync(root, { recursive: true, force: true });
}

main().catch(error => {
    console.error(JSON.stringify({ success: false, error: error.stack || error.message }, null, 2));
    process.exitCode = 1;
});
