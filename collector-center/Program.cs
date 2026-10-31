using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("采集运行中心")]
[assembly: System.Reflection.AssemblyVersion("2.3.0.0")]
namespace HeatTreatmentCollectorCenter
{
    internal static class Program
    {
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--self-test") return SelfTests.Run(args[1]);
            if (args.Length == 3 && args[0] == "--point-api-test") return SelfTests.PointApi(args[1],args[2]);
            bool smoke = args.Length == 2 && args[0] == "--smoke-test";
            bool created;
            using (var mutex = new Mutex(true, "Local\\HeatTreatmentCollectorCenter-" + Environment.UserName, out created))
            {
                if (!created && !smoke) { var handle=FindWindow(null,"采集运行中心"); ShowWindow(handle,9); SetForegroundWindow(handle); return 0; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try { Application.Run(new CenterForm(smoke ? args[1] : null)); return 0; }
                catch (Exception error) { MessageBox.Show(error.Message,"采集运行中心",MessageBoxButtons.OK,MessageBoxIcon.Error); return 1; }
            }
        }
    }
}
