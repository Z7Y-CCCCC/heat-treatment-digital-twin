'use strict';

// Recovery/schema preparation is a hard barrier. Once it is complete, optional
// backup/retention work must not serialize the live collection startup behind
// an archive scan, nor may either independent service suppress the other.
async function startRuntimeServices({ prepare, collector, maintenance, isStopping = () => false, onError = () => {} }) {
    await prepare();
    if (isStopping()) return;
    const launch = async (name, work) => {
        if (isStopping()) return;
        try { await work(); }
        catch (error) { onError(name, error); }
    };
    await Promise.all([launch('collector', collector), launch('maintenance', maintenance)]);
}
module.exports = { startRuntimeServices };
