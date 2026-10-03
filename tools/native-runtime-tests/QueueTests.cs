using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using HeatTreatment.DigitalTwin.Backend;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static async Task ReceiveDoesNotWaitForRender()
    {
        using var sockets = await SocketPair.Open();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var client = new RealtimeWebSocketClient();
        var renderContext = new QueuedContext();
        var previous = SynchronizationContext.Current;
        Task receiving;
        SynchronizationContext.SetSynchronizationContext(renderContext);
        try { receiving = (Task)Invoke(client, "ReceiveLoopAsync", sockets.Client, timeout.Token, 0); }
        finally { SynchronizationContext.SetSynchronizationContext(previous); }
        var queue = (RealtimeMessageQueue)Field("_messages").GetValue(client)!;
        try
        {
            // Simulate a busy render frame without running its posted callbacks.
            await SendFrame(sockets.Server, Patch("a", "x", 1), timeout.Token);
            await Until(() => queue.Count > 0 || renderContext.HasPending, timeout.Token);
            Check(queue.Count > 0 && !renderContext.HasPending, "Network receive waits for a Unity render-frame callback.");
            Check(queue.TryDequeue(0, out var received) && received["payload"]["devices"][0]["analog"].Value<int>("x") == 1,
                "Realtime payload did not reach the bounded main-thread handoff queue.");
        }
        finally
        {
            timeout.Cancel();
            renderContext.Drain();
            try { await receiving; } catch (OperationCanceledException) { }
            client.StopClient();
        }
    }

    private static JObject Patch(string id, string field, int value, string quality = "good") => new JObject {
        ["type"] = "realtime_frame", ["payload"] = new JObject { ["devices"] = new JArray(new JObject {
            ["furnace_id"] = id, ["analog"] = new JObject { [field] = value },
            ["quality"] = new JObject { ["analog"] = new JObject { [field] = quality } }
        }) }
    };
    private static Task InboundQueuePreservesOrder()
    {
        var queue = new RealtimeMessageQueue();
        queue.Reset(1);
        foreach (var frame in new[] { Patch("a", "x", 1), Patch("b", "y", 2), Patch("a", "z", 3) })
            Check(queue.TryEnqueue(1, frame), "Valid patch was rejected.");
        Check(queue.Count == 1, "Independent PLC patches did not merge.");
        queue.TryEnqueue(1, new JObject { ["type"] = "configuration_changed" });
        queue.TryEnqueue(1, Patch("a", "x", 0, "bad"));
        queue.TryEnqueue(1, Patch("b", "y", 4));
        queue.TryEnqueue(1, Patch("a", "x", 5));
        var received = new List<JObject>();
        while (queue.TryDequeue(1, out var item)) received.Add(item);
        Check(received.Select(m => m.Value<string>("type")).SequenceEqual(new[] {
            "realtime_frame", "configuration_changed", "realtime_frame", "realtime_frame"
        }), "Controls or quality faults were merged away or reordered.");
        var devices = (JArray)received[0]["payload"]["devices"];
        Check(devices.Count == 2 && devices[0]["analog"].Value<int>("x") == 1 && devices[0]["analog"].Value<int>("z") == 3,
            "Multi-task device patch fields were lost.");
        Check(received[2]["payload"]["devices"][0]["quality"]["analog"].Value<string>("x") == "bad", "Fault was overwritten.");
        Check(queue.Bytes == 0, "Dequeue leaked accounted bytes.");
        return Task.CompletedTask;
    }
    private static Task InboundQueueLimits()
    {
        var queue = new RealtimeMessageQueue(maxBytes: 200, maxMessages: 2);
        queue.Reset(1);
        var control = new JObject { ["type"] = "control" };
        Check(queue.TryEnqueue(1, control) && queue.TryEnqueue(1, control), "Queue rejected messages below limit.");
        Check(!queue.TryEnqueue(1, control), "Count ceiling was ignored.");
        queue.Reset(2);
        Check(queue.Count == 0 && queue.Bytes == 0, "New generation retained old messages.");
        Check(queue.TryEnqueue(1, control) && queue.Count == 0, "Obsolete producer contaminated new session.");
        Check(!queue.TryEnqueue(2, new JObject { ["type"] = "control", ["data"] = new string('中', 100) }), "UTF-8 byte ceiling was ignored.");
        Check(queue.TryEnqueue(2, control), "Rejected message consumed budget.");
        queue.Clear(1);
        Check(queue.Count == 1 && !queue.TryDequeue(1, out _), "Stale consumer cleared/read new session.");
        queue.Clear(2);
        Check(queue.Count == 0 && queue.Bytes == 0, "Clear leaked accounting.");
        return Task.CompletedTask;
    }
    private static async Task SendFrame(WebSocket socket, JObject message, CancellationToken token)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToString(Formatting.None));
        await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, token);
    }
    private static async Task QueuedSendSnapshotsMessage()
    {
        using var sockets = await SocketPair.Open();
        using var lifetime = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var client = new RealtimeWebSocketClient();
        Field("_socket").SetValue(client, sockets.Client);
        Field("_lifetime").SetValue(client, lifetime);
        var sendLock = (SemaphoreSlim)Field("_sendLock").GetValue(client)!;
        await sendLock.WaitAsync(lifetime.Token);
        var message = new JObject { ["type"] = "dashboard_context", ["payload"] = new JObject { ["partId"] = "before" } };
        var sending = (Task)Invoke(client, "SendMessageAsync", message, false);
        message["payload"]["partId"] = "after";
        sendLock.Release();
        try
        {
            await sending.WaitAsync(lifetime.Token);
            var bytes = new byte[1024];
            var result = await sockets.Server.ReceiveAsync(new ArraySegment<byte>(bytes), lifetime.Token);
            var received = JObject.Parse(Encoding.UTF8.GetString(bytes, 0, result.Count));
            Check(received["payload"].Value<string>("partId") == "before", "Later publication rewrote queued JSON.");
        }
        finally { client.StopClient(); }
    }
    private static async Task InboundFragmentsAreBounded()
    {
        using var sockets = await SocketPair.Open();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var client = new RealtimeWebSocketClient();
        var receiving = (Task)Invoke(client, "ReceiveLoopAsync", sockets.Client, timeout.Token, 0);
        var wire = Encoding.UTF8.GetBytes(Patch("a", "x", 9).ToString(Formatting.None));
        await sockets.Server.SendAsync(new ArraySegment<byte>(wire, 0, 15), WebSocketMessageType.Text, false, timeout.Token);
        await sockets.Server.SendAsync(new ArraySegment<byte>(wire, 15, wire.Length - 15), WebSocketMessageType.Text, true, timeout.Token);
        var queue = (RealtimeMessageQueue)Field("_messages").GetValue(client)!;
        await Until(() => queue.Count == 1, timeout.Token);
        Check(queue.TryDequeue(0, out var message) && message["payload"]["devices"][0]["analog"].Value<int>("x") == 9,
            "Text fragments were not reassembled.");
        var fragment = new byte[64 * 1024];
        for (var i = 0; i <= RealtimeMessageQueue.MaxMessageBytes / fragment.Length; i++)
            await sockets.Server.SendAsync(new ArraySegment<byte>(fragment), WebSocketMessageType.Text, false, timeout.Token);
        try { await receiving.WaitAsync(timeout.Token); throw new InvalidOperationException("Oversized fragmented message was accepted."); }
        catch (InvalidDataException error) { Check(error.Message.Contains("4 MiB"), "Unexpected receive failure: " + error.Message); }
        Check(queue.Count == 0 && queue.Bytes == 0, "Oversized message entered the queue.");
        client.StopClient();
    }
    private static async Task Until(Func<bool> predicate, CancellationToken token)
    { while (!predicate()) await Task.Delay(10, token); }
    private static async Task InboundOverflowResyncs()
    {
        using var reservation = new TcpListener(IPAddress.Loopback, 0);
        reservation.Start();
        var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
        reservation.Stop();
        using var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var client = new RealtimeWebSocketClient();
        try
        {
            var accepting = listener.GetContextAsync();
            client.StartClient($"ws://127.0.0.1:{port}/", .5f);
            var firstRequest = await accepting.WaitAsync(timeout.Token);
            using var first = (await firstRequest.AcceptWebSocketAsync(null)).WebSocket;
            var secondAccept = listener.GetContextAsync();
            for (var i = 0; i < 260; i++)
            {
                try { await SendFrame(first, new JObject { ["type"] = "configuration_changed", ["order"] = i }, timeout.Token); }
                catch (WebSocketException) { break; } // overflow may close TCP while the fixture is still sending
            }
            var secondRequest = await secondAccept.WaitAsync(timeout.Token);
            using var second = (await secondRequest.AcceptWebSocketAsync(null)).WebSocket;
            await SendFrame(second, new JObject { ["type"] = "after_reconnect" }, timeout.Token);
            var queue = (RealtimeMessageQueue)Field("_messages").GetValue(client)!;
            await Until(() => queue.Count >= 4, timeout.Token); // connecting, connected, resync, marker
            var received = new List<JObject>();
            client.MessageReceived += received.Add;
            InvokeVoid(client, "Update");
            Check(received.Select(m => m.Value<string>("type")).SequenceEqual(new[] { "dashboard_release_changed", "after_reconnect" }),
                "Reconnect did not replace stale backlog with authoritative resync before fresh messages.");
            Check(received[0]["payload"].Value<string>("reason") == "websocket_reconnect_resync", "Resync reason is missing.");
            Check(queue.Bytes == 0, "Reconnect/dequeue retained byte budget.");
        }
        finally { client.StopClient(); }
    }
}
