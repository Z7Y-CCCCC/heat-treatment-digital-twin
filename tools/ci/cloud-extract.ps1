function Expand-VerifiedCloudArchive {
    param(
        [Parameter(Mandatory=$true)][string]$Archive,
        [Parameter(Mandatory=$true)][string]$Destination,
        [Parameter(Mandatory=$true)][ValidateRange(1, [long]::MaxValue)][long]$ExpectedSize,
        [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256
    )
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
        -not $env:RUNNER_TEMP -or -not [IO.Path]::IsPathRooted($env:RUNNER_TEMP)) {
        throw 'Cloud archive extraction requires an isolated hosted runner'
    }
    $root = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
    if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\', '/')) { throw 'Unsafe runner temporary directory' }
    $archivePath = [IO.Path]::GetFullPath($Archive)
    $destinationPath = [IO.Path]::GetFullPath($Destination)
    foreach ($target in @($archivePath, $destinationPath)) {
        if (-not [IO.Path]::IsPathRooted($target) -or
            -not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Cloud archive paths must remain inside RUNNER_TEMP'
        }
        for ($ancestor = $target; $ancestor.StartsWith($root, [StringComparison]::OrdinalIgnoreCase); $ancestor = Split-Path -Parent $ancestor) {
            if ((Test-Path -LiteralPath $ancestor) -and
                ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Cloud archive paths must not use linked ancestors'
            }
            if ($ancestor -eq $root) { break }
        }
    }
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf) -or
        (Get-Item -LiteralPath $archivePath).Length -ne $ExpectedSize -or
        (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedSha256) {
        throw 'Cloud archive must match the pinned byte size and SHA-256 before extraction'
    }
    if ((Test-Path -LiteralPath $destinationPath) -and
        (-not (Test-Path -LiteralPath $destinationPath -PathType Container) -or
            @(Get-ChildItem -LiteralPath $destinationPath -Force).Count -ne 0)) {
        throw 'Cloud archive destination must be new or empty; existing files are never overwritten'
    }
    # PATH may resolve tar.exe to Git/MSYS GNU tar, which treats D:\... as a
    # remote host. Always use the Windows native ZIP-capable bsdtar explicitly.
    $tar = Join-Path ([Environment]::SystemDirectory) 'tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw 'Windows native archive tool is missing' }
    $forbidden = [char[]]@([char]0, [char]10, [char]13, [char]34)
    if ($archivePath.IndexOfAny($forbidden) -ge 0 -or $destinationPath.IndexOfAny($forbidden) -ge 0) { throw 'Unsafe native archive argument' }
    New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
    $arguments = @('-xf', ('"' + $archivePath + '"'), '-C', ('"' + $destinationPath + '"'))
    $process = Start-Process -FilePath $tar -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'Verified cloud archive extraction failed' }
}
