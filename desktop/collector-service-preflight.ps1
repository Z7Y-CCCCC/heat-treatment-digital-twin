$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    try { $service = Get-Service -Name 'HeatTreatmentCollector' -ErrorAction Stop }
    catch {
        if ($_.FullyQualifiedErrorId -like 'NoServiceFoundForGivenName*') { [Console]::WriteLine('NOT_INSTALLED'); exit 0 }
        throw
    }
    if ($service.Status -ne [ServiceProcess.ServiceControllerStatus]::Stopped) {
        $service.Stop()
        $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(60))
    }
    [Console]::WriteLine('STOPPED'); exit 0
} catch {
    [Console]::WriteLine($_.Exception.Message); exit 1
}
