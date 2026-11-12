// Decimal UI values can round-trip through Unity Float32. Those representation
// tails are not a changed calibration and must not block normal saves.
export function sceneUnitsEquivalent(a,b){
 return Number.isFinite(a)&&Number.isFinite(b)&&a>0&&b>0&&Math.abs(a-b)<=Math.max(Math.abs(a),Math.abs(b))*1e-6
}
export function displayCoordinateNumber(value){
 if(value==null||typeof value==='boolean'||typeof value==='string'&&!value.trim())return ''
 const n=Number(value);return Number.isFinite(n)?String(Number(n.toFixed(2))):''
}
export function displaySceneUnits(value){
 if(value==null||typeof value==='boolean'||typeof value==='string'&&!value.trim())return ''
 const n=Number(value);if(!Number.isFinite(n))return ''
 // Summing station distances can accumulate a few Float32 tails too. Prefer
 // the shortest equivalent number, without changing the authored value.
 for(let precision=1;precision<=6;precision++){const rounded=Number(n.toPrecision(precision));if(sceneUnitsEquivalent(n,rounded))return String(rounded)}
 return String(Number(n.toPrecision(6)))
}
