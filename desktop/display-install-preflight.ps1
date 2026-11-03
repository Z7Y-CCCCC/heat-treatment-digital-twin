param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
try {
    if (Get-Process -Name '热处理数字孪生大屏','HeatTreatmentDigitalTwin','HeatTreatmentAdminHost' -ErrorAction SilentlyContinue) {
        throw '请保存编辑并退出大屏和后台管理后再安装；采集服务不会被停止。'
    }
    $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
    $service = Get-CimInstance Win32_Service -Filter "Name='HeatTreatmentCollector'" -ErrorAction Stop
    if ($service -and $service.PathName.TrimStart('"').StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {
        throw '检测到旧版内置采集服务。请先安装独立采集插件完成迁移，再升级大屏；未停止采集或修改数据。'
    }
    $file = Join-Path $env:ProgramData 'HeatTreatmentDigitalTwin\collector-service.json'
    if (Test-Path -LiteralPath $file) {
        $config = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$config.resourcesRoot -and ([IO.Path]::GetFullPath($config.resourcesRoot) + '\').StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {
            throw '旧采集服务仍引用此大屏目录，请先迁移到独立采集插件；本次安装已取消。'
        }
    }
    exit 0
} catch { [Console]::WriteLine($_.Exception.Message); exit 1 }
