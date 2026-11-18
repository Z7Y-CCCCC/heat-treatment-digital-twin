function Save-ResumableCloudDownload {
    param(
        [Parameter(Mandatory=$true)][string]$Partial,
        [Parameter(Mandatory=$true)][string]$Url,
        [Parameter(Mandatory=$true)][ValidateRange(1, [long]::MaxValue)][long]$Size,
        [ValidateRange(1, 10)][int]$MaxAttempts = 6,
        [ValidateRange(1, 900)][int]$MaxTimeSeconds = 600
    )
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP -or -not [IO.Path]::IsPathRooted($env:RUNNER_TEMP)) {
        throw 'Resumable cloud downloads require the isolated hosted runner environment'
    }
    $root = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/')
    $target = [IO.Path]::GetFullPath($Partial)
    if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\', '/') -or
        -not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        -not $target.EndsWith('.partial', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Resumable download target must remain inside RUNNER_TEMP'
    }
    $forbidden = [char[]]@([char]0, [char]10, [char]13, [char]34)
    if ($target.IndexOfAny($forbidden) -ge 0 -or $Url.IndexOfAny($forbidden) -ge 0) { throw 'Unsafe native download argument' }
    # Use the Windows native tool, not PATH shims or operator curlrc files.
    # Explicitly wait for the hidden child and read its actual exit code.
    $curl = Join-Path ([Environment]::SystemDirectory) 'curl.exe'
    if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) { throw 'Windows native curl is missing' }
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $before = if (Test-Path -LiteralPath $target) { (Get-Item -LiteralPath $target).Length } else { 0 }
        if ($before -gt $Size) { throw 'Cloud prerequisite download exceeds the pinned byte size' }
        if ($before -eq $Size) { return }
        Write-Host "Official prerequisite download attempt $attempt/$MaxAttempts, resume at $before/$Size bytes."
        $arguments = @('--disable','--fail','--location','--silent','--show-error',
            '--connect-timeout','30','--max-time',([string]$MaxTimeSeconds),'--continue-at','-',
            '--output',('"' + $target + '"'),('"' + $Url + '"'))
        $process = Start-Process -FilePath $curl -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
        $exit = $process.ExitCode
        $after = if (Test-Path -LiteralPath $target) { (Get-Item -LiteralPath $target).Length } else { 0 }
        if ($after -gt $Size) { throw 'Cloud prerequisite download exceeds the pinned byte size' }
        if ($exit -eq 0 -and $after -eq $Size) { return }
        # curl refuses an ignored/mismatched HTTP Range rather than appending
        # a second full response. Never delete partial bytes to hide that error.
        if ($exit -in @(33, 36)) { throw 'Official prerequisite server refused a safe resumable transfer' }
        if ($attempt -eq $MaxAttempts) { throw 'Official cloud prerequisite download failed after bounded resumable attempts' }
        Write-Warning "Transfer interrupted (curl $exit), retained $after/$Size bytes; resuming without trusting incomplete content."
        Start-Sleep -Seconds ([Math]::Min(2 * $attempt, 10))
    }
}
