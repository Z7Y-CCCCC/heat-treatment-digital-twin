using System.IO;
using System.Text;

namespace HeatTreatmentAdminHost;

internal static class NativeSessionCommandTransport
{
    internal static async Task SendAsync(Stream pipe, string message, CancellationToken cancellation)
    {
        // PipeStream is unbuffered: a completed write already delivered the line.
        // A StreamWriter flushes again during DisposeAsync; Unity may have closed
        // the pipe by then. Treating that disposal failure as a send failure
        // replayed the same single-use login ticket and revoked a valid login.
        await pipe.WriteAsync(Encoding.UTF8.GetBytes(message + "\n"), cancellation);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        using var receipt = new StreamReader(pipe, Encoding.UTF8, false, 1024, leaveOpen: true);
        try { await receipt.ReadLineAsync(timeout.Token); }
        catch (IOException) { /* The peer may close immediately after reading. Do not replay a delivered ticket. */ }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { /* Delivery is complete; only receipt timed out. */ }
    }
}
