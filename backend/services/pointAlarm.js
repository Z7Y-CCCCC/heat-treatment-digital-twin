'use strict';

// Evaluate only real numeric/boolean readings. Missing/bad data is unknown,
// never a recovery. The condition uses the converted point value, not raw PLC bytes.
function parseAlarmCondition(condition) {
    const text = String(condition || '!=0').replace(/\s+/g, '');
    const match = text.match(/^(>=|<=|!=|==|=|>|<)([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)$/i);
    if (!match || !Number.isFinite(Number(match[2]))) return null;
    return { operator: match[1], threshold: Number(match[2]) };
}

function evaluateAlarm(value, condition = '!=0') {
    const rule = parseAlarmCondition(condition);
    if (!rule || value === null || value === undefined || value === '' || typeof value === 'object') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    switch (rule.operator) {
        case '=': case '==': return number === rule.threshold;
        case '!=': return number !== rule.threshold;
        case '>': return number > rule.threshold;
        case '<': return number < rule.threshold;
        case '>=': return number >= rule.threshold;
        case '<=': return number <= rule.threshold;
        default: return null;
    }
}

function isAlarmTrigger(point = {}) {
    const role = String(point.alarm_record_role || point.value_role || point.name || '').toLowerCase();
    if (point.alarm_record_role || /^(?:txt|date1|date2|num|state)_record$/.test(role) || /^alarm_(?:text|start|end|number|state)_record$/.test(role)) return false;
    return point.point_kind === 'alarm' || point.is_alarm === true || /^bj\d+$/i.test(point.name || '');
}

function pointAlarmReadings(device, now = Date.now()) {
    return Object.entries(device.pointMeta || {}).filter(([, point]) => point.id && isAlarmTrigger(point)).map(([path, point]) => {
        const separator = path.indexOf('.'), group = path.slice(0, separator), field = path.slice(separator + 1);
        const timestamp = Number(point.timestamp);
        const quality = device.quality?.[group]?.[field];
        const fresh = Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= now
            && now - timestamp <= Math.max(6000, Number(point.sample_interval_ms || 1000) * 3);
        const alarm = fresh && quality === 'good' && device.status?.online !== false
            ? evaluateAlarm(device[group]?.[field], point.alarm_condition) : null;
        return { deviceId: String(device.furnace_id), deviceName: String(device.furnace_name || device.furnace_id).slice(0, 180),
            pointId: String(point.id), pointName: String(point.name || field).slice(0, 256),
            alarmText: String(point.alarm_text || point.label || point.name || field).slice(0, 4000),
            condition: point.alarm_condition || '!=0', alarm, quality: 'good', occurredAt: timestamp };
    });
}

function alarmEventValue(event) {
    return JSON.stringify({ kind: 'point-alarm-v1', occurrenceId: event.occurrenceId,
        pointId: event.pointId, pointName: event.pointName, alarmText: event.alarmText,
        condition: event.condition, active: event.alarm, startedAt: event.startedAt, endedAt: event.endedAt });
}

function alarmEventDetails(row) {
    let value;
    try { value = JSON.parse(row.value); } catch { return {}; }
    if (value?.kind !== 'point-alarm-v1' || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0 || value.startedAt > 8640000000000000
        || value.endedAt !== null && (!Number.isSafeInteger(value.endedAt) || value.endedAt < value.startedAt || value.endedAt > 8640000000000000)) return {};
    return { alarm_occurrence_id: value.occurrenceId, point_id: value.pointId, point_name: value.pointName,
        alarm_text: value.alarmText, alarm_condition: value.condition, alarm_active: value.active,
        alarm_started_at: new Date(value.startedAt).toISOString(),
        alarm_ended_at: value.endedAt === null ? null : new Date(value.endedAt).toISOString() };
}

module.exports = { parseAlarmCondition, evaluateAlarm, isAlarmTrigger, pointAlarmReadings, alarmEventValue, alarmEventDetails };
