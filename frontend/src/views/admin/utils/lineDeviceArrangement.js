const finite=value=>{if(value===null||value===''||!Number.isFinite(Number(value)))throw Error('排布数值无效');return Number(value)}
const round=value=>Number(value.toFixed(6))
export function arrangeLineDevices(rows,target,{gap=1,spacing='edge',anchor='append',start=0,occupied=[]}={}){
    if(!rows.length)throw Error('请至少选择一台设备')
    if(rows.length>200||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('一次最多排布 200 台不同设备')
    if(!target?.item||!['lane','rail'].includes(target.type))throw Error('请选择目标设备线或导轨')
    const length=finite(target.item.length),distance=finite(gap),z=finite(target.item.offsetZ)
    if(length<=0||distance<0||spacing==='center'&&distance<=0)throw Error('净间距不能为负，中心间距必须大于零')
    if(!['edge','center'].includes(spacing)||!['append','center','start'].includes(anchor))throw Error('排布方式无效')
    const bounds=row=>{const min=finite(row.minX),max=finite(row.maxX);if(max-min<=.000001)throw Error(`设备「${row.name||row.id}」缺少有效外形尺寸`);return {min,max}}
    let previous
    const positions=rows.map((row,i)=>{const b=bounds(row),x=i===0?-b.min:spacing==='edge'?previous.right+distance-b.min:previous.x+distance;previous={x,right:x+b.max};return {...row,x,left:x+b.min,right:x+b.max}})
    const min=Math.min(...positions.map(p=>p.left)),max=Math.max(...positions.map(p=>p.right))
    const other=occupied.filter(row=>!rows.some(r=>r.id===row.id)).map(row=>{const b=bounds(row),x=finite(row.x);return {...row,left:x+b.min,right:x+b.max}})
    const origin=anchor==='center'?-(min+max)/2:anchor==='start'?finite(start)-min:other.length?Math.max(...other.map(p=>p.right))+distance-min:-(min+max)/2
    const plan=positions.map(row=>({...row,x:round(row.x+origin),left:round(row.left+origin),right:round(row.right+origin),z,binding:target}))
    for(let i=0;i<plan.length;i++){
        const row=plan[i]
        if(row.left < -length/2-.000001||row.right>length/2+.000001)throw Error(`排布超出「${target.item.name||target.item.id}」的 ${length} 米长度，请增加线长、减小间距或改为整组居中`)
        if(i&&row.left<plan[i-1].right-.000001)throw Error('中心间距小于设备外形宽度，会造成模型重叠；请增大间距或使用外形净间距')
        const collision=other.find(p=>row.left<p.right-.000001&&row.right>p.left+.000001)
        if(collision)throw Error(`与未选设备「${collision.name||collision.id}」重叠，请选择末尾追加，或将它一起排布`)
    }
    return plan
}
