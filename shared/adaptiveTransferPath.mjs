// Metre-space DISPLAY path. It does not change an authored CAD drive or prove
// arrival/ownership. Missing handoffMode continues to use the original drive.
const fail=message=>{throw Error(message)}
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)
const sub=(a,b)=>a.map((n,i)=>n-b[i]),dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0)
const length=v=>Math.hypot(...v),mix=(a,b,p)=>a.map((n,i)=>n+(b[i]-n)*p)
const unit=v=>{const n=length(v);if(!Number.isFinite(n)||n<1e-8)fail('交接方向无效');return v.map(x=>x/n)}
const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,dot(a,b))))*180/Math.PI
export function buildAdaptiveTransferPath({home,sourcePort,sourceDirection,mouth,targetDirection,seat,maximumDrive,heightToleranceMeters=0,lateralToleranceMeters=0,angleToleranceDegrees=0}){
 if(![home,sourcePort,sourceDirection,mouth,targetDirection,seat,maximumDrive].every(vector))fail('示意交接坐标无效')
 if(![heightToleranceMeters,lateralToleranceMeters,angleToleranceDegrees].every(Number.isFinite)||heightToleranceMeters<0||heightToleranceMeters>1||lateralToleranceMeters<0||lateralToleranceMeters>1||angleToleranceDegrees<0||angleToleranceDegrees>30)fail('示意交接公差无效')
 const direction=unit(sourceDirection),normal=unit(targetDirection),drive=unit(maximumDrive)
 if([direction,normal,drive].some(v=>Math.abs(v[1])>.0001))fail('示意送料方向不是水平直线')
 if(Math.max(angle(direction,normal.map(n=>-n)),angle(direction,drive))>angleToleranceDegrees+.0001)fail('进出料口或送料机构方向不相对')
 const gap=dot(sub(mouth,sourcePort),direction),stroke=dot(maximumDrive,direction)
 if(!Number.isFinite(gap)||!Number.isFinite(stroke)||gap<-.0001||stroke<=0)fail('目标设备在送料方向后方')
 if(gap>stroke+.0001)fail('设备距离过远，请缩短设备与小车间距；已取消延长送料桥')
 for(const p of [home,mouth,seat]){
  const d=sub(p,sourcePort),along=dot(d,direction),lateral=Math.hypot(d[0]-direction[0]*along,d[2]-direction[2]*along)
  if(Math.abs(p[1]-sourcePort[1])>heightToleranceMeters+.000001)fail('车上、设备口与内部承料面高度不一致')
  if(lateral>lateralToleranceMeters+.000001)fail('承料位或设备口存在侧向偏差，不能用示意桥绕过')
 }
 const first=sub(mouth,home),second=sub(seat,mouth),a=length(first),b=length(second)
 if(dot(first,direction)<=.0001||dot(second,direction)<=.0001||!Number.isFinite(a+b))fail('设备口必须位于车上承料位与设备内承料位之间')
 return {home:[...home],sourcePort:[...sourcePort],mouth:[...mouth],seat:[...seat],direction,gapMeters:Math.max(0,gap),strokeMeters:stroke,bridgeMeters:0,uncoveredMeters:0,mouthFraction:a/(a+b),totalMeters:a+b}
}
export function sampleAdaptiveTransferPath(path,progress){
 if(!Number.isFinite(progress))fail('物料路径进度无效')
 const p=Math.max(0,Math.min(1,progress)),m=path.mouthFraction
 return p<=m?mix(path.home,path.mouth,p/m):mix(path.mouth,path.seat,(p-m)/(1-m))
}
// Freeze an active/prepared path if its datums change, including translations
// that preserve mouthFraction. Tolerance is metres (0.1 mm), not drive reach.
export function sameAdaptiveTransferGeometry(a,b,tolerance=.0001){
 if(!a||!b||!Number.isFinite(tolerance)||tolerance<0)return false
 return ['home','sourcePort','mouth','seat','direction'].every(key=>vector(a[key])&&vector(b[key])&&a[key].every((n,i)=>Math.abs(n-b[key][i])<=tolerance))&&
  ['gapMeters','strokeMeters','mouthFraction'].every(key=>Number.isFinite(a[key])&&Number.isFinite(b[key])&&Math.abs(a[key]-b[key])<=tolerance)
}
