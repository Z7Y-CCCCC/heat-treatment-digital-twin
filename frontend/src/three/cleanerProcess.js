import { FEED_STEPS, feedDurations, sampleFeedSequence } from './feedSequence.js'

export const CLEANER_PROCESS_STEPS = Object.freeze([
    ...FEED_STEPS,
    { id: 'fill', label: '注液', detail: '进液开启，清洗腔液位逐渐升高', seconds: 8 },
    { id: 'heat', label: '加热', detail: '加热器投入，清洗液模拟升温', seconds: 6 },
    { id: 'spray', label: '喷淋清洗', detail: '喷淋支管向物料喷射清洗液', seconds: 6 },
    { id: 'ultrasonic', label: '超声清洗', detail: '震板投入，液体内显示空化示意', seconds: 8 },
    { id: 'drain', label: '排液 / 回液', detail: '回液开启，液位下降至空腔', seconds: 6 },
    { id: 'blow', label: '吹扫', detail: '风机运行，气流带走残留水滴', seconds: 6 },
    { id: 'unseal', label: '开门待出料', detail: '排液及吹扫结束，开门等待出料', seconds: 3 }
])

const clamp = value => Math.max(0, Math.min(1, value))
export function cleanerDurations(input = {}) {
    return Object.fromEntries(CLEANER_PROCESS_STEPS.map(step => {
        const value = Number(input[step.id] ?? step.seconds)
        return [step.id, Number.isFinite(value) ? Math.max(.2, Math.min(120, value)) : step.seconds]
    }))
}

export function cleanerStepStart(index, input = {}) {
    const durations = cleanerDurations(input)
    return CLEANER_PROCESS_STEPS.slice(0, Math.max(0, Math.min(CLEANER_PROCESS_STEPS.length, index)))
        .reduce((sum, step) => sum + durations[step.id], 0)
}

// A seekable visual process, not a PLC program or a source of control outputs.
// Every effect is a function of the same timeline, so pausing and seeking do
// not leave pumps, particles or liquid levels running on a separate clock.
export function sampleCleanerProcess(time = 0, input = {}) {
    const durations = cleanerDurations(input)
    const total = Object.values(durations).reduce((sum, value) => sum + value, 0)
    const elapsed = Math.max(0, Math.min(total, Number(time) || 0))
    let start = 0, index = CLEANER_PROCESS_STEPS.length - 1
    for (let i = 0; i < CLEANER_PROCESS_STEPS.length; i++) {
        if (elapsed < start + durations[CLEANER_PROCESS_STEPS[i].id] || i === CLEANER_PROCESS_STEPS.length - 1) { index = i; break }
        start += durations[CLEANER_PROCESS_STEPS[i].id]
    }
    const stage = CLEANER_PROCESS_STEPS[index].id
    const progress = clamp((elapsed - start) / durations[stage])
    const feedTotal = Object.values(feedDurations(durations)).reduce((sum, value) => sum + value, 0)
    const pose = sampleFeedSequence(Math.min(elapsed, feedTotal), durations)
    const complete = elapsed >= total
    const level = index < 5 ? 0 : stage === 'fill' ? progress : index < 9 ? 1 : stage === 'drain' ? 1 - progress : 0
    const temperature = index < 6 ? 25 : stage === 'heat' ? 25 + 30 * progress
        : index < 10 ? 55 : stage === 'blow' ? 55 - 15 * progress : 40
    const process = {
        time: elapsed, level, temperature,
        fill: stage === 'fill', heat: stage === 'heat', spray: stage === 'spray',
        ultrasonic: stage === 'ultrasonic', drain: stage === 'drain', blow: stage === 'blow',
        // Remaining surface moisture is illustrative, not a measured dryness.
        wetness: index < 5 ? 0 : stage === 'fill' ? progress : index < 10 ? 1 : stage === 'blow' ? 1 - progress : 0,
        demo: true, quality: 'good'
    }
    const door = stage === 'unseal' ? progress : pose.door
    return { ...pose, elapsed, total, index, stage, progress, complete, process,
        door, doorOpen: door >= 1 }
}

// Explicit read-only integration boundary for a future mapped PLC data frame.
// Boolean strings such as "false" are parsed strictly. Bad/missing feedback
// freezes measured level/temperature and stops active effects; no inference
// from a missing limit switch is made. Nothing here writes to a PLC.
export function cleanerEffectsFromSignals(signals = {}, previous = {}) {
    const good = signals.online !== false && signals.quality === 'good'
    const bit = value => good && (value === true || value === 1 || value === '1' || value === 'true')
    const finite = (value, fallback) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback
    return {
        time: Math.max(0, finite(signals.time, previous.time || 0)),
        level: good ? clamp(finite(signals.level, previous.level || 0)) : previous.level || 0,
        temperature: good ? finite(signals.temperature, previous.temperature ?? 25) : previous.temperature ?? 25,
        fill: bit(signals.fill), heat: bit(signals.heat), spray: bit(signals.spray),
        ultrasonic: bit(signals.ultrasonic), drain: bit(signals.drain), blow: bit(signals.blow),
        wetness: good ? clamp(finite(signals.wetness, previous.wetness || 0)) : previous.wetness || 0,
        demo: false, quality: good ? 'good' : 'bad'
    }
}
