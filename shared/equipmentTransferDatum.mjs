// Display-model transfer datum, in local metres at scale 1 with bases on Y=0.
// This is deliberately separate from the preserved original CAD deliveries.
export const TRANSFER_DATUM={surfaceY:1.25,palletThickness:.08,loadY:1.29}
export const TRANSFER_ALIGNMENT={
    cad_tempering_furnace_091300:{floor:.10,knot:.435,delta:.020,rollerCorrection:-.002},
    cad_cleaner_170700:{floor:.10,knot:1.10,delta:-.045,rollerCorrection:-.002,basketStroke:.80},
    cad_multipurpose_furnace_082000:{floor:.14,knot:1.53,delta:-.380,basketStroke:.80},
    cad_water_cooling_tank_471000:{floor:.16,knot:1.50,delta:-.383,basketStroke:.85},
    cad_lifting_load_table_111400:{floor:.14,knot:.95,delta:.050},
    cad_air_cooling_table_115800ht:{floor:0,knot:1,delta:0,doorCorrection:-.006},
    cad_transfer_cart_101300:{floor:0,knot:1,delta:0,pusherOffsetY:-.085},
    cad_fixed_load_table_112200:{floor:0,knot:1,delta:0}
}
export function transferAuthoringY(id,y,suffix=''){
    const c=TRANSFER_ALIGNMENT[id];if(!c)return y
    const fraction=Math.max(0,Math.min(1,(y-c.floor)/(c.knot-c.floor)))
    const adjustment=c.rollerCorrection&&suffix.startsWith('internal_rollers')?c.rollerCorrection:c.doorCorrection&&/^(door|door_carriages)(_|$)/.test(suffix)?c.doorCorrection:0
    return y+c.delta*fraction+adjustment
}
export function transferAuthoringSlope(id,y){const c=TRANSFER_ALIGNMENT[id];return c&&y>c.floor&&y<c.knot?1+c.delta/(c.knot-c.floor):1}
