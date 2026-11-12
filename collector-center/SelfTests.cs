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
                Check(s.DisplayState=="unknown" && s.DisplayNote.Contains("更新"),"legacy health must not invent a display connection");
                foreach(string state in new[]{"online","stale","offline"}) {
                    var displayHealth=Health(now-1000);
                    ((IDictionary<string,object>)Ops.Get(displayHealth,"components"))["displayConnection"]=Ops.Parse("{\"status\":\""+state+"\",\"connectedClients\":"+(state=="online"?"2":"0")+",\"sceneReadyClients\":1,\"ageMs\":"+(state=="online"?"500":"17000")+"}");
                    var ds=Ops.Summarize(new Snapshot(),displayHealth,DateTime.UtcNow);
                    Check(ds.Healthy && ds.DisplayState==state,"display disconnection cannot stop or degrade collection: "+state);
                    Check(state=="online"?ds.DisplayConnection.Contains("2 个大屏") && ds.DisplayNote.Contains("就绪") && ds.DisplayLastCommunication=="刚刚":state=="stale"?ds.DisplayConnection=="通信超时" && ds.DisplayNote.Contains("15 秒"):ds.DisplayConnection=="未连接大屏" && ds.DisplayNote.Contains("不影响"),"display projection: "+state);
                }
                var loading=Health(now);
                ((IDictionary<string,object>)Ops.Get(loading,"components"))["displayConnection"]=Ops.Parse("{\"status\":\"online\",\"connectedClients\":1,\"sceneReadyClients\":0,\"ageMs\":null}");
                var displayLoading=Ops.Summarize(new Snapshot(),loading,DateTime.UtcNow);
                Check(displayLoading.DisplayNote.Contains("加载中") && displayLoading.DisplayLastCommunication=="暂无通信","connection and scene readiness are distinct");
                ((IDictionary<string,object>)loading)["version"]=Ops.Parse("{\"license\":{\"enforce\":true,\"valid\":false}}");
                Check(Ops.Summarize(new Snapshot(),loading,DateTime.UtcNow).DisplayState=="online","activation status cannot hide connection health");
                ((IDictionary<string,object>)Ops.Get(loading,"components"))["displayConnection"]=Ops.Parse("{\"status\":\"online\",\"connectedClients\":0,\"ageMs\":-3}");
                var malformed=Ops.Summarize(new Snapshot(),loading,DateTime.UtcNow);
                Check(malformed.DisplayState=="unknown" && malformed.DisplayLastCommunication=="暂无通信","malformed telemetry cannot be healthy");
                Check(Ops.Summarize(displayLoading,Health(now),DateTime.UtcNow).DisplayState=="unknown","missing telemetry resets old healthy state");
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
                foreach(var invalid in new[]{"{}","{\"runtime\":{\"role\":\"display\"}}","{\"runtime\":{\"role\":\"collector\",\"owner\":\"standalone\"}}"}) {
                    bool refused=false;try{Ops.AssertCollectorHealth(Ops.Parse(invalid));}catch{refused=true;}Check(refused,"never attach to display/legacy collector");
                }
                Ops.AssertCollectorHealth(Ops.Parse("{\"runtime\":{\"role\":\"collector\",\"owner\":\"windows-service\",\"serviceName\":\"HeatTreatmentCollector\"}}"));
                Check(!Ops.CompleteRuntime(Path.GetTempPath()),"a cache/single executable is not a complete collector install");
                var unlicensed=Health(now);((IDictionary<string,object>)unlicensed)["version"]=Ops.Parse("{\"license\":{\"enforce\":true,\"valid\":false}}");
                Check(Ops.Summarize(new Snapshot(),unlicensed,DateTime.UtcNow).HealthState=="activation_required","service awaiting activation is not healthy collection");
                var points=PointRow.From(Ops.Parse("{\"points\":[{\"label\":\"温度\",\"plc_tag\":\"DB1,REAL0\",\"data_type\":\"REAL\",\"value\":0,\"quality\":\"good\"},{\"name\":\"报警\",\"value\":false,\"quality\":\"good\"},{\"name\":\"过期\",\"value\":100,\"quality\":\"stale\"}]}"));
                Check(points.Count==3 && points[0].Name=="温度" && points[0].Address=="DB1,REAL0" && points[0].Value=="0" && points[1].Value=="0" && points[2].Value=="—","point projection");
                var logs=Ops.ParseLogs(new[]{new KeyValuePair<string,string>("backend.log","[2026-10-30T12:00:00Z] 中文错误 password=SECRET\n<script>literal</script>"),new KeyValuePair<string,string>("database-config.json","SECRET")});
                Check(logs.Count==2 && logs.Any(x=>x.Level=="ERROR") && logs.All(x=>!x.Message.Contains("SECRET")),"log parsing");
                string diagnostic=output+".json.gz"; Ops.Export(diagnostic,s,logs,"");
                using(var file=File.OpenRead(diagnostic)) using(var gzip=new GZipStream(file,CompressionMode.Decompress)) using(var reader=new StreamReader(gzip)) { var report=reader.ReadToEnd(); Check(!report.Contains("SECRET"),"diagnostic redaction"); Ops.Parse(report); }
                Check(Ops.Origin(Ops.Parse("{\"port\":4567,\"backendOrigin\":\"https://evil.test\"}"))=="http://127.0.0.1:4567","fixed local origin");
                File.WriteAllText(output,Ops.Serialize(new {success=true,tests=new[]{"credentials-redacted","freshness","database","process-health","secondary-factory-health","mixed-mode","unity-optional","simulation-labeled","display-online","display-stale","display-offline","display-legacy-unknown","display-scene-loading","display-unlicensed","display-malformed","display-no-stale-healthy","fixed-log-files","chinese-log-level","literal-log-text","gzip-json-export","fixed-loopback","invalid-port"}}),Encoding.UTF8);
                return 0;
            } catch(Exception error) { File.WriteAllText(output,Ops.Serialize(new {success=false,error=error.ToString()})); return 1; }
        }
        internal static int HealthApi(string origin,string output)
        {
            try { var health=Ops.FetchHealth(origin).GetAwaiter().GetResult();var s=Ops.Summarize(new Snapshot(),health,DateTime.UtcNow);File.WriteAllText(output,Ops.Serialize(new{success=true,s.HealthState,s.HealthLabel,s.Process,s.Database}));return 0; }
            catch(Exception error){File.WriteAllText(output,Ops.Serialize(new{success=false,error=error.Message}));return 1;}
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
