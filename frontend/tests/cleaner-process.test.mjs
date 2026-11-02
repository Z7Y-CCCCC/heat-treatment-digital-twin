import test from 'node:test'
import assert from 'node:assert/strict'
import { CLEANER_PROCESS_STEPS, cleanerDurations, cleanerStepStart, sampleCleanerProcess, cleanerEffectsFromSignals } from '../src/three/cleanerProcess.js'

const halfway = (id, durations) => {
    const index = CLEANER_PROCESS_STEPS.findIndex(step => step.id === id)
    return sampleCleanerProcess(cleanerStepStart(index, durations) + cleanerDurations(durations)[id] / 2, durations)
}

test('continuous cleaner playback visits all work steps after feeding and finishes only after reopening', () => {
    const total = sampleCleanerProcess(0).total
    const visited = []
    let last
    for (let tick = 0; tick <= Math.ceil(total * 60); tick++) {
        const frame = sampleCleanerProcess(tick / 60)
        if (frame.stage !== last) visited.push(frame.stage)
        last = frame.stage
        if (tick / 60 < total) assert.equal(frame.complete, false)
    }
    assert.deepEqual(visited, CLEANER_PROCESS_STEPS.map(step => step.id))
    const afterFeeding = sampleCleanerProcess(17)
    assert.equal(afterFeeding.stage, 'fill')
    assert.equal(afterFeeding.complete, false)
    assert.equal(sampleCleanerProcess(total).door, 1)
    assert.equal(sampleCleanerProcess(total).complete, true)
})

test('all cleaning operations occur with the load in place, chain home and door closed', () => {
    const total = sampleCleanerProcess(Infinity).total
    for (let time = 0; time <= total; time += .031) {
        const frame = sampleCleanerProcess(time), process = frame.process
        if (Object.entries(process).some(([key, active]) => ['fill', 'heat', 'spray', 'ultrasonic', 'drain', 'blow'].includes(key) && active)) {
            assert.equal(frame.material, 1)
            assert.equal(frame.chain, 0)
            assert.equal(frame.door, 0)
        }
        if (frame.stage === 'unseal') {
            assert.equal(process.level, 0)
            assert.equal(process.blow, false)
            assert.equal(process.wetness, 0)
        }
        assert.ok(process.level >= 0 && process.level <= 1)
    }
})

test('seeking a process reconstructs liquid level, temperature and active effects without prior playback', () => {
    assert.equal(halfway('fill').process.level, .5)
    assert.equal(halfway('heat').process.temperature, 40)
    assert.equal(halfway('spray').process.spray, true)
    assert.equal(halfway('ultrasonic').process.ultrasonic, true)
    assert.equal(halfway('drain').process.level, .5)
    assert.equal(halfway('blow').process.wetness, .5)
    assert.equal(halfway('unseal').door, .5)
    const final = sampleCleanerProcess(Infinity)
    assert.equal(final.complete, true)
    assert.equal(final.door, 1)
    assert.equal(final.material, 1)
    for (const key of ['fill', 'heat', 'spray', 'ultrasonic', 'drain', 'blow']) assert.equal(final.process[key], false)
    assert.equal(sampleCleanerProcess(-1).process.level, 0)
    assert.deepEqual(halfway('spray'), halfway('spray'))
})

test('custom and invalid timings preserve order, endpoint continuity and bounded durations', () => {
    const durations = Object.fromEntries(CLEANER_PROCESS_STEPS.map(step => [step.id, .2]))
    for (let i = 0; i < CLEANER_PROCESS_STEPS.length; i++) {
        const frame = halfway(CLEANER_PROCESS_STEPS[i].id, durations)
        assert.equal(frame.stage, CLEANER_PROCESS_STEPS[i].id)
        if (i > 0) {
            const boundary = cleanerStepStart(i, durations)
            const before = sampleCleanerProcess(boundary - 1e-7, durations), after = sampleCleanerProcess(boundary + 1e-7, durations)
            for (const key of ['cart', 'door', 'chain', 'material']) assert.ok(Math.abs(before[key] - after[key]) < .00001, `${key} at ${i}`)
            assert.ok(Math.abs(before.process.level - after.process.level) < .00001)
        }
    }
    assert.equal(cleanerDurations({ fill: NaN }).fill, 8)
    assert.equal(cleanerDurations({ drain: -1 }).drain, .2)
    assert.equal(cleanerDurations({ blow: Infinity }).blow, 6)
    assert.equal(cleanerDurations({ heat: 10000 }).heat, 120)
})

test('future mapped PLC input uses feedback values and fails closed on bad or missing quality', () => {
    const previous = cleanerEffectsFromSignals({ quality: 'good', level: .65, temperature: 48, spray: true, ultrasonic: 'true' })
    assert.equal(previous.spray, true)
    assert.equal(previous.ultrasonic, true)
    assert.equal(previous.demo, false)
    for (const signals of [{ quality: 'bad' }, { quality: 'stale' }, { quality: 'good', online: false }, {}]) {
        const state = cleanerEffectsFromSignals({ ...signals, level: 0, temperature: 0, fill: true, spray: true }, previous)
        assert.equal(state.level, .65)
        assert.equal(state.temperature, 48)
        assert.equal(state.fill, false)
        assert.equal(state.spray, false)
    }
    const parsed = cleanerEffectsFromSignals({ quality: 'good', level: null, temperature: '', spray: 'false', blow: '0' }, previous)
    assert.equal(parsed.spray, false)
    assert.equal(parsed.blow, false)
    assert.equal(parsed.level, .65)
    assert.equal(parsed.temperature, 48)
})
