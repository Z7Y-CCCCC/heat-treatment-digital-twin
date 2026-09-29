const test = require('node:test');
const assert = require('node:assert/strict');
const { createContinuityClock } = require('./endurance-continuity.cjs');
function fixture() {
    let mono = 0, wall = 100000;
    const clock = createContinuityClock({ monotonic: () => mono, wall: () => wall });
    return { clock, advance: (m, w = m) => { mono += m; wall += w; return clock.sample(); } };
}
test('regular observations permit duration measurement and configured asynchronous restarts', () => {
    const { clock, advance } = fixture();
    for (let i = 0; i < 100; i++) assert.equal(advance(1000), true);
    assert.equal(clock.elapsedMs(), 100000);
    assert.equal(clock.summary().continuous, true);
});
test('forward wall-clock jumps cannot manufacture completed duration', () => {
    const { clock, advance } = fixture();
    advance(1000); advance(1000, 72 * 3600000);
    assert.equal(clock.elapsedMs(), 2000);
    assert.equal(clock.summary().continuous, false);
});
test('suspend invalidates continuity whether monotonic time includes or excludes sleep', () => {
    for (const monotonicSleep of [1000, 72 * 3600000]) {
        const { clock, advance } = fixture();
        advance(1000); advance(monotonicSleep, 72 * 3600000); advance(1000);
        assert.equal(clock.summary().continuous, false);
        assert.ok(clock.summary().observedSeconds < 10);
    }
});
test('backward clock changes and cumulative clock skew invalidate continuity', () => {
    const backward = fixture(); backward.advance(1000, -10000);
    assert.equal(backward.clock.summary().continuous, false);
    const skew = fixture(); for (let i = 0; i < 6; i++) skew.advance(1000, 2000);
    assert.equal(skew.clock.summary().continuous, false);
});
