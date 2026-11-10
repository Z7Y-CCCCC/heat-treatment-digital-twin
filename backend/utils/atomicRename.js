'use strict';
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

// A destination may briefly be held without delete sharing on Windows. Retry
// only the errors which can represent that condition, never unlink/truncate the
// old target. A persistent permission/lock failure still propagates unchanged.
// Normal renames do not wait; exceptional added waits are bounded to 70 ms.
const retryDelays = [10, 20, 40];
let syncWait;
function isTransientRenameError(error) {
    return error != null && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
}
function renameAtomicSync(source, destination) {
    for (let attempt = 0; ; attempt++) {
        try { return fs.renameSync(source, destination); }
        catch (error) {
            if (attempt >= retryDelays.length || !isTransientRenameError(error)) throw error;
            syncWait ||= new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(syncWait, 0, 0, retryDelays[attempt]);
        }
    }
}
async function renameAtomic(source, destination) {
    for (let attempt = 0; ; attempt++) {
        try { return await fs.promises.rename(source, destination); }
        catch (error) {
            if (attempt >= retryDelays.length || !isTransientRenameError(error)) throw error;
            await delay(retryDelays[attempt]);
        }
    }
}
module.exports = { renameAtomicSync, renameAtomic, isTransientRenameError };
