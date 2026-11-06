using System.Diagnostics;
using System.Drawing.Imaging;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using HeatTreatmentAdminHost;

// Exercises only dialogs created by this process; never touches the live app.
internal static class Program
{
    [DllImport("user32.dll")] private static extern int GetGuiResources(IntPtr process, uint flag);
    private static readonly List<string> Checks = [];
    private static void Check(bool value, string name)
    {
        if (!value) throw new InvalidOperationException(name);
        Checks.Add(name);
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        var directory = Path.GetFullPath(args[0]);
        if (!directory.Contains(Path.DirectorySeparatorChar + "output" + Path.DirectorySeparatorChar))
            throw new InvalidOperationException("Owned output directory required");
        Directory.CreateDirectory(directory);
        // Production has already painted the main WinForms/WebView host before
        // opening this dialog. Separate framework cold-start from dialog latency.
        var hostClock = Stopwatch.StartNew();
        using var host = new Form { ShowInTaskbar = false, Size = new Size(32, 32) };
        host.Show(); host.Update(); Application.DoEvents(); host.Hide();
        var frameworkFirstPaintMilliseconds = hostClock.Elapsed.TotalMilliseconds;
        var samples = new List<double>();
        using (var dark = new CloseChoiceDialog("dark"))
        {
            dark.Show(); dark.Update(); Application.DoEvents();
            Check(dark.BackColor == Color.FromArgb(40, 41, 43), "Previous dark native dialog remains available");
            using var image = new Bitmap(dark.Width, dark.Height);
            dark.DrawToBitmap(image, dark.ClientRectangle);
            image.Save(Path.Combine(directory, "close-dialog-dark.png"), ImageFormat.Png);
            dark.Close();
        }
        for (var i = 0; i < 12; i++)
        {
            var clock = Stopwatch.StartNew();
            using var dialog = new CloseChoiceDialog();
            dialog.Show();
            dialog.Update();
            Application.DoEvents();
            samples.Add(clock.Elapsed.TotalMilliseconds);
            Check(dialog.BackColor == Color.FromArgb(245, 247, 251), $"Blue-white native dialog {i + 1}");
            if (i == 0)
            {
                using var image = new Bitmap(dialog.Width, dialog.Height);
                dialog.DrawToBitmap(image, dialog.ClientRectangle);
                image.Save(Path.Combine(directory, "close-dialog.png"), ImageFormat.Png);
            }
            dialog.Close();
        }

        using (var dialog = new CloseChoiceDialog())
        {
            dialog.Show(); Application.DoEvents();
            var card = Descendants(dialog).Single(c => c.AccessibleName == "最小化到系统托盘");
            var clicks = 0; card.Click += (_, _) => clicks++;
            Mouse(card, false, 12, 12); // release without a press
            Check(clicks == 0 && dialog.Visible, "A stray release cannot close the dialog");
            Mouse(card, true, 12, 12); Mouse(card, false, -10, -10);
            Check(clicks == 0 && dialog.Visible, "Dragging off the card cancels the choice");
            Mouse(card, true, 12, 12); Mouse(card, false, 12, 12);
            Check(clicks == 1 && dialog.Choice == CloseChoice.MinimizeToTray, "A genuine click dispatches exactly once");
        }
        using (var dialog = new CloseChoiceDialog())
        {
            dialog.Show(); Application.DoEvents();
            var exit = Descendants(dialog).Single(c => c.AccessibleName == "完全退出程序");
            Mouse(exit, true, 12, 12); Mouse(exit, false, 12, 12);
            Check(dialog.Choice == CloseChoice.ExitApplication, "Exit keeps the existing safe-shutdown choice");
        }
        using (var dialog = new CloseChoiceDialog())
        {
            dialog.Show(); Application.DoEvents();
            typeof(Control).GetMethod("OnKeyDown", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(dialog, [new KeyEventArgs(Keys.Escape)]);
            Check(dialog.Choice == CloseChoice.Cancel && !dialog.Visible, "Escape cancels without exiting");
        }
        using (var dialog = new CloseChoiceDialog())
        {
            // The same native controls must still fit at increased scaling.
            dialog.MaximumSize = Size.Empty; dialog.MinimumSize = Size.Empty;
            dialog.Scale(new SizeF(1.5f, 1.5f));
            dialog.Show(); Application.DoEvents();
            foreach (var card in Descendants(dialog).Where(c => c.AccessibleRole == AccessibleRole.PushButton))
                Check(card.Width > 240 && card.Height >= 65, "Scaled choice remains comfortably clickable");
            using var image = new Bitmap(dialog.Width, dialog.Height);
            dialog.DrawToBitmap(image, dialog.ClientRectangle);
            image.Save(Path.Combine(directory, "close-dialog-150.png"), ImageFormat.Png);
            dialog.Close();
        }

        var gdiBefore = GetGuiResources(Process.GetCurrentProcess().Handle, 0);
        for (var i = 0; i < 40; i++)
        {
            using var dialog = new CloseChoiceDialog();
            dialog.Show(); dialog.Update(); dialog.Close();
        }
        Application.DoEvents(); GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        var gdiAfter = GetGuiResources(Process.GetCurrentProcess().Handle, 0);
        Check(gdiAfter <= gdiBefore + 8, "Repeated open/close does not leak GDI handles");
        Check(samples.Skip(1).Order().ElementAt(5) < 250, "Warm dialog first paint stays below 250ms");
        var result = new { success = true, checks = Checks, frameworkFirstPaintMilliseconds, firstPaintMilliseconds = samples,
            warmMedianMilliseconds = samples.Skip(1).Order().ElementAt(5), gdiBefore, gdiAfter };
        File.WriteAllText(Path.Combine(directory, "native-result.json"), JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine(JsonSerializer.Serialize(result));
    }
    private static IEnumerable<Control> Descendants(Control parent) => parent.Controls.Cast<Control>()
        .SelectMany(child => new[] { child }.Concat(Descendants(child)));
    private static void Mouse(Control control, bool down, int x, int y) => NativeMethods.SendMessage(
        control.Handle, down ? 0x0201u : 0x0202u, down ? new IntPtr(1) : IntPtr.Zero, NativeMethods.PackScreenPoint(x, y));
}
