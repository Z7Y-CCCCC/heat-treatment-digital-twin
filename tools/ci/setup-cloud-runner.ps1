param([switch]$CheckOnly, [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'Cloud setup is restricted to disposable GitHub-hosted Windows x64 runners. It never provisions the operator computer.'
}
$workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
if ($temp -eq [IO.Path]::GetPathRoot($temp).TrimEnd('\', '/')) { throw 'Unsafe runner temporary directory' }
function Resolve-ContainedPath([string]$Relative) {
    $full = [IO.Path]::GetFullPath((Join-Path $temp $Relative))
    if (-not $full.StartsWith($temp + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cloud resource path escapes RUNNER_TEMP' }
    return $full
}
$runtimeCheck = & node (Join-Path $workspace 'tools/ci/cloud-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Cloud runtime source verification failed' }
$config = Get-Content -LiteralPath (Join-Path $workspace 'tools/ci/cloud-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$cloud = Resolve-ContainedPath 'cloud-release-v1'
$unity = Resolve-ContainedPath 'cloud-release-v1/unity/Editor/Unity.exe'
$mysql = Resolve-ContainedPath "cloud-release-v1/mysql/mysql-$($config.mysql.version)-winx64"
$publicKey = [IO.Path]::GetFullPath((Join-Path $workspace $config.publicKey.file))
if (-not $publicKey.StartsWith($workspace.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Public key escapes the source checkout' }
function Assert-UnityInstaller([string]$File) {
    if ((Get-Item -LiteralPath $File).Length -ne $config.unity.size) { throw 'Unity installer download is truncated or changed' }
    $signature = Get-AuthenticodeSignature -LiteralPath $File
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $config.unity.signerThumbprint) {
        throw 'Unity installer must have a valid timestamped signature from the pinned official publisher'
    }
}
function Download-Verified([string]$Name, [string]$Url, [string]$Sha256, [long]$Size) {
    $file = Resolve-ContainedPath "cloud-release-v1/downloads/$Name"
    if (Test-Path -LiteralPath $file) { throw 'Refusing to reuse an unverified installer download' }
    $partial = Resolve-ContainedPath "cloud-release-v1/downloads/$Name.partial"
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    try {
        & curl.exe --fail --location --silent --show-error --retry 3 --retry-delay 2 --output $partial $Url
        if ($LASTEXITCODE -ne 0) { throw 'Official cloud prerequisite download failed' }
        if ((Get-Item -LiteralPath $partial).Length -ne $Size) { throw 'Official cloud prerequisite download size mismatch' }
        if ($Sha256 -and (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) { throw 'Cloud prerequisite SHA-256 mismatch' }
        if (-not $Sha256) { Assert-UnityInstaller $partial }
        # Both literal paths were resolved and bounded to this runner's temp.
        Move-Item -LiteralPath $partial -Destination $file
        return $file
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}
if (-not $CheckOnly) {
    if (-not $PrepareOnly) {
        & node (Join-Path $workspace 'tools/ci/cloud-runtime.cjs') --require-license
        if ($LASTEXITCODE -ne 0) { throw 'Authorized Unity license must be configured before downloading build tools' }
    }
    if (-not (Test-Path -LiteralPath $unity -PathType Leaf)) {
        $installer = Download-Verified 'unity-editor.exe' $config.unity.url '' $config.unity.size
        $unityDirectory = Resolve-ContainedPath 'cloud-release-v1/unity'
        try {
            $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$unityDirectory") -WindowStyle Hidden -Wait -PassThru
            if ($process.ExitCode -ne 0) { throw 'Official Unity editor installation failed' }
        } finally { Remove-Item -LiteralPath $installer -Force }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $mysql 'bin/mysqld.exe') -PathType Leaf)) {
        $archive = Download-Verified 'mysql.zip' $config.mysql.url $config.mysql.sha256 $config.mysql.size
        $mysqlDirectory = Resolve-ContainedPath 'cloud-release-v1/mysql'
        New-Item -ItemType Directory -Path $mysqlDirectory -Force | Out-Null
        try { & tar.exe -xf $archive -C $mysqlDirectory; if ($LASTEXITCODE -ne 0) { throw 'MySQL runtime extraction failed' } }
        finally { Remove-Item -LiteralPath $archive -Force }
    }
}
if (-not (Test-Path -LiteralPath $unity -PathType Leaf)) { throw 'Cloud Unity editor is missing' }
$actual = (Get-Item -LiteralPath $unity).VersionInfo.ProductVersion
if (($actual -split '_')[0] -ne $config.unity.version) { throw 'Cloud Unity editor version differs from project' }
foreach ($name in @('bin/mysqld.exe','bin/mysql.exe','bin/mysqladmin.exe','bin/mysqldump.exe','LICENSE','README','lib','share')) {
    if (-not (Test-Path -LiteralPath (Join-Path $mysql $name))) { throw "Cloud MySQL runtime is incomplete: $name" }
}
if (-not $CheckOnly -and -not $PrepareOnly) {
    $license = Resolve-ContainedPath 'cloud-release-v1/private/Unity.ulf'
    $log = Resolve-ContainedPath 'cloud-release-v1/private/activation.log'
    New-Item -ItemType Directory -Path (Split-Path -Parent $license) -Force | Out-Null
    try {
        [IO.File]::WriteAllText($license, $env:UNITY_LICENSE, (New-Object System.Text.UTF8Encoding($false)))
        $process = Start-Process -FilePath $unity -ArgumentList @('-batchmode','-nographics','-quit','-manualLicenseFile',('"' + $license + '"'),'-logFile',('"' + $log + '"')) -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw 'Unity rejected the supplied authorized license. Activation logs stay private in runner temp and are never published.' }
    } finally {
        if (Test-Path -LiteralPath $license) { Remove-Item -LiteralPath $license -Force }
        [Environment]::SetEnvironmentVariable('UNITY_LICENSE', $null, 'Process')
    }
}
if ($CheckOnly) { Write-Host 'Cloud build prerequisites verified; no packaging or license changes performed.'; return }
foreach ($entry in @("UNITY_EDITOR_PATH=$unity", "DESKTOP_MYSQL_RUNTIME_SOURCE=$mysql", "LICENSE_ISSUER_PUBLIC_KEY_FILE=$publicKey")) {
    $entry | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
}
Write-Host "Cloud prerequisites ready: Unity $($config.unity.version), MySQL $($config.mysql.version), approved public key only."
