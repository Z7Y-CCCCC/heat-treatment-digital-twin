const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function retryFilesystem(operation, { attempts = 12, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt >= attempts - 1) throw error;
            await wait(Math.min(100 * (attempt + 1), 1000));
        }
    }
}

async function publishDirectory(staging, target, { io = fs.promises, retryOptions, warn = console.warn } = {}) {
    if (path.dirname(path.resolve(staging)) !== path.dirname(path.resolve(target)) || path.resolve(staging) === path.resolve(target)) {
        throw new Error('Directory publication requires distinct sibling directories');
    }
    const previous = `${target}.previous-${process.pid}-${crypto.randomUUID()}`;
    const retry = operation => retryFilesystem(operation, retryOptions);
    let movedPrevious = false;
    try {
        try { await io.stat(target); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        // rename, unlike removing the old tree first, keeps rollback possible.
        try { await retry(() => io.rename(target, previous)); movedPrevious = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await retry(() => io.rename(staging, target));
    } catch (error) {
        if (movedPrevious) {
            try { await retry(() => io.rename(previous, target)); }
            catch (restoreError) { error.message += `; previous dependencies preserved at ${previous}; restore failed: ${restoreError.message}`; }
        }
        throw error;
    }
    if (movedPrevious) {
        try { await retry(() => io.rm(previous, { recursive: true, force: true })); }
        catch (error) { warn(`Published dependencies; old directory cleanup deferred: ${previous}: ${error.message}`); }
    }
}

module.exports = { retryFilesystem, publishDirectory };
