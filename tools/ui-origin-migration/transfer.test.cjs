'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const code = fs.readFileSync(path.resolve(__dirname, '../../desktop/ui-origin/transfer.js'), 'utf8');
function fixture(initial = [], failKey = '') {
    const values = new Map(initial);
    const localStorage = { getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => { if (key === failKey) throw Error('Quota'); values.set(key, value); }, removeItem: key => values.delete(key) };
    return { values, transfer: vm.runInNewContext(code, { localStorage }) };
}
test('all drafts and Unicode values copy exactly without deleting source or unrelated target state', () => {
    const f = fixture([['unrelated', 'keep']]), source = [['draft:<fixture>', '草稿"\\\n'], ['settings', 'false']];
    assert.equal(f.transfer(source).success, true);
    assert.deepEqual([...f.values], [['unrelated', 'keep'], ...source]);
    assert.equal(f.transfer(source).copied, 0, 'idempotent recovery');
});
test('one newer target draft refuses all writes, not a partial overwrite', () => {
    const f = fixture([['draft', 'newer']]);
    assert.equal(f.transfer([['first', 'value'], ['draft', 'old']]).success, false);
    assert.deepEqual([...f.values], [['draft', 'newer']]);
});
test('quota failure rolls back only newly copied keys and keeps matching/preexisting state', () => {
    const f = fixture([['existing', 'same']], 'quota');
    assert.equal(f.transfer([['existing', 'same'], ['added', 'value'], ['quota', 'value']]).success, false);
    assert.deepEqual([...f.values], [['existing', 'same']]);
});
test('malformed snapshots and duplicate keys cannot cause writes', () => {
    const f = fixture();
    for (const data of [null, {}, [[1, 'value']], [['key', 'value'], ['key', 'other']]]) assert.throws(() => f.transfer(data));
    assert.equal(f.values.size, 0);
});
