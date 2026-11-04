'use strict';
// Select-only inventory of the locally saved desktop project. Never starts its collector.
const fs = require('node:fs'), path = require('node:path');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
async function main() {
    const data = path.join(process.env.APPDATA, 'heat-treatment-digital-twin-desktop/data');
    const config = JSON.parse(fs.readFileSync(path.join(data, 'database-config.json')));
    if (config.type !== 'mysql' || config.host !== '127.0.0.1') throw Error('This inventory only allows the saved local MySQL database');
    const mysql = require('../backend/node_modules/mysql2/promise');
    const db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
    const directory = createRunDirectory('current-binding-inventory');
    const parse = (x, fallback = {}) => { try { return typeof x === 'string' ? JSON.parse(x) : x || fallback; } catch { return fallback; } };
    try {
        await db.query('SET SESSION TRANSACTION READ ONLY'); await db.beginTransaction();
        const query = async (sql, args = []) => (await db.query(sql, args))[0];
        const active = (await query("SELECT value FROM settings WHERE `key`='active_factory_id'"))[0]?.value;
        const factories = await query('SELECT id,name,collection_enabled FROM factories');
        const scenes = await query('SELECT id,project_id,name,published_release_id,draft_revision,draft_json FROM scenes');
        const releases = await query('SELECT id,scene_id,is_current,snapshot_json FROM releases WHERE is_current=1');
        const devices = await query('SELECT id,name,plc_enabled,plc_protocol,model_type,instance_config FROM devices');
        const points = await query('SELECT id,device_id,label,plc_tag,data_type,sample_interval_ms FROM data_points');
        const activeDevices = await query('SELECT d.id,d.name,d.model_type,d.plc_enabled FROM devices d JOIN `lines` l ON l.id=d.line_id JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=?', [active]);
        const scopedSettings = await query("SELECT `key`,value FROM factory_settings WHERE factory_id=? AND `key` IN ('data_mode','external_dataset_config')", [active]);
        const connections = [];
        for (const name of fs.readdirSync(data).filter(n => /^data-sources.*\.json$/.test(n))) {
            const source = parse(fs.readFileSync(path.join(data, name), 'utf8'));
            for (const c of source.connections || []) connections.push({ file: name, id: c.id, name: c.name, sourceType: c.sourceType, connector: c.connector, enabled: c.enabled,
                requestPath: c.request?.path || c.requestPath || '', queryKeys: Object.keys(c.queries || {}), refreshMs: c.refreshMs,
                // Only local request shapes are retained. No credential/auth/baseUrl is exported.
                queries: c.queries });
        }
        const summary = { activeFactoryId: active, factories, scenes: scenes.map(s => ({ id: s.id, projectId: s.project_id, name: s.name, publishedReleaseId: s.published_release_id,
            draftRevision: s.draft_revision, widgets: (parse(s.draft_json).widgets || []).map(w => ({ id: w.id, type: w.type, title: w.title, data: w.data, visibility: w.visibility })) })),
            releases: releases.map(r => ({ id: r.id, sceneId: r.scene_id, widgets: (parse(r.snapshot_json).widgets || parse(r.snapshot_json).document?.widgets || []).map(w => ({ id: w.id, type: w.type, title: w.title, data: w.data })) })),
            activeDevices, activeSettings: Object.fromEntries(scopedSettings.map(s => [s.key, s.key === 'external_dataset_config' ? parse(s.value) : s.value])),
            devices: devices.map(d => ({ id: d.id, name: d.name, plcEnabled: !!d.plc_enabled, protocol: d.plc_protocol, model: d.model_type,
                animationBindings: parse(d.instance_config).animationBindings || null })), points, connections, readOnly: true, remoteConnectionsMade: false };
        await db.rollback(); fs.writeFileSync(path.join(directory, 'inventory.json'), JSON.stringify(summary, null, 2));
        const activeScene = scenes.find(s => s.id === active + '_scene'), activeRelease = releases.find(r => r.scene_id === activeScene?.id);
        const fileSources = parse(fs.readFileSync(path.join(data, 'data-sources.' + active + '.json'), 'utf8'));
        const payloads = {};
        for (const c of fileSources.connections || []) {
            if (c.connector !== 'file' || !/^[a-f0-9-]+\.json$/.test(c.baseUrl || '')) continue;
            const filename = path.join(data, 'data-source-files', active, c.baseUrl);
            if (fs.existsSync(filename)) payloads[c.id] = parse(fs.readFileSync(filename, 'utf8'));
        }
        fs.writeFileSync(path.join(directory, 'active-reference.json'), JSON.stringify({ activeFactoryId: active,
            draftDocument: parse(activeScene?.draft_json), publishedDocument: parse(activeRelease?.snapshot_json),
            datasets: summary.activeSettings.external_dataset_config?.datasets || [], devices: activeDevices,
            sources: (fileSources.connections || []).map(c => ({ id: c.id, name: c.name, sourceType: c.sourceType, connector: c.connector, enabled: c.enabled })), payloads }, null, 2));
        console.log(JSON.stringify({ directory, activeFactoryId: active, devices: devices.length, plcEnabled: devices.filter(d => d.plc_enabled).length,
            points: points.length, animationConfigured: summary.devices.filter(d => d.animationBindings?.bindings?.length).length,
            activeMode: summary.activeSettings.data_mode, activeDeviceCount: activeDevices.length, activePoints: points.filter(p => activeDevices.some(d => d.id === p.device_id)).length,
            scenes: summary.scenes.map(s => ({ id: s.id, name: s.name, widgets: s.widgets.length })), connections: connections.length, filePayloads: Object.keys(payloads).length }, null, 2));
    } finally { await db.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
