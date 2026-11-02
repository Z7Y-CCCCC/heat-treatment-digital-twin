// Only used by activation-flow-ui-test against an isolated loopback backend.
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('node:path');
const { requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { runStartupActivation } = require('../desktop/activation.cjs');
app.setPath('userData', requireTestPath(process.env.ACTIVATION_UI_DATA));
const origin = new URL(process.env.ACTIVATION_UI_ORIGIN);
if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw new Error('Owned loopback fixture required');
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 440, height: 200,
        webPreferences: { preload: path.resolve(__dirname, '../desktop/startup-preload.cjs'), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.on('closed', () => app.quit());
    await window.loadFile(path.resolve(__dirname, '../desktop/assets/startup.html'));
    await window.webContents.executeJavaScript(`window.updateStartup({status:'running',title:'等待激活',detail:'复制本机指纹给厂商，粘贴返回的激活码'})`);
    await runStartupActivation({ origin: origin.origin, ipcMain, clipboard, getWindow: () => window,
        onWaiting: () => console.log('ACTIVATION_GATE_WAITING') });
    console.log('ACTIVATION_GATE_PASSED');
    // The real app now hands off to its full-sized Unity/WebView host, not the
    // compact 440x200 pre-Unity status window used earlier in this fixture.
    window.setSize(1400, 1000);
    await window.loadURL(origin.origin + '/admin');
    console.log('ORIGINAL_ADMIN_LOADED');
}).catch(error => { console.error(error); app.exit(1); });
