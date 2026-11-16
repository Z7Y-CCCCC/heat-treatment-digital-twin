using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("采集运行中心")]
[assembly: System.Reflection.AssemblyVersion("2.3.2.0")]
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
            if (args.Length == 2 && args[0] == "--status-json") { File.WriteAllText(args[1],Ops.Serialize(Ops.Status().GetAwaiter().GetResult())); return 0; }
            if (args.Length == 3 && args[0] == "--health-api-test") return SelfTests.HealthApi(args[1],args[2]);
            if (args.Length == 3 && args[0] == "--point-api-test") return SelfTests.PointApi(args[1],args[2]);
            if (args.Length == 2 && args[0] == "--open-view") return ConfirmView(CenterNavigation.OpenView(args[1]), args[1]);
            if (args.Length == 3 && args[0] == "--navigation-smoke-select")
                return ConfirmView(CenterNavigation.Send(CenterNavigation.PipeName(args[1]), args[2]), args[2]);
            if (args.Length == 3 && args[0] == "--navigation-smoke-open")
                return ConfirmView(CenterNavigation.OpenView(args[2], args[1]), args[2]);
            bool smoke = args.Length == 2 && args[0] == "--smoke-test";
            bool navigationSmoke = args.Length == 2 && args[0] == "--navigation-smoke-test";
            string view = args.Length == 2 && args[0] == "--view" && CenterNavigation.IsView(args[1]) ? args[1] : null;
            if (args.Length != 0 && !smoke && !navigationSmoke && view == null) return 2;
            string fixtureDirectory = smoke || navigationSmoke ? args[1] : null;
            bool created;
            using (var mutex = new Mutex(true, CenterNavigation.MutexName(fixtureDirectory), out created))
            {
                if (!created && !smoke && !navigationSmoke)
                {
                    if (view != null) return ConfirmView(CenterNavigation.Send(CenterNavigation.PipeName(), view), view);
                    var handle=FindWindow(null,"采集运行中心"); ShowWindow(handle,9); SetForegroundWindow(handle); return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    using (var form = new CenterForm(fixtureDirectory, navigationSmoke ? "overview" : view, navigationSmoke))
                    using (var navigation = new CenterNavigationServer(form, CenterNavigation.PipeName(fixtureDirectory)))
                    {
                        form.Shown += (s,e) => navigation.Start(); Application.Run(form); return 0;
                    }
                }
                catch (Exception error) { MessageBox.Show(error.Message,"采集运行中心",MessageBoxButtons.OK,MessageBoxIcon.Error); return 1; }
            }
        }
        static int ConfirmView(bool confirmed, string view)
        {
            if (!confirmed || !CenterNavigation.IsView(view)) return 1;
            Console.WriteLine("COLLECTOR_CENTER_VIEW:" + view); Console.Out.Flush(); return 0;
        }
    }
}
