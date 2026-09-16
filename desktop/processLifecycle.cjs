const DEFAULT_FORCE_TIMEOUT_MS = 5000;

function hasProcessExited(child) {
    return !child || child.exitCode != null || child.signalCode != null;
}

// ChildProcess.killed means a signal was sent, not that the OS process exited.
// Keep supervision/shutdown pending until exit is observed, including when a
// watchdog has already called kill(). Never start a replacement on a live port.
function terminateProcess(child, options = {}) {
    if (hasProcessExited(child)) return Promise.resolve();
    const {
        gracefulShutdown,
        gracefulTimeoutMs = 14000,
        forceTimeoutMs = DEFAULT_FORCE_TIMEOUT_MS
    } = options;

    return new Promise((resolve, reject) => {
        let settled = false;
        let forceRequested = false;
        let gracefulTimer;
        let forceTimer;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(gracefulTimer);
            clearTimeout(forceTimer);
            child.off('exit', onExit);
            if (error) reject(error);
            else resolve();
        };
        const onExit = () => finish();
        const force = () => {
            if (settled || forceRequested) return;
            if (hasProcessExited(child)) return finish();
            forceRequested = true;
            clearTimeout(gracefulTimer);
            forceTimer = setTimeout(() => {
                if (hasProcessExited(child)) finish();
                else finish(new Error(`进程 ${child.pid || '未知'} 在终止请求后仍未退出`));
            }, forceTimeoutMs);
            try { child.kill(); }
            catch (error) { finish(error); }
        };

        child.once('exit', onExit);
        if (hasProcessExited(child)) return finish();
        if (typeof gracefulShutdown === 'function') {
            gracefulTimer = setTimeout(force, gracefulTimeoutMs);
            Promise.resolve().then(gracefulShutdown).catch(force);
        } else {
            force();
        }
    });
}

module.exports = { hasProcessExited, terminateProcess };
