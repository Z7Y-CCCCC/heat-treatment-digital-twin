'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeRecordTimestamp, resolveRecordTimeColumn } = require('../services/dataRecordTime');
test('source timestamp parsing keeps UTC instant, explicit offset, Unix seconds/milliseconds and SQL local time', () => {
    const iso = '2026-11-07T07:44:16.837Z', milliseconds = Date.parse(iso);
    for (const value of [iso, new Date(iso), milliseconds, String(milliseconds), milliseconds / 1000, String(milliseconds / 1000), '2026-11-07T15:44:16.837+08:00']) assert.equal(normalizeRecordTimestamp(value), iso, String(value));
    assert.equal(normalizeRecordTimestamp('2026-11-07 15:44:16'), new Date('2026-11-07T15:44:16').toISOString());
    assert.equal(normalizeRecordTimestamp('2024-02-29T12:34:56Z'), '2024-02-29T12:34:56.000Z');
    assert.equal(normalizeRecordTimestamp('2026-11-07'), '2026-11-07T00:00:00.000Z');
});
test('missing, malformed, impossible or non-time source values cannot turn into a fetch time or a rollover date', () => {
    for (const value of [null, undefined, '', '  ', true, false, {}, [], NaN, Infinity, 0, -1, '0', '1', '2026-02-29T12:00:00Z', '2026-02-31', '2026-13-01T00:00:00Z', '2026-11-07T25:00:00Z', '2026-11-07T15:61:00Z', '2026-11-07T15:00:61Z', '2026-11-07T15:00:00+99:99', '2026-11-07 arbitrary text']) assert.equal(normalizeRecordTimestamp(value), null, String(value));
});
test('explicit configured time role wins over source update aliases', () => {
    const configured = { name: 'sampled', role: 'time' }, update = { name: 'updatedAt', path: 'updatedAt', role: '' };
    assert.deepEqual(resolveRecordTimeColumn([update, configured]), { column: configured, inferred: false, ambiguous: false });
});
test('a sole unassigned update field is recognized by name, last field path or exact update label', () => {
    for (const field of [{ name: 'updatedAt' }, { name: 'updated_at' }, { name: 'update_time' }, { name: 'col_4', path: 'record.updatedAt' }, { name: 'col_4', path: '$["更新时间"]' }, { name: 'col_4', label: '更新时间' }, { name: 'lastModifiedAt' }]) assert.deepEqual(resolveRecordTimeColumn([field]), { column: field, inferred: true, ambiguous: false });
});
test('ambiguous update candidates and intentionally assigned non-time roles are never guessed', () => {
    assert.deepEqual(resolveRecordTimeColumn([{ name: 'updatedAt' }, { name: 'update_time' }]), { column: null, inferred: false, ambiguous: true });
    for (const field of [{ name: 'createdAt' }, { name: 'dueDate' }, { name: 'timestamp' }, { name: 'updatedAt', role: 'category' }, { name: 'updatedAt', role: 'value' }]) assert.deepEqual(resolveRecordTimeColumn([field]), { column: null, inferred: false, ambiguous: false });
});
