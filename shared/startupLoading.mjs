export const startupPhase = progress => progress < 18 ? 0 : progress < 32 ? 1 : progress < 90 ? 2 : 3

// A load has one progress owner. Web readiness must not replace native model
// progress, and 100% is reserved for BOTH completed scene and dashboard setup.
export function createOverlayStartup({requiresNative=false,onProgress=()=>{},onReady=()=>{}}={}) {
  let loadId='', sequence=-1, progress=0, phase=0, step='', nativeReady=false, webReady=false, finished=false
  const retired=new Set()
  const emit=()=>{
    const ready=webReady&&(!requiresNative||nativeReady)
    if(ready){progress=100;phase=3;step='生产现场已就绪'}
    const detail={source:requiresNative?'native':'web',loadId,sequence,progress,phase,step,sceneReady:nativeReady,webReady,ready}
    onProgress(detail)
    if(ready&&!finished){finished=true;onReady(detail)}
    return detail
  }
  return {
    webProgress(value,current,text) {
      if(finished||requiresNative)return
      const number=Number(value);if(!Number.isFinite(number))return
      progress=Math.max(progress,Math.min(99,Math.max(0,number)));phase=Math.max(phase,current);step=text;return emit()
    },
    nativeContext(context) {
      if(finished||!requiresNative)return
      const loading=context?.startupLoading,id=loading?.loadId
      if(typeof id!=='string'||!id||retired.has(id)||!Number.isFinite(loading.progress)||!Number.isInteger(loading.sequence))return
      if(id!==loadId){if(loadId)retired.add(loadId);loadId=id;sequence=-1;progress=0;phase=0;nativeReady=false}
      if(loading.sequence<sequence)return
      sequence=loading.sequence
      nativeReady=nativeReady||(context.sceneReady===true&&loading.progress>=100)
      progress=Math.max(progress,Math.min(99,Math.max(0,loading.progress)))
      phase=startupPhase(progress)
      step=nativeReady&&!webReady?'三维场景已就绪，正在准备数据组件':[loading.step,loading.detail].filter(Boolean).join(' · ')
      return emit()
    },
    webReady(){if(finished)return;webReady=true;return emit()}
  }
}

// Defense at the injected cover: coalescing paints must never change ownership
// or replay retired loads. Mirrored in DashboardLoadingExperience.cs and tested.
export function createLoadingProgressTracker(requireNative) {
  let loadId='',progress=0,phase=0,sequence=-1
  const retired=new Set()
  return detail=>{
    if(!detail||!Number.isFinite(Number(detail.progress)))return null
    if(requireNative){
      if(detail.source!=='native'||typeof detail.loadId!=='string'||!detail.loadId||retired.has(detail.loadId)||!Number.isInteger(detail.sequence))return null
      if(detail.loadId!==loadId){if(loadId)retired.add(loadId);loadId=detail.loadId;progress=0;phase=0;sequence=-1}
      if(detail.sequence<sequence)return null
      sequence=detail.sequence
    }
    const ready=detail.ready===true&&detail.sceneReady===true&&detail.webReady===true
    progress=Math.max(progress,Math.max(0,Math.min(requireNative&&!ready?99:100,Number(detail.progress))))
    phase=Math.max(phase,Math.max(0,Math.min(3,Math.trunc(Number(detail.phase)||0))))
    return {...detail,loadId,progress,phase,ready}
  }
}
