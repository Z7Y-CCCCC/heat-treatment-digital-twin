const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('./smoke-sandbox.cjs');

const desktopDir = path.resolve(__dirname, '..');
const projectDir = path.resolve(desktopDir, '..');
const electron = path.join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');

function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('桌面进程自愈测试超时')), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function main() {
    if (!fs.existsSync(electron)) throw new Error(`找不到 Electron：${electron}`);
    const hang = process.argv.includes('--hang');
    const sandbox = await createSmokeSandbox(hang ? 'backend-hang' : 'backend-supervisor');
    const outputDir = sandbox.directory;
    const child = spawn(electron, [path.join(desktopDir, 'main.cjs')], {
        cwd: desktopDir,
        windowsHide: true,
        env: {
            ...sandbox.env,
            NATIVE_CLIENT_SMOKE_MODE: 'true',
            DESKTOP_SMOKE_BACKEND_ONLY: 'true',
            DESKTOP_SMOKE_CRASH_BACKEND_AFTER_MS: hang ? '' : '3000',
            // Only the hidden Electron supervisor and an isolated SQLite backend
            // are started. Rendering and WebView2 have independent native tests.
            DESKTOP_SMOKE_EXIT_AFTER_MS: hang ? '35000' : '12000'
        },
        stdio: 'ignore'
    });
    let exit, suspendedPid;
    try {
        if (hang) {
            // Select only this isolated desktop's direct server child. Never
            // suspend a process discovered by a generic executable name.
            const script=`$ProgressPreference='SilentlyContinue';$env:PSModulePath=(Join-Path $PSHOME 'Modules');$p=Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Where-Object {$_.CommandLine -match 'server\\.js'};@($p.ProcessId)|ConvertTo-Json -Compress`;
            for(let n=0;n<60;n++){
                const ids=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}).trim()||'[]');
                const rows=Array.isArray(ids)?ids:[ids];if(rows.length===1&&Number.isSafeInteger(rows[0])){suspendedPid=rows[0];break;}await new Promise(r=>setTimeout(r,300));
            }
            if(!suspendedPid)throw Error('Isolated API child not found');
            await new Promise(r=>setTimeout(r,2500));
            const suspend=`$env:PSModulePath=(Join-Path $PSHOME 'Modules');$ProgressPreference='SilentlyContinue';Add-Type 'using System;using System.Runtime.InteropServices;public static class FlowSuspend{[DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint a,bool b,int c);[DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);[DllImport("ntdll.dll")]static extern int NtSuspendProcess(IntPtr h);public static int Run(int pid){var h=OpenProcess(0x0800,false,pid);if(h==IntPtr.Zero)return -1;try{return NtSuspendProcess(h);}finally{CloseHandle(h);}}}';if([FlowSuspend]::Run(${suspendedPid}) -ne 0){throw 'Suspend failed'}`;
            execFileSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(suspend,'utf16le').toString('base64')],{windowsHide:true,timeout:10000});
        }
        exit = await waitForExit(child, 120000);
    } catch (error) {
        await stopOwnedSmokeProcess(child);
        throw error;
    }

    const logFile = path.join(outputDir, 'logs', 'desktop-error.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const checks = {
        desktopExitedCleanly: exit.code === 0,
        crashDetected: log.includes('[backend-exit]'),
        restartScheduled: log.includes('[backend-restart-scheduled]'),
        restartSucceeded: log.includes('[backend-restart-success]'),
        retryLimitNotExhausted: !log.includes('[backend-restart-exhausted]')
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const result = { success: failed.length === 0, checks, outputDir, exit, hangInjected: hang, suspendedPid };
    console.log(JSON.stringify(result, null, 2));
    if (failed.length) throw new Error(`后端自愈检查失败：${failed.join(', ')}`);
    process.exit(0);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
