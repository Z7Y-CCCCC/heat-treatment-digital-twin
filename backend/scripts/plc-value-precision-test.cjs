const assert = require('assert/strict');
const net = require('net');
const path = require('path');
const { createRunDirectory } = require('./integration-test-utils.cjs');

process.env.APP_DATA_DIR = path.join(createRunDirectory('plc-value-precision'), 'data');
const originalConnect = net.Socket.prototype.connect;
let networkAttempts = 0;
net.Socket.prototype.connect = function () {
    networkAttempts += 1;
    throw new Error('Precision unit tests must not make network connections');
};

try {
    const PlcReader = require('../services/plcReader');
    const reader = new PlcReader();
    const checks = [];
    for (const type of ['REAL', 'LREAL']) {
        for (const raw of [0.125, -0.125, 0.00125, 123.456789]) {
            assert.equal(reader._convertValue(raw, type), raw, `${type} must retain raw precision before scaling`);
            assert.equal(reader._convertValue(String(raw), type), raw, `${type} numeric text must retain precision`);
        }
        const scaled = reader._applyScaleOffset(reader._convertValue(0.00125, type), { scale: 1000, offset: 1 });
        assert.equal(scaled, 2.25, `${type} engineering scaling must happen before output rounding`);
        const passthrough = reader._applyScaleOffset(reader._convertValue(0.125, type), { scale: 1, offset: 0 });
        assert.equal(passthrough, 0.125);
        for (const invalid of [null, undefined, '', NaN, Infinity, -Infinity]) {
            assert.equal(reader._convertValue(invalid, type), null);
        }
        checks.push(`${type}: raw precision, numeric text, scaling, three-decimal output and invalid values`);
    }
    for (const [type, value] of [['BYTE', 255], ['WORD', 65535], ['INT', -32768], ['DWORD', 4294967295], ['DINT', -2147483648]]) {
        assert.equal(reader._convertValue(value, type), value);
    }
    assert.equal(reader._convertValue(false, 'BOOL'), false);
    assert.equal(networkAttempts, 0);
    console.log(JSON.stringify({ success: true, checks, integerAndBooleanBoundaries: true, networkAttempts }, null, 2));
} finally {
    net.Socket.prototype.connect = originalConnect;
}
