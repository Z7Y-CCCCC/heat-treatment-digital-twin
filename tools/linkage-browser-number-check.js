async page => {
 await page.getByRole('button',{name:'保存移动配置',exact:true}).click();
 return await page.evaluate(()=>{
  const inputs=[...document.querySelectorAll('input[type=number]')],tails=inputs.filter(i=>/\.\d{3,}/.test(i.value));
  if(tails.length||!window.fixtureSavedMovement)throw Error('Float tail or non-actionable save failure returned');
  return {saved:true,operatorWrites:0,unitsDisplay:document.querySelector('[aria-label="移动场景单位每米"]')?.value,coordinate:document.querySelector('[aria-label="工位 3 X 坐标"]').value,distance:[...document.querySelectorAll('input[placeholder="例如 8.5"]')].map(i=>i.value),originalUnits:window.fixtureEvidence.movementUnits,savedUnits:window.fixtureSavedMovement.sceneUnitsPerMeter};
 });
}
