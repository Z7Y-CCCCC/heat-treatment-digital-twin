'use strict';
// Exercise the production startup window in an isolated Electron process. No
// backend, Unity, licensing service, account profile or collector is started.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'startup-window-drag-'));
const checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let electron;

(async () => {
    assert.equal(process.platform, 'win32', 'Native hit-test regression requires Windows');
    const desktop = path.join(root, 'desktop');
    const source = fs.readFileSync(path.join(desktop, 'main.cjs'), 'utf8');
    const start = source.indexOf('async function createStartupWindow()');
    const end = source.indexOf('function closeStartupWindow()', start);
    assert.ok(start >= 0 && end > start);
    const fixture = path.join(directory, 'fixture.cjs');
    fs.writeFileSync(fixture, `
        const {app,BrowserWindow,ipcMain}=require('electron');
        const vm=require('node:vm'),path=require('node:path');
        app.setPath('userData',path.join(__dirname,'profile'));
        global.fixtureCalls=[];
        for(const name of ['status','activate','copy-fingerprint'])ipcMain.handle('startup:'+name,(_event,value)=>{
            global.fixtureCalls.push({name,value});return {success:true};
        });
        app.whenReady().then(async()=>{
            const context={BrowserWindow,path,__dirname:${JSON.stringify(desktop)},app,
                startupWindow:null,startupWindowClosingForSuccess:false,startupAppearance:null,
                applicationReadyForInteraction:true,backendOnlySmokeMode:false,isQuitting:true,
                readCachedStartupAppearance:()=>null,applyStartupAppearance:()=>{},
                startupAction:url=>global.fixtureCalls.push({name:'action',value:url}),
                sendStartupState:()=>{},delay:ms=>new Promise(r=>setTimeout(r,ms))};
            global.fixtureWindow=await vm.runInNewContext(${JSON.stringify(source.slice(start, end) + '\ncreateStartupWindow()')},context);
        });
        app.on('window-all-closed',()=>app.quit());
    `);
    const hitScript = path.join(directory, 'hit-test.ps1');
    fs.writeFileSync(hitScript, `param([long]$Handle,[double]$X,[double]$Y)
        $ErrorActionPreference='Stop'
        Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class StartupHitTest {
 [StructLayout(LayoutKind.Sequential)]public struct POINT{public int X,Y;}
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")]static extern bool ClientToScreen(IntPtr hwnd,ref POINT point);
 [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr hwnd,int msg,IntPtr wp,IntPtr lp);
 public static long Query(long handle,double x,double y){
  SetThreadDpiAwarenessContext(new IntPtr(-4));var hwnd=new IntPtr(handle);RECT r;
  if(!GetClientRect(hwnd,out r))throw new Exception("Owned window unavailable");
  var p=new POINT{X=(int)Math.Round(x*(r.Right-r.Left)),Y=(int)Math.Round(y*(r.Bottom-r.Top))};
  if(!ClientToScreen(hwnd,ref p))throw new Exception("Owned window coordinate failure");
  return SendMessage(hwnd,0x84,IntPtr.Zero,new IntPtr((p.Y<<16)|(p.X&0xffff))).ToInt64();
 }
}
'@
        [StartupHitTest]::Query($Handle,$X,$Y)
    `);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    electron = await playwright._electron.launch({
        executablePath: process.env.ELECTRON_EXECUTABLE || path.join(desktop, 'node_modules/electron/dist/electron.exe'),
        args: [fixture], env, timeout: 30000
    });
    const page = await electron.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof window.updateStartup === 'function');
    const hwnd = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
    const hit = async (selector, point) => {
        const relative = await page.evaluate(({selector,point}) => {
            const r=document.querySelector(selector).getBoundingClientRect();
            if(!r.width||!r.height)throw new Error('Hit-test target is not visible: '+selector);
            return {x:(r.x+(point?.x??r.width/2))/innerWidth,y:(r.y+(point?.y??r.height/2))/innerHeight};
        }, { selector, point });
        return Number(execFileSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-File',hitScript,
            '-Handle',hwnd,'-X',String(relative.x),'-Y',String(relative.y)], { encoding:'utf8',windowsHide:true,timeout:15000 }).trim());
    };
    const regions = async () => {
        assert.equal(await hit('.brand'), 2, 'header must be a native HTCAPTION drag region');
        assert.equal(await hit('body', {x:12,y:145}), 2, 'empty background must be draggable');
        assert.equal(await hit('#detail'), 1, 'status detail remains selectable client text');
    };
    await page.evaluate(() => window.updateStartup({status:'running',title:'正在检查数据服务',detail:'等待测试服务响应'}));
    await regions();
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMovable()), true);
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximizable()), false);
    check('compact loading header and background are native drag regions; status text is copyable');
    await page.screenshot({path:path.join(directory,'01-loading.png')});

    await electron.evaluate(({ BrowserWindow }) => {const w=BrowserWindow.getAllWindows()[0];const [x,y]=w.getPosition();w.setPosition(x+36,y+24);});
    const moved = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getPosition());
    await page.evaluate(() => window.updateStartup({status:'running',title:'正在准备场景',detail:'下一步'}));
    assert.deepEqual(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getPosition()), moved);
    check('loading progress updates do not snap a moved window back to the centre');

    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(620,560));
    await page.evaluate(() => window.showActivation({machineId:'isolated-test-fingerprint',publicKeyConfigured:true}));
    for (const selector of ['#fingerprint','#copyFingerprint','#activationCode','#activateButton']) assert.equal(await hit(selector),1,selector);
    assert.equal(await hit('.brand'),2);
    await page.locator('#activationCode').fill('isolated-test-code');
    await page.locator('#copyFingerprint').click();
    await page.locator('#activateButton').click();
    assert.deepEqual(await electron.evaluate(() => global.fixtureCalls.filter(c=>c.name!=='action')), [
        {name:'copy-fingerprint',value:undefined},{name:'activate',value:'isolated-test-code'}
    ]);
    check('activation inputs/copy/submit remain native client regions and respond normally');
    await page.screenshot({path:path.join(directory,'02-activation.png')});

    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(620,360));
    await page.evaluate(() => {window.hideActivation();window.updateStartup({status:'error',title:'程序启动失败',detail:'隔离错误页面',error:'可复制的失败原因',logPath:'isolated-test.log'});});
    assert.equal(await hit('.brand'),2);
    for (const selector of ['#error','#logPath','.actions [data-action="open-log"]','.actions [data-action="restart"]','.actions [data-action="exit"]']) assert.equal(await hit(selector),1,selector);
    // Production intentionally cancels this custom-protocol navigation and
    // handles it in main; wait for the handler, not a page navigation to finish.
    await page.locator('[data-action="open-log"]').click({noWaitAfter:true});
    let handled = false;
    for(let i=0;i<30&&!handled;i++){
        handled=await electron.evaluate(() => global.fixtureCalls.some(c=>c.value==='startup-action://open-log'));
        if(!handled)await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(handled,'real window navigation handler must receive the action');
    check('failure page is draggable without disabling copyable errors or recovery actions');
    await page.screenshot({path:path.join(directory,'03-error.png')});
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,profileIsolated:true},null,2));
    console.log('Evidence: '+directory);
})().catch(error => {
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:false,checks,error:error.stack},null,2));
    console.error(error);process.exitCode=1;
}).finally(async () => {if(electron)await electron.close();});
