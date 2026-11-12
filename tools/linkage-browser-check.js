async page => {
  const start=page.getByRole('button',{name:'一键演示',exact:true});if(await start.count())await start.click();
  await page.waitForFunction(()=>window.fixtureScene?.plan&&document.querySelector('[aria-label="产线联动流程进度"]')?.disabled===false);
  const pause=page.getByRole('button',{name:'暂停',exact:true});if(await pause.count())await pause.click();
  const report=await page.evaluate(async()=>{
    const scene=window.fixtureScene,input=document.querySelector('[aria-label="产线联动流程进度"]'),cart=scene.entries.get(scene.plan.cart.id);
    const seek=async value=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))};
    await seek(0);const rest=cart.rig.node('feed_carriage').position.x;let samples=0,maxStroke=0;
    for(const step of scene.plan.steps)for(const fraction of [.01,.5,.99]){
      await seek(step.start+step.duration*fraction);samples++;maxStroke=Math.max(maxStroke,Math.abs(cart.rig.node('feed_carriage').position.x-rest));
      if(scene.siteTransferReason||!scene.material.position.toArray().every(Number.isFinite)||document.querySelector('[role=alert]'))throw Error('Actual UI animation failed');
    }
    if(maxStroke>1.08501||scene.transferBridge||scene.plan.useSavedCycle!==false)throw Error('Long-extension or saved-site constraint returned');
    await seek(9);
    return {actualWebGL:true,oneClick:true,devices:scene.plan.rows.length,steps:scene.plan.steps.length,samples,maxStroke,mode:scene.mode,useSavedCycle:scene.plan.useSavedCycle,drawCalls:scene.renderer.info.render.calls,bridge:false};
  });
  await page.getByRole('button',{name:'当前设备',exact:true}).click();
  await page.screenshot({path:'output/playwright/linkage-simplification-20261111/one-click-multipurpose.png'});
  return report;
}
