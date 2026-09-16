using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatmentAdminHost;
using Newtonsoft.Json.Linq;

internal static class Program
{
    private static async Task Main()
    {
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("cancelled send cannot release another owner's semaphore", CancelledSendKeepsLock),
            ("stale queued send cannot move to a replacement session", QueuedSendKeepsSession),
            ("old cancelled connection loop cannot dispose its replacement", RestartKeepsNewSocket),
            ("old connection state messages cannot overwrite a new session", StaleStateIsIgnored),
            ("model timeout cancels its in-flight loopback HTTP download", ModelDownloadRespectsCancellation),
            ("WebView native bridge and navigation require exact app origin", CheckWebOrigins)
        };
        foreach (var test in tests)
        {
            await test.Run();
            Console.WriteLine($"PASS: {test.Name}");
        }
        Console.WriteLine($"Passed {tests.Length}/{tests.Length} isolated native runtime checks.");
    }

    private static FieldInfo Field(string name) => typeof(RealtimeWebSocketClient)
        .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)
        ?? throw new InvalidOperationException($"Missing runtime field {name}");
    private static object Invoke(RealtimeWebSocketClient client, string name, params object[] args) =>
        typeof(RealtimeWebSocketClient).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)
            ?.Invoke(client, args) ?? throw new InvalidOperationException($"Missing runtime method {name}");
    private static void InvokeVoid(RealtimeWebSocketClient client, string name, params object[] args) =>
        typeof(RealtimeWebSocketClient).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(client, args);
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static async Task CancelledSendKeepsLock()
    {
        using var sockets = await SocketPair.Open();
        using var lifetime = new CancellationTokenSource();
        var client = new RealtimeWebSocketClient();
        Field("_socket").SetValue(client, sockets.Client);
        Field("_lifetime").SetValue(client, lifetime);
        var sendLock = (SemaphoreSlim)Field("_sendLock").GetValue(client)!;
        await sendLock.WaitAsync();
        try
        {
            var sending = (Task)Invoke(client, "SendMessageAsync", new JObject { ["type"] = "test" });
            lifetime.Cancel();
            await sending.WaitAsync(TimeSpan.FromSeconds(5));
            Check(sendLock.CurrentCount == 0, "Cancelled waiter released the lock held by a different sender.");
        }
        finally
        {
            if (sendLock.CurrentCount == 0) sendLock.Release();
            client.StopClient();
        }
    }

    private static async Task QueuedSendKeepsSession()
    {
        using var first = await SocketPair.Open();
        using var replacement = await SocketPair.Open();
        using var lifetime = new CancellationTokenSource();
        var client = new RealtimeWebSocketClient();
        Field("_socket").SetValue(client, first.Client);
        Field("_lifetime").SetValue(client, lifetime);
        var sendLock = (SemaphoreSlim)Field("_sendLock").GetValue(client)!;
        await sendLock.WaitAsync();
        var sending = (Task)Invoke(client, "SendMessageAsync", new JObject { ["type"] = "old-session-message" });
        Field("_socket").SetValue(client, replacement.Client);
        sendLock.Release();
        await sending.WaitAsync(TimeSpan.FromSeconds(5));
        using var timeout = new CancellationTokenSource(150);
        try
        {
            await replacement.Server.ReceiveAsync(new ArraySegment<byte>(new byte[1024]), timeout.Token);
            throw new InvalidOperationException("An old queued message leaked into the replacement socket.");
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested) { }
        finally { client.StopClient(); }
    }

    private static Task RestartKeepsNewSocket()
    {
        // TCP accepts the connections but deliberately never answers the HTTP
        // upgrade. This leaves ConnectAsync pending without any external server.
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endpoint = $"ws://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/";
        var previousContext = SynchronizationContext.Current;
        var context = new QueuedContext();
        var client = new RealtimeWebSocketClient();
        SynchronizationContext.SetSynchronizationContext(context);
        try
        {
            client.StartClient(endpoint, 1);
            var oldSocket = Field("_socket").GetValue(client);
            client.StartClient(endpoint, 1);
            var replacement = Field("_socket").GetValue(client);
            Check(replacement != null && !ReferenceEquals(oldSocket, replacement), "Replacement was not created.");
            Check(SpinWait.SpinUntil(() => context.HasPending, 5000), "Cancelled connect did not finish.");
            context.Drain();
            Check(ReferenceEquals(Field("_socket").GetValue(client), replacement), "Old finally cleared the new socket.");
            var state = ((ClientWebSocket)replacement).State;
            Check(state != WebSocketState.Closed && state != WebSocketState.Aborted, "Old finally disposed the new socket.");
        }
        finally
        {
            client.StopClient();
            SpinWait.SpinUntil(() => context.HasPending, 5000);
            context.Drain();
            SynchronizationContext.SetSynchronizationContext(previousContext);
        }
        return Task.CompletedTask;
    }

    private static Task StaleStateIsIgnored()
    {
        var client = new RealtimeWebSocketClient();
        var states = new List<string>();
        client.ConnectionStateChanged += states.Add;
        client.StopClient();
        InvokeVoid(client, "QueueState", "stopped", 0);
        InvokeVoid(client, "QueueState", "connected", 1);
        InvokeVoid(client, "Update");
        Check(states.SequenceEqual(new[] { "connected" }), "Stale state escaped generation filtering.");
        return Task.CompletedTask;
    }

    private static Task CheckWebOrigins()
    {
        const string app = "http://127.0.0.1:3001/admin?embedded=unity";
        Check(WebContentPolicy.IsSameOrigin("http://127.0.0.1:3001/native-overlay", app), "App navigation was rejected.");
        foreach (var candidate in new[] {
            "http://127.0.0.1:30010/admin", "http://127.0.0.1:3001.evil.test/admin",
            "http://127.0.0.1:3001@evil.test/", "http://evil.test/", "file:///C:/test.html",
            "javascript:alert(1)", "https://127.0.0.1:3001/admin", "not a url"
        }) Check(!WebContentPolicy.IsSameOrigin(candidate, app), $"Unexpected trusted origin: {candidate}");
        return Task.CompletedTask;
    }

    private static async Task ModelDownloadRespectsCancellation()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var cancellation = new CancellationTokenSource();
        var provider = new LoopbackDownloadProvider(cancellation.Token);
        var request = provider.Request(new Uri($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/model.glb"));
        cancellation.CancelAfter(50);
        try
        {
            using var result = await request.WaitAsync(TimeSpan.FromSeconds(5));
            throw new InvalidOperationException("Cancellation was swallowed as a cached download failure.");
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }

    private sealed class QueuedContext : SynchronizationContext
    {
        private readonly ConcurrentQueue<(SendOrPostCallback Callback, object State)> _queue = new();
        public bool HasPending => !_queue.IsEmpty;
        public override void Post(SendOrPostCallback callback, object state) => _queue.Enqueue((callback, state));
        public void Drain()
        {
            while (_queue.TryDequeue(out var work)) work.Callback(work.State);
        }
    }

    private sealed class SocketPair : IDisposable
    {
        private readonly HttpListener _listener;
        public ClientWebSocket Client { get; }
        public WebSocket Server { get; }
        private SocketPair(HttpListener listener, ClientWebSocket client, WebSocket server)
            => (_listener, Client, Server) = (listener, client, server);
        public static async Task<SocketPair> Open()
        {
            using var reservation = new TcpListener(IPAddress.Loopback, 0);
            reservation.Start();
            var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
            reservation.Stop();
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            var client = new ClientWebSocket();
            client.Options.Proxy = null;
            try
            {
                listener.Start();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var connecting = client.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/"), timeout.Token);
                var request = await listener.GetContextAsync().WaitAsync(timeout.Token);
                var accepted = await request.AcceptWebSocketAsync(null).WaitAsync(timeout.Token);
                await connecting;
                return new SocketPair(listener, client, accepted.WebSocket);
            }
            catch
            {
                client.Dispose();
                listener.Close();
                throw;
            }
        }
        public void Dispose()
        {
            Client.Dispose();
            Server.Dispose();
            _listener.Close();
        }
    }
}
