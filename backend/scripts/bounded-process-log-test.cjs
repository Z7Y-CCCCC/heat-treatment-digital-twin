const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { BoundedProcessLog } = require('../utils/boundedProcessLog');
const { createRunDirectory } = require('./integration-test-utils.cjs');

(async () => {
    const root = createRunDirectory('bounded-process-log'), file = path.join(root, 'mysql-server.log');
    const unrelated = path.join(root, 'customer.log');
    fs.writeFileSync(unrelated, 'keep');
    const writer = new BoundedProcessLog(file, 64);
    writer.end(Buffer.alloc(64 * 12 + 17, 65));
    await finished(writer);
    assert.equal(fs.statSync(file).size, 17);
    assert.equal(fs.statSync(`${file}.previous`).size, 64);
    const next = new BoundedProcessLog(file, 64);
    next.end(Buffer.alloc(64, 66)); await finished(next);
    assert.equal(fs.statSync(file).size, 17);
    assert.equal(fs.statSync(`${file}.previous`).size, 64);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    console.log(JSON.stringify({ success: true, oversizedChunksBounded: true, restartAppendsAndRotates: true, root }));
})().catch(error => { console.error(error); process.exitCode = 1; });
