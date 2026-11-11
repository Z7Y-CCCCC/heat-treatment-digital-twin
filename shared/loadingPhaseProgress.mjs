// The global percentage only estimates the active ring. A phase is confirmed
// complete by the next reported phase (or the real overall 100% milestone).
export function loadingPhaseState(value, phase, index) {
  const number=Number(value), progress=Number.isFinite(number)?Math.max(0,Math.min(100,number)):0
  const supplied=Number(phase), current=Math.max(0,Math.min(3,Number.isFinite(supplied)?Math.trunc(supplied):Math.floor(progress/25)))
  const complete=index<current||progress>=100
  return {complete,current:index===current&&!complete,progress:complete?1:index===current?Math.min(.99,Math.max(0,(progress-index*25)/25)):0}
}
