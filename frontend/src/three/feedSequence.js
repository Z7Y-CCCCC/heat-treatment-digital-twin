export const FEED_STEPS = Object.freeze([
    { id: 'approach', label: '料车定位', detail: '料车沿轨道停靠炉前', seconds: 4 },
    { id: 'open', label: '炉门打开', detail: '料车到位，打开送料通道', seconds: 3 },
    { id: 'feed', label: '推链送料', detail: '门开到位，推链推动物料入炉', seconds: 4 },
    { id: 'retract', label: '推链退回', detail: '物料留在炉内，推链退回原位', seconds: 3 },
    { id: 'close', label: '炉门关闭', detail: '推链已退回，关闭炉门', seconds: 3 }
])

export const TRANSFER_MODEL_PROFILES = Object.freeze({
    ultrasonic_cleaner_cad: {
        label: '清洗机 CAD', rotationY: -Math.PI / 2, doorNode: '108_炉门', mouthNode: '008_COMPOUND',
        hiddenNodes: ['221_气动管路'],
        shellNodes: ['002_后面板', '006_前面板', '033_水槽', '152_排烟罩'], materialLength: .68, materialWidth: .58, materialHeight: .30
    },
    photo_multipurpose_furnace_v6: {
        label: '多用炉', rotationY: 0, doorNode: 'door_front_lift', mouthNode: 'mouth_frame',
        shellNodes: ['shell_front', 'shell_rear'], materialLength: 1.02, materialWidth: .78, materialHeight: .42
    },
    photo_tempering_furnace_v6: {
        label: '回火炉', rotationY: Math.PI / 2, doorNode: 'temper_v6_node_door_front_lift', mouthNode: 'temper_v6_node_front_shallow_tray',
        shellNodes: ['temper_v6_node_thermal_shell', 'temper_v6_node_refractory_chamber'], materialLength: .92, materialWidth: .78, materialHeight: .42
    }
})

const clamp = value => Math.max(0, Math.min(1, value))
export function feedDurations(input = {}) {
    return Object.fromEntries(FEED_STEPS.map(step => {
        const seconds = Number(input[step.id] ?? step.seconds)
        return [step.id, Number.isFinite(seconds) ? Math.max(.2, Math.min(120, seconds)) : step.seconds]
    }))
}

export function sampleFeedSequence(time = 0, input = {}) {
    const durations = feedDurations(input)
    const total = Object.values(durations).reduce((sum, seconds) => sum + seconds, 0)
    const elapsed = Math.max(0, Math.min(total, Number(time) || 0))
    let start = 0, index = FEED_STEPS.length - 1
    for (let i = 0; i < FEED_STEPS.length; i++) {
        if (elapsed < start + durations[FEED_STEPS[i].id] || i === FEED_STEPS.length - 1) { index = i; break }
        start += durations[FEED_STEPS[i].id]
    }
    const stage = FEED_STEPS[index], progress = clamp((elapsed - start) / durations[stage.id])
    // These are visual poses, never PLC outputs. Material remains in the furnace
    // during chain retraction; both motions deliberately have different tracks.
    const cart = index === 0 ? progress : 1
    const door = index === 0 ? 0 : index === 1 ? progress : index === 4 ? 1 - progress : 1
    const chain = index < 2 ? 0 : index === 2 ? progress : index === 3 ? 1 - progress : 0
    const material = index < 2 ? 0 : index === 2 ? progress : 1
    return {
        elapsed, total, index, stage: stage.id, progress, cart, door, chain, material,
        complete: elapsed >= total,
        cartAtFurnace: cart >= 1,
        doorOpen: door >= 1,
        chainHome: chain <= 0,
        materialInFurnace: material >= 1,
        canFeed: cart >= 1 && door >= 1,
        canClose: cart >= 1 && chain <= 0 && material >= 1
    }
}

export function feedStepStart(index, input = {}) {
    const durations = feedDurations(input)
    return FEED_STEPS.slice(0, Math.max(0, Math.min(FEED_STEPS.length, index)))
        .reduce((sum, step) => sum + durations[step.id], 0)
}

export function planFeedPlacement({ mouthMaxX, mouthCenterZ, cartLeadingX, innerDoorX, materialLength }) {
    const dockX = mouthMaxX - cartLeadingX + .18
    const materialStartX = dockX + .0325 - materialLength / 2 - .08
    const materialEndX = innerDoorX - materialLength / 2 - .14
    return { dockX, dockZ: mouthCenterZ - .085, materialStartX, materialEndX,
        feedDistance: materialStartX - materialEndX, materialY: 1.58, approachDistance: 4.1 }
}
