import fs from 'node:fs'
import {newTransferCycle,advanceTransferCycle} from '../shared/transferCycle.mjs'
const config={extendSeconds:4,latchSeconds:.75,retractSeconds:4,conveySeconds:3,confirmTimeoutSeconds:10},traces=[]
for(const pickup of [false,true]){
 const state=newTransferCycle(),steps=[];let elapsed=0
 for(let i=0;i<640;i++){
  const delta=[1/60,.021,.013,.034][i%4];elapsed+=delta
  const confirmed=elapsed>4.15,input={valid:!(elapsed>2&&elapsed<2.1),docked:true,start:elapsed<10,pickup,sourcePresent:confirmed?pickup:!pickup,targetPresent:confirmed?!pickup:pickup,mouthFraction:.55}
  advanceTransferCycle(state,input,delta,config);steps.push({delta,input,expected:structuredClone(state)})
 }
 traces.push({name:pickup?'pickup-opposite-or-primary':'deposit-opposite-or-primary',config,steps})
}
fs.writeFileSync(new URL('../shared/transfer-cycle-fixtures.json',import.meta.url),JSON.stringify({version:1,scope:'Display estimates; synthetic BOOL observations; no physical PLC proof',traces}))
console.log('Wrote '+traces.reduce((n,t)=>n+t.steps.length,0)+' exact shared trace steps')
