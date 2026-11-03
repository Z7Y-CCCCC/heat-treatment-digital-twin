using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;

namespace HeatTreatmentCollectorCenter
{
    internal static class SelfTests
    {
        static void Check(bool condition,string message) { if(!condition) throw new Exception(message); }
        static object Health(double timestamp) {
            return Ops.Parse("{\"status\":\"ok\",\"db\":{\"connected\":true},\"components\":{\"dataEngine\":{}},\"readiness\":{\"failures\":[\"unity\"]},\"engine\":{\"mode\":\"simulation\",\"process\":{\"status\":\"running\",\"pid\":123,\"restartCount\":2},\"collectorStatus\":{\"status\":\"connected\",\"lastFrameAt\":"+timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture)+"}}}");
        }
        internal static int Run(string output)
        {
            try {
                // Assemble this synthetic marker so the repository credential scan does not mistake it for a real key.
                foreach(var text in new[]{"password=SECRET","{\"api_key\":\"SECRET\"}","https://fred:SECRET@host/","Authorization: Basic SECRET","Bearer SECRET","-----BEGIN " + "PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----"}) Check(!Ops.Redact(text).Contains("SECRET"),"redaction: "+text);
                double now=(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
                var s=Ops.Summarize(new Snapshot(),Health(now-1000),DateTime.UtcNow);
                Check(s.Healthy && s.Mode=="模拟数据","Unity must be optional, simulation explicit");
                Check(!Ops.Summarize(new Snapshot(),Health(now-20000),DateTime.UtcNow).Healthy,"stale data");
                var h=Health(now); ((IDictionary<string,object>)Ops.Get(h,"db"))["connected"]=false;
                Check(!Ops.Summarize(new Snapshot(),h,DateTime.UtcNow).Healthy,"database error");
                h=Health(now); ((IDictionary<string,object>)Ops.Get(Ops.Get(h,"engine"),"process"))["status"]="recovering";
                Check(!Ops.Summarize(new Snapshot(),h,DateTime.UtcNow).Healthy,"process recovery");
                h=Health(now);
                ((IDictionary<string,object>)h)["collectorFactories"]=new object[]{
                    Ops.Get(h,"engine"),Ops.Parse("{\"mode\":\"integrated_plc\",\"collectorStatus\":{\"status\":\"error\"},\"devices\":[{\"status\":\"offline\",\"quality\":\"bad\"}]}")};
                var mixed=Ops.Summarize(new Snapshot(),h,DateTime.UtcNow);
                Check(!mixed.Healthy && mixed.Mode.Contains("混合"),"secondary factory and mixed mode");
                var automatic=Ops.Parse("{\"db\":{\"connected\":true},\"collectorFactories\":[{\"mode\":\"integrated_plc\"}],\"collectorHealth\":{\"state\":\"degraded\",\"label\":\"部分采集异常\",\"reason\":\"坏设备不影响其他设备\",\"counts\":{\"normal\":16,\"abnormal\":1},\"lastSampleAgeMs\":23,\"process\":{\"pid\":42,\"memoryRssBytes\":67108864}}}");
                var observed=Ops.Summarize(new Snapshot(),automatic,DateTime.UtcNow);
                Check(!observed.Healthy && observed.Normal==16 && observed.Abnormal==1 && observed.HealthLabel=="部分采集异常" && observed.Collection=="刚刚" && observed.Process.Contains("64 MB"),"shared observed collector health and counts");
                bool rejected=false; try { Ops.Origin(Ops.Parse("{\"port\":1}")); } catch { rejected=true; }
                Check(rejected,"invalid port");
                var points=PointRow.From(Ops.Parse("{\"points\":[{\"label\":\"温度\",\"plc_tag\":\"DB1,REAL0\",\"data_type\":\"REAL\",\"value\":0,\"quality\":\"good\"},{\"name\":\"报警\",\"value\":false,\"quality\":\"good\"},{\"name\":\"过期\",\"value\":100,\"quality\":\"stale\"}]}"));
                Check(points.Count==3 && points[0].Name=="温度" && points[0].Address=="DB1,REAL0" && points[0].Value=="0" && points[1].Value=="0" && points[2].Value=="—","point projection");
                var logs=Ops.ParseLogs(new[]{new KeyValuePair<string,string>("backend.log","[2026-10-30T12:00:00Z] 中文错误 password=SECRET\n<script>literal</script>"),new KeyValuePair<string,string>("database-config.json","SECRET")});
                Check(logs.Count==2 && logs.Any(x=>x.Level=="ERROR") && logs.All(x=>!x.Message.Contains("SECRET")),"log parsing");
                string diagnostic=output+".json.gz"; Ops.Export(diagnostic,s,logs,"");
                using(var file=File.OpenRead(diagnostic)) using(var gzip=new GZipStream(file,CompressionMode.Decompress)) using(var reader=new StreamReader(gzip)) { var report=reader.ReadToEnd(); Check(!report.Contains("SECRET"),"diagnostic redaction"); Ops.Parse(report); }
                Check(Ops.Origin(Ops.Parse("{\"port\":4567,\"backendOrigin\":\"https://evil.test\"}"))=="http://127.0.0.1:4567","fixed local origin");
                File.WriteAllText(output,Ops.Serialize(new {success=true,tests=new[]{"credentials-redacted","freshness","database","process-health","secondary-factory-health","mixed-mode","unity-optional","simulation-labeled","fixed-log-files","chinese-log-level","literal-log-text","gzip-json-export","fixed-loopback","invalid-port"}}),Encoding.UTF8);
                return 0;
            } catch(Exception error) { File.WriteAllText(output,Ops.Serialize(new {success=false,error=error.ToString()})); return 1; }
        }
        internal static int PointApi(string origin,string output)
        {
            try {
                using(var client=new PointClient(origin)) {
                    client.Login(Environment.GetEnvironmentVariable("NATIVE_TEST_USER"),Environment.GetEnvironmentVariable("NATIVE_TEST_PASSWORD")).GetAwaiter().GetResult();
                    var factories=client.Factories().GetAwaiter().GetResult();
                    string factory=Ops.Str(factories,"activeFactoryId");
                    var devices=Ops.Items(client.Devices(factory).GetAwaiter().GetResult()).ToArray();
                    Check(devices.Length>0,"no devices");string device=Ops.Str(devices[0],"id");
                    var initial=client.Points(factory,device).GetAwaiter().GetResult();
                    var before=PointRow.From(initial);
                    if(Environment.GetEnvironmentVariable("NATIVE_TEST_GATE")=="1") {
                        File.WriteAllText(output+".before",Ops.Serialize(new {factory,device,points=Ops.Items(Ops.Get(initial,"points")).Select(p=>new {id=Ops.Str(p,"id"),label=Ops.Str(p,"label")}).ToArray()}),Encoding.UTF8);
                        var deadline=DateTime.UtcNow.AddSeconds(15);
                        while(!File.Exists(output+".continue") && DateTime.UtcNow<deadline)System.Threading.Thread.Sleep(50);
                        Check(File.Exists(output+".continue"),"configuration update gate timed out");
                    } else System.Threading.Thread.Sleep(1200);
                    var after=PointRow.From(client.Points(factory,device).GetAwaiter().GetResult());
                    client.Logout().GetAwaiter().GetResult();
                    File.WriteAllText(output,Ops.Serialize(new { success=true,before=before.Select(p=>new {p.Name,p.Address,p.Value,p.Quality}).ToArray(),after=after.Select(p=>new {p.Name,p.Address,p.Value,p.Quality}).ToArray() }),Encoding.UTF8);return 0;
                }
            } catch(Exception error) {File.WriteAllText(output,Ops.Serialize(new {success=false,error=Ops.Redact(error.Message)}),Encoding.UTF8);return 1;}
        }
    }
}
