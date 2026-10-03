const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// These small configuration transactions have a synchronous public contract.
// Windows indexers/antivirus can briefly hold the destination without delete
// sharing. Retry only those transient rename failures, keeping the old file
// intact. The exceptional retry delay is capped at 70 ms; normal writes do not wait.
function writeJsonAtomicSync(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        for (let attempt = 0; ; attempt++) {
            try { fs.renameSync(temporary, filename); break; }
            catch (error) {
                if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, [10, 20, 40][attempt]);
            }
        }
    } finally {
        try { fs.rmSync(temporary, { force: true }); } catch { /* Keep the original failure. */ }
    }
}

module.exports = { writeJsonAtomicSync };
