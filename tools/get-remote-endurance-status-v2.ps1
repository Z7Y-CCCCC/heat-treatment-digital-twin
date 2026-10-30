[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$TestRoot,[switch]$PersistObservation)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. (Join-Path $PSScriptRoot 'remote-endurance-common-v2.ps1')
$status=Get-RemoteObservedStatus $TestRoot
if ($PersistObservation) {
    Write-RemoteJson (Join-Path $status.root 'observed-status.json') $status
    if ($status.state -eq 'interrupted') {
        $file=Join-Path $status.root 'run-interrupted.json'
        if (!(Test-Path -LiteralPath $file)) { Write-RemoteJson $file $status -CreateNew }
    }
}
$status | ConvertTo-Json -Depth 30
if ($status.state -in @('interrupted','failed','incomplete','invalid-completion','unresponsive')) { exit 1 }
exit 0
