import test from 'node:test'
import assert from 'node:assert/strict'
import { FEED_STEPS, feedStepStart, sampleFeedSequence } from '../src/three/feedSequence.js'

test('cart arrives before opening and feeding cannot precede full door opening', () => {
    assert.deepEqual(FEED_STEPS.map(step => step.id), ['approach','open','feed','retract','close'])
    for (let t = 0; t < 17; t += .013) {
        const frame = sampleFeedSequence(t)
        if (frame.cart < 1) assert.equal(frame.door, 0)
        if (frame.chain > 0) assert.equal(frame.canFeed, true)
        if (frame.stage === 'close') assert.equal(frame.canClose, true)
    }
    assert.equal(sampleFeedSequence(4).stage, 'open')
    assert.equal(sampleFeedSequence(7).stage, 'feed')
})

test('material stays inside while the chain retracts and the door closes', () => {
    const feeding = sampleFeedSequence(9), retracting = sampleFeedSequence(12.5), closing = sampleFeedSequence(15.5)
    assert.equal(feeding.material, .5)
    assert.equal(feeding.chain, .5)
    assert.equal(retracting.chain, .5)
    assert.equal(retracting.material, 1)
    assert.equal(retracting.door, 1)
    assert.equal(closing.chain, 0)
    assert.equal(closing.material, 1)
    assert.equal(closing.door, .5)
    assert.equal(sampleFeedSequence(17).complete, true)
})

test('seeking, invalid durations and custom timings preserve the sequence prerequisites', () => {
    const durations = { approach: 2, open: 1, feed: 6, retract: 2, close: 1 }
    assert.equal(feedStepStart(3, durations), 9)
    assert.equal(sampleFeedSequence(10, durations).material, 1)
    assert.equal(sampleFeedSequence(10, durations).chain, .5)
    assert.equal(sampleFeedSequence(-100).cart, 0)
    assert.equal(sampleFeedSequence(Infinity).complete, true)
    assert.equal(sampleFeedSequence(100, { open: NaN, close: -1 }).complete, true)
    for (const step of FEED_STEPS) assert.ok(sampleFeedSequence(0, { [step.id]: 0 }).total > 0)
})
