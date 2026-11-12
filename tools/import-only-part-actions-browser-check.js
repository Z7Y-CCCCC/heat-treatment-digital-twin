async page => {
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const component=page.locator('.imported-action-list');
 await component.getByText('暂无动作，请导入动作包',{exact:true}).waitFor();
 if(await component.getByRole('button',{name:/参数配置|新增动作|编辑|删除|保存绑定/}).count())throw Error('Manual authoring entry remains');
 await page.screenshot({path:'output/import-only-part-actions-empty-20261112.png'});
 await page.getByRole('button',{name:'已导入动作包示例',exact:true}).click();
 if(await component.locator('.action-card').count()!==4)throw Error('First action page is incomplete');
 await component.getByRole('button',{name:'预览前室门开启 / 关闭',exact:true}).click();
 await page.getByTestId('preview-result').filter({hasText:'sample_0'}).waitFor();
 await component.getByRole('button',{name:'下一页动作节点',exact:true}).click();
 await component.getByText('热室循环叶轮',{exact:true}).waitFor();
 await component.getByRole('combobox',{name:'跳转动作节点页码',exact:true}).selectOption('3');
 if(await component.locator('.action-card').count()!==1)throw Error('Final action page was lost');
 await component.getByRole('textbox',{name:'搜索动作节点',exact:true}).fill('热风');
 await component.getByText('加热与热风循环',{exact:true}).waitFor();
 if(await component.locator('.action-card').count()!==1)throw Error('Search did not filter imported actions');
 await page.screenshot({path:'output/import-only-part-actions-preview-20261112.png'});
 if(errors.length)throw Error(errors.join('; '));
 return {success:true,actualComponent:true,manualAuthoringRemoved:true,emptyMessage:true,previewEvent:true,paging:true,search:true,configurationWrites:0,errors};
}
