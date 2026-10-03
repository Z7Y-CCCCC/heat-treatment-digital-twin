const assert = require('assert/strict');
const Nodes7 = require('nodes7');
const { protectS7Reads } = require('../services/s7ReadSafety');

const driver = new Nodes7({ silent: true });
const addresses = Array.from({ length: 100 }, (_, index) => `DB1,${['X', 'WORD', 'REAL'][index % 3]}${index * 8}${index % 3 === 0 ? '.0' : ''}`);
driver.addItemsNow(addresses);
driver.prepareReadPacket();
assert.ok(driver.readPacketArray.some(packet => packet.itemList.length > 20), 'fixture must reproduce the vendor packetizer defect');
const originalItems = driver.readPacketArray.flatMap(packet => packet.itemList.map(item => item.addr));
protectS7Reads(driver, error => { throw error; });
driver.prepareReadPacket();
assert.ok(driver.readPacketArray.every(packet => packet.itemList.length <= 20));
assert.deepEqual(driver.readPacketArray.flatMap(packet => packet.itemList.map(item => item.addr)), originalItems);
assert.equal(new Set(driver.readPacketArray.map(packet => packet.seqNum)).size, driver.readPacketArray.length);

const seen = [];
const failures = [];
const receiving = { onResponse(packet) { seen.push(Buffer.from(packet)); if (packet[7] === 99) throw new RangeError('simulated vendor offset'); } };
protectS7Reads(receiving, error => failures.push(error.message));
const packet = payload => Buffer.from([3, 0, 0, 8, 2, 240, 128, payload]);
const first = packet(1), second = packet(2);
receiving.onResponse(first.subarray(0, 2));
receiving.onResponse(first.subarray(2, 5));
assert.equal(seen.length, 0);
receiving.onResponse(Buffer.concat([first.subarray(5), second]));
assert.deepEqual(seen, [first, second]);
assert.doesNotThrow(() => receiving.onResponse(packet(99)));
assert.equal(failures.pop(), 'simulated vendor offset');
receiving.onResponse(Buffer.from([0, 0, 0, 8]));
assert.match(failures.pop(), /TPKT/);
receiving.onResponse(second);
assert.deepEqual(seen.at(-1), second);

const decoder = { readPacketArray: [{ itemList: [{}, {}] }], readResponse() { throw new Error('decoder must not receive a truncated item list'); } };
protectS7Reads(decoder, error => failures.push(error.message));
const truncated = Buffer.alloc(21); truncated[20] = 1;
assert.throws(() => decoder.readResponse(truncated, 0), /点位数量/);
console.log(JSON.stringify({ success: true, checks: {
    actualVendorOversizedPacketReproduced: true, allMixedReadItemsPreservedWithin20ItemLimit: true,
    splitAndCoalescedTcpFramesReassembled: true, vendorParserExceptionConfinedToConnection: true,
    invalidHeaderRejectedAndBufferReset: true, inconsistentItemCountRejectedBeforeDecoding: true
} }, null, 2));
