const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

// Publish a complete snapshot. Slow disk operations must not block the runner's
// continuity timer or WebSocket callbacks; failed writes retain the last report.
async function writeReportFile(filename, contents, io = fs) {
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.tmp`);
    try {
        await io.writeFile(temporary, contents, 'utf8');
        for (let attempt = 0; ; attempt++) {
            try { await io.rename(temporary, filename); break; }
            catch (failure) {
                if (!['EPERM', 'EACCES', 'EBUSY'].includes(failure.code) || attempt >= 5) throw failure;
                await delay(50 * (attempt + 1));
            }
        }
    } finally { await io.unlink(temporary).catch(failure => { if (failure.code !== 'ENOENT') throw failure; }); }
}
module.exports = { writeReportFile };
