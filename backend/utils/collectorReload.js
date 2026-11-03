'use strict';
const pending = new Map();
// Coalesce one factory's configuration saves. Do not restart the worker (or
// other factories) just because a point/address changed in the admin page.
function reloadCollectorSoon(factoryId, reason) {
    const key = String(factoryId || '');
    clearTimeout(pending.get(key));
    const timer = setTimeout(async () => {
        pending.delete(key);
        const engine = global.dataEngine;
        try {
            if (key && engine?.reloadFactoryConfiguration) await engine.reloadFactoryConfiguration(key);
            else await engine?.restart?.(); // legacy in-process/test engine
        } catch (error) { console.warn('[Collector] Configuration reload failed:', reason, error.message); }
    }, 80);
    timer.unref?.(); pending.set(key, timer);
}
module.exports = { reloadCollectorSoon };
