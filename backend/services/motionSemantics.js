'use strict';

const crypto = require('node:crypto');
const { deriveMotionSemantics } = require('../../shared/motionSemanticPolicy.cjs');
const { deviceLineId } = require('./deviceLineUnits');
const parse = value => { try { const result = typeof value === 'string' ? JSON.parse(value || '{}') : value ?? {}; return result && typeof result === 'object' && !Array.isArray(result) ? result : null; } catch { return null; } };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(key => !['__proto__', 'constructor', 'prototype'].includes(key)).map(key => [key, canonical(value[key])])) : value;
const scope = frame => String(frame?.factoryId ?? frame?.factory_id ?? '');

// Cached metadata only. A sample never causes a synchronous DB read, and a
// configuration change cannot reuse old declarations while its new read waits.
class MotionSemanticResolver {
    constructor(options = {}) {
        this.getDb = options.getDb || (() => require('../db/database').getDb());
        this.mergeModels = options.mergeModels || (rows => require('./builtinModels').mergeBuiltinModels(rows));
        this.now = options.now || Date.now; this.reloadMs = options.reloadMs || 1000;
        this.maxDevices = options.maxDevices || 5000;
        this.records = new Map(); this.generation = 0; this.dirty = true; this.nextReadAt = 0;
        this.closed = false; this.loading = null; this.timer = null;
        this.stats = { databaseRefreshes: 0, modelMetadataMerges: 0, pointCatalogReads: 0, decoratedFrames: 0, pendingFrames: 0 };
    }
    start() { if (this.dirty) this.requestRefresh(); }
    requestRefresh() {
        if (this.closed || this.loading || this.timer) return;
        this.dirty = true;
        this.timer = setTimeout(() => { this.timer = null; this.refresh().catch(() => {}); }, Math.max(0, this.nextReadAt - this.now()));
        this.timer.unref?.();
    }
    refresh() {
        if (this.closed) return Promise.resolve(false);
        if (this.loading) return this.loading;
        clearTimeout(this.timer); this.timer = null;
        const generation = this.generation;
        this.nextReadAt = this.now() + this.reloadMs;
        this.loading = (async () => {
            try {
                const db = await this.getDb(); this.stats.databaseRefreshes++;
                const [devices, lines, workshops, models, points] = await Promise.all([
                    db.all('SELECT id,line_id,model_type,instance_config FROM devices'), db.all('SELECT id,workshop_id FROM `lines`'), db.all('SELECT id,factory_id FROM workshops'),
                    db.all('SELECT * FROM models'), db.all('SELECT id,device_id,category,value_role,name,access_type FROM data_points ORDER BY id')
                ]);
                if (this.closed || generation !== this.generation) return false;
                this.stats.pointCatalogReads++;
                const devicePoints = new Map();
                for (const point of points) {
                    const id = String(point.device_id);
                    if (!devicePoints.has(id)) devicePoints.set(id, []);
                    devicePoints.get(id).push(point);
                }
                const lineMap = new Map(lines.map(row => [String(row.id), String(row.workshop_id || '')]));
                const workshopMap = new Map(workshops.map(row => [String(row.id), String(row.factory_id || '')]));
                // Same effective metadata as loadDeviceAnimations / /api/config.
                // Merge builtins only ONCE per factory refresh, never per sample
                // or device; SQL metadata deliberately overrides the same ID.
                const factoryModels = new Map();
                for (const factoryId of new Set(workshopMap.values())) {
                    if (!factoryId) continue;
                    this.stats.modelMetadataMerges++;
                    factoryModels.set(factoryId, new Map(this.mergeModels(models.filter(row => row.factory_id == null || String(row.factory_id) === factoryId))
                        .map(model => [String(model.id), parse(model.metadata)])));
                }
                const records = new Map(),transferPresence=new Map(),deviceMap=new Map(devices.map(d=>[String(d.id),d]));
                const factoryOf=device=>{const i=parse(device?.instance_config),line=deviceLineId(device||{},i||{});return workshopMap.get(line?lineMap.get(String(line)):String(i?.workshop_id??i?.workshopId??''))||'';};
                for(const source of devices){const i=parse(source.instance_config),link=i?.animationBindings?.transferLink;
                    if(!link?.enabled||!link.cycle?.enabled)continue;
                    for(const s of link.cycle.stations||[]){const target=deviceMap.get(String(s.targetDeviceId));
                        if(!target||!factoryOf(source)||factoryOf(source)!==factoryOf(target))continue;
                        const point=(devicePoints.get(String(target.id))||[]).find(p=>String(p.id)===String(s.presencePointId)&&String(p.access_type||'READ').toUpperCase()==='READ');
                        if(!point)continue;if(!transferPresence.has(String(target.id)))transferPresence.set(String(target.id),new Set());transferPresence.get(String(target.id)).add(String(point.id));
                    }
                }
                for (const device of devices.slice(0, this.maxDevices)) {
                    const instance = parse(device.instance_config);
                    const lineId = deviceLineId(device, instance || {});
                    const workshop = lineId ? lineMap.get(String(lineId)) : String(instance?.workshop_id ?? instance?.workshopId ?? '');
                    const factoryId = workshopMap.get(workshop) || '';
                    const metadata = factoryModels.get(factoryId)?.get(String(device.model_type)) || null;
                    const definition = deriveMotionSemantics(instance, metadata, { deviceId: String(device.id), points: devicePoints.get(String(device.id)) || [],transferPresencePointIds:[...(transferPresence.get(String(device.id))||[])] });
                    const bindings = Object.freeze(definition.bindings.map(binding => Object.freeze({ ...binding,
                        source: Object.freeze({ ...binding.source }), ...(binding.values ? { values: Object.freeze([...binding.values]) } : {}) })));
                    records.set(String(device.id), { factoryId, valid: definition.valid && !!factoryId,
                        revision: crypto.createHash('sha256').update(JSON.stringify(canonical({ instance, partBindings: metadata?.partBindings ?? null,
                            resolvedBindings: definition.bindings }))).digest('hex'), bindings });
                }
                // This is a COMPLETE configuration snapshot. Never union old
                // devices, removed bindings, or old source declarations into it.
                this.records = records; this.dirty = false; return true;
            } catch { this.dirty = true; return false; }
        })().finally(() => { this.loading = null; if (!this.closed && this.dirty) this.requestRefresh(); });
        return this.loading;
    }
    decorate(devices) {
        return devices.map(frame => {
            this.stats.decoratedFrames++;
            const record = this.records.get(String(frame?.furnace_id || ''));
            const frameScope = scope(frame), ready = !!record?.valid && (!frameScope || frameScope === record.factoryId);
            if (!record) this.requestRefresh();
            if (!ready) this.stats.pendingFrames++;
            return { ...frame, motionSemantics: Object.freeze({ version: 1, ready, generation: this.generation,
                factoryId: ready ? record.factoryId : frameScope, revision: ready ? record.revision : '', bindings: ready ? record.bindings : Object.freeze([]) }) };
        });
    }
    invalidate(type, payload) {
        if (this.closed) return;
        this.generation++; this.dirty = true; this.nextReadAt = 0;
        if (type === 'device_configuration_changed' && payload?.deviceId) this.records.delete(String(payload.deviceId));
        else this.records.clear();
        this.requestRefresh();
    }
    dispose() { this.closed = true; this.generation++; clearTimeout(this.timer); this.timer = null; this.records.clear(); }
}
module.exports = { MotionSemanticResolver };
