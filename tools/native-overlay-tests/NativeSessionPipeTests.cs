using System.IO;
using System.IO.Pipes;
using System.Text;
using HeatTreatmentAdminHost;

internal static class NativeSessionPipeTests
{
    internal static async Task Run(Action<bool, string> check)
    {
        // Deterministic reproduction of the old writer's second flush after EOF.
        var legacy = new CloseAfterReadStream();
        var failed = false;
        try
        {
            await using var writer = new StreamWriter(legacy, new UTF8Encoding(false), 1024, leaveOpen: true);
            await writer.WriteLineAsync("one-time-ticket");
            await writer.FlushAsync();
            using var receipt = new StreamReader(legacy, Encoding.UTF8, false, 1024, leaveOpen: true);
            await receipt.ReadLineAsync();
        }
        catch (IOException) { failed = true; }
        check(failed && legacy.Writes == 1, "Old transport reproduced a post-delivery disposal error");

        var current = new CloseAfterReadStream();
        await NativeSessionCommandTransport.SendAsync(current, "one-time-ticket", CancellationToken.None);
        check(current.Writes == 1 && current.Flushes == 0, "Delivered session command is not flushed/replayed after Unity closes");

        var brokenReceipt = new CloseAfterReadStream { FailRead = true };
        await NativeSessionCommandTransport.SendAsync(brokenReceipt, "one-time-ticket", CancellationToken.None);
        check(brokenReceipt.Writes == 1, "A broken receipt cannot replay a delivered ticket");

        var pipeName = $"DigitalTwinOwnedSessionTest_{Environment.ProcessId}_{Guid.NewGuid():N}";
        using var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        string? received = null;
        var reading = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync(cancellation.Token);
            using var reader = new StreamReader(server, Encoding.UTF8, false, 1024, leaveOpen: true);
            received = await reader.ReadLineAsync(cancellation.Token);
            server.Disconnect();
        });
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(cancellation.Token);
        await NativeSessionCommandTransport.SendAsync(client, "owned-ticket", cancellation.Token);
        await reading;
        check(received == "owned-ticket", "Real named-pipe peer can read and immediately close without a false send failure");
    }

    private sealed class CloseAfterReadStream : Stream
    {
        private bool closed;
        internal int Writes, Flushes;
        internal bool FailRead;
        public override bool CanRead => true;
        public override bool CanWrite => true;
        public override bool CanSeek => false;
        public override long Length => 0;
        public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) { closed = true; if (FailRead) throw new IOException("Peer closed"); return 0; }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { try { return ValueTask.FromResult(Read(Array.Empty<byte>(), 0, 0)); } catch (Exception error) { return ValueTask.FromException<int>(error); } }
        public override void Write(byte[] buffer, int offset, int count) { if (closed) throw new IOException("Peer closed"); Writes++; }
        public override void Flush() { Flushes++; if (closed) throw new IOException("Peer closed"); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
