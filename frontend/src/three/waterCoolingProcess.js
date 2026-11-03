export const WATER_COOLING_STEPS = [
    { id: 'ready', label: '上位待料', duration: 3, detail: '承料架位于工作高度，水槽保持工作液位。' },
    { id: 'lower', label: '下降入水', duration: 6, detail: '升降轴与链条联动，承料架下降 1050 mm。' },
    { id: 'quench', label: '搅拌冷却', duration: 10, detail: '工件浸没，侧置搅拌叶轮运转，水面出现流动示意。' },
    { id: 'raise', label: '升起出水', duration: 6, detail: '停止冷却，承料架上升回到工作高度。' },
    { id: 'drip', label: '沥水', duration: 6, detail: '承料架保持上位，残余水滴回落至槽内。' },
    { id: 'finish', label: '待出料', duration: 3, detail: '升降机构停止，工件等待转运。' }
]
export const WATER_COOLING_TOTAL = WATER_COOLING_STEPS.reduce((sum,s)=>sum+s.duration,0)
const smooth = t => t*t*(3-2*t)
export function sampleWaterCooling(time) {
    const elapsed = Math.max(0,Math.min(WATER_COOLING_TOTAL,Number(time)||0))
    let start=0, index=WATER_COOLING_STEPS.length-1
    for(let i=0;i<WATER_COOLING_STEPS.length;i++){if(elapsed<start+WATER_COOLING_STEPS[i].duration){index=i;break}if(i<WATER_COOLING_STEPS.length-1)start+=WATER_COOLING_STEPS[i].duration}
    const step=WATER_COOLING_STEPS[index],progress=Math.min(1,(elapsed-start)/step.duration)
    const down=step.id==='lower'?smooth(progress):step.id==='quench'?1:step.id==='raise'?1-smooth(progress):0
    // Absolute-time angles make pause, seek and replay deterministic.
    const lowerTime=Math.max(0,Math.min(6,elapsed-3)),raiseTime=Math.max(0,Math.min(6,elapsed-19))
    const coolingTime=Math.max(0,Math.min(10,elapsed-9))
    return {elapsed,index,stage:step.id,complete:elapsed===WATER_COOLING_TOTAL,down,level:1,agitator:step.id==='quench',
        rotorAngle:coolingTime*Math.PI*4,hoistAngle:(lowerTime-raiseTime)*Math.PI*2,
        bubbles:step.id==='quench',dripping:step.id==='drip',progress}
}
