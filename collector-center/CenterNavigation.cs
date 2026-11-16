using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace HeatTreatmentCollectorCenter
{
    // Navigation only: neither pipe commands nor CLI views can control a
    // service, provide an endpoint, execute a command or change configuration.
    internal static class CenterNavigation
    {
        internal static bool IsView(string view) { return view == "points" || view == "overview"; }
        internal static int TabIndex(string view) { if (!IsView(view)) throw new ArgumentException("Unknown center view"); return view == "points" ? 1 : 3; }
        internal static string Caption(string view) { return view == "points" ? "设备采集 · 点位" : view == "overview" ? "数据服务 · API / 数据库" : "数据采集"; }
        static string TestSuffix(string testDirectory)
        {
            if (testDirectory == null) return "";
            using (var hash = SHA256.Create()) return "-fixture-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(testDirectory)))).Replace("-", "").Substring(0,24);
        }
        static string WorkspaceSuffix()
        {
            if(Environment.GetEnvironmentVariable("DIGITAL_TWIN_WORKSPACE_CENTER")!="1")return "";
            using(var hash=SHA256.Create())return "-workspace-"+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(System.Reflection.Assembly.GetExecutingAssembly().Location.ToUpperInvariant()))).Replace("-", "").Substring(0,24);
        }
        internal static string PipeName(string testDirectory = null) { return "HeatTreatmentCollectorCenter-" + WindowsIdentity.GetCurrent().User.Value + WorkspaceSuffix() + TestSuffix(testDirectory); }
        internal static string MutexName(string testDirectory = null) { return "Local\\HeatTreatmentCollectorCenter-" + Environment.UserName + WorkspaceSuffix() + TestSuffix(testDirectory); }
        internal static PipeSecurity CurrentUserSecurity()
        {
            var user = WindowsIdentity.GetCurrent().User;
            var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(user);
            security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow)); return security;
        }
        internal static bool OpenView(string view, string fixtureDirectory = null)
        {
            if (!IsView(view)) return false;
            bool exists;
            try { using (Mutex.OpenExisting(MutexName(fixtureDirectory))) exists = true; } catch (WaitHandleCannotBeOpenedException) { exists = false; }
            if (!exists)
            {
                string arguments = fixtureDirectory == null ? "--view " + view : "--navigation-smoke-test \"" + Path.GetFullPath(fixtureDirectory) + "\"";
                // The GUI is an independent, long-lived application. Starting
                // it with CreateProcess/UseShellExecute=false inherits the short
                // helper's redirected stdout: Node then sees exit(0)+marker but
                // cannot see close until the GUI shuts down, causing a false
                // timeout. ShellExecute starts only this fixed executable with
                // a whitelisted view (no shell command or elevation verb).
                var info = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, arguments)
                    { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Normal };
                using (Process.Start(info)) { }
            }
            return Send(PipeName(fixtureDirectory), view);
        }
        internal static bool Send(string pipeName, string view) { return IsView(view) && SendAsync(pipeName, view).GetAwaiter().GetResult(); }
        static async Task<bool> SendAsync(string pipeName, string view)
        {
            var deadline = DateTime.UtcNow.AddSeconds(8);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
                    using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3)))
                    {
                        pipe.Connect(500);
                        byte[] command = Encoding.ASCII.GetBytes(view + "\n"); await pipe.WriteAsync(command, 0, command.Length, timeout.Token);
                        return await ReadLine(pipe, timeout.Token) == view;
                    }
                }
                catch (IOException) { } catch (TimeoutException) { } catch (OperationCanceledException) { }
                await Task.Delay(100);
            }
            return false;
        }
        internal static async Task<string> ReadLine(Stream stream, CancellationToken token)
        {
            var bytes = new byte[1]; var text = new StringBuilder();
            while (text.Length <= 32)
            {
                if (await stream.ReadAsync(bytes, 0, 1, token) != 1) return "";
                if (bytes[0] == 10) return text.ToString();
                if (bytes[0] < 32 || bytes[0] > 126) return "";
                text.Append((char)bytes[0]);
            }
            return "";
        }
    }

    internal sealed class CenterNavigationServer : IDisposable
    {
        readonly CenterForm form; readonly string name; readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        NamedPipeServerStream current; bool started;
        internal CenterNavigationServer(CenterForm form, string name) { this.form = form; this.name = name; }
        internal void Start() { if (started) return; started = true; Task.Run((Func<Task>)Listen); }
        async Task Listen()
        {
            while (!cancellation.IsCancellationRequested)
            {
                try
                {
                    using (var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous, 4096, 4096, CenterNavigation.CurrentUserSecurity()))
                    {
                        current = pipe; await pipe.WaitForConnectionAsync(cancellation.Token);
                        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token))
                        {
                            timeout.CancelAfter(TimeSpan.FromSeconds(3));
                            string view = await CenterNavigation.ReadLine(pipe, timeout.Token), result = "unconfirmed";
                            if (CenterNavigation.IsView(view))
                            {
                                var selection = form.SelectNavigationViewAsync(view);
                                if (await Task.WhenAny(selection, Task.Delay(2500, timeout.Token)) == selection) result = await selection;
                            }
                            byte[] reply = Encoding.ASCII.GetBytes(result + "\n"); await pipe.WriteAsync(reply, 0, reply.Length, timeout.Token);
                        }
                    }
                }
                catch (OperationCanceledException) { } catch (ObjectDisposedException) { } catch (IOException) { }
                finally { current = null; }
                if (!cancellation.IsCancellationRequested) await Task.Delay(20);
            }
        }
        public void Dispose() { cancellation.Cancel(); try { if (current != null) current.Dispose(); } catch { } }
    }
}
