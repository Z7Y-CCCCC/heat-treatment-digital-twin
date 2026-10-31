using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Low-frequency local acknowledgements only. No polling, database writes or backend broadcast.
    internal static class NativeQualityBridge
    {
        private static readonly SemaphoreSlim Sender = new SemaphoreSlim(1, 1);
        public static async void Publish(int playerId, string message)
        {
            await Sender.WaitAsync();
            try
            {
                using (var pipe = new NamedPipeClientStream(".", $"HeatTreatmentAdminHost_{playerId}", PipeDirection.Out, PipeOptions.Asynchronous))
                {
                    await pipe.ConnectAsync(700);
                    using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                    {
                        await writer.WriteLineAsync(message);
                        await writer.FlushAsync();
                    }
                }
            }
            catch (Exception) { /* Host may be starting or closing. Its next query resynchronizes state. */ }
            finally { Sender.Release(); }
        }
    }
}
