/**
 * 屏幕捕获 → H.264/MPEG-TS 直播流 → DLNA 电视。
 *
 * DLNA 电视只会“播一个媒体地址”，不会打开网页，所以真正的一键投屏必须由本机
 * 把大屏画面实时编码成视频流，再把流地址交给电视。本服务负责：
 *   1. 找到可用的 ffmpeg；
 *   2. 起一个只在局域网内可访问的 HTTP 流服务（/cast/<token>/live.ts）；
 *   3. 将 Unity 窗口切回实时大屏，并把后台宿主的顶栏切换到“展示模式”；
 *   4. 电视来拉流时，为它单独拉起一路 ffmpeg（只捕获 Unity 客户区，避免顶栏、任务栏和输入法浮层），断开即回收；
 *   5. 启动独立的 Windows 窗口隔离守护，持续处理投屏期间新出现的置顶窗口；后端异常退出时守护也会自动恢复窗口；
 *   6. 通过 AVTransport 让电视开始/停止播放。
 *
 * 正式安装包内置固定版本的 LGPL FFmpeg；开发环境未准备资源时会明确提示。
 */

const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dlna = require('./dlnaClient');
const { ipv4ToLong, isPrivateIpv4, listLanIpv4Interfaces } = require('../utils/lanNetwork');

