param([Parameter(Mandatory=$true)][string]$ControlFile)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AuditIo {
    [StructLayout(LayoutKind.Sequential)] public struct Counters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetProcessIoCounters(IntPtr handle, out Counters counters);
}
'@
while (Test-Path -LiteralPath $ControlFile) {
    $taskControl=Get-Content -LiteralPath $ControlFile -Raw | ConvertFrom-Json
    if ($taskControl.stop) { break }
    $taskInventory=@(Get-CimInstance Win32_Process)
    $taskIds=[System.Collections.Generic.HashSet[int]]::new()
    foreach($taskRoot in $taskControl.roots) { [void]$taskIds.Add([int]$taskRoot) }
    do {
        $taskAdded=$false
        foreach($taskEntry in $taskInventory) {
            if($taskIds.Contains([int]$taskEntry.ParentProcessId) -and $taskIds.Add([int]$taskEntry.ProcessId)) { $taskAdded=$true }
        }
    } while($taskAdded)
    $taskRows=@(foreach($taskId in $taskIds) {
        try {
            $taskProcess=Get-Process -Id $taskId -ErrorAction Stop
            $taskIo=[AuditIo+Counters]::new()
            if(-not [AuditIo]::GetProcessIoCounters($taskProcess.Handle,[ref]$taskIo)) { throw 'I/O counters unavailable' }
            @{pid=$taskId;name=$taskProcess.ProcessName;cpuSeconds=$taskProcess.TotalProcessorTime.TotalSeconds;
              rss=$taskProcess.WorkingSet64;privateBytes=$taskProcess.PrivateMemorySize64;
              ioReadBytes=$taskIo.ReadBytes;ioWriteBytes=$taskIo.WriteBytes;ioWriteOperations=$taskIo.WriteOperations}
        } catch { @{pid=$taskId;error=$_.Exception.Message} }
    })
    @{timestamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();logicalProcessors=[Environment]::ProcessorCount;processes=$taskRows} | ConvertTo-Json -Depth 4 -Compress
    Start-Sleep -Seconds 5
}
