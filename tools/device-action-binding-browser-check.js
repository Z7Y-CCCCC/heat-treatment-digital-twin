async page => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const actions=page.locator('[aria-label="可绑定动作"] button');
  if(await actions.count()!==9)throw Error('Existing furnace part actions are missing');
  if(await page.locator('.advanced-device-transfer').count()||await page.getByText('进出料联动',{exact:true}).count())throw Error('Removed settings entry remains');
  await page.getByRole('combobox',{name:'动作数据表',exact:true}).selectOption({label:'2号多用炉 · 采集点位'});
  await page.getByRole('combobox',{name:'动作驱动数据项',exact:true}).selectOption({label:'炉门到位 · 开关量'});
  await page.getByRole('switch',{name:'启用动作联动',exact:true}).check();
  const transition=page.getByRole('spinbutton',{name:'动作过渡秒数',exact:true});
  await transition.fill(await transition.inputValue()==='0.5'?'0.6':'0.5');
  await page.getByRole('button',{name:'保存并同步',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已保存，Unity 自动同步'}).waitFor();
  const state=await (await page.request.get(new URL('/__binding-state',page.url()).href)).json();
  const saved=state.config.bindings.find(row=>row.actionId==='clip:door');
  if(!saved?.enabled||!saved.pointId)throw Error('Actual isolated HTTP save did not persist the point binding');
  await page.getByRole('button',{name:'重新读取',exact:true}).click();
  await page.getByRole('combobox',{name:'动作驱动数据项',exact:true}).locator('option:checked').filter({hasText:'炉门到位'}).waitFor({state:'attached'});
  if(!(await page.getByRole('switch',{name:'启用动作联动',exact:true}).isChecked()))throw Error('Saved enabled binding did not reopen');
  if(await actions.count()!==9||errors.length)throw Error('Action catalogue/rendering regression: '+errors.join('; '));
  await page.screenshot({path:'output/action-binding-saved-20261112.png'});
  return {success:true,actualBrowser:true,actualVueComponent:true,actualEmptyInstallBackend:true,actions:9,pointBindingSaved:true,reopened:true,removedSettingsEntry:true,productionWrites:0,errors};
}
