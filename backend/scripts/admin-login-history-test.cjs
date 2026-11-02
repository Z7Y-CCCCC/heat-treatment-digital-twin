const assert = require('node:assert/strict');
const { recentUsernames, decodeLoginHistory, encodeLoginHistory } = require('../services/adminLoginHistory');
assert.deepEqual(recentUsernames(['ADMIN', '普通用户', 'admin', '无效 用户', null, {}, '张三']), ['admin', '普通用户', '张三']);
const names = Array.from({ length: 20 }, (_, i) => `用户${i}`);
assert.deepEqual(decodeLoginHistory(encodeLoginHistory(names)), names.slice(0, 8));
for (const value of ['', undefined, 'broken!', 'a'.repeat(4097), Buffer.from('{bad json').toString('base64url'),
    Buffer.from(JSON.stringify({ authenticated: true, user: 'admin' })).toString('base64url')]) assert.deepEqual(decodeLoginHistory(value), []);
assert.deepEqual(decodeLoginHistory(encodeLoginHistory(['普通用户', 'admin'])), ['普通用户', 'admin']);
console.log('PASS bounded, validated username-only login hints; malformed cookies fail closed');
