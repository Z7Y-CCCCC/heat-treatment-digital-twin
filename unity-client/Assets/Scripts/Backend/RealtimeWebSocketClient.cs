using System;
using System.Collections.Concurrent;
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
        private readonly ConcurrentQueue<(int Generation, JObject Message)> _messages = new ConcurrentQueue<(int, JObject)>();
        private CancellationTokenSource _lifetime;
        private ClientWebSocket _socket;
        private int _generation;
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);

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
            _generation += 1;
            var lifetime = _lifetime;
            _lifetime = null;
            var socket = _socket;
            _socket = null;
            lifetime?.Cancel();
            socket?.Dispose();
            while (_messages.TryDequeue(out _)) { }
            // The loop owns its CTS and disposes it after cancellation unwinds.
        }

        private async Task RunLoopAsync(Uri endpoint, float reconnectSeconds, CancellationTokenSource lifetime, int generation, CookieContainer sessionCookies)
        {
            var cancellationToken = lifetime.Token;
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    ClientWebSocket socket = null;
                    try
                    {
                        socket = new ClientWebSocket();
                        _socket = socket;
                        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                        if (sessionCookies != null) socket.Options.Cookies = sessionCookies;
                        QueueState("connecting", generation);
                        await socket.ConnectAsync(endpoint, cancellationToken);
                        await SendHelloAsync(socket, cancellationToken);
                        QueueState("connected", generation);
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
            var cancellationToken = _lifetime?.Token ?? CancellationToken.None;
            if (socket == null || socket.State != WebSocketState.Open || cancellationToken.IsCancellationRequested) return;
            var lockTaken = false;
            try
            {
                if (dropIfBusy)
                {
                    lockTaken = _sendLock.Wait(0);
                    if (!lockTaken) return;
                }
                else
                {
                    await _sendLock.WaitAsync(cancellationToken);
                    lockTaken = true;
                }
                // A queued message belongs to the captured connection, not a
                // replacement session that appeared while waiting for the lock.
                if (!ReferenceEquals(socket, _socket) || socket.State != WebSocketState.Open) return;
                var payload = Encoding.UTF8.GetBytes(message.ToString(Newtonsoft.Json.Formatting.None));
                await socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                // Runtime is stopping or reconnecting.
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[RealtimeWebSocket] Send failed: {exception.Message}");
            }
            finally
            {
                if (lockTaken) _sendLock.Release();
            }
        }

        private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken, int generation)
        {
            var buffer = new byte[64 * 1024];
            using var stream = new MemoryStream();
            while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text) continue;
                stream.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage) continue;

                var json = Encoding.UTF8.GetString(stream.GetBuffer(), 0, (int)stream.Length);
                stream.SetLength(0);
                try { _messages.Enqueue((generation, JObject.Parse(json))); }
                catch (Exception exception) { Debug.LogWarning($"[RealtimeWebSocket] Invalid frame: {exception.Message}"); }
            }
        }

        private void QueueState(string state, int generation)
        {
            _messages.Enqueue((generation, new JObject
            {
                ["type"] = "__connection_state",
                ["state"] = state
            }));
        }

        private void Update()
        {
            var processed = 0;
            while (processed < 20 && _messages.TryDequeue(out var queued))
            {
                processed += 1;
                if (queued.Generation != _generation) continue;
                var message = queued.Message;
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
