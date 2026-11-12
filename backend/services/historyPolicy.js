'use strict';

const KEY = 'history_policy_v1';
const HOUR_MS = 3600000, DAY_MS = 24 * HOUR_MS;
const DEFAULT_POLICY = Object.freeze({ version: 1, recentEnabled: true, recentHours: 24, metricMode: 'finite', metricDays: 90 });
const POINT_MODES = new Set(['recent', 'off', 'finite', 'permanent']);

function integer(value, min, max, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw Error(`${label}须为 ${min}～${max} 之间的整数`);
    return value;
}
function normalizePolicy(input = DEFAULT_POLICY) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_POLICY, key))) throw Error('历史记录策略格式无效');
    const policy = { ...DEFAULT_POLICY, ...input };
    if (policy.version !== 1 || typeof policy.recentEnabled !== 'boolean' || !['off', 'finite', 'permanent'].includes(policy.metricMode)) throw Error('历史记录开关或模式无效');
    integer(policy.recentHours, 1, 720, '近期趋势保留小时数');
    integer(policy.metricDays, 1, 36500, '指标保留天数');
    return policy;
}
function parsePolicy(value) { return normalizePolicy(value ? JSON.parse(value) : DEFAULT_POLICY); }
function normalizePointPolicy(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'days'].includes(key))) throw Error('点位历史策略格式无效');
    const mode = input.mode ?? 'recent', days = input.days ?? 30;
    if (!POINT_MODES.has(mode)) throw Error('点位历史模式无效');
    integer(days, 1, 36500, '点位保留天数');
    return { mode, days };
}
async function readPolicy(db, factoryId) {
    const row = await db.get('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=?', [factoryId, KEY]);
    return parsePolicy(row?.value);
}
async function readHistoryPoints(db, factoryId, deviceId = '') {
    if (!factoryId) return [];
    const workshops = new Set((await db.all('SELECT id FROM workshops WHERE factory_id=?', [factoryId])).map(row => String(row.id)));
    const rows = await db.all(`SELECT p.id,p.device_id,p.name,p.label,p.history_mode,p.history_days,d.name AS device_name,
        d.line_id,d.instance_config,w.factory_id AS line_factory_id FROM data_points p JOIN devices d ON d.id=p.device_id
        LEFT JOIN lines l ON l.id=d.line_id LEFT JOIN workshops w ON w.id=l.workshop_id
        ${deviceId ? 'WHERE d.id=?' : ''} ORDER BY d.name,p.id`, deviceId ? [deviceId] : []);
    return rows.filter(row => {
        // Match collector ownership: an explicit line wins over workshop hints.
        if (row.line_id) return String(row.line_factory_id) === String(factoryId);
        let config = {};
        try { config = typeof row.instance_config === 'object' ? row.instance_config : JSON.parse(row.instance_config || '{}'); } catch { return false; }
        return workshops.has(String(config?.workshop_id || config?.workshopId || ''));
    }).map(({line_id, instance_config, line_factory_id, ...point}) => point);
}
function sampleRetention(policy, point = { mode: 'recent', days: 30 }, timestamp) {
    if (point.mode === 'off') return { record: false, retentionUntil: null };
    if (point.mode === 'permanent') return { record: true, retentionUntil: null };
    const recent = policy.recentEnabled ? policy.recentHours * HOUR_MS : 0;
    const duration = Math.max(recent, point.mode === 'finite' ? point.days * DAY_MS : 0);
    return { record: duration > 0, retentionUntil: duration ? timestamp + duration : null };
}
function selectSamples(records, policy, points) {
    return records.flatMap(record => {
        const point = points.get(String(record.pointId));
        // A configuration cannot apply to a different device's context.
        const retention = sampleRetention(policy, point?.deviceId === record.deviceId ? point : undefined, record.sampledAt);
        return retention.record ? [{ ...record, retentionUntil: retention.retentionUntil }] : [];
    });
}
module.exports = { KEY, DEFAULT_POLICY, normalizePolicy, parsePolicy, normalizePointPolicy, readPolicy, readHistoryPoints, sampleRetention, selectSamples, DAY_MS };
