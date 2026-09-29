// Monotonic duration alone may include suspend time on some operating systems.
// A periodic wall/monotonic observation guard prevents either clock behavior
// from turning a sleeping or clock-adjusted run into 72 hours of evidence.
function createContinuityClock({ monotonic = () => performance.now(), wall = () => Date.now(), maxGapMs = 15000, maxClockSkewMs = 5000 } = {}) {
    const startMono = monotonic(), startWall = wall();
    let lastMono = startMono, lastWall = startWall, observedMs = 0, samples = 0, violations = 0, largestGapMs = 0;
    const failures = [];
    function sample() {
        const nextMono = monotonic(), nextWall = wall();
        const monoGap = nextMono - lastMono, wallGap = nextWall - lastWall;
        const clockSkew = Math.abs((nextWall - startWall) - (nextMono - startMono));
        largestGapMs = Math.max(largestGapMs, monoGap, wallGap);
        const valid = monoGap >= 0 && wallGap >= 0 && monoGap <= maxGapMs && wallGap <= maxGapMs && clockSkew <= maxClockSkewMs;
        if (valid) observedMs += monoGap;
        else { violations++; if (failures.length < 100) failures.push({ monoGapMs: monoGap, wallGapMs: wallGap, clockSkewMs: clockSkew }); }
        lastMono = nextMono; lastWall = nextWall; samples++;
        return valid;
    }
    return { sample, elapsedMs: () => Math.max(0, monotonic() - startMono), summary: () => ({ continuous: samples > 0 && violations === 0, samples, observedSeconds: observedMs / 1000, violations, largestGapMs, maxGapMs, maxClockSkewMs, failures }) };
}
module.exports = { createContinuityClock };
