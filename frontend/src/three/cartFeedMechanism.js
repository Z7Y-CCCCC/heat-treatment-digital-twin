// Metres in the CAD cart's coordinates. Guide length 1.315, carriage length .230.
export const CART_FEED=Object.freeze({rearX:.5425,frontX:-.5425,stroke:1.085,carriageOriginalX:-.06,hookTipOffset:.15,trayHalfLength:.275,homeTrayX:.1175,sprocketRadius:.135})

// The authored return-chain route, sampled exactly like the original CAD detail
// builder: upper and lower semicircles joined by two vertical runs.
const points=[]
for(const [height,start] of [[1.99,0],[1.46,Math.PI]])for(let i=0;i<=18;i++){
 const angle=start+i*Math.PI/18;points.push([.806+.15*Math.cos(angle),height+.15*Math.sin(angle),.038])
}
points.push(points[0])
const segments=[];let length=0
for(let i=0;i<points.length-1;i++){
 const a=points[i],b=points[i+1],dx=b[0]-a[0],dy=b[1]-a[1],span=Math.hypot(dx,dy)
 segments.push({a,b,start:length,span,angle:Math.atan2(dy,dx)});length+=span
}
export const CART_CHAIN_LENGTH=length
export function sampleCartChain(distance){
 const wrapped=((distance%length)+length)%length,segment=segments.find(s=>wrapped<s.start+s.span)||segments.at(-1),p=(wrapped-segment.start)/segment.span
 return {position:[segment.a[0]+(segment.b[0]-segment.a[0])*p,segment.a[1]+(segment.b[1]-segment.a[1])*p,.038],angle:segment.angle}
}
export function locateCartChain(x,y){
 let best={error:Infinity,distance:0,angle:0}
 for(const s of segments){const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],p=Math.max(0,Math.min(1,((x-s.a[0])*dx+(y-s.a[1])*dy)/(s.span*s.span))),error=Math.hypot(x-s.a[0]-dx*p,y-s.a[1]-dy*p);if(error<best.error)best={error,distance:s.start+s.span*p,angle:s.angle}}
 return best
}
