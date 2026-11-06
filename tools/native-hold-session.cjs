'use strict';
const fs = require('node:fs');

// Wait only for this display-test session. The caller owns process cleanup.
// Leave no stdin reader, timer or file poll keeping its runner alive afterward.
function waitForOwnedHold({ finishFile, timeoutMs = 20 * 60 * 1000, pollMs = 200, stdin = process.stdin }) {
    if (typeof finishFile !== 'string' || !finishFile) throw new TypeError('finishFile is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 0x7fffffff) throw new RangeError('Invalid hold timeout');
    if (!Number.isFinite(pollMs) || pollMs < 1 || pollMs > 0x7fffffff) throw new RangeError('Invalid hold poll interval');
    return new Promise(resolve => {
        let timer, watch, finished = false, input = '';
        const onData = chunk => {
            input = (input + chunk).slice(-4096);
            // Accept the documented command even if the stream splits it.
            if (/(^|[\r\n])\s*finish\s*(?:[\r\n]|$)/.test(input)) done('finish');
        };
        const done = reason => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearInterval(watch);
            stdin.removeListener('data', onData);
            stdin.pause();
            // On Windows an open pipe/TTY handle can stay referenced even after
            // pause(). The hold no longer owns an input reader at this point.
            if (typeof stdin.unref === 'function') stdin.unref();
            resolve(reason);
        };
        stdin.setEncoding('utf8');
        stdin.on('data', onData);
        stdin.resume();
        watch = setInterval(() => { if (fs.existsSync(finishFile)) done('finish.request'); }, pollMs);
        timer = setTimeout(() => done('timeout'), timeoutMs);
        if (fs.existsSync(finishFile)) done('finish.request');
    });
}

module.exports = { waitForOwnedHold };
