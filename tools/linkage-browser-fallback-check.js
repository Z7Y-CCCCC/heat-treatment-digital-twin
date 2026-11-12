async page => {
 await page.getByRole('button',{name:/设备选择/}).click();
 await page.getByText('高级：核对现场位置',{exact:true}).click();
 await page.getByRole('combobox',{name:'联动预览排布',exact:true}).selectOption('site');
 await page.getByRole('button',{name:'一键演示',exact:true}).click();
 const fallback=page.getByRole('button',{name:'自动排布并演示',exact:true});await fallback.waitFor();
 const siteError=await page.getByRole('status').textContent();
 await fallback.click();await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
 await page.getByRole('button',{name:'暂停',exact:true}).click();
 const result=await page.evaluate(()=>({recovered:window.fixtureScene?.mode==='scheme',useSavedCycle:window.fixtureScene?.plan.useSavedCycle,steps:window.fixtureScene?.plan.steps.length}));
 if(!result.recovered||result.useSavedCycle!==false)throw Error('Advanced site error blocked one-click animation');
 return {...result,siteError};
}
