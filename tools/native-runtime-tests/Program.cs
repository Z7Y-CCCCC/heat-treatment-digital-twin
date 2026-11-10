using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatmentAdminHost;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static async Task Main()
    {
        var tests = new (string Name, Func<Task> Run)[]
        {
            ("bidirectional native transfer fork, hook and cargo match all shared Three cycle traces",TransferCycleMatchesSharedTraces),
            ("transfer BOOL observations require owned typed sources and preserve bad/old/stale barriers",TransferBoolObservationsAreOwnedAndOrdered),
            ("native loading uses the shared light/dark choice and preserves malformed setting failures", LoadingThemesMatch),
            ("motion signals freeze on stale, invalid or wrong point identity; interpolation follows authored coordinates", MotionSignalsAreSafe),
            ("numeric feedback renders each source segment with a bounded delay and no stacked full-span slew", FeedbackSmoothingFollowsSourceSegments),
            ("feedback delay accounts for original source age and never predicts a missing sample", FeedbackSmoothingUsesSourceAge),
            ("repeated and old source times do not invent interpolation samples or renew freshness", FeedbackSmoothingRejectsInventedTime),
            ("invalid and disconnected feedback freezes, then directly aligns on recovery", FeedbackSmoothingFreezesAndRecovers),
            ("zero feedback delay, BOOL, conditions, endpoints and running actions preserve legacy behavior", FeedbackSmoothingKeepsLegacySemantics),
            ("feedback history is fixed at 64 observations and safely aligns rather than dropping unshown peaks", FeedbackSmoothingIsBounded),
            ("unchanged native model refresh retains the source history while changed bindings cannot inherit it", FeedbackSmoothingSnapshotsAreScoped),
            ("numeric feedback's per-render interpolation allocates no managed memory", FeedbackSmoothingStepDoesNotAllocate),
            ("dual endpoint feedback confirms poses and freezes unknown, conflicting, stale or mismatched signals", MotionEndpointSignalsAreSafe),
            ("authored motion downloads allow only local managed asset namespaces", MotionPathsAreBounded),
            ("manual orbit retains direction across half turns and many full revolutions", OrbitRetainsWinding),
            ("world drag out and back never becomes a selection click", WorldClickRetainsGesture),
            ("device return restores its actual factory/workshop/line entry without stacking device switches", DeviceEntryReturnsToSource),
            ("device entry never leaks across factories, scenes, reloads or explicit overview navigation", DeviceEntryIsSessionScoped),
            ("industrial floor, pits, platforms and device heights match the shared Web/Unity contract", IndustrialGroundMatchesContract),
            ("factory activation and scoped configuration changes select reload or live update correctly", ConfigurationChangesAreScoped),
            ("model/action refresh selects affected instances without importing layout or another factory", ModelRefreshKeepsScene),
            ("realtime receive progresses while the render synchronization context is idle", ReceiveDoesNotWaitForRender),
            ("cancelled send cannot release another owner's semaphore", CancelledSendKeepsLock),
            ("stale queued send cannot move to a replacement session", QueuedSendKeepsSession),
            ("queued outbound messages snapshot their JSON before waiting", QueuedSendSnapshotsMessage),
            ("old cancelled connection loop cannot dispose its replacement", RestartKeepsNewSocket),
            ("unanswered websocket upgrades time out without stopping the client lifetime", UnansweredUpgradeTimesOut),
            ("old connection state messages cannot overwrite a new session", StaleStateIsIgnored),
            ("inbound queue merges PLC patches and preserves control/fault barriers", InboundQueuePreservesOrder),
            ("Web and native queues share exact source snapshot, actuator edge and endpoint ordering", RealtimeMotionQueueContract),
            ("numeric motion has no replay backlog and mechanical edge load remains bounded", RealtimeMotionQueueBoundedLoad),
            ("mobile travel freezes on invalid, expired, reordered or stopped feedback and follows diagonal rail", MobileMotionStopsOnInvalidInputs),
            ("retained last-station feedback never invents travel or docking; only owned actual BOOL movement feedback can confirm stop", LastConfirmedStationIsObservationOnly),
            ("model replay retains original per-point age without renewing old readings", ReplayDoesNotRefreshObservations),
            ("motion signal freshness includes transport and queued receipt age", MotionSignalsCountTransportAge),
            ("handoff uses real actuator travel without inventing reach or moving the track", TransferReachUsesPhysicalNodeTravel),
            ("loading port coordinates retain authored frames and refuse missing or malformed datums", LoadingPortsPreserveSavedCoordinates),
            ("declared line units are inherited without writes; invalid or conflicting calibration never becomes a usable default", SceneUnitsRespectDeclaredLineCalibration),
            ("station and diagonal rail projection preserves explicit along-rail calibration", RailProjectionPreservesStationCalibration),
            ("inbound queue enforces byte/count limits and session isolation", InboundQueueLimits),
            ("render dequeue never waits for the producer lock and retains the exact inbox", InboundQueueNeverBlocksRender),
            ("opt-in work timings are bounded, resettable and disabled by default", WorkTimingsAreOptIn),
            ("streamed queue byte accounting matches canonical JSON UTF-8 without a materialized string", QueueByteCountingMatchesUtf8),
            ("owned telemetry replay retains source ages and protects replay consumers", OwnedReplayRemainsSafe),
            ("real websocket fragments remain bounded and reject oversized messages", InboundFragmentsAreBounded),
            ("real websocket overflow reconnects and requests authoritative resync", InboundOverflowResyncs),
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

    private static Task LoadingThemesMatch()
    {
        foreach (var (config, expected) in new[] { ("{theme:'light'}", "light"), ("{theme:'dark'}", "dark"), ("{background:'#28282B'}", "dark"), ("{background:'#29292c'}", "dark"), ("{background:'#f5f7fb'}", "light") })
        {
            var value = JObject.Parse(config);
            foreach (var input in new JToken[] { value, new JValue(value.ToString()) })
                if (!HeatTreatment.DigitalTwin.Runtime.LoadingThemePolicy.TryResolve(input, out var actual) || actual != expected)
                    throw new Exception("native loading theme mismatch: " + config);
        }
        foreach (var input in new JToken[] { null, JValue.CreateNull(), new JValue("invalid"), JObject.Parse("{theme:'invalid'}"), JObject.Parse("{theme:2}"), new JObject(), new JArray() })
            if (HeatTreatment.DigitalTwin.Runtime.LoadingThemePolicy.TryResolve(input, out _)) throw new Exception("invalid loading theme accepted");
        return Task.CompletedTask;
    }

    private static Task MotionPathsAreBounded()
    {
        foreach (var path in new[] { "/assets/motions/cad.json", "/uploads/models/motions/model/hash.glb", "/uploads/projects/new/assets/motions/a.json" })
            if (!MotionAssetPolicy.IsAllowed(path)) throw new Exception("managed motion path rejected: " + path);
        foreach (var path in new[] { "https://example.com/a.json", "//example.com/a.glb", "/uploads/models/a.glb", "/uploads/audio/a.json", "/uploads/projects/../secret.json", "/uploads/projects/%2e%2e/a.json", "/uploads/projects/a.json?url=remote", "/assets/motions/a.json#secret", "/assets/motions/a\\b.json", "/uploads/projects/a.js", "/assets/motions/a.json\n", "/assets/motions//a.glb" })
            if (MotionAssetPolicy.IsAllowed(path)) throw new Exception("unsafe motion path accepted: " + path);
        return Task.CompletedTask;
    }

    private static Task MotionSignalsAreSafe()
    {
        var binding = JObject.Parse("{sourceGroup:'doors',sourceKey:'open',pointId:'42',inputMin:0,inputMax:1,transitionSeconds:2,speed:1}");
        JObject Frame(double value) => new JObject { ["doors"]=new JObject { ["open"]=value }, ["pointMeta"]=new JObject { ["doors.open"]=new JObject { ["id"]="42" } } };
        var state=new HeatTreatment.DigitalTwin.Rendering.MotionSignalState();
        state.Receive(Frame(0),binding,0);state.Receive(Frame(1),binding,1);state.Step(.5,1.5,5000,binding);
        if(Math.Abs(state.Position-.25)>1e-9)throw new Exception("motion interpolation");
        state.Receive(Frame(0),binding,2);state.Step(.2,2.2,5000,binding);
        if(Math.Abs(state.Position-.15)>1e-9)throw new Exception("motion reversal");
        state.Receive(Frame(1),binding,3);state.Step(100,10,5000,binding);
        if(state.Usable||Math.Abs(state.Position-.15)>1e-9)throw new Exception("stale motion did not freeze");
        var wrong=Frame(1);wrong["pointMeta"]["doors.open"]["id"]="other";state.Receive(wrong,binding,11);
        if(state.Usable)throw new Exception("wrong device point moved animation");
        state.Receive(JObject.Parse("{doors:{open:null}}"),binding,12);if(state.Usable)throw new Exception("missing sample interpreted as zero");
        binding["invert"]=true;binding["transitionSeconds"]=0;state.Receive(Frame(0),binding,13);if(state.Target!=1)throw new Exception("explicit inversion target");
        state.Step(.2,13.2,5000,binding);if(state.Position!=1)throw new Exception("explicit inversion after existing reconnect smoothing");
        var clip=JObject.Parse("{count:2,duration:1}");var track=JObject.Parse("{size:3,channel:'p',values:[0,0,0,2,4,6]}");
        var v=HeatTreatment.DigitalTwin.Rendering.MotionSignalState.Sample(clip,track,.25);
        if(v[0]!=.5||v[1]!=1||v[2]!=1.5)throw new Exception("native portable track interpolation differs");
        var loopBinding=JObject.Parse("{actionId:'clip:fan',kind:'clip',mode:'continuous',dataItemId:'point:fan',speed:1,trigger:{mode:'condition',operator:'eq',value:true}}");
        var loopFrame=JObject.Parse("{timestamp:1000000,motionInputOnly:true,motionInputs:{'clip:fan':{dataItemId:'point:fan',value:true,quality:'good',timestamp:1000000,staleMs:5000}}}");
        var loopState=new HeatTreatment.DigitalTwin.Rendering.MotionSignalState();loopState.Receive(loopFrame,loopBinding,0);loopState.Step(.5,.5,5000,loopBinding);
        var loopRestored=new HeatTreatment.DigitalTwin.Rendering.MotionSignalState();
        if(!loopRestored.RestoreDisplayState(loopBinding,loopState.CaptureDisplayState(loopBinding))||loopRestored.Seconds!=loopState.Seconds||loopRestored.Running!=loopState.Running)throw new Exception("unmodified clip lost its current display clock during model action refresh");
        var changedLoop=(JObject)loopBinding.DeepClone();changedLoop["dataItemId"]="point:other";
        if(new HeatTreatment.DigitalTwin.Rendering.MotionSignalState().RestoreDisplayState(changedLoop,loopState.CaptureDisplayState(loopBinding)))throw new Exception("changed source inherited a prior clip timer");
        return Task.CompletedTask;
    }

    private static Task ConfigurationChangesAreScoped()
    {
        var oldFactory = "factory_default";
        var newFactory = "factory_pit_furnaces_v1";
        Check(ConfigurationSyncPolicy.ChangeAction(new JObject { ["activeFactoryId"] = newFactory }, oldFactory) == "reload", "Activation without settings was silently ignored.");
        Check(ConfigurationSyncPolicy.ChangeAction(new JObject { ["activeFactoryId"] = newFactory }, newFactory) == "ignore", "An already loaded factory need not rebuild.");
        Check(ConfigurationSyncPolicy.ChangeAction(new JObject { ["factoryId"] = oldFactory, ["reloadRequired"] = true }, newFactory) == "ignore", "Another factory's save invalidated this scene.");
        Check(ConfigurationSyncPolicy.ChangeAction(new JObject { ["factoryId"] = newFactory, ["reloadRequired"] = true }, newFactory) == "reload", "Committed layout save did not rebuild.");
        Check(ConfigurationSyncPolicy.ChangeAction(new JObject { ["factoryId"] = newFactory, ["settings"] = new JObject { ["factory_name"] = "New name" } }, newFactory) == "settings", "Ordinary settings should update live.");
        Check(ConfigurationSyncPolicy.ChangeAction(new JObject { ["settings"] = new JObject { ["native_environment_config"] = "{}" } }, newFactory) == "reload", "Environment hierarchy was not rebuilt.");
        Check(ConfigurationSyncPolicy.ChangeAction(new JObject { ["keys"] = new JArray("layout") }, newFactory) == "reload", "Legacy invalidation without settings was lost.");
        Check(!ConfigurationSyncPolicy.MatchesFactory(new JObject { ["factoryId"] = newFactory }, oldFactory), "An old scene can acknowledge navigation to a different factory.");
        Check(ConfigurationSyncPolicy.MatchesFactory(new JObject { ["factoryId"] = newFactory }, newFactory), "Target factory cannot acknowledge its own navigation.");
        Check(ConfigurationSyncPolicy.ChangeAction(JObject.Parse("{resource:'models',reloadRequired:true}"), newFactory) == "models", "Model generic event still rebuilds the hall.");
        Check(ConfigurationSyncPolicy.ChangeAction(JObject.Parse("{resource:'device-animations',reloadRequired:true}"), newFactory) == "models", "Action data binding still rebuilds the hall.");
        return Task.CompletedTask;
    }

    private static Task ModelRefreshKeepsScene()
    {
        var current = Newtonsoft.Json.JsonConvert.DeserializeObject<FactoryConfigDto>("{factoryId:'one',models:[{id:'cart',file_path:'/assets/a.glb',metadata:{partBindings:[]}},{id:'furnace',file_path:'/assets/b.glb'}],workshops:[{id:'w',layout_json:{x:8},lines:[{id:'l',devices:[{id:'c',model_type:'cart',pos_x:4,instance_config:{caption:'unsaved',animationBindings:{bindings:[]}}},{id:'f',model_type:'furnace'}]}]}]}");
        var latest = Newtonsoft.Json.JsonConvert.DeserializeObject<FactoryConfigDto>(Newtonsoft.Json.JsonConvert.SerializeObject(current));
        latest.Models[0].Metadata = JObject.Parse("{partBindings:[{id:'new',action:'rotate_angle'}]}");
        ModelHotRefreshPolicy.Devices(latest).First().PositionX = 100;
        ModelHotRefreshPolicy.Devices(latest).First().InstanceConfig = JObject.Parse("{caption:'other',animationBindings:{bindings:[{actionId:'part:new'}]}}");
        var merged = ModelHotRefreshPolicy.Merge(current, latest, out var affected);
        Check(affected.SetEquals(new[] { "c" }), "Unchanged furnace was selected for replacement.");
        var cart = ModelHotRefreshPolicy.Devices(merged).First();
        Check(cart.PositionX == 4 && cart.InstanceConfigObject.Value<string>("caption") == "unsaved", "Model event imported unrelated saved layout/settings.");
        Check(cart.InstanceConfigObject["animationBindings"]["bindings"].Count() == 1, "Changed action inputs were lost.");
        Check(ModelHotRefreshPolicy.Devices(current).First().InstanceConfigObject["animationBindings"]["bindings"].Count() == 0, "Planning mutated the active config before commit.");
        var repeated = ModelHotRefreshPolicy.Merge(merged, latest, out affected); Check(affected.Count == 0, "Duplicate generic/specific event replaced unchanged instances.");
        Check(ModelHotRefreshPolicy.ScaleRatio(new ModelAssetDto { DefaultScale = 2 }, new ModelAssetDto { DefaultScale = 3 }) == 1.5f, "Changing model scale swallowed the instance/preview scale multiplier.");
        latest.Models[0].Metadata = JObject.Parse("{partBindings:[]}");
        ModelHotRefreshPolicy.Merge(repeated, latest, out affected); Check(affected.SetEquals(new[] { "c" }), "Deleting a part action failed to invalidate its model.");
        latest.FactoryId = "another"; Check(ModelHotRefreshPolicy.Merge(current, latest, out _) == null, "Cross-factory read overwrote this scene.");
        return Task.CompletedTask;
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
            var sending = (Task)Invoke(client, "SendMessageAsync", new JObject { ["type"] = "test" }, false);
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
        var sending = (Task)Invoke(client, "SendMessageAsync", new JObject { ["type"] = "old-session-message" }, false);
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

    private static async Task UnansweredUpgradeTimesOut()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var socket = new ClientWebSocket();
        socket.Options.Proxy = null;
        using var lifetime = new CancellationTokenSource();
        var client = new RealtimeWebSocketClient();
        var connecting = (Task)Invoke(client, "ConnectAndHelloAsync", socket,
            new Uri($"ws://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/"), lifetime.Token, TimeSpan.FromMilliseconds(100));
        using var accepted = await listener.AcceptTcpClientAsync().WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await connecting.WaitAsync(TimeSpan.FromSeconds(5));
            throw new InvalidOperationException("Unanswered HTTP upgrade never hit the connection deadline.");
        }
        catch (TimeoutException error)
        {
            Check(error.Message.Contains("connect/hello"), "The test wait expired instead of the connection deadline.");
        }
        Check(!lifetime.IsCancellationRequested, "A connect timeout cancelled the entire reconnect lifetime.");
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
