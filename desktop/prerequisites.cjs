'use strict';
const path=require('node:path'), fs=require('node:fs');
const {execFile}=require('node:child_process');
const LINKS=Object.freeze({ WebView2:'https://developer.microsoft.com/microsoft-edge/webview2/#download-section', VCRedist:'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist' });
function runPrerequisiteCheck(script,runtimeRoot,action='Inspect',component='All') {
    return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Action',action,'-Component',component,'-RuntimeRoot',runtimeRoot],
        {windowsHide:true,timeout:action==='Install'?510000:15000,maxBuffer:65536},(error,stdout)=>{
            let data;try{data=JSON.parse(stdout.trim().replace(/^\uFEFF/,''))}catch{return reject(new Error('无法检查 Windows 运行环境，请检查 PowerShell 和系统策略'))}
            if(error && !data.restartRequired)return reject(new Error(data.error||'运行环境准备失败'));
            resolve(data);
        }));
}
function evaluatePrerequisites(value={}) {
    if(value.supported!==true || Number(value.build)<17763 || !Number.isInteger(Number(value.build)) || value.architecture!=='AMD64')return {supported:false,missing:[],message:'需要 Windows 10 1809 或更新版本 / Windows 11（Intel/AMD x64）。32 位、ARM64 和 S 模式不在本版本支持范围内。'};
    return {supported:true,missing:[...(!value.vcRedist?.ready?['VCRedist']:[]),...(!value.webView2?.ready?['WebView2']:[])]};
}
async function ensurePrerequisites({script,runtimeRoot,dialog,shell,onProgress=()=>{},reportFile,run=runPrerequisiteCheck}) {
    let snapshot=await run(script,runtimeRoot), result=evaluatePrerequisites(snapshot);
    if(reportFile){fs.mkdirSync(path.dirname(reportFile),{recursive:true});fs.writeFileSync(reportFile,JSON.stringify(snapshot,null,2))}
    if(!result.supported)throw new Error(result.message);
    if(!result.missing.length)return snapshot;
    const choice=await dialog.showMessageBox({type:'info',title:'准备运行环境',message:'首次使用需要准备运行环境',detail:result.missing.map(name=>name==='WebView2'?'Microsoft Edge WebView2 Runtime':'Microsoft Visual C++ x64 运行库').join('\n')+'\n使用随包 Microsoft 离线安装程序，不需要自行安装 Node.js、MySQL 或 .NET。',buttons:['安装所需环境','打开官方下载页','暂不启动'],defaultId:0,cancelId:2,noLink:true});
    if(choice.response===1)await shell.openExternal(LINKS[result.missing[0]]);
    if(choice.response!==0)throw new Error('运行环境尚未准备好，可重新打开程序继续；账号和工程数据未修改');
    onProgress('正在准备运行环境','安装随包 Microsoft 运行库，请等待…');
    snapshot=await run(script,runtimeRoot,'Install');
    if(snapshot.restartRequired)throw new Error('运行环境已安装，请先重启 Windows，再打开大屏；程序不会自行重启电脑');
    result=evaluatePrerequisites(snapshot);
    if(!result.supported||result.missing.length)throw new Error('运行环境仍未就绪，请查看日志或从 Microsoft 官网修复后重试');
    return snapshot;
}
module.exports={runPrerequisiteCheck,evaluatePrerequisites,ensurePrerequisites,LINKS};
