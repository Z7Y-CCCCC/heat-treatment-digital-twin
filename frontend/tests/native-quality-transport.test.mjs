import test from 'node:test'
import assert from 'node:assert/strict'
import { createQualityTransport } from '../src/runtime/nativeQualityTransport.js'
import { createNativeQualityControl } from '../src/runtime/nativeQuality.js'

function channels() {
  const ports=[]
  return () => {
    const handlers=new Set(),port={addEventListener(_name,f){handlers.add(f)},removeEventListener(_name,f){handlers.delete(f)},
      postMessage(data){for(const other of ports)if(other!==port)for(const f of other.handlers)f({data:structuredClone(data)})},
      close(){ports.splice(ports.indexOf(port),1)},handlers}
    ports.push(port);return port
  }
}
test('the admin relay synchronizes only confirmed native states, queries late mounts, and forwards a bounded quality-only command', () => {
  const channel=channels(),sent=[],state={enabled:false,profile:'',pending:'',notice:''}
  const native=createQualityTransport({channel:channel(),postNative:m=>sent.push(m),receive(){assert.fail('native must not trust channel snapshots')}})
  let relay
  const control=createNativeQualityControl({state,post:m=>relay.post(m)})
  relay=createQualityTransport({relay:true,channel:channel(),receive:m=>control.receive(m)})
  const snapshot={type:'native_quality_state',revision:5,profile:'showcase',automatic:false,enabled:true,hotkeysEnabled:true,notify:true}
  native.publish(snapshot)
  assert.equal(state.profile,'showcase');assert.equal(state.notice,'','cross-page updates must not replay success toasts')
  assert.equal(control.request('balanced'),true);assert.equal(state.profile,'showcase','never optimistically display an unconfirmed renderer setting')
  assert.equal(sent.at(-1).action,'set_quality_profile');assert.equal(sent.at(-1).profile,'balanced')
  native.publish({...snapshot,revision:6,profile:'balanced',requestId:sent.at(-1).requestId})
  assert.equal(state.profile,'balanced');assert.equal(state.pending,'')
  native.publish({...snapshot,revision:4});assert.equal(state.profile,'balanced','stale broadcasts cannot roll back the current profile')
  assert.throws(()=>relay.post({type:'dashboard_action',action:'quit'}),/Invalid/)
  assert.throws(()=>relay.post({type:'dashboard_action',action:'set_quality_profile',profile:'bad'}),/Invalid/)
  control.query();assert.equal(sent.at(-1).action,'get_quality_profile')
  relay.dispose();control.dispose();native.dispose()
})
test('a newly opened admin receives the cached non-notifying renderer snapshot; disposal closes its subscription', () => {
  const channel=channels(),received=[],native=createQualityTransport({channel:channel(),postNative(){}})
  native.publish({type:'native_quality_state',revision:10,profile:'integrated_gpu',enabled:true,notify:true,requestId:'old'})
  const relay=createQualityTransport({relay:true,channel:channel(),receive:m=>received.push(m)})
  relay.post({type:'dashboard_action',action:'get_quality_profile'})
  assert.equal(received[0].profile,'integrated_gpu');assert.equal(received[0].notify,false);assert.equal(received[0].requestId,'')
  relay.dispose();native.publish({type:'native_quality_state',revision:11,profile:'showcase'})
  assert.equal(received.length,1);assert.throws(()=>relay.post({type:'dashboard_action',action:'get_quality_profile'}),/closed/)
  native.dispose()
})
