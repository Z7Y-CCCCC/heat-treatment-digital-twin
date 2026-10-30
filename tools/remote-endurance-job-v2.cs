using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Only processes launched suspended by this object enter the job. Closing the
// job cannot select or terminate pre-existing Node, MySQL, SCM or IIS processes.
public sealed class DapingOwnedJobV2 : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int size; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedSize;
        public IntPtr reservedPointer, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public int processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long processTime, jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readCount,writeCount,otherCount,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long userTime,kernelTime,periodUserTime,periodKernelTime; public uint pageFaults,totalProcesses,activeProcesses,terminatedProcesses; }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string filename,uint access,uint share,ref SecurityAttributes attributes,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder commandLine,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint flags);
    IntPtr job;
    public DapingOwnedJobV2() {
        job=CreateJobObject(IntPtr.Zero,null); if (job==IntPtr.Zero) throw new Win32Exception();
        var limits=new ExtendedLimit(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway flag.
        if (!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimit)))) { int e=Marshal.GetLastWin32Error(); Dispose(); throw new Win32Exception(e); }
    }
    public uint ActiveProcesses {
        get { Accounting info; if (!QueryInformationJobObject(job,1,out info,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Win32Exception(); return info.activeProcesses; }
    }
    public Process Start(string executable,string arguments,string directory,string stdout,string stderr) {
        var security=new SecurityAttributes(); security.length=Marshal.SizeOf(typeof(SecurityAttributes)); security.inherit=1;
        IntPtr output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero;
        var process=new ProcessInformation(); bool resumed=false;
        try {
            output=CreateFile(stdout,0x40000000,1,ref security,1,0x80,IntPtr.Zero); if (output==new IntPtr(-1)) throw new Win32Exception();
            error=CreateFile(stderr,0x40000000,1,ref security,1,0x80,IntPtr.Zero); if (error==new IntPtr(-1)) throw new Win32Exception();
            input=CreateFile("NUL",0x80000000,3,ref security,3,0x80,IntPtr.Zero); if (input==new IntPtr(-1)) throw new Win32Exception();
            var startup=new StartupInfo(); startup.size=Marshal.SizeOf(typeof(StartupInfo)); startup.flags=0x100; startup.input=input; startup.output=output; startup.error=error;
            var command=new StringBuilder("\""+executable+"\" "+arguments);
            if (!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,directory,ref startup,out process)) throw new Win32Exception();
            if (!AssignProcessToJobObject(job,process.process)) throw new Win32Exception();
            if (ResumeThread(process.thread)==0xffffffff) throw new Win32Exception();
            resumed=true;
            return Process.GetProcessById(process.processId);
        } finally {
            if (!resumed && process.process!=IntPtr.Zero) TerminateProcess(process.process,91);
            if (process.thread!=IntPtr.Zero) CloseHandle(process.thread);
            if (process.process!=IntPtr.Zero) CloseHandle(process.process);
            foreach(var handle in new[]{output,error,input}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
        }
    }
    public void Dispose() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } }
}
