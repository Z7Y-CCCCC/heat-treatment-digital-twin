using System.Reflection;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static async Task InboundQueueNeverBlocksRender()
    {
        var queue = new RealtimeMessageQueue(); queue.Reset(7);
        var original = JObject.Parse("{type:'device_configuration_changed',payload:{id:'cart'}}");
        Check(queue.TryEnqueue(7, original), "fixture enqueue");
        var gate = typeof(RealtimeMessageQueue).GetField("_gate", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(queue)!;
        using var entered = new ManualResetEventSlim(); using var release = new ManualResetEventSlim();
        var owner = Task.Run(() => { lock (gate) { entered.Set(); release.Wait(); } });
        Check(entered.Wait(TimeSpan.FromSeconds(5)), "producer owns gate");
        try
        {
            var read = Task.Run(() => { var found = queue.TryDequeue(7, out var message); return (found,message); });
            Check(await Task.WhenAny(read, Task.Delay(2000)) == read, "render reader blocked behind producer work");
            var result = await read; Check(!result.found && result.message == null, "contended read changed queue ownership");
        }
        finally { release.Set(); await owner; }
        Check(queue.Count == 1 && queue.TryDequeue(7, out var retained) && ReferenceEquals(retained,original), "exact reliable inbox was not retained");
        Check(!queue.TryDequeue(7,out _), "message replayed twice");
        queue.Reset(8);Check(!queue.TryDequeue(7,out _), "old generation read new session");
    }

    private static Task WorkTimingsAreOptIn()
    {
        Check(!RuntimeWorkMetrics.Enabled, "ordinary launch enabled instrumentation");
        RuntimeWorkMetrics.Enable();
        try
        {
            for(var i=0;i<2000;i++) using(RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.RealtimeApply)) { }
            RuntimeWorkMetrics.ReadContended();
            var window=RuntimeWorkMetrics.CaptureWindow();
            Check(window["sections"]!["RealtimeApply"]!.Value<long>("calls")==2000,"work count");
            Check(window.Value<long>("nonblockingQueueReadContentions")==1,"contention count");
            Check(RuntimeWorkMetrics.CaptureWindow()["sections"]!["RealtimeApply"]!.Value<long>("calls")==0,"window reset");
            // Warm up before the per-render no-allocation assertion.
            for(var i=0;i<10;i++) using(RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.RealtimeApply)) { }
            var before=GC.GetAllocatedBytesForCurrentThread();
            for(var i=0;i<2000;i++) using(RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.RealtimeApply)) { }
            Check(GC.GetAllocatedBytesForCurrentThread()==before,"per-callback timing allocated");
        }
        finally { RuntimeWorkMetrics.Disable(); }
        RuntimeWorkMetrics.CaptureWindow();
        using(RuntimeWorkMetrics.Measure(RuntimeWorkMetrics.Section.RealtimeApply)) { }
        Check(RuntimeWorkMetrics.CaptureWindow()["sections"]!["RealtimeApply"]!.Value<long>("calls")==0,"disabled timing was recorded");
        return Task.CompletedTask;
    }

    private static Task QueueByteCountingMatchesUtf8()
    {
        foreach(var value in new[]{"", "ASCII", "炉门开关", "😀", "\ud800", "\udfff", "\ud800x\udfff", "\u2028\u2029\0\t\r\n\"\\", new string('界',4096)})
        {
            var q=new RealtimeMessageQueue();q.Reset(1);
            var message=new JObject{["type"]="reliable",["payload"]=new JObject{[value]=value,["date"]=new DateTime(2026,11,10,0,0,0,DateTimeKind.Utc),["n"]=1.25,["nil"]=null}};
            Check(q.TryEnqueue(1,message),"UTF-8 fixture rejected");
            Check(q.Bytes==System.Text.Encoding.UTF8.GetByteCount(message.ToString(Newtonsoft.Json.Formatting.None)),"streamed canonical UTF-8 count differs");
        }
        return Task.CompletedTask;
    }

    private static Task OwnedReplayRemainsSafe()
    {
        var cache=new HeatTreatment.DigitalTwin.Rendering.RealtimeDeviceFrameCache();
        var source=JObject.Parse("{furnace_id:'cart',timestamp:10000,status:{online:true},analog:{temp:12},pointTimestamps:{analog:{temp:9500}}}");
        cache.RememberOwned("cart",source,2);
        Check(cache.TryGet("cart",out var first,3),"owned replay missing");
        Check(first.Value<double>("timestamp")==11000&&first["pointTimestamps"]!["analog"]!.Value<double>("temp")==9500,"source age was renewed");
        first["analog"]!["temp"]=99;
        Check(cache.TryGet("cart",out var second,4)&&second["analog"]!.Value<int>("temp")==12,"replay consumer mutated immutable cache");
        var old=(JObject)source.DeepClone();old["timestamp"]=9000;old["analog"]!["temp"]=0;cache.RememberOwned("cart",old,5);
        Check(cache.TryGet("cart",out var third,5)&&third["analog"]!.Value<int>("temp")==12,"older source displaced newest owned frame");
        Check(source.Value<long>("timestamp")==10000,"clock bridge mutated owned source packet");
        return Task.CompletedTask;
    }
}
