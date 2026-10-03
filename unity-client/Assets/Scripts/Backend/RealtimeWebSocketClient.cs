using System;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Backend
{
    public sealed class RealtimeWebSocketClient : MonoBehaviour
    {
        private readonly RealtimeMessageQueue _messages = new RealtimeMessageQueue();
        private CancellationTokenSource _lifetime;
        private ClientWebSocket _socket;
        private int _generation;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly object _sendBudgetGate = new object();
        private int _pendingSendBytes, _pendingSends;

        public bool IsConnected => _socket?.State == WebSocketState.Open;
        public event Action<JObject> MessageReceived;
        public event Action<string> ConnectionStateChanged;

        public void StartClient(string endpoint, float reconnectSeconds, CookieContainer sessionCookies = null)
        {
            StopClient();
            var uri = new Uri(endpoint);
            if (uri.Scheme != "ws" && uri.Scheme != "wss")
                throw new ArgumentException("Realtime endpoint must use ws:// or wss://", nameof(endpoint));
            var retry = float.IsNaN(reconnectSeconds) || float.IsInfinity(reconnectSeconds)
                ? 2f
                : Mathf.Max(0.5f, reconnectSeconds);
            _lifetime = new CancellationTokenSource();
            _ = RunLoopAsync(uri, retry, _lifetime, _generation, sessionCookies);
        }

        public void StopClient()
        {
            Interlocked.Increment(ref _generation);
            var lifetime = _lifetime;
            _lifetime = null;
            var socket = _socket;
            _socket = null;
            lifetime?.Cancel();
            socket?.Dispose();
            _messages.Reset(_generation);
            // The loop owns its CTS and disposes it after cancellation unwinds.
        }

        private async Task RunLoopAsync(Uri endpoint, float reconnectSeconds, CancellationTokenSource lifetime, int generation, CookieContainer sessionCookies)
        {
            var cancellationToken = lifetime.Token;
            var connectedOnce = false;
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    ClientWebSocket socket = null;
                    try
                    {
                        if (generation != _generation || cancellationToken.IsCancellationRequested) break;
                        _messages.Clear(generation);
                        socket = new ClientWebSocket();
                        _socket = socket;
                        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                        if (sessionCookies != null) socket.Options.Cookies = sessionCookies;
                        QueueState("connecting", generation);
                        await socket.ConnectAsync(endpoint, cancellationToken);
                        await SendHelloAsync(socket, cancellationToken);
                        QueueState("connected", generation);
                        // A disconnect may have interrupted reliable configuration events.
                        // Existing runtime handles this message by fetching authoritative state.
                        if (connectedOnce) Enqueue(generation, new JObject {
                            ["type"] = "dashboard_release_changed",
                            ["payload"] = new JObject { ["reason"] = "websocket_reconnect_resync" }
                        });
                        connectedOnce = true;
                        await ReceiveLoopAsync(socket, cancellationToken, generation);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        break;
                    }
                    catch (Exception exception)
                    {
                        if (!cancellationToken.IsCancellationRequested)
                            QueueState($"error:{exception.Message}", generation);
                    }
                    finally
                    {
                        socket?.Dispose();
                        // A stopped loop can finish after StartClient has installed
                        // its replacement. It must never dispose/null the new socket.
                        if (ReferenceEquals(_socket, socket)) _socket = null;
                    }

                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(reconnectSeconds), cancellationToken);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                }
            }
            finally
            {
                if (ReferenceEquals(_lifetime, lifetime)) _lifetime = null;
                lifetime.Dispose();
                QueueState("stopped", generation);
            }
        }

        private async Task SendHelloAsync(ClientWebSocket socket, CancellationToken cancellationToken)
        {
            var payload = Encoding.UTF8.GetBytes(new JObject
            {
                ["type"] = "client_hello",
                ["role"] = "unity",
                ["client"] = "heat-treatment-digital-twin"
            }.ToString(Newtonsoft.Json.Formatting.None));
            await _sendLock.WaitAsync(cancellationToken);
            try
            {
                await socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, cancellationToken);
            }
            finally { _sendLock.Release(); }
        }

        public void SendMessage(JObject message)
        {
            if (message == null) return;
            _ = SendMessageAsync(message);
        }

        public void SendTransientMessage(JObject message)
        {
            if (message != null) _ = SendMessageAsync(message, true);
        }

        private async Task SendMessageAsync(JObject message, bool dropIfBusy = false)
        {
            var socket = _socket;
            var generation = _generation;
            var cancellationToken = _lifetime?.Token ?? CancellationToken.None;
            if (socket == null || socket.State != WebSocketState.Open || cancellationToken.IsCancellationRequested) return;
            var lockTaken = false;
            var budgetTaken = false;
            var payloadBytes = 0;
            try
            {
                var payload = Encoding.UTF8.GetBytes(message.ToString(Newtonsoft.Json.Formatting.None));
                payloadBytes = payload.Length;
                lock (_sendBudgetGate)
                {
                    if (payloadBytes > RealtimeMessageQueue.MaxMessageBytes || _pendingSends >= 256 || _pendingSendBytes + payloadBytes > 16 * 1024 * 1024)
                    {
                        if (!dropIfBusy) { socket.Abort(); QueueState("error:outbound resource limit; reconnect and resync", generation); }
                        return;
                    }
                    _pendingSends++; _pendingSendBytes += payloadBytes; budgetTaken = true;
                }
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                deadline.CancelAfter(TimeSpan.FromSeconds(15));
                if (dropIfBusy)
                {
                    lockTaken = _sendLock.Wait(0);
                    if (!lockTaken) return;
                }
                else
                {
                    await _sendLock.WaitAsync(deadline.Token);
                    lockTaken = true;
                }
                // A queued message belongs to the captured connection, not a
                // replacement session that appeared while waiting for the lock.
                if (!ReferenceEquals(socket, _socket) || socket.State != WebSocketState.Open) return;
                await socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, deadline.Token);
            }
            catch (OperationCanceledException)
            {
                if (!cancellationToken.IsCancellationRequested && ReferenceEquals(socket, _socket))
                { socket.Abort(); QueueState("error:send timeout; reconnect and resync", generation); }
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[RealtimeWebSocket] Send failed: {exception.Message}");
                if (ReferenceEquals(socket, _socket)) { socket.Abort(); QueueState("error:send failed; reconnect and resync", generation); }
            }
            finally
            {
                if (lockTaken) _sendLock.Release();
                if (budgetTaken) lock (_sendBudgetGate) { _pendingSends--; _pendingSendBytes -= payloadBytes; }
            }
        }

        private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken, int generation)
        {
            var buffer = new byte[64 * 1024];
            using var stream = new MemoryStream();
            while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                // Unity's synchronization context resumes pending I/O only during
                // a render frame. Bursts of PLC status/data messages can therefore
                // outrun socket reads even when the main-thread handoff queue is
                // empty. Parse/queue on the I/O continuation; Update alone applies
                // the messages to Unity objects. Connection lifecycle stays on its
                // original context in RunLoopAsync.
                var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                { QueueState($"disconnected:{result.CloseStatus}:{result.CloseStatusDescription}; reconnect and resync", generation); break; }
                if (result.MessageType != WebSocketMessageType.Text) throw new InvalidDataException("Only text realtime messages are supported");
                if (stream.Length + result.Count > RealtimeMessageQueue.MaxMessageBytes)
                    throw new InvalidDataException("Inbound message exceeds 4 MiB; reconnect and resync");
                stream.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;

                var json = Encoding.UTF8.GetString(stream.GetBuffer(), 0, (int)stream.Length);
                stream.SetLength(0);
                Enqueue(generation, JObject.Parse(json));
            }
        }

        private void QueueState(string state, int generation)
        {
            if (generation != _generation) return;
            // Record the actual cause before reconnect clears the bounded queue.
            // This is a connection transition, never a per-frame/point diagnostic.
            if (state.StartsWith("error:", StringComparison.Ordinal) || state.StartsWith("disconnected:", StringComparison.Ordinal))
                Debug.LogWarning($"[RealtimeWebSocket] {DateTime.UtcNow:O} {state}; inbound={_messages.Count}/{_messages.Bytes} bytes");
            var message = new JObject
            {
                ["type"] = "__connection_state",
                ["state"] = state
            };
            if (!_messages.TryEnqueue(generation, message))
            {
                _messages.Clear(generation);
                _messages.TryEnqueue(generation, new JObject { ["type"] = "__connection_state", ["state"] = "error:inbound resource limit; reconnect and resync" });
                _socket?.Abort();
            }
        }

        private void Enqueue(int generation, JObject message)
        {
            if (!_messages.TryEnqueue(generation, message))
                throw new InvalidDataException("Inbound queue resource limit; reconnect and resync");
        }

        private void Update()
        {
            var processed = 0;
            while (processed < 20 && _messages.TryDequeue(_generation, out var message))
            {
                processed += 1;
                if (message.Value<string>("type") == "__connection_state")
                {
                    ConnectionStateChanged?.Invoke(message.Value<string>("state"));
                }
                else
                {
                    MessageReceived?.Invoke(message);
                }
            }
        }

        private void OnDestroy()
        {
            StopClient();
            // WaitAsync continuations may still be releasing an acquired lock.
            // No WaitHandle is used, so GC can safely reclaim this semaphore
            // after those tasks complete instead of disposing it underneath them.
        }
    }
}
