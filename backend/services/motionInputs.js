'use strict';

// Prepared catalog definitions are not live values. Resolve only owned sources
// and retain their real read/confirmation timestamps across broadcast cycles.
const { getDb } = require('../db/database');
const { loadDeviceAnimations, validateCatalogItem, sourceFingerprint } = require('./deviceAnimations');
const { readDefinition, bindingResult } = require('./dataSets');
const { MotionSemanticResolver } = require('./motionSemantics');
const { deviceLineId } = require('./deviceLineUnits');
const parseObject = value => { try { return typeof value === 'string' ? JSON.parse(value || '{}') : value || {}; } catch { return {}; } };
function milliseconds(value) {
    if (value == null || value === '') return 0;
    const number = Number(value), result = Number.isFinite(number) ? number : Date.parse(value);
    return Number.isFinite(result) && result > 0 ? result : 0;
}
function qualityLeaves(value) {
    if (typeof value === 'string') return [value];
    return value && typeof value === 'object' ? Object.values(value).flatMap(qualityLeaves) : [];
}
function sample(row, value, quality, timestamp, now, staleMs) {
    timestamp = milliseconds(timestamp);
    if (quality !== 'good' || value == null || !['number','string','boolean'].includes(typeof value)
        || typeof value === 'number' && !Number.isFinite(value) || !timestamp || timestamp > now + 1000) {
        return { dataItemId:row.dataItemId, value:null, quality:quality === 'stale' ? 'stale' : 'bad', timestamp, staleMs };
    }
    if (now - timestamp > staleMs) return { dataItemId:row.dataItemId, value:null, quality:'stale', timestamp, staleMs };
    return { dataItemId:row.dataItemId, value, quality:'good', timestamp, staleMs };
}
function catalogSample(row, item, loaded, frame, datasets, now, readAt) {
    const staleMs = loaded.config.staleMs || 5000;
    const invalid = () => sample(row, null, 'bad', 0, now, staleMs);
    try { validateCatalogItem(item, loaded.device.id); } catch { return invalid(); }
    if (!row.sourceFingerprint || row.sourceFingerprint !== sourceFingerprint(item)) return invalid();
    const binding = item.binding;
    let value = null, quality = 'bad', timestamp = 0;
    if (binding.mode === 'plc') {
        const separator = binding.pointKey.indexOf('.'), group = binding.pointKey.slice(0, separator), field = binding.pointKey.slice(separator + 1), metadata = frame?.pointMeta?.[binding.pointKey];
        // Frames from merged PLC tasks must not freshen an un-read point. Old
        // collectors without per-point confirmation metadata fail closed.
        if (!metadata || String(metadata.id) !== String(binding.pointId)) return invalid();
        value = frame?.[group]?.[field]; quality = frame?.quality?.[group]?.[field] || 'bad';
        timestamp = metadata.timestamp || metadata.last_good_update_ms || metadata.lastReadAt;
        if (frame?.status?.online === false) quality = 'bad';
    } else if (binding.mode === 'dataset') {
        const result = datasets.get(row.dataItemId);
        if (!result || result.fingerprint !== sourceFingerprint(item)) return invalid();
        ({ value, quality, timestamp } = result);
    } else if (binding.path === 'deviceInfo.dataStatus') {
        const qualities = qualityLeaves(frame?.quality);
        const observed = frame?.status?.online === false || qualities.some(q => ['good','bad','stale'].includes(q));
        const state = frame?.status?.online === false || qualities.some(q => q === 'bad') ? 'bad'
            : qualities.some(q => q === 'stale') ? 'stale' : qualities.length && qualities.every(q => q === 'good') ? 'good' : 'unknown';
        // An observed "disconnected" status is valid status data, not a healthy
        // temperature reading. It can trigger an offline indicator until the
        // actual observation expires; packaging clocks cannot renew it.
        quality = observed && state !== 'unknown' ? 'good' : 'bad';
        value = state === 'good' ? '数据正常' : state === 'stale' ? '数据已过期' : '数据异常 / 未连接';
        timestamp = frame?.connectionStatusTimestamp || frame?.timestamp;
    } else {
        // These are real owned DB rows, not catalog previewValue (which may be
        // a different object's example). readAt records the actual DB query.
        const scope = loaded.catalog.devices.find(d => String(d.id) === String(loaded.device.id));
        const fields = { 'deviceInfo.name':loaded.device.name, 'deviceInfo.id':String(loaded.device.id),
            'deviceInfo.modelName':loaded.device.model_type, 'deviceInfo.workshopName':scope?.workshopName,
            'deviceInfo.lineName':scope?.lineName };
        value = fields[binding.path]; quality = value == null ? 'bad' : 'good'; timestamp = readAt;
    }
    if (typeof value !== item.type) quality = 'bad';
    return sample(row, value, quality, timestamp, now, staleMs);
}
function motionSources(row) {
    const sources = row?.trigger?.mode === 'endpoints' ? [row.trigger.extended,row.trigger.retracted] : [row];
    return sources.filter(source => source?.dataItemId).map(source => ({ ...source, enabled:row.enabled }));
}
function hasCatalogBindings(config, enabledOnly = false) {
    return configuredMotionSources(config).some(row => (!enabledOnly || row.enabled) && row.dataItemId);
}
function configuredMotionSources(config) {
    const rows = (config?.bindings || []).flatMap(motionSources), transfer = config?.transferLink;
    if (transfer?.presenceDataItemId) rows.push({ enabled:transfer.enabled === true, dataItemId:transfer.presenceDataItemId, sourceFingerprint:transfer.presenceSourceFingerprint });
    return rows;
}
function endpointFeedbackSample(row, loaded, frame, datasets, now, readAt) {
    const endpointFeedback = {};
    for (const name of ['extended','retracted']) {
        const source = row.trigger?.[name] || {dataItemId:''};
        const item = loaded.catalog?.items.find(item => item.id === source.dataItemId);
        endpointFeedback[name] = row.enabled ? catalogSample(source,item,loaded,frame,datasets,now,readAt)
            : sample(source,null,'bad',0,now,loaded.config.staleMs);
        if (endpointFeedback[name].quality === 'good' && typeof endpointFeedback[name].value !== 'boolean') endpointFeedback[name] = { ...endpointFeedback[name], value:null, quality:'bad' };
    }
    const samples = Object.values(endpointFeedback), quality = samples.some(input => input.quality === 'stale') ? 'stale'
        : samples.every(input => input.quality === 'good') ? 'good' : 'bad';
    let stage = 'invalid', value = null;
    if (quality === 'good') {
        const extended = endpointFeedback.extended.value, retracted = endpointFeedback.retracted.value;
        stage = extended && retracted ? 'conflict' : extended ? 'extended' : retracted ? 'retracted' : 'waiting';
        value = stage === 'extended' ? 1 : stage === 'retracted' ? 0 : null;
    }
    // The pair is not a synthetic PLC stage. Preserve each source's actual
    // confirmation time; transport/catalog reload clocks may never renew it.
    return { endpointFeedback, value, quality:stage === 'conflict' ? 'bad' : quality,
        timestamp:Math.min(...samples.map(input => input.timestamp || 0)), staleMs:loaded.config.staleMs || 5000, stage };
}

