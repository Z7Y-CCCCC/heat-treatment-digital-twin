import * as THREE from 'three'

export const CLEANER_EFFECT_NODES = Object.freeze({
    tank: '033_水槽', mouth: '008_COMPOUND', fan: '030_电机风扇',
    spray: ['227_喷淋支管', '230_喷淋支管', '233_喷淋支管', '236_喷淋支管', '239_喷淋支管', '242_喷淋支管', '245_喷淋支管', '248_喷淋支管', '251_喷淋支管', '254_喷淋支管'],
    ultrasonic: ['299_超声波震板', '302_震板2'],
    heaters: ['155_碱水加热器', '158_碱水加热器', '161_碱水加热器', '164_碱水加热器', '167_碱水加热器', '170_碱水加热器', '173_碱水加热器', '176_碱水加热器', '179_碱水加热器', '182_碱水加热器', '185_碱水加热器', '188_碱水加热器', '260_加热器2', '263_加热器2', '266_加热器2', '269_加热器2', '272_加热器2', '275_加热器2', '278_加热器2', '281_加热器2']
})

// Bounds are in scene coordinates after the CAD has been oriented and aligned.
// No hidden/detached pipe determines the process envelope. Flow routes are
// explicitly schematic; nozzle locations follow the actual spray branch bounds.
export function cleanerProcessLayout(bounds) {
    const required = name => {
        const box = bounds(name)
        if (!box || box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) throw new Error(`清洗工艺缺少有效 CAD 部件：${name}`)
        return box
    }
    const mouth = required(CLEANER_EFFECT_NODES.mouth)
    const tank = required(CLEANER_EFFECT_NODES.tank)
    const fan = required(CLEANER_EFFECT_NODES.fan)
    const branches = CLEANER_EFFECT_NODES.spray.map(required)
    const sprayBox = branches.reduce((box, branch) => box.union(branch), new THREE.Box3())
    const chamber = new THREE.Box3(
        new THREE.Vector3(sprayBox.min.x + .02, mouth.min.y + .04, mouth.min.z + .025),
        new THREE.Vector3(mouth.max.x - .06, mouth.max.y - .07, mouth.max.z - .025)
    )
    const center = chamber.getCenter(new THREE.Vector3())
    const jets = branches.flatMap(box => [.25, .5, .75].map(t => ({
        start: new THREE.Vector3(THREE.MathUtils.lerp(box.min.x, box.max.x, t), box.getCenter(new THREE.Vector3()).y, box.getCenter(new THREE.Vector3()).z),
        end: new THREE.Vector3(THREE.MathUtils.lerp(chamber.min.x, chamber.max.x, t), Math.min(center.y + .05, box.min.y), center.z)
    })))
    const returnPoint = new THREE.Vector3(center.x - .25, tank.max.y - .22, tank.min.z + .3)
    const fillPath = [returnPoint.clone(), new THREE.Vector3(chamber.min.x - .08, returnPoint.y, chamber.min.z),
        new THREE.Vector3(chamber.min.x - .08, center.y, chamber.min.z), new THREE.Vector3(chamber.min.x + .1, center.y, chamber.min.z + .08)]
    const drainPath = [new THREE.Vector3(center.x, chamber.min.y, center.z),
        new THREE.Vector3(center.x, tank.max.y - .1, center.z), returnPoint.clone()]
    return { chamber, tank, fan, jets, fillPath, drainPath }
}
