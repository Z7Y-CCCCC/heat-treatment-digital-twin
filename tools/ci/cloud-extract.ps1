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
    # Use the built-in ZIP API: GNU tar misreads Windows drive letters, and
    # external tar versions/command-line encodings differ across Windows images.
    # The API accepts Unicode paths directly and rejects archive path traversal.
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $destinationPath)
    } catch {
        throw 'Verified cloud archive extraction failed'
    }
}
