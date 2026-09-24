// Transport delivery is not a rendered scene. Wait for Unity's matching
// dashboard context before exposing its window / replacing the Web scene.
export function createNativeViewNavigator(send,timeoutMs=10000) {
  let pending=null
  function finish(error) {
    if(!pending) return
    const current=pending;pending=null;clearTimeout(current.timer)
    error ? current.reject(error) : current.resolve(current.context)
  }
  return {
    go(target) {
      if(pending) return Promise.reject(new Error('正在切换视角，请稍候'))
      return new Promise((resolve,reject)=>{
        const current={target,resolve,reject,delivered:false,context:null}
        pending=current
        current.timer=setTimeout(()=>finish(new Error('Unity 未确认视角就绪，已保留当前页面')),timeoutMs)
        Promise.resolve().then(()=>send(target)).then(result=>{
          if(pending!==current) return
          if(!result?.success || !result.sent) return finish(new Error(result?.error || 'Unity 尚未连接，未切换视角'))
          current.delivered=true
          if(current.context) finish()
        },error=>{if(pending===current) finish(error)})
      })
    },
    accept(context) {
      if(!pending || context?.sceneReady===false || context?.viewId!==pending.target.viewId) return
      if(['deviceId','lineId','workshopId'].some(key=>pending.target[key]!==undefined && String(context?.[key] || '')!==String(pending.target[key] || '')))return
      pending.context=context
      if(pending.delivered) finish()
    },
    dispose() { finish(new Error('视角切换已取消')) }
  }
}
