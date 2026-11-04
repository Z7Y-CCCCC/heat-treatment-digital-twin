// One shared process for the standalone demo and production-line simulation.
// No device commands are sent: these durations are presentation time only.
export const MULTIPURPOSE_CYCLE=[
    {kind:'approach',label:'料车到达前室',duration:4},
    {kind:'open',label:'打开前室外门',duration:3},
    {kind:'feed',label:'送料进入前室',duration:4},
    {kind:'retract',label:'料车推链退回',duration:3},
    {kind:'close',label:'关闭前室外门',duration:3},
    {kind:'gate_open',label:'打开中门',duration:3},
    {kind:'hot_feed',label:'前室送入后室',duration:4},
    {kind:'gate_close',label:'关闭中门',duration:3},
    {kind:'heat_treat',label:'后室加热加工',duration:10},
    {kind:'gate_open_return',label:'加工完成，打开中门',duration:3},
    {kind:'hot_return',label:'后室返回前室',duration:4},
    {kind:'gate_close_return',label:'返回到位，关闭中门',duration:3},
    {kind:'lower',label:'前室料架下降入油槽',duration:4},
    {kind:'quench',label:'油槽淬火',duration:8},
    {kind:'raise',label:'料架升回前室',duration:4},
    {kind:'drip',label:'前室沥油',duration:8},
    {kind:'open_out',label:'沥油完成，打开外门',duration:3},
    {kind:'pickup_extend',label:'料车伸链勾合料盘',duration:2},
    {kind:'reclaim',label:'料车从前室拉出料盘',duration:4},
    {kind:'close_out',label:'关闭前室外门',duration:3}
]
export const MULTIPURPOSE_PROCESS_KINDS=MULTIPURPOSE_CYCLE.slice(5,16).map(step=>step.kind)
export const MULTIPURPOSE_CYCLE_DURATION=MULTIPURPOSE_CYCLE.reduce((sum,step)=>sum+step.duration,0)