const DEFAULT_STREAM_PORT = 8788;
const STREAM_TITLE = '热处理数字孪生大屏';
const DEFAULT_WINDOW_TITLE = 'Heat Treatment Digital Twin';
const DASHBOARD_CHROME_HEIGHT = 46;
const WINDOW_BOUNDS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CastWindowProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle, ref POINT point);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@
[void][CastWindowProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))
$target = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq $env:CAST_WINDOW_TITLE
} | Select-Object -First 1
if ($null -eq $target) { exit 2 }
if ([CastWindowProbe]::IsIconic($target.MainWindowHandle)) {
    [void][CastWindowProbe]::ShowWindow($target.MainWindowHandle, 9)
}
[void][CastWindowProbe]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 220
$client = New-Object CastWindowProbe+RECT
if (-not [CastWindowProbe]::GetClientRect($target.MainWindowHandle, [ref]$client)) { exit 3 }
$origin = New-Object CastWindowProbe+POINT
if (-not [CastWindowProbe]::ClientToScreen($target.MainWindowHandle, [ref]$origin)) { exit 3 }
$virtualLeft = [CastWindowProbe]::GetSystemMetrics(76)
$virtualTop = [CastWindowProbe]::GetSystemMetrics(77)
$virtualRight = $virtualLeft + [CastWindowProbe]::GetSystemMetrics(78)
$virtualBottom = $virtualTop + [CastWindowProbe]::GetSystemMetrics(79)
$clientRight = $origin.X + $client.Right
$clientBottom = $origin.Y + $client.Bottom
$left = [Math]::Max($origin.X, $virtualLeft)
$top = [Math]::Max($origin.Y, $virtualTop)
$right = [Math]::Min($clientRight, $virtualRight)
$bottom = [Math]::Min($clientBottom, $virtualBottom)
$width = $right - $left
$height = $bottom - $top
if ($width -lt 64 -or $height -lt 64) { exit 4 }
$dpi = [CastWindowProbe]::GetDpiForWindow($target.MainWindowHandle)
if ($dpi -lt 96) { $dpi = 96 }
$chromeHeight = [Math]::Round(${DASHBOARD_CHROME_HEIGHT} * $dpi / 96)
[Console]::Out.Write(("{0},{1},{2},{3},{4},{5},{6}" -f $left,$top,$width,$height,$chromeHeight,$target.MainWindowHandle.ToInt64(),$target.Id))
`;
const WINDOW_BOUNDS_SCRIPT_BASE64 = Buffer.from(WINDOW_BOUNDS_SCRIPT, 'utf16le').toString('base64');
// gdigrab 只能捕获桌面像素，不能像浏览器那样天然隔离其它窗口。
// 投屏时临时隔离“捕获区域上方”的所有顶层窗口（输入法、通知、其它软件、任务栏等），
// 停止投屏后按原来的显示状态恢复。窗口只隐藏，不结束进程，也不改系统输入法配置。
const WINDOW_ISOLATION_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class CastWindowIsolation {
    private sealed class HiddenWindowRecord {
        public long Handle;
        public int RestoreCommand;
        public uint ProcessId;
    }

    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr handle, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern IntPtr GetWindowLongPtr32(IntPtr handle, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);

    private const int GwlExStyle = -20;
    private const long WsExTopmost = 0x00000008L;
    private const uint GaRoot = 2;
    private const int DwmwaCloaked = 14;
    private const int SwHide = 0;
    private const int SwShowMaximized = 3;
    // SW_SHOW is more reliable than SW_SHOWNOACTIVATE for shell-owned windows
    // such as Shell_TrayWnd; it still does not change the active window when
    // the target application remains foreground.
    private const int SwShowNoActivate = 5;
    private static readonly Dictionary<long, HiddenWindowRecord> GuardHidden = new Dictionary<long, HiddenWindowRecord>();

    public static string HideOverlappingWindows(
        long targetHandleValue,
        uint targetProcessId,
        int captureLeft,
        int captureTop,
        int captureWidth,
        int captureHeight
    ) {
        var records = HideOverlappingWindowRecords(
            targetHandleValue,
            targetProcessId,
            captureLeft,
            captureTop,
            captureWidth,
            captureHeight
        );
        var lines = records.ConvertAll(record => string.Format(
            "{0}|{1}|{2}",
            record.Handle,
            record.RestoreCommand,
            record.ProcessId
        ));
        return string.Join("\\n", lines.ToArray());
    }

    public static void RunGuard(
        long targetHandleValue,
        uint targetProcessId,
        int captureLeft,
        int captureTop,
        int captureWidth,
        int captureHeight,
        int parentProcessId,
        string stopFilePath,
        int intervalMilliseconds
    ) {
        GuardHidden.Clear();
        try {
            var ready = false;
            while (!StopRequested(stopFilePath) && IsProcessAlive(parentProcessId)) {
                var added = HideOverlappingWindowRecords(
                    targetHandleValue,
                    targetProcessId,
                    captureLeft,
                    captureTop,
                    captureWidth,
                    captureHeight
                );
                foreach (var record in added) {
                    GuardHidden[record.Handle] = record;
                    WriteGuardLine(string.Format(
                        "HIDDEN|{0}|{1}|{2}",
                        record.Handle,
                        record.RestoreCommand,
                        record.ProcessId
                    ));
                }
                if (!ready) {
                    ready = true;
                    WriteGuardLine(string.Format("READY|{0}", GuardHidden.Count));
                }
                Thread.Sleep(Math.Max(100, intervalMilliseconds));
            }
        } finally {
            RestoreGuardWindows();
            try {
                if (!string.IsNullOrWhiteSpace(stopFilePath) && File.Exists(stopFilePath)) File.Delete(stopFilePath);
            } catch { }
            WriteGuardLine("RESTORED");
        }
    }

    private static List<HiddenWindowRecord> HideOverlappingWindowRecords(
        long targetHandleValue,
        uint targetProcessId,
        int captureLeft,
        int captureTop,
        int captureWidth,
        int captureHeight
    ) {
        var targetHandle = new IntPtr(targetHandleValue);
        var captureRight = (long)captureLeft + Math.Max(0, captureWidth);
        var captureBottom = (long)captureTop + Math.Max(0, captureHeight);
        var hidden = new List<HiddenWindowRecord>();
        var targetSeen = false;
        EnumWindows((handle, lParam) => {
            if (handle == targetHandle) targetSeen = true;
            if (!IsWindowVisible(handle)) return true;
            if (IsCloaked(handle)) return true;

            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            var isTarget = handle == targetHandle
                || processId == targetProcessId
                || GetAncestor(handle, GaRoot) == targetHandle;
            if (isTarget) return true;

            RECT rect;
            if (!GetWindowRect(handle, out rect)) return true;
            var overlaps = rect.Left < captureRight
                && rect.Right > captureLeft
                && rect.Top < captureBottom
                && rect.Bottom > captureTop;
            if (!overlaps) return true;

            // EnumWindows 按 Z 序从上到下枚举。目标窗口之前的窗口在它上面，
            // 目标窗口之后的普通窗口在它下面，不会进入 gdigrab 的最终像素。
            // WS_EX_TOPMOST 窗口无论枚举位置如何都必须隔离。
            var exStyle = GetWindowLong(handle, GwlExStyle);
            var topmost = (exStyle & WsExTopmost) != 0;
            if (targetSeen && !topmost) return true;

            var restoreCommand = IsZoomed(handle) ? SwShowMaximized : SwShowNoActivate;
            if (ShowWindow(handle, SwHide)) {
                hidden.Add(new HiddenWindowRecord {
                    Handle = handle.ToInt64(),
                    RestoreCommand = restoreCommand,
                    ProcessId = processId
                });
            }
            return true;
        }, IntPtr.Zero);
        return hidden;
    }

    private static void RestoreGuardWindows() {
        foreach (var record in GuardHidden.Values) {
            try {
                var handle = new IntPtr(record.Handle);
                if (!IsWindow(handle)) continue;
                uint actualProcessId;
                GetWindowThreadProcessId(handle, out actualProcessId);
                if (actualProcessId == record.ProcessId) {
                    ShowWindow(handle, record.RestoreCommand);
                }
            } catch { }
        }
        GuardHidden.Clear();
    }

    private static bool IsProcessAlive(int processId) {
        try {
            var process = Process.GetProcessById(processId);
            return !process.HasExited;
        } catch {
            return false;
        }
    }

    private static bool StopRequested(string stopFilePath) {
        try {
            return !string.IsNullOrWhiteSpace(stopFilePath) && File.Exists(stopFilePath);
        } catch {
            return false;
        }
    }

    private static void WriteGuardLine(string value) {
        try {
            Console.Out.WriteLine(value);
            Console.Out.Flush();
        } catch { }
    }

    private static long GetWindowLong(IntPtr handle, int index) {
        var value = IntPtr.Size == 8
            ? GetWindowLongPtr64(handle, index)
            : GetWindowLongPtr32(handle, index);
        return value.ToInt64();
    }

    private static bool IsCloaked(IntPtr handle) {
        try {
            int cloaked;
            return DwmGetWindowAttribute(handle, DwmwaCloaked, out cloaked, sizeof(int)) == 0 && cloaked != 0;
        } catch {
            return false;
        }
    }
}
"@
$null = [CastWindowIsolation]::SetProcessDpiAwarenessContext([IntPtr](-4))
$targetHandle = [Int64]$env:CAST_TARGET_HWND
$targetPid = [UInt32]$env:CAST_TARGET_PID
$left = [Int32]$env:CAST_CAPTURE_LEFT
$top = [Int32]$env:CAST_CAPTURE_TOP
$width = [Int32]$env:CAST_CAPTURE_WIDTH
$height = [Int32]$env:CAST_CAPTURE_HEIGHT
if ($env:CAST_GUARD_MODE -eq '1') {
    $parentPid = [Int32]$env:CAST_GUARD_PARENT_PID
    $stopFile = [String]$env:CAST_GUARD_STOP_FILE
    $interval = [Int32]$env:CAST_GUARD_INTERVAL_MS
    [CastWindowIsolation]::RunGuard($targetHandle, $targetPid, $left, $top, $width, $height, $parentPid, $stopFile, $interval)
} else {
    [Console]::Out.Write([CastWindowIsolation]::HideOverlappingWindows($targetHandle, $targetPid, $left, $top, $width, $height))
}
`;
const WINDOW_ISOLATION_SCRIPT_BASE64 = Buffer.from(WINDOW_ISOLATION_SCRIPT, 'utf16le').toString('base64');
const WINDOW_RESTORE_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CastWindowRestore {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
}
"@
foreach ($value in ($env:CAST_WINDOW_RECORDS -split ';')) {
    if ([string]::IsNullOrWhiteSpace($value)) { continue }
    try {
        $parts = $value -split '\\|'
        if ($parts.Count -lt 3) { continue }
        $handle = [IntPtr]::new([Int64]$parts[0])
        $restoreCommand = [Int32]$parts[1]
        $expectedPid = [UInt32]$parts[2]
        if ([CastWindowRestore]::IsWindow($handle)) {
            [UInt32]$actualPid = 0
            [CastWindowRestore]::GetWindowThreadProcessId($handle, [ref]$actualPid) | Out-Null
            if ($actualPid -eq $expectedPid) {
                [void][CastWindowRestore]::ShowWindow($handle, $restoreCommand)
            }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}
`;
const WINDOW_RESTORE_SCRIPT_BASE64 = Buffer.from(WINDOW_RESTORE_SCRIPT, 'utf16le').toString('base64');

function candidateFfmpegPaths() {
    const root = path.resolve(__dirname, '..', '..');
    return [
        process.env.FFMPEG_PATH,
        path.join(root, 'desktop', 'resources', 'ffmpeg', 'ffmpeg.exe'),
        path.join(root, 'backend', 'vendor', 'ffmpeg', 'ffmpeg.exe'),
        path.join(process.resourcesPath || root, 'ffmpeg', 'ffmpeg.exe'),
        process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    ].filter(Boolean);
}

function runFfmpegCommand(command, args, timeout = 5000) {
    return new Promise(resolve => {
        execFile(command, args, {
            timeout,
            windowsHide: true,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024
        }, (error, stdout = '', stderr = '') => resolve({ error, stdout, stderr }));
    });
}

function runPowerShellEncoded(encodedCommand, { env = {}, timeout = 5000, windowsHide = true } = {}) {
    return new Promise(resolve => {
        const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
        // CREATE_NO_WINDOW 会让跨进程 ShowWindow(SW_SHOW) 失效。恢复窗口时让
        // PowerShell 正常加入当前桌面会话，再用 WindowStyle Hidden 隐藏它自己的控制台。
        if (!windowsHide) args.push('-WindowStyle', 'Hidden');
        args.push('-EncodedCommand', encodedCommand);
        execFile('powershell.exe', args, {
            timeout,
            windowsHide,
            encoding: 'utf8',
            env: { ...process.env, ...env },
            maxBuffer: 1024 * 1024
        }, (error, stdout = '', stderr = '') => resolve({ error, stdout, stderr }));
    });
}

async function restoreSuppressedWindows(records) {
    if (process.platform !== 'win32' || !Array.isArray(records) || !records.length) return;
    const result = await runPowerShellEncoded(WINDOW_RESTORE_SCRIPT_BASE64, {
        timeout: 5000,
        windowsHide: false,
        env: { CAST_WINDOW_RECORDS: records.map(entry => `${entry.handle}|${entry.restoreCommand}|${entry.processId}`).join(';') }
    });
    if (result.error) {
        const detail = String(result.stderr || result.error.message || '').trim().replace(/\s+/g, ' ');
        if (detail) console.warn(`[投屏] 恢复桌面窗口失败：${detail}`);
    }
}

function launchWindowIsolationGuard(captureBounds, { intervalMs = 250, timeout = 12000, onRecord } = {}) {
    if (process.platform !== 'win32' || !captureBounds?.targetHwnd || !captureBounds?.targetPid) {
        return Promise.reject(new Error('Unity 大屏窗口信息不完整，无法启动投屏隔离守护'));
    }
    return new Promise((resolve, reject) => {
        const stopFile = path.join(
            process.env.TEMP || process.env.TMP || path.dirname(process.execPath),
            `heat-treatment-cast-guard-${process.pid}-${crypto.randomBytes(6).toString('hex')}.stop`
        );
        try { fs.unlinkSync(stopFile); } catch (error) { /* 不存在 */ }
        const child = spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden',
            '-EncodedCommand', WINDOW_ISOLATION_SCRIPT_BASE64
        ], {
            windowsHide: false,
            env: {
                ...process.env,
                CAST_TARGET_HWND: String(captureBounds.targetHwnd),
                CAST_TARGET_PID: String(captureBounds.targetPid),
                CAST_CAPTURE_LEFT: String(captureBounds.left),
                CAST_CAPTURE_TOP: String(captureBounds.top),
                CAST_CAPTURE_WIDTH: String(captureBounds.width),
                CAST_CAPTURE_HEIGHT: String(captureBounds.height),
                CAST_GUARD_MODE: '1',
                CAST_GUARD_PARENT_PID: String(process.pid),
                CAST_GUARD_STOP_FILE: stopFile,
                CAST_GUARD_INTERVAL_MS: String(Math.max(100, Number(intervalMs) || 250))
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const guard = {
            child,
            stopFile,
            records: new Map(),
            restored: false,
            ready: false,
            stderr: '',
            exitPromise: null
        };
        let stdoutBuffer = '';
        let settled = false;
        let resolveExit;
        guard.exitPromise = new Promise(exitResolve => { resolveExit = exitResolve; });

        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(readyTimer);
            if (error) reject(error);
            else resolve(guard);
        };
        const handleLine = rawLine => {
            const line = String(rawLine || '').trim();
            if (!line) return;
            if (line.startsWith('HIDDEN|')) {
                const [handle, restoreCommand, processId] = line.slice(7).split('|').map(Number);
                if (Number.isSafeInteger(handle) && handle > 0
                    && Number.isSafeInteger(restoreCommand) && restoreCommand >= 0
                    && Number.isSafeInteger(processId) && processId > 0) {
                    const record = { handle, restoreCommand, processId };
                    guard.records.set(handle, record);
                    onRecord?.(record);
                }
                return;
            }
            if (line.startsWith('READY|')) {
                guard.ready = true;
                finish();
                return;
            }
            if (line === 'RESTORED') guard.restored = true;
        };

        child.stdout.on('data', chunk => {
            stdoutBuffer += chunk.toString('utf8');
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) handleLine(line);
        });
        child.stderr.on('data', chunk => {
            guard.stderr = `${guard.stderr}\n${chunk.toString('utf8')}`.trim().slice(-8000);
        });
        child.once('error', error => finish(new Error(`投屏隔离守护启动失败：${error.message}`)));
        child.once('exit', (code, signal) => {
            if (stdoutBuffer) handleLine(stdoutBuffer);
            try { fs.unlinkSync(stopFile); } catch (error) { /* 守护已清理 */ }
            resolveExit({ code, signal });
            if (!guard.ready) {
                const detail = guard.stderr.replace(/\s+/g, ' ').trim();
                finish(new Error(`投屏隔离守护未能启动${detail ? `：${detail}` : `（代码 ${code ?? 'unknown'}）`}`));
            }
        });
        const readyTimer = setTimeout(() => {
            try { fs.writeFileSync(stopFile, 'stop'); } catch (error) { /* ignore */ }
            finish(new Error('投屏隔离守护启动超时'));
        }, timeout);
    });
}

async function stopWindowIsolationGuard(guard, timeout = 8000) {
    if (!guard?.child) return;
    const child = guard.child;
    if (child.exitCode == null && child.signalCode == null) {
        try { fs.writeFileSync(guard.stopFile, 'stop'); } catch (error) { /* 已退出 */ }
        let timeoutTimer;
        const timeoutPromise = new Promise(resolve => {
            timeoutTimer = setTimeout(() => resolve({ timeout: true }), timeout);
            timeoutTimer.unref?.();
        });
        await Promise.race([guard.exitPromise, timeoutPromise]);
        clearTimeout(timeoutTimer);
    }
    if (!guard.restored && guard.records.size) {
        await restoreSuppressedWindows([...guard.records.values()]);
    }
    if (child.exitCode == null && child.signalCode == null) {
        try { child.kill(); } catch (error) { /* 已退出 */ }
    }
    try { fs.unlinkSync(guard.stopFile); } catch (error) { /* 已清理 */ }
}

function resolveWindowBounds(windowTitle, timeout = 6000) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-EncodedCommand', WINDOW_BOUNDS_SCRIPT_BASE64
        ], {
            timeout,
            windowsHide: true,
            encoding: 'utf8',
            env: { ...process.env, CAST_WINDOW_TITLE: windowTitle },
            maxBuffer: 1024 * 1024
        }, (error, stdout = '', stderr = '') => {
            if (error) {
                const exitCode = Number(error.code);
                if (exitCode === 2) {
                    reject(new Error(`没有找到 Unity 大屏窗口“${windowTitle}”。请先启动原生大屏，再点击投屏`));
                    return;
                }
                if (exitCode === 3) {
                    reject(new Error(`无法读取 Unity 大屏窗口“${windowTitle}”的位置`));
                    return;
                }
                if (exitCode === 4) {
                    reject(new Error(`Unity 大屏窗口“${windowTitle}”当前不在可见桌面范围内`));
                    return;
                }
                const detail = String(stderr || error.message || '').trim().replace(/\s+/g, ' ');
                reject(new Error(detail || `没有找到 Unity 大屏窗口“${windowTitle}”`));
                return;
            }
            const match = String(stdout).trim().match(/^(-?\d+),(-?\d+),(\d+),(\d+),(\d+),(\d+),(\d+)$/);
            if (!match) {
                reject(new Error(`Unity 大屏窗口坐标无效：${String(stdout).trim() || 'empty'}`));
                return;
            }
            resolve({
                left: Number(match[1]),
                top: Number(match[2]),
                width: Number(match[3]),
                height: Number(match[4]),
                chromeHeight: Number(match[5]),
                targetHwnd: Number(match[6]),
                targetPid: Number(match[7]),
                captureMode: 'desktop_client_region'
            });
        });
    });
}

function requestDesktopControl(action, timeout = 2500) {
    const origin = String(process.env.DESKTOP_CONTROL_URL || '').trim();
    const token = String(process.env.DESKTOP_CONTROL_TOKEN || '').trim();
    if (!origin || !token) return Promise.resolve(false);
    return new Promise(resolve => {
        let endpoint;
        try {
            endpoint = new URL(`/${String(action || '').replace(/^\/+/, '')}`, origin);
        } catch (error) {
            resolve(false);
            return;
        }
        const request = http.request(endpoint, {
            method: 'POST',
            headers: { 'x-desktop-control-token': token }
        }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode >= 200 && response.statusCode < 300));
        });
        request.setTimeout(timeout, () => request.destroy());
        request.on('error', () => resolve(false));
        request.end();
    });
}

function requestDashboardView(timeout = 2500) {
    return requestDesktopControl('show-dashboard', timeout);
}

function requestCastPresentation(timeout = 2500) {
    return requestDesktopControl('prepare-cast', timeout);
}

function requestCastRestore(timeout = 2500) {
    return requestDesktopControl('restore-cast', timeout);
}

async function probeFfmpeg(command) {
    const version = await runFfmpegCommand(command, ['-version']);
    if (version.error) {
        return { available: false, executable: false, reason: version.error.message };
    }
    const encoders = await runFfmpegCommand(command, ['-hide_banner', '-encoders']);
    if (encoders.error) {
        return { available: false, executable: true, reason: encoders.error.message };
    }
    const hasMediaFoundationH264 = /\bh264_mf\b/.test(`${encoders.stdout}\n${encoders.stderr}`);
    return {
        available: hasMediaFoundationH264,
        executable: true,
        reason: hasMediaFoundationH264 ? '' : '该 FFmpeg 不包含 Windows Media Foundation h264_mf 编码器',
        version: String(version.stdout || version.stderr).split(/\r?\n/)[0].trim()
    };
}

function buildCaptureInputArgs(options, captureBounds) {
    if (!captureBounds || captureBounds.width < 1 || captureBounds.height < 1) {
        throw new Error('Unity 大屏捕获区域无效');
    }
    return [
        '-thread_queue_size', '512',
        '-f', 'gdigrab', '-framerate', String(options.frameRate), '-draw_mouse', '0',
        '-offset_x', String(captureBounds.left), '-offset_y', String(captureBounds.top),
        '-video_size', `${captureBounds.width}x${captureBounds.height}`,
        '-rtbufsize', '256M', '-i', 'desktop'
    ];
}

function buildEncoderArgs(options, captureBounds) {
    const { frameRate, width, height, bitrateKbps } = options;
    const cropTop = Math.max(0, Math.min(
        Number(captureBounds?.chromeHeight) || 0,
        Math.max(0, Number(captureBounds?.height) - 1)
    ));
    const croppedHeight = Math.max(1, Number(captureBounds?.height) - cropTop);
    const cropFilter = cropTop > 0
        ? `crop=iw:${croppedHeight}:0:${cropTop},`
        : '';
    return [
        '-hide_banner', '-loglevel', 'error',
        ...buildCaptureInputArgs({ frameRate }, captureBounds),
        // 电视对纯视频的 TS 容错参差不齐，补一路静音音轨兼容性最好。
        '-thread_queue_size', '512',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-vf', `${cropFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease,`
            + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=nv12`,
        // h264_mf 使用 Windows 自带 Media Foundation，无独显也可用；不依赖 GPL libx264。
        '-c:v', 'h264_mf', '-rate_control', 'cbr', '-scenario', 'display_remoting',
        // Media Foundation 只接受数字枚举：77 = Main Profile，41 = Level 4.1。
        // 相比默认可能选择的 High Profile，老款电视的硬解兼容性更好。
        '-profile:v', '77', '-level:v', '41',
        '-b:v', `${bitrateKbps}k`, '-maxrate', `${bitrateKbps}k`, '-bufsize', `${Math.round(bitrateKbps / 2)}k`,
        // 每秒一个关键帧，电视中途接入也能尽快出画面；关闭 B 帧降低延迟。
        '-g', String(frameRate), '-bf', '0', '-flags', '+low_delay',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        '-f', 'mpegts', '-mpegts_flags', '+resend_headers',
        '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1',
        'pipe:1'
    ];
}

/** 找出能直连目标电视的那张网卡的地址；多网卡（有线 + WiFi + 虚拟网卡）时很关键。 */
function pickLocalAddressFor(targetIp) {
    const interfaces = listLanIpv4Interfaces();
    if (!interfaces.length) return '';

    if (targetIp) {
        const target = ipv4ToLong(targetIp);
        const sameSubnet = interfaces.find(entry => {
            if (target == null || !entry.netmask) return false;
            const mask = ipv4ToLong(entry.netmask);
            const local = ipv4ToLong(entry.address);
            return mask != null && local != null && (local & mask) === (target & mask);
        });
        if (sameSubnet) return sameSubnet.address;
    }
    const priv = interfaces.find(entry => isPrivateIpv4(entry.address));
    return (priv || interfaces[0]).address;
}

class ScreenCastService {
    constructor({ port = DEFAULT_STREAM_PORT, windowTitle = process.env.CAST_WINDOW_TITLE, onConnected = null, verifyDevice = null } = {}) {
        this.onConnected = onConnected;
        this.verifyDevice = verifyDevice;
        const requested = Number(port);
        // 0 表示交给系统随机分配端口（自测用），不能被当成“没填”而回落到默认值。
        this.port = Number.isInteger(requested) && requested >= 0 && requested <= 65535
            ? requested
            : DEFAULT_STREAM_PORT;
        this.server = null;
        this.ffmpegPath = '';
        this.ffmpegVersion = '';
        this.ffmpegProbeError = '';
        this.ffmpegChecked = false;
        this.ffmpegCheckedAt = 0;
        this.ffmpegProbePromise = null;
        this.windowTitle = String(windowTitle || DEFAULT_WINDOW_TITLE).trim() || DEFAULT_WINDOW_TITLE;
        this.streamToken = '';
        this.session = null;
        this.encoders = new Set();
        this.captureBounds = null;
        this.castPresentationActive = false;
        this.suppressedWindows = [];
        this.windowIsolationGuard = null;
        this.windowIsolationStopping = false;
        this.error = '';
        this.options = {
            frameRate: 20,
            width: 1920,
            height: 1080,
            bitrateKbps: 8000
        };
    }

    async resolveFfmpeg({ force = false } = {}) {
        if (this.ffmpegPath && !force) return this.ffmpegPath;
        // 开发时把 FFmpeg 放进目录后无需重启后端；失败结果只缓存几秒。
        const missingRetryDue = !this.ffmpegPath && Date.now() - this.ffmpegCheckedAt >= 5000;
        if (this.ffmpegChecked && !force && !missingRetryDue) return this.ffmpegPath;
        if (this.ffmpegProbePromise) return this.ffmpegProbePromise;

        this.ffmpegProbePromise = (async () => {
            this.ffmpegPath = '';
            this.ffmpegVersion = '';
            this.ffmpegProbeError = '';
            for (const candidate of new Set(candidateFfmpegPaths())) {
                const isBarePath = path.dirname(candidate) === '.';
                if (!isBarePath && !fs.existsSync(candidate)) continue;
                const probe = await probeFfmpeg(candidate);
                if (probe.available) {
                    this.ffmpegPath = candidate;
                    this.ffmpegVersion = probe.version || '';
                    this.ffmpegProbeError = '';
                    break;
                }
                if (probe.executable && probe.reason) this.ffmpegProbeError = probe.reason;
            }
            if (!this.ffmpegPath && !this.ffmpegProbeError) {
                this.ffmpegProbeError = '没有在程序资源目录或系统 PATH 中找到 ffmpeg';
            }
            this.ffmpegChecked = true;
            this.ffmpegCheckedAt = Date.now();
            return this.ffmpegPath;
        })().finally(() => { this.ffmpegProbePromise = null; });
        return this.ffmpegProbePromise;
    }

    async assertCaptureTarget() {
        if (process.platform !== 'win32') {
            throw new Error('Unity 原生大屏投屏目前只支持 Windows');
        }
        try {
            const dashboardRequested = await requestDashboardView();
            if (dashboardRequested) await new Promise(resolve => setTimeout(resolve, 450));

            // 隐藏 AdminHost 的 46px 顶部页签，并把透明数据层扩展到整个 Unity 客户区。
            // 这样桌面捕获仍能保留 DirectX 场景 + WebView2 数据面板，但不会把软件壳投出去。
            this.castPresentationActive = await requestCastPresentation();
            if (this.castPresentationActive) await new Promise(resolve => setTimeout(resolve, 220));

            this.captureBounds = await resolveWindowBounds(this.windowTitle);
            if (this.castPresentationActive) this.captureBounds.chromeHeight = 0;

            // gdigrab 仍然是桌面捕获，因此把所有会出现在捕获区域上方的顶层窗口
            // 临时隐藏。首次立即执行一次，之后在整个投屏期间持续监测新出现的浮层。
            await this.startWindowIsolationGuard();

            const result = await runFfmpegCommand(this.ffmpegPath, [
                '-hide_banner', '-loglevel', 'error',
                ...buildCaptureInputArgs({ frameRate: 1 }, this.captureBounds),
                '-frames:v', '1', '-f', 'null', 'NUL'
            ], 8000);
            if (!result.error) return;

            const detail = String(result.stderr || result.error.message || '').trim().replace(/\s+/g, ' ');
            throw new Error(`无法读取 Unity 大屏画面“${this.windowTitle}”：${detail || result.error.message}`);
        } catch (error) {
            await this.restoreCapturePresentation();
            throw error;
        }
    }

    mergeSuppressedWindows(records) {
        for (const record of records || []) {
            if (!record) continue;
            const index = this.suppressedWindows.findIndex(existing => existing.handle === record.handle);
            if (index >= 0) this.suppressedWindows[index] = record;
            else this.suppressedWindows.push(record);
        }
    }

    async startWindowIsolationGuard() {
        if (!this.captureBounds) throw new Error('Unity 大屏捕获区域尚未确定');
        if (this.windowIsolationGuard) await this.stopWindowIsolationGuard();
        this.suppressedWindows = [];
        const guard = await launchWindowIsolationGuard(this.captureBounds, {
            intervalMs: 250,
            onRecord: record => this.mergeSuppressedWindows([record])
        });
        this.windowIsolationGuard = guard;
        guard.exitPromise.then(async ({ code, signal }) => {
            if (this.windowIsolationGuard !== guard) return;
            this.windowIsolationGuard = null;
            if (!guard.restored && guard.records.size) {
                await restoreSuppressedWindows([...guard.records.values()]);
            }
            if (this.windowIsolationStopping || (!this.session && !this.castPresentationActive)) return;
            const message = `投屏桌面隔离守护异常退出（${signal || code || 'unknown'}），已停止投屏以避免把其它窗口投到电视`;
            setImmediate(async () => {
                await this.stop().catch(() => {});
                this.error = message;
            });
        }).catch(() => {});
    }

    async stopWindowIsolationGuard() {
        const guard = this.windowIsolationGuard;
        this.windowIsolationGuard = null;
        if (!guard) return;
        this.windowIsolationStopping = true;
        try {
            await stopWindowIsolationGuard(guard);
        } finally {
            this.windowIsolationStopping = false;
        }
    }

    async restoreCapturePresentation() {
        // 先停止隔离守护，再恢复 AdminHost。否则守护在恢复顶栏的瞬间可能
        // 又把刚显示的窗口判定为遮挡并隐藏，造成恢复闪烁或状态不一致。
        await this.stopWindowIsolationGuard();
        if (this.castPresentationActive) {
            await requestCastRestore().catch(() => {});
            this.castPresentationActive = false;
        }
        const records = this.suppressedWindows;
        this.suppressedWindows = [];
        await restoreSuppressedWindows(records);
    }

    async ensureStreamServer() {
        if (this.server) return;
        if (!this.streamToken) this.streamToken = crypto.randomBytes(12).toString('hex');
        const server = http.createServer((req, res) => this.handleStreamRequest(req, res));
        await new Promise((resolve, reject) => {
            const onError = error => { server.off('listening', onListening); reject(error); };
            const onListening = () => { server.off('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(this.port, '0.0.0.0');
        });
        // 电视一路直播会挂很久，别让 Node 的默认超时把它掐了。
        server.timeout = 0;
        server.headersTimeout = 0;
        server.requestTimeout = 0;
        this.server = server;
        // 端口传 0 时以系统实际分配的为准，否则给电视的地址会指向错误端口。
        this.port = server.address().port;
    }

    streamPath() {
        return `/cast/${this.streamToken}/live.ts`;
    }

    streamUrl(deviceAddress) {
        const host = pickLocalAddressFor(deviceAddress);
        if (!host) throw new Error('本机没有可用的局域网 IPv4 地址，无法向电视提供画面');
        return `http://${host}:${this.port}${this.streamPath()}`;
    }

    handleStreamRequest(req, res) {
        const pathname = (req.url || '/').split('?')[0];
        if (pathname !== this.streamPath()) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.statusCode = 405;
            res.setHeader('Allow', 'GET, HEAD');
            res.end('method not allowed');
            return;
        }
        const session = this.session;
        if (!session) {
            res.statusCode = 410;
            res.end('cast session ended');
            return;
        }

        res.setHeader('Content-Type', session.mimeType || 'video/mp2t');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'close');
        // 直播长度未知，明确告诉电视不要试图 seek。
        res.setHeader('transferMode.dlna.org', 'Streaming');
        res.setHeader(
            'contentFeatures.dlna.org',
            'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8D500000000000000000000000000000'
        );
        res.setHeader('Accept-Ranges', 'none');
        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        const encoder = this.spawnEncoder();
        if (!encoder) {
            res.statusCode = 503;
            res.end('encoder unavailable');
            return;
        }

        this.encoders.add(encoder);
        session.viewers += 1;
        session.streamRequests += 1;
        session.state = 'casting';
        session.firstViewerAt ||= Date.now();
        session.lastViewerAt = Date.now();
        session.retryCount = 0;
        session.lastReconnectError = '';
        this.clearPlaybackRetry(session);
        this.error = '';

        const cleanup = () => {
            if (!this.encoders.delete(encoder)) return;
            session.viewers = Math.max(0, session.viewers - 1);
            session.lastViewerAt = Date.now();
            encoder.castExpectedStop = true;
            try { encoder.kill('SIGKILL'); } catch (error) { /* 已退出 */ }
            if (this.session === session && session.viewers === 0) {
                session.state = 'waiting_for_tv';
                this.schedulePlaybackRetry(session, 5000);
            }
        };

        res.flushHeaders?.();
        encoder.stdout.once('data', () => {
            // A successful SOAP response alone does not mean the TV ever received video.
            if (this.session !== session || session.historyRecorded) return;
            session.historyRecorded = true;
            try { this.onConnected?.(session.device); }
            catch (error) { console.warn(`[投屏] 保存设备记录失败：${error.message}`); }
        });
        encoder.stdout.pipe(res);
        encoder.stdout.on('error', cleanup);
        encoder.on('exit', () => { try { res.end(); } catch (error) { /* 已关闭 */ } cleanup(); });
        res.on('close', cleanup);
        res.on('error', cleanup);
    }

    spawnEncoder() {
        if (!this.ffmpegPath || !this.captureBounds) return null;
        const args = buildEncoderArgs(this.options, this.captureBounds);
        const child = spawn(this.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.castExpectedStop = false;
        let latestError = '';
        child.stderr.on('data', chunk => {
            const text = chunk.toString('utf8').trim();
            if (text) {
                latestError = `${latestError}\n${text}`.trim().slice(-4000);
                console.warn(`[投屏编码] ${text}`);
            }
        });
        child.on('error', error => {
            this.error = `屏幕编码进程启动失败：${error.message}`;
            console.error(`[投屏编码] ${this.error}`);
        });
        child.on('exit', code => {
            if (!child.castExpectedStop && code !== 0) {
                const detail = latestError.replace(/\s+/g, ' ').trim();
                this.error = `Unity 大屏画面编码中断${detail ? `：${detail}` : `（代码 ${code}）`}`;
                console.error(`[投屏编码] ${this.error}`);
            }
        });
        return child;
    }

    stopEncoders() {
        for (const encoder of this.encoders) {
            encoder.castExpectedStop = true;
            try { encoder.kill('SIGKILL'); } catch (error) { /* 已退出 */ }
        }
        this.encoders.clear();
    }

    clearPlaybackRetry(session) {
        if (!session?.retryTimer) return;
        clearTimeout(session.retryTimer);
        session.retryTimer = null;
    }

    schedulePlaybackRetry(session, delayMs = 12000) {
        if (!session || this.session !== session || session.viewers > 0 || session.retryTimer) return;
        session.retryTimer = setTimeout(() => {
            session.retryTimer = null;
            this.retryPlayback(session).catch(error => {
                console.warn(`[投屏] 自动重连异常：${error.message}`);
            });
        }, delayMs);
        session.retryTimer.unref?.();
    }

    async retryPlayback(session) {
        if (this.session !== session || session.viewers > 0) return;
        if (session.retryCount >= 2) {
            session.state = 'waiting_for_tv';
            if (!session.firstViewerAt) {
                this.error = '电视已收到投屏控制命令，但没有连接视频流。请检查电视是否允许外部媒体播放，以及 Windows 防火墙是否允许本程序访问局域网。';
            }
            return;
        }

        session.retryCount += 1;
        session.state = 'reconnecting';
        try {
            const device = this.verifyDevice ? await this.verifyDevice(session.device) : session.device;
            if (this.session !== session || session.viewers > 0) return;
            if (!device) throw new Error('电视地址或设备标识已变化，请重新连接');
            session.device = device;
            const playback = await dlna.startPlayback(device, {
                url: session.url,
                title: STREAM_TITLE,
                mimeType: session.mimeType
            });
            if (this.session !== session) return;
            session.metadataMode = playback.metadataMode;
            session.lastReconnectError = '';
            session.state = session.viewers > 0 ? 'casting' : 'waiting_for_tv';
            if (session.viewers === 0) this.schedulePlaybackRetry(session, 15000);
        } catch (error) {
            if (this.session !== session) return;
            session.lastReconnectError = error.message;
            session.state = 'reconnect_failed';
            this.error = `电视连接中断，自动重连失败：${error.message}`;
            this.schedulePlaybackRetry(session, 15000);
        }
    }

    async start(device) {
        if (!device?.avTransportUrl) throw new Error('该设备没有提供 AVTransport 控制地址，无法投屏');
        const ffmpeg = await this.resolveFfmpeg();
        if (!ffmpeg) {
            throw new Error(
                '内置 FFmpeg 投屏编码器未就绪，无法把 Unity 大屏转换成电视能播放的视频流。'
                + (this.ffmpegProbeError ? ` ${this.ffmpegProbeError}。` : '')
                + '开发环境请在 desktop 目录运行 npm run prepare:ffmpeg 后重启后端。'
            );
        }
        if (this.session) await this.stop().catch(() => {});
        await this.assertCaptureTarget();
        try {
            await this.ensureStreamServer();
            this.streamToken = crypto.randomBytes(12).toString('hex');

            const url = this.streamUrl(device.address);
            let sinkProtocols = [];
            try {
                sinkProtocols = await dlna.getSinkProtocolInfo(device);
            } catch (error) {
                // ConnectionManager 并非所有电视都完整实现；读取失败时使用通用类型继续。
            }
            const mimeType = dlna.chooseVideoMimeType(sinkProtocols);
            this.error = '';
            const session = {
                device,
                deviceId: device.id,
                deviceName: device.name,
                deviceAddress: device.address,
                url,
                mimeType,
                sinkProtocols,
                metadataMode: 'full',
                state: 'starting',
                startedAt: Date.now(),
                viewers: 0,
                streamRequests: 0,
                retryCount: 0,
                retryTimer: null,
                firstViewerAt: 0,
                lastViewerAt: 0,
                lastReconnectError: ''
            };
            // Play 调用返回前电视就可能开始 GET，先登记临时会话，避免把合法请求当成过期流。
            this.session = session;
            try {
                const playback = await dlna.startPlayback(device, { url, title: STREAM_TITLE, mimeType });
                session.metadataMode = playback.metadataMode;
            } catch (error) {
                if (this.session === session) this.session = null;
                this.stopEncoders();
                await this.restoreCapturePresentation();
                this.error = error.message;
                throw error;
            }
            session.state = session.viewers > 0 ? 'casting' : 'waiting_for_tv';
            this.schedulePlaybackRetry(session);
            console.log(`[投屏] 已推送到电视「${device.name}」(${device.address})：${url}`);
            return this.status();
        } catch (error) {
            await this.restoreCapturePresentation();
            throw error;
        }
    }

    async stop() {
        const session = this.session;
        this.session = null;
        this.clearPlaybackRetry(session);
        this.stopEncoders();
        if (session?.device) {
            // 电视可能已经关机或换了输入源，停不下来不算失败。
            try {
                const device = this.verifyDevice ? await this.verifyDevice(session.device) : session.device;
                if (device) await dlna.stopPlayback(device);
            } catch (error) { /* 忽略 */ }
            console.log(`[投屏] 已停止推送到「${session.deviceName}」`);
        }
        await this.restoreCapturePresentation();
        this.error = '';
        return this.status();
    }

    async close() {
        await this.stop();
        const server = this.server;
        this.server = null;
        this.streamToken = '';
        if (!server) return;
        await new Promise(resolve => {
            try { server.close(() => resolve()); } catch (error) { resolve(); }
        });
    }

    status() {
        return {
            ffmpegChecked: this.ffmpegChecked,
            ffmpegChecking: Boolean(this.ffmpegProbePromise),
            ffmpegAvailable: Boolean(this.ffmpegPath),
            ffmpegPath: this.ffmpegPath,
            ffmpegVersion: this.ffmpegVersion,
            ffmpegError: this.ffmpegProbeError,
            encoder: 'h264_mf',
            captureMode: 'desktop_client_region_presentation',
            captureWindowTitle: this.windowTitle,
            captureBounds: this.captureBounds,
            castPresentationActive: this.castPresentationActive,
            windowIsolationGuardActive: Boolean(this.windowIsolationGuard),
            suppressedWindows: this.suppressedWindows.length,
            streamPort: this.port,
            casting: Boolean(this.session),
            session: this.session
                ? {
                    deviceId: this.session.deviceId,
                    deviceName: this.session.deviceName,
                    deviceAddress: this.session.deviceAddress,
                    url: this.session.url,
                    mimeType: this.session.mimeType,
                    metadataMode: this.session.metadataMode,
                    state: this.session.state,
                    startedAt: new Date(this.session.startedAt).toISOString(),
                    viewers: this.session.viewers,
                    streamRequests: this.session.streamRequests,
                    retryCount: this.session.retryCount,
                    firstViewerAt: this.session.firstViewerAt ? new Date(this.session.firstViewerAt).toISOString() : '',
                    lastViewerAt: this.session.lastViewerAt ? new Date(this.session.lastViewerAt).toISOString() : '',
                    lastReconnectError: this.session.lastReconnectError
                }
                : null,
            error: this.error
        };
    }
}

module.exports = ScreenCastService;
module.exports.pickLocalAddressFor = pickLocalAddressFor;
module.exports.buildEncoderArgs = buildEncoderArgs;
module.exports.buildCaptureInputArgs = buildCaptureInputArgs;
module.exports.resolveWindowBounds = resolveWindowBounds;
module.exports.DEFAULT_WINDOW_TITLE = DEFAULT_WINDOW_TITLE;
