'use strict';

// Transport semantics come from saved motion configuration, never from a
// numeric value that happens to be 0/1. Values and source clocks stay untouched.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const operators = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
const numericOperators = new Set(['gt', 'gte', 'lt', 'lte']);
const MAX_DECLARATIONS = 102;
const pointId = value => {
    const id = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value;
    return text(id) && id.length <= 120 ? id : '';
};
function number(value, allowBoolean = false) {
    if (allowBoolean && typeof value === 'boolean') return Number(value);
    if (finite(value)) return value;
    if (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return NaN;
    const result = Number(value); return Number.isFinite(result) ? result : NaN;
}
function timestamp(value) {
    if (typeof value === 'boolean' || value === null || value === undefined) return NaN;
    const numeric = number(value), result = Number.isFinite(numeric) ? numeric : typeof value === 'string' ? Date.parse(value) : NaN;
    return result > 0 ? result : NaN;
}
const good = value => value == null || typeof value === 'string' && value.toLowerCase() === 'good';
function sourceFor(row) {
    if (text(row.dataItemId) && text(row.actionId)) return { dataItemId: row.dataItemId, actionId: row.actionId };
    const id = pointId(row.pointId);
    if (!id) return null;
    return { pointId: id, ...(text(row.sourceGroup) && text(row.sourceKey) ? { pointKey: row.sourceGroup + '.' + row.sourceKey } : {}) };
}
function validSource(source) {
    if (!object(source)) return false;
    if (own(source, 'dataItemId')) return Object.keys(source).every(key => ['dataItemId', 'actionId'].includes(key)) && text(source.dataItemId) && text(source.actionId);
    return Object.keys(source).every(key => ['pointId', 'pointKey'].includes(key)) && typeof source.pointId === 'string' && !!pointId(source.pointId)
        && (!own(source, 'pointKey') || text(source.pointKey) && source.pointKey.includes('.'));
}
function validCondition(value) {
    const type = typeof value.value;
    return operators.has(value.operator) && ['number', 'boolean', 'string'].includes(type)
        && (type !== 'number' || finite(value.value) && Math.abs(value.value) <= 1e12)
        && (type !== 'string' || value.value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value.value))
        && finite(value.hysteresis) && value.hysteresis >= 0 && value.hysteresis <= 1e12
        && (numericOperators.has(value.operator) ? type === 'number' : value.hysteresis === 0);
}
function validDeclaration(value) {
    if (!object(value) || !text(value.key) || !validSource(value.source)) return false;
    const common = ['key', 'kind', 'source'];
    if (value.kind === 'condition') return Object.keys(value).every(key => [...common, 'operator', 'value', 'hysteresis'].includes(key)) && validCondition(value);
    if (value.kind === 'running') return Object.keys(value).every(key => [...common, 'inputMin', 'inputMax', 'invert'].includes(key))
        && finite(value.inputMin) && finite(value.inputMax) && Math.max(Math.abs(value.inputMin), Math.abs(value.inputMax)) <= 1e12
        && value.inputMin < value.inputMax && typeof value.invert === 'boolean';
    if (value.kind === 'signed_speed') return Object.keys(value).every(key => [...common, 'speedFactor', 'speed', 'invert'].includes(key))
        && finite(value.speedFactor) && Number.isFinite(Math.fround(value.speedFactor)) && finite(value.speed) && value.speed >= .05 && value.speed <= 10 && typeof value.invert === 'boolean';
    if (value.kind === 'running_gate') return Object.keys(value).every(key => common.includes(key)) && !!value.source.pointId;
    if (value.kind === 'station') return Object.keys(value).every(key => [...common, 'values'].includes(key)) && !!value.source.pointId
        && Array.isArray(value.values) && value.values.length > 0 && value.values.length <= 500
        && value.values.every(finite) && new Set(value.values).size === value.values.length;
    return false;
}
function deriveMotionSemantics(instance, modelMetadata = null, pointContext = null) {
    if (!object(instance)) return { valid: false, bindings: [] };
    const bindings = [], keys = new Set();
    function add(row) {
        if (!validDeclaration(row) || keys.has(row.key) || bindings.length >= MAX_DECLARATIONS) throw Error('Invalid/duplicate motion declaration');
        keys.add(row.key); bindings.push(row);
    }
    try {
        const movement = instance.movement;
        if (movement?.enabled === true) {
            const rawStart = movement.startActionPointId ?? movement.start_action_point_id;
            const start = pointId(rawStart);
            if (rawStart != null && rawStart !== '' && !start) throw Error('Invalid configured movement gate');
            if (start) add({ key: 'movement:start', kind: 'running_gate', source: { pointId: start } });
            if (movement.valueMode === 'station') {
                const position = pointId(movement.currentPositionPointId ?? movement.current_position_point_id);
                if (!position || !Array.isArray(movement.stations)) throw Error('Missing configured station point/values');
                add({ key: 'movement:station', kind: 'station', source: { pointId: position }, values: movement.stations.map(station => station?.value) });
            }
        }
        const hasRuntimeConfig = own(instance, 'animationBindings');
        if (hasRuntimeConfig && !object(instance.animationBindings)) throw Error('Invalid animation configuration');
        // RuntimeModelLibrary.DeviceBindings inherits model parts ONLY when the
        // instance has no animationBindings token. An explicit empty/disabled
        // configuration removes those parts; it is never permission to union
        // model bindings back in. The legacy rotate_speed path ignores model
        // inversion and uses raw RPM with speed=1, not a range midpoint gate.
        if (!hasRuntimeConfig) {
            const parts = Array.isArray(modelMetadata?.partBindings) ? modelMetadata.partBindings : [];
            const owned = Array.isArray(pointContext?.points) ? pointContext.points.filter(point => object(point)
                && String(point.device_id) === String(pointContext.deviceId)
                && String(point.access_type || 'READ').toUpperCase() === 'READ') : [];
            for (let index = 0; index < parts.length; index++) {
                const part = parts[index];
                if (!object(part) || (part.action ?? 'rotate_speed') !== 'rotate_speed') continue;
                const group = part.source_group ?? 'analog', field = part.source_key;
                if (!text(group) || !text(field)) throw Error('Missing inherited speed source');
                const matches = owned.filter(point => point.category === group && (point.value_role || point.name) === field);
                const explicit = part.point_id != null && part.point_id !== '' ? pointId(part.point_id) : '';
                if (matches.length !== 1 || !pointId(matches[0].id)
                    || (part.point_id != null && part.point_id !== '' && (!explicit || explicit !== pointId(matches[0].id))))
                    throw Error('Missing/foreign/ambiguous inherited speed point');
                const id = part.id == null || part.id === '' ? String(index) : String(part.id);
                const factor = number(own(part, 'speed_factor') ? part.speed_factor : .10472);
                if (!text(id) || !Number.isFinite(factor)) throw Error('Invalid inherited speed metadata');
                add({ key: 'action:part:' + id, kind: 'signed_speed', source: { pointId: pointId(matches[0].id), pointKey: group + '.' + field },
                    speedFactor: Math.fround(factor), speed: 1, invert: false });
            }
        }
        const rows = instance.animationBindings?.bindings ?? [];
        if (!Array.isArray(rows) || rows.length > 100) throw Error('Invalid animation bindings');
        for (const row of rows) {
            if (!object(row) || row.enabled !== true) continue;
            if (row.actionId === 'clip:process_cycle' || row.trigger?.mode === 'endpoints') continue;
            if (row.trigger?.mode !== 'condition' && row.mode !== 'running') continue;
            const source = sourceFor(row);
            if (!source || !text(row.actionId)) throw Error('Missing configured action source');
            if (row.trigger?.mode === 'condition') add({ key: 'action:' + row.actionId, kind: 'condition', source,
                operator: row.trigger.operator, value: row.trigger.value, hysteresis: row.trigger.hysteresis ?? 0 });
            else if (row.actionId.startsWith('part:')) {
                const parts = Array.isArray(modelMetadata?.partBindings) ? modelMetadata.partBindings : [];
                const matches = parts.filter(binding => object(binding) && 'part:' + binding.id === row.actionId && (binding.action ?? 'rotate_speed') === 'rotate_speed');
                if (matches.length !== 1) throw Error('Missing/ambiguous configured speed part');
                const rawFactor = own(matches[0], 'speed_factor') ? matches[0].speed_factor : .10472;
                const factor = number(rawFactor);
                if (!Number.isFinite(factor)) throw Error('Invalid configured part speed factor');
                add({ key: 'action:' + row.actionId, kind: 'signed_speed', source, speedFactor: Math.fround(factor), speed: row.speed ?? 1, invert: row.invert ?? false });
            }
            else add({ key: 'action:' + row.actionId, kind: 'running', source,
                inputMin: row.inputMin ?? 0, inputMax: row.inputMax ?? 1, invert: row.invert ?? false });
        }
        return { valid: true, bindings };
    } catch { return { valid: false, bindings: [] }; }
}
function validSnapshot(value) {
    if (!object(value) || Object.keys(value).some(key => !['version', 'ready', 'generation', 'revision', 'factoryId', 'bindings'].includes(key))
        || value.version !== 1 || value.ready !== true || !Number.isSafeInteger(value.generation) || value.generation < 0
        || typeof value.revision !== 'string' || value.revision.length > 128 || /[\u0000-\u001f\u007f]/.test(value.revision)
        || typeof value.factoryId !== 'string' || value.factoryId.length > 128 || /[\u0000-\u001f\u007f]/.test(value.factoryId)
        || !Array.isArray(value.bindings) || value.bindings.length > MAX_DECLARATIONS) return false;
    const keys = new Set();
    for (const binding of value.bindings) {
        if (!validDeclaration(binding) || keys.has(binding.key)) return false;
        keys.add(binding.key);
    }
    return true;
}
function observation(frame, declaration) {
    const source = declaration.source;
    if (source.dataItemId) {
        const item = frame?.motionInputs?.[source.actionId];
        return object(item) && item.dataItemId === source.dataItemId && item.quality != null && good(item.quality) && Number.isFinite(timestamp(item.timestamp))
            ? { valid: true, value: item.value } : { valid: false };
    }
    const matches = Object.entries(frame?.pointMeta || {}).filter(([, meta]) => object(meta) && String(meta.id) === source.pointId);
    if (matches.length !== 1) return { valid: false };
    const [address, meta] = matches[0], separator = address.indexOf('.');
    if (separator <= 0) return { valid: false };
    const group = meta.category ?? address.slice(0, separator), field = meta.field_name ?? address.slice(separator + 1);
    const key = group + '.' + field, quality = frame?.quality?.[group]?.[field];
    if (address !== key || source.pointKey && source.pointKey !== key || frame?.pointMeta?.[key] !== meta || !Number.isFinite(timestamp(meta.timestamp))
        || !good(meta.quality) || !good(quality) || String(frame?.status?.online).toLowerCase() === 'false' || !good(frame?.status?.quality) || frame?.[group]?.[field] == null
        || ['running_gate', 'station'].includes(declaration.kind) && quality == null) return { valid: false };
    return { valid: true, value: frame[group][field] };
}
function compare(raw, declaration, previous) {
    const expected = declaration.value, operation = declaration.operator;
    if (typeof raw !== typeof expected || !['number', 'boolean', 'string'].includes(typeof raw) || typeof raw === 'number' && !finite(raw)) return null;
    if (operation === 'eq' || operation === 'ne') return operation === 'eq' ? raw === expected : raw !== expected;
    const greater = operation === 'gt' || operation === 'gte';
    const threshold = expected + (previous ? greater ? -declaration.hysteresis : declaration.hysteresis : 0);
    return operation === 'gt' ? raw > threshold : operation === 'gte' ? raw >= threshold : operation === 'lt' ? raw < threshold : raw <= threshold;
}
function semanticState(frame, declaration) {
    const input = observation(frame, declaration);
    if (!input.valid) return 'unavailable';
    const raw = input.value;
    if (declaration.kind === 'condition') {
        // Comparing the outcomes under BOTH possible hysteresis states is
        // state-independent and lossless: changes within the same pair cannot
        // change any consumer's condition. No backend condition is fabricated.
        const a = compare(raw, declaration, false), b = compare(raw, declaration, true);
        return a === null || b === null ? 'invalid' : String(Number(a)) + String(Number(b));
    }
    if (declaration.kind === 'running_gate') {
        if (typeof raw === 'boolean') return raw ? 'running' : 'stopped';
        const n = number(raw);
        if (Number.isFinite(n)) return Math.abs(n) > .0001 ? 'running' : 'stopped';
        if (typeof raw !== 'string') return 'invalid';
        const value = raw.toLowerCase();
        return value === 'true' || value === 'on' ? 'running' : value === 'false' || value === 'off' ? 'stopped' : 'invalid';
    }
    const n = number(raw, ['running', 'signed_speed'].includes(declaration.kind) && !declaration.source.dataItemId);
    if (!Number.isFinite(n)) return 'invalid';
    if (declaration.kind === 'station') {
        const matches = declaration.values.filter(value => Math.abs(value - n) <= .0001);
        return matches.length === 1 ? 'station:' + String(matches[0]) : 'invalid';
    }
    if (declaration.source.dataItemId && !finite(raw)) return 'invalid';
    if (declaration.kind === 'signed_speed') {
        // Match ModelBindingDriver's actual float32 raw RPM → angular speed,
        // including zero/negative model factors, inversion and underflow. This
        // is NOT a range-midpoint switch and never changes legacy RPM mapping.
        const f = Math.fround;
        const angular = f(f(f(f(f(n) * f(declaration.speedFactor)) * f(180 / Math.PI)) * f(declaration.speed)) * (declaration.invert ? -1 : 1));
        return !Number.isFinite(angular) ? 'invalid' : angular === 0 ? 'stopped' : angular < 0 ? 'negative' : 'positive';
    }
    let p = Math.max(0, Math.min(1, (n - declaration.inputMin) / (declaration.inputMax - declaration.inputMin)));
    if (declaration.invert) p = 1 - p;
    return p > .5 ? 'running' : 'stopped';
}
function hasDeclaredMotionBoundary(previous, next) {
    const a = previous?.motionSemantics, b = next?.motionSemantics;
    if (a === undefined && b === undefined) return false; // Existing wire clients remain compatible.
    // Cold/unavailable/malformed configuration is never permission to discard
    // a numeric actuator edge. Existing byte/count limits still bound the queue.
    if (!validSnapshot(a) || !validSnapshot(b)) return true;
    const identity = bindings => JSON.stringify(bindings.map(d => [d.key, d.kind, d.source.actionId ?? '', d.source.dataItemId ?? '',
        d.source.pointId ?? '', d.source.pointKey ?? '', d.operator ?? '', d.value ?? null, d.hysteresis ?? null,
        d.inputMin ?? null, d.inputMax ?? null, d.invert ?? null, d.values ?? null, d.speedFactor ?? null, d.speed ?? null]));
    if (a.generation !== b.generation || a.revision !== b.revision || a.factoryId !== b.factoryId || identity(a.bindings) !== identity(b.bindings)) return true;
    return b.bindings.some(declaration => semanticState(previous, declaration) !== semanticState(next, declaration));
}
module.exports = { deriveMotionSemantics, hasDeclaredMotionBoundary, semanticState, validSnapshot, MAX_DECLARATIONS };
