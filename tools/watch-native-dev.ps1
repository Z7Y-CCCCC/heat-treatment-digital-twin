[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$UnityPid,
    [Parameter(Mandatory)][long]$UnityStartTicks,
    [int]$BackendPid = 0,
    [long]$BackendStartTicks = 0,
    [int]$FrontendPid = 0,
    [long]$FrontendStartTicks = 0,
    [string]$BackendUrl = 'http://127.0.0.1:3001'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Test-OwnedProcess([int]$ProcessId, [long]$StartTicks) {
    if ($ProcessId -le 0 -or $StartTicks -le 0) { return $false }
    try {
        $candidate = Get-Process -Id $ProcessId -ErrorAction Stop
        return -not $candidate.HasExited -and $candidate.StartTime.ToUniversalTime().Ticks -eq $StartTicks
    } catch {
        return $false
    }
}

while (Test-OwnedProcess $UnityPid $UnityStartTicks) {
    Start-Sleep -Milliseconds 1500
}

Write-Output "[$(Get-Date -Format o)] Unity 已退出；清理本次开发启动器创建的服务。"

if (Test-OwnedProcess $FrontendPid $FrontendStartTicks) {
    try {
        Stop-Process -Id $FrontendPid -ErrorAction Stop
        Write-Output "[$(Get-Date -Format o)] 已停止本次启动的 Vite：PID $FrontendPid"
    } catch {
        Write-Warning "Vite 停止失败：$($_.Exception.Message)"
    }
}

if (Test-OwnedProcess $BackendPid $BackendStartTicks) {
    $shutdownToken = [Environment]::GetEnvironmentVariable('DIGITAL_TWIN_DEV_SHUTDOWN_TOKEN', 'Process')
    if ([string]::IsNullOrWhiteSpace($shutdownToken)) {
        Write-Warning '本次后端缺少安全退出令牌，保留后端进程以免绕过退出备份。'
        exit 1
    }
    try {
        $response = Invoke-WebRequest -Uri "$($BackendUrl.TrimEnd('/'))/api/internal/shutdown" `
            -Method Post -Headers @{ 'x-shutdown-token' = $shutdownToken } -TimeoutSec 4
        if ([int]$response.StatusCode -ne 202) { throw "HTTP $($response.StatusCode)" }
        Write-Output "[$(Get-Date -Format o)] 后端已接受安全退出与备份请求：PID $BackendPid"
    } catch {
        Write-Warning "后端安全退出请求失败，未强制结束以免跳过备份：$($_.Exception.Message)"
        exit 1
    }
    $deadline = (Get-Date).AddSeconds(16)
    while ((Test-OwnedProcess $BackendPid $BackendStartTicks) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (Test-OwnedProcess $BackendPid $BackendStartTicks) {
        Write-Warning '后端超过 16 秒仍未退出；已保留进程和备份状态，需检查后端日志。'
        exit 1
    }
    Write-Output "[$(Get-Date -Format o)] 后端已安全退出：PID $BackendPid"
}