class MotionInputResolver {
    constructor(options = {}) {
        this.getDb = options.getDb || getDb;
        this.semanticResolver = options.semanticResolver || new MotionSemanticResolver({ getDb: this.getDb, now: options.now, maxDevices: options.maxDevices });
        this.loadDevice = options.loadDevice || loadDeviceAnimations;
        this.readDefinition = options.readDefinition || readDefinition;
        this.bindingResult = options.bindingResult || bindingResult;
        this.now = options.now || Date.now;
        this.reloadMs = options.reloadMs || 1000;
        this.maxDevices = options.maxDevices || 5000;
        this.maxConcurrent = options.maxConcurrent || 4;
        this.entries = new Map(); this.queue = new Map(); this.running = 0;
        this.generation = 0; this.closed = false; this.discoveryBusy = false;
    }
    start(publish, active = () => true) {
        this.publish = publish; this.active = active;
        this.semanticResolver.start();
        this.timer = setInterval(() => this.poll().catch(() => {}), this.reloadMs);
        this.timer.unref?.();
    }
    entry(id) {
        let entry = this.entries.get(id);
        if (!entry && this.entries.size < this.maxDevices) {
            entry = { id, loaded:null, readAt:0, datasets:new Map(), lastFrame:null, datasetBusy:new Map(), nextReload:0, loadToken:0, datasetToken:0 };
            this.entries.set(id, entry);
        }
        return entry;
    }
    enqueue(key, work) {
        if (this.closed || this.queue.has(key) || this.queue.size >= this.maxDevices * 2) return false;
        this.queue.set(key, work); this.drain(); return true;
    }
    drain() {
        while (!this.closed && this.running < this.maxConcurrent && this.queue.size) {
            const [key, work] = this.queue.entries().next().value;
            this.queue.delete(key); this.running++;
            Promise.resolve().then(work).catch(() => {}).finally(() => { this.running--; this.drain(); });
        }
    }
    refresh(entry) {
        if (entry.loading || this.now() < entry.nextReload) return;
        entry.loading = true; entry.nextReload = this.now() + this.reloadMs;
        const generation = this.generation, token = ++entry.loadToken;
        const accepted = this.enqueue(`device:${entry.id}`, async () => {
            try {
                const db = await this.getDb(), device = await db.get('SELECT * FROM devices WHERE id=?', [entry.id]);
                if (!device) throw Error('设备已移除');
                const instance = parseObject(device.instance_config);
                if (!hasCatalogBindings(instance.animationBindings)) {
                    entry.loaded = null; entry.datasets.clear(); entry.nextReload = this.now() + Math.max(10000, this.reloadMs); return;
                }
                const lineId = deviceLineId(device, instance);
                const owner = lineId
                    ? await db.get('SELECT w.factory_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=?', [lineId])
                    : await db.get('SELECT factory_id FROM workshops WHERE id=?', [instance.workshop_id || instance.workshopId || '']);
                if (!owner) throw Error('设备范围不存在');
                const loaded = await this.loadDevice(db, entry.id, owner.factory_id, { includeTransferTargets:false }), readAt = this.now();
                if (this.closed || generation !== this.generation || token !== entry.loadToken) return;
                const previous = entry.loaded?.revision;
                entry.loaded = loaded; entry.readAt = readAt;
                if (previous && previous !== loaded.revision) entry.datasets.clear();
                this.scheduleDatasets(entry);
                if (this.active?.() !== false && hasCatalogBindings(loaded.config)) this.publish?.([
                    { furnace_id:entry.id, timestamp:readAt, motionInputOnly:true, motionInputs:this.inputs(entry, entry.lastFrame) }
                ]);
            } catch {
                if (generation === this.generation && token === entry.loadToken) { entry.loaded = null; entry.datasets.clear(); }
            } finally { if (token === entry.loadToken) entry.loading = false; }
        });
        if (!accepted) entry.loading = false;
    }
    scheduleDatasets(entry) {
        const loaded = entry.loaded;
        if (!loaded || this.closed) return;
        for (const row of configuredMotionSources(loaded.config)) {
            if (!row.enabled || !row.dataItemId || entry.datasetBusy.has(row.dataItemId)) continue;
            const item = loaded.catalog.items.find(i => i.id === row.dataItemId);
            if (item?.binding?.mode !== 'dataset') continue;
            try { validateCatalogItem(item, entry.id); } catch { entry.datasets.delete(row.dataItemId); continue; }
            if (row.sourceFingerprint !== sourceFingerprint(item)) { entry.datasets.delete(row.dataItemId); continue; }
            const definition = loaded.datasets.find(d => d.id === item.binding.datasetId);
            const current = entry.datasets.get(row.dataItemId);
            if (!definition || current && this.now() < current.nextReadAt) continue;
            const token = ++entry.datasetToken;
            entry.datasetBusy.set(row.dataItemId, token);
            const generation = this.generation, revision = loaded.revision;
            const accepted = this.enqueue(`dataset:${entry.id}:${row.dataItemId}`, async () => {
                let record;
                try {
                    const scope = loaded.catalog.devices.find(d => String(d.id) === entry.id);
                    const instance = parseObject(loaded.device.instance_config), lineId = deviceLineId(loaded.device, instance);
                    const context = { factoryId:loaded.factoryId, deviceId:entry.id,
                        lineId, workshopId:scope?.workshopId || instance.workshop_id || instance.workshopId || '',
                        widgetRefreshMs:definition.refreshMs };
                    // Catalog device summaries intentionally omit internal IDs;
                    // resolve them from the owned relationships when required.
                    if (lineId) {
                        const db = await this.getDb(), line = await db.get('SELECT workshop_id FROM `lines` WHERE id=?', [lineId]);
                        context.workshopId = line?.workshop_id || '';
                    }
                    const result = this.bindingResult(await this.readDefinition(definition, context, loaded.factoryId), item.binding);
                    record = { value:result.value, quality:result.quality, timestamp:milliseconds(result.fetchedAt),
                        fingerprint:sourceFingerprint(item), nextReadAt:this.now() + Math.max(250, result.refreshAfterMs ?? definition.refreshMs) };
                } catch {
                    // A failed request is not a successful observation. Do not
                    // stamp Date.now into timestamp and pretend it is fresh.
                    record = { value:null, quality:'bad', timestamp:current?.timestamp || 0,
                        fingerprint:sourceFingerprint(item), nextReadAt:this.now() + Math.min(5000, definition.refreshMs) };
                }
                if (!this.closed && generation === this.generation && entry.loaded?.revision === revision && entry.datasetBusy.get(row.dataItemId) === token) {
                    entry.datasets.set(row.dataItemId, record);
                    if (this.active?.() !== false) this.publish?.([{ furnace_id:entry.id, timestamp:this.now(), motionInputOnly:true,
                        motionInputs:this.inputs(entry, entry.lastFrame) }]);
                }
                if (entry.datasetBusy.get(row.dataItemId) === token) entry.datasetBusy.delete(row.dataItemId);
            });
            if (!accepted) entry.datasetBusy.delete(row.dataItemId);
        }
    }
    inputs(entry, frame) {
        const result = {}, loaded = entry.loaded;
        if (!loaded) return result;
        for (const row of loaded.config.bindings || []) {
            if (row.trigger?.mode === 'endpoints') {
                result[row.actionId] = endpointFeedbackSample(row,loaded,frame,entry.datasets,this.now(),entry.readAt);
                continue;
            }
            if (!row.dataItemId) continue;
            const item = loaded.catalog.items.find(i => i.id === row.dataItemId);
            result[row.actionId] = row.enabled
                ? catalogSample(row, item, loaded, frame, entry.datasets, this.now(), entry.readAt)
                : sample(row, null, 'bad', 0, this.now(), loaded.config.staleMs);
        }
        const transfer = loaded.config.transferLink;
        if (transfer?.enabled === true) {
            const row = { dataItemId:transfer.presenceDataItemId, sourceFingerprint:transfer.presenceSourceFingerprint };
            const item = loaded.catalog.items.find(item => item.id === row.dataItemId);
            const input = catalogSample(row, item, loaded, frame, entry.datasets, this.now(), entry.readAt);
            result.__transfer_presence = typeof input.value === 'boolean' || input.quality !== 'good' ? input : { ...input, value:null, quality:'bad' };
        }
        return result;
    }
    decorate(devices) {
        return devices.map(frame => {
            const id = String(frame?.furnace_id || '');
            const entry = id && this.entry(id);
            if (!entry) return { ...frame, motionInputs:{} };
            // Never let a delayed older telemetry package replace a point's
            // newer observation used by subsequent motion-only publications.
            if (!entry.lastFrame || milliseconds(frame.timestamp) >= milliseconds(entry.lastFrame.timestamp)) entry.lastFrame = frame;
            this.refresh(entry); this.scheduleDatasets(entry);
            return { ...frame, motionInputs:this.inputs(entry, frame) };
        });
    }
    decorateSemantics(devices) { return this.semanticResolver.decorate(devices); }
    async poll() {
        if (this.closed || this.discoveryBusy || this.active?.() === false) return;
        this.discoveryBusy = true;
        try {
            const db = await this.getDb(), devices = await db.all('SELECT id,instance_config FROM devices');
            const owned = new Set();
            for (const device of devices.slice(0, this.maxDevices)) {
                const config = parseObject(device.instance_config).animationBindings;
                if (!hasCatalogBindings(config,true)) continue;
                const entry = this.entry(String(device.id)); if (!entry) continue;
                owned.add(entry.id); this.refresh(entry); this.scheduleDatasets(entry);
            }
            for (const [id, entry] of this.entries) if (!owned.has(id) && this.now() - entry.readAt > 60000) this.entries.delete(id);
        } finally { this.discoveryBusy = false; }
    }
    invalidate(type, payload) {
        this.generation++;
        this.semanticResolver.invalidate(type, payload);
        for (const entry of this.entries.values()) { entry.loaded = null; entry.datasets.clear(); entry.datasetBusy.clear(); entry.loadToken++; entry.loading = false; entry.nextReload = 0; }
        this.queue.clear();
    }
    dispose() { this.closed = true; clearInterval(this.timer); this.semanticResolver.dispose(); this.invalidate(); this.entries.clear(); }
}
module.exports = { MotionInputResolver, catalogSample, sample, milliseconds, qualityLeaves, motionSources, configuredMotionSources, hasCatalogBindings, endpointFeedbackSample };
