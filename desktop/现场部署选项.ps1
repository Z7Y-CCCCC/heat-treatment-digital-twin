[CmdletBinding()]
param(
    [string]$InstallRoot = $PSScriptRoot,
    [switch]$ApplyPowerPolicy,
    [switch]$RestorePowerPolicy
)
$ErrorActionPreference = 'Stop'
$machineRoot = Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin'
$policyFile = Join-Path $machineRoot 'power-policy.json'
$service = Get-Service HeatTreatmentCollector -ErrorAction SilentlyContinue
Write-Host "采集服务：$($service.Status)"
& "$env:SystemRoot\System32\powercfg.exe" /getactivescheme
Write-Host '默认只检查，不修改 Windows Update、自动登录、键盘拦截或电源设置。'
if ($ApplyPowerPolicy -and $RestorePowerPolicy) { throw '应用与恢复不能同时选择。' }
if (-not $ApplyPowerPolicy -and -not $RestorePowerPolicy) { exit 0 }
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '应用或恢复现场电源计划需要管理员权限。'
}
function Invoke-Power([string[]]$Arguments) {
    $result = & "$env:SystemRoot\System32\powercfg.exe" @Arguments
    if ($LASTEXITCODE -ne 0) { throw "电源配置失败：$($Arguments -join ' ')；未宣称全部应用成功。" }
    return ($result -join "`n")
}
if ($RestorePowerPolicy) {
    $stored = Get-Content -LiteralPath $policyFile -Raw -Encoding UTF8 | ConvertFrom-Json
    Invoke-Power @('/setactive', [string]$stored.originalGuid) | Out-Null
    Write-Host '已恢复原电源计划。现场专用计划保留，不删除其他系统配置。'
    exit 0
}
New-Item -ItemType Directory -Force -Path $machineRoot | Out-Null
if (Test-Path -LiteralPath $policyFile) {
    $stored = Get-Content -LiteralPath $policyFile -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    $active = Invoke-Power @('/getactivescheme')
    $originalGuid = [regex]::Match($active, '[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}').Value
    if (-not $originalGuid) { throw '无法确定当前电源计划，未修改。' }
    $backupFile = Join-Path $machineRoot 'original-power-plan.pow'
    Invoke-Power @('/export', $backupFile, $originalGuid) | Out-Null
    $duplicate = Invoke-Power @('/duplicatescheme', $originalGuid)
    $guid = [regex]::Match($duplicate, '[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}').Value
    if (-not $guid) { throw '无法确定新电源计划，未激活任何新计划。' }
    $stored = @{ originalGuid = $originalGuid; fieldGuid = $guid; backup = $backupFile }
    [IO.File]::WriteAllText($policyFile, ($stored | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
$targetGuid = [string]$stored.fieldGuid
Invoke-Power @('/changename', $targetGuid, 'Heat Treatment Field') | Out-Null
# Change only a cloned plan, AC/mains power only. Battery safety remains intact.
foreach ($setting in @(
    @('SUB_SLEEP', 'STANDBYIDLE', '0'), @('SUB_SLEEP', 'HIBERNATEIDLE', '0'),
    @('SUB_VIDEO', 'VIDEOIDLE', '0'), @('SUB_DISK', 'DISKIDLE', '0'),
    @('SUB_PCIEXPRESS', 'ASPM', '0'),
    @('2a737441-1930-4402-8d77-b2bebba308a3', '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', '0')
)) { Invoke-Power @('/setacvalueindex', $targetGuid, $setting[0], $setting[1], $setting[2]) | Out-Null }
Invoke-Power @('/setactive', $targetGuid) | Out-Null
Write-Host "已启用现场专用电源计划；原计划备份：$($stored.backup)。"
Write-Host '恢复命令：现场部署选项.ps1 -RestorePowerPolicy。不会禁用更新或存储登录密码。'
