using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Linq;
using System.Net.Http;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace HeatTreatmentCollectorCenter
{
    internal sealed class Snapshot
    {
        public string Service="未安装", Api="不可达", Database="未知", Mode="未知", Collection="暂无采样", Process="—", Error="", Root="", Origin="http://127.0.0.1:3001";
        public bool Installed, Running, Healthy;
        public string HealthState="offline",HealthLabel="等待采集进程";
        public int Normal=-1,Abnormal=-1;
        public DateTime CheckedAt=DateTime.Now;
    }
    internal sealed class LogLine
    {
        public string Time, Level, File, Message;
        public DateTime? Timestamp;
    }
    internal static class Ops
    {
        internal const string ServiceName="HeatTreatmentCollector";
        internal static readonly string ConfigFile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"HeatTreatmentDigitalTwin","collector-service.json");
        internal static readonly string InstallRoot=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..",".."));
        internal static readonly string[] LogFiles={"service-host.log","backend.log","backend-error.log","operations.log"};
        static readonly HttpClient Client=new HttpClient(new HttpClientHandler { UseProxy=false, AllowAutoRedirect=false }) { Timeout=TimeSpan.FromSeconds(3) };
        static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength=4*1024*1024, RecursionLimit=64 }; }
        internal static object Parse(string text) { return Json().DeserializeObject(text.TrimStart('\uFEFF')); }
        internal static string Serialize(object value) { return Json().Serialize(value); }
        internal static object Get(object value,string key) { var d=value as IDictionary<string,object>; return d!=null && d.ContainsKey(key) ? d[key] : null; }
        internal static string Text(object value) { return value==null ? "" : Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture); }
        internal static string Str(object value,string key) { return Text(Get(value,key)); }
        internal static double Num(object value) { double n; return double.TryParse(Text(value),System.Globalization.NumberStyles.Any,System.Globalization.CultureInfo.InvariantCulture,out n) ? n : 0; }
        internal static IEnumerable<object> Items(object value) { return value as object[] ?? Enumerable.Empty<object>(); }
        internal static bool Yes(object value) { return value is bool && (bool)value; }
        internal static string Redact(string text)
        {
            text=Regex.Replace(text??"",@"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)","[REDACTED PRIVATE KEY]");
            text=Regex.Replace(text,@"\b([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@","$1[REDACTED]@",RegexOptions.IgnoreCase);
            text=Regex.Replace(text,@"\b((?:Proxy-)?Authorization\s*[:=]\s*)(?:Basic|Bearer)\s+[^\s\x22',;]+","$1[REDACTED]",RegexOptions.IgnoreCase);
            text=Regex.Replace(text,@"\b(Bearer\s+)[^\s,;\x22']+","$1[REDACTED]",RegexOptions.IgnoreCase);
            text=Regex.Replace(text,@"((?:[\x22']?)(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|api[_-]?key|private[_-]?key|authorization|cookie|set-cookie)(?:[\x22']?)\s*[:=]\s*)(\x22(?:\\.|[^\x22\\])*\x22|'(?:\\.|[^'\\])*'|[^\s,;}]+)","$1\"[REDACTED]\"",RegexOptions.IgnoreCase);
            return Regex.Replace(text,@"^[A-Za-z0-9+/]{64,}={0,2}$","[REDACTED KEY MATERIAL]",RegexOptions.Multiline);
        }
        internal static object ReadConfig() { return File.Exists(ConfigFile) ? Parse(File.ReadAllText(ConfigFile,Encoding.UTF8)) : null; }
        internal static string Origin(object config)
        {
            var port=Get(config,"port")==null ? 3001 : (int)Num(Get(config,"port"));
            if(port<1024 || port>65535) throw new InvalidDataException("服务端口无效");
            return "http://127.0.0.1:"+port;
        }
        internal static async Task<object> FetchHealth(string origin)
        {
            if(!Regex.IsMatch(origin,@"^http://127\.0\.0\.1:\d+$")) throw new InvalidDataException("只允许本机地址");
            using(var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(3)))
            using(var response=await Client.GetAsync(origin+"/api/health",HttpCompletionOption.ResponseHeadersRead,cancel.Token).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                using(var stream=await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using(var memory=new MemoryStream())
                {
                    var buffer=new byte[8192]; int count;
                    while((count=await stream.ReadAsync(buffer,0,buffer.Length,cancel.Token).ConfigureAwait(false))>0)
                    { if(memory.Length+count>1024*1024) throw new InvalidDataException("健康响应过大"); memory.Write(buffer,0,count); }
                    var health=Parse(Encoding.UTF8.GetString(memory.ToArray()));
                    if(Str(health,"status")!="ok" || Get(Get(health,"components"),"dataEngine")==null || Get(health,"db")==null) throw new InvalidDataException("端口不是采集服务");
                    return health;
                }
            }
        }
        internal static Snapshot Summarize(Snapshot s,object health,DateTime now)
        {
            var observed=Get(health,"collectorHealth");
            if(observed!=null) {
                s.HealthState=Str(observed,"state");s.HealthLabel=Str(observed,"label");
                s.Healthy=s.HealthState=="healthy" || s.HealthState=="simulation";
                s.Normal=(int)Num(Get(Get(observed,"counts"),"normal"));s.Abnormal=(int)Num(Get(Get(observed,"counts"),"abnormal"));
                s.Api="可达";s.Database=Yes(Get(Get(health,"db"),"connected"))?"已连接":"异常";
                var observedModes=Items(Get(health,"collectorFactories")).Select(f=>Str(f,"mode")).Where(x=>x!="").Distinct().ToArray();
                if(observedModes.Length==0)observedModes=new[]{Str(Get(health,"engine"),"mode")};
                s.Mode=observedModes.All(x=>x=="")?"未运行":observedModes.Length>1?"混合来源":observedModes.Contains("simulation")?"模拟演示":"现场采集";
                double sampleAge=Get(observed,"lastSampleAgeMs")==null?double.PositiveInfinity:Num(Get(observed,"lastSampleAgeMs"));
                s.Collection=double.IsInfinity(sampleAge)?"—":sampleAge<1000?"刚刚":(sampleAge/1000).ToString("0.0")+" 秒前";
                var process=Get(observed,"process");
                s.Process=Get(process,"pid")==null?"未运行":"PID "+Str(process,"pid")+(Get(process,"memoryRssBytes")==null?"":" · "+(Num(Get(process,"memoryRssBytes"))/1048576).ToString("0")+" MB");
                s.Error=Redact(Str(observed,"reason")); return s;
            }
            var engine=Get(health,"engine"); var proc=Get(engine,"process");
            var factories=Items(Get(health,"collectorFactories")).ToArray();
            if(factories.Length==0) factories=new[]{engine};
            var modes=factories.Select(f=>Str(f,"mode")).Where(x=>x!="").Distinct().ToArray();
            s.Mode=modes.Length>1 ? "混合（含模拟）" : modes.Contains("simulation") ? "模拟数据" : modes.Length>0 ? "现场 PLC" : "未知";
            var states=factories.Select(f=>Get(f,"collectorStatus")).ToArray();
            var times=states.Select(c=>Num(Get(c,"lastFrameAt"))).ToArray();
            double age=times.Length>0 && times.All(t=>t>0) ? Math.Max(0,(now.ToUniversalTime()-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds-times.Min()) : double.PositiveInfinity;
            bool processReady=Str(proc,"status")=="running";
            bool engineReady=states.All(c=>new[]{"connected","simulating"}.Contains(Str(c,"status")));
            bool databaseReady=Yes(Get(Get(health,"db"),"connected"));
            var failures=Items(Get(Get(health,"readiness"),"failures")).Select(Text).Where(x=>!new[]{"unity","database","data_engine","data_freshness"}.Contains(x)).ToArray();
            var devices=factories.SelectMany(f=>Items(Get(f,"devices"))).ToArray();
            bool devicesReady=!devices.Any(d=>Str(d,"status")!="disabled" && (new[]{"bad","stale"}.Contains(Str(d,"quality")) || new[]{"offline","error","disconnected"}.Contains(Str(d,"status"))));
            s.Healthy=databaseReady && processReady && engineReady && devicesReady && age<=15000 && failures.Length==0;
            s.Api="可达"; s.Database=databaseReady ? "已连接" : "异常";
            s.Collection=double.IsInfinity(age) ? "暂无采样" : age>15000 ? "采样过期" : (age/1000).ToString("0.0")+" 秒前";
            s.Process=Get(proc,"pid")==null ? "未运行" : "PID "+Text(Get(proc,"pid"))+"  ·  恢复 "+Text(Get(proc,"restartCount"))+" 次";
            s.Error=Redact(Str(proc,"lastError"));
            if(!devicesReady) s.Error="部分设备连接或数据质量异常";
            if(failures.Length>0) s.Error="需检查："+string.Join("、",failures);
            s.HealthLabel=s.Healthy?"采集正常":"采集需检查";s.HealthState=s.Healthy?"healthy":"degraded";
            return s;
        }
        internal static async Task<Snapshot> Status()
        {
            var s=new Snapshot();
            try {
                using(var controller=new ServiceController(ServiceName)) {
                    var state=controller.Status; s.Installed=true; s.Running=state==ServiceControllerStatus.Running;
                    s.Service=state==ServiceControllerStatus.Running ? "运行中" : state==ServiceControllerStatus.Stopped ? "已停止" : state==ServiceControllerStatus.StartPending ? "启动中" : state==ServiceControllerStatus.StopPending ? "停止中" : state.ToString();
                }
            } catch(InvalidOperationException ex) {
                var native=ex.InnerException as Win32Exception;
                if(native==null || native.NativeErrorCode!=1060) { s.Service="无法查询"; s.Error=Redact(ex.Message); }
            } catch(Exception ex) { s.Service="无法查询"; s.Error=Redact(ex.Message); }
            object config=null;
            try { config=ReadConfig(); s.Root=Str(config,"root"); s.Origin=Origin(config); }
            catch(Exception error) { s.Error=Redact(error.Message); return s; }
            // A development/application-owned collector can be alive without an
            // installed SCM service. Detect it; never claim boot collection exists.
            if(config==null && s.Installed && s.Running) { s.Error="服务配置丢失"; return s; }
            try { Summarize(s,await FetchHealth(s.Origin).ConfigureAwait(false),DateTime.UtcNow); }
            catch(Exception error) { s.Error=Redact(error is TaskCanceledException ? "管理接口超时" : error.Message); }
            return s;
        }
        internal static string ReadTail(string filename)
        {
            if((File.GetAttributes(filename)&FileAttributes.ReparsePoint)!=0) throw new IOException("拒绝读取链接日志");
            using(var file=new FileStream(filename,FileMode.Open,FileAccess.Read,FileShare.ReadWrite)) {
                int length=(int)Math.Min(file.Length,131072); long offset=file.Length-length;
                file.Seek(offset,SeekOrigin.Begin); var bytes=new byte[length]; int read=0,n;
                while(read<length && (n=file.Read(bytes,read,length-read))>0) read+=n;
                var text=Encoding.UTF8.GetString(bytes,0,read);
                if(offset>0) { int line=text.IndexOf('\n'); text=line<0 ? "" : text.Substring(line+1); }
                return Redact(text);
            }
        }
        internal static List<LogLine> ParseLogs(IEnumerable<KeyValuePair<string,string>> files)
        {
            var entries=new List<LogLine>();
            foreach(var pair in files.Where(f=>LogFiles.Contains(f.Key))) {
                foreach(var raw in Redact(pair.Value).Split(new[]{'\n'},StringSplitOptions.RemoveEmptyEntries).Reverse().Take(500).Reverse()) {
                    var message=raw.TrimEnd('\r'); object item=null;
                    try { item=Parse(message); } catch { }
                    string timestamp=Str(item,"timestamp");
                    if(timestamp=="") { var match=Regex.Match(message,@"\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?"); timestamp=match.Success ? match.Value : ""; }
                    DateTime date; DateTime? parsed=DateTime.TryParse(timestamp,null,System.Globalization.DateTimeStyles.RoundtripKind,out date) ? (DateTime?)date.ToLocalTime() : null;
                    string level=Str(item,"level");
                    if(level=="") level=pair.Key=="backend-error.log" || Regex.IsMatch(message,@"\b(error|failed|failure|exception)\b|错误|失败|异常",RegexOptions.IgnoreCase) ? "ERROR" : Regex.IsMatch(message,@"\b(warn|warning)\b|警告",RegexOptions.IgnoreCase) ? "WARN" : "INFO";
                    entries.Add(new LogLine { Time=parsed.HasValue ? parsed.Value.ToString("MM-dd HH:mm:ss") : "—",Timestamp=parsed, Level=level.ToUpperInvariant(),File=pair.Key,Message=message.Length>12000 ? message.Substring(0,12000) : message });
                }
            }
            return entries.OrderBy(e=>e.Timestamp??DateTime.MinValue).Skip(Math.Max(0,entries.Count-1600)).ToList();
        }
        internal static List<LogLine> Logs()
        {
            var config=ReadConfig(); string root=Str(config,"root");
            if(root=="") return new List<LogLine>();
            string logs=Path.Combine(root,"logs");
            foreach(var dir in new[]{root,logs}) if(Directory.Exists(dir) && (File.GetAttributes(dir)&FileAttributes.ReparsePoint)!=0) throw new IOException("拒绝读取链接目录");
            var files=new List<KeyValuePair<string,string>>();
            try { Directory.GetFiles(logs); } catch(DirectoryNotFoundException) { return new List<LogLine>(); }
            foreach(var name in LogFiles) {
                var file=Path.Combine(logs,name);
                if(File.Exists(file)) files.Add(new KeyValuePair<string,string>(name,ReadTail(file)));
            }
            return ParseLogs(files);
        }
        internal static async Task<object> Elevated(string action)
        {
            if(!new[]{"logs","install","start","stop","restart"}.Contains(action)) throw new InvalidOperationException("不支持的操作");
            string script=Path.Combine(InstallRoot,"collector-operations.ps1");
            if(!File.Exists(script)) throw new FileNotFoundException("请使用完整安装包安装服务",script);
            string name="HeatTreatmentOps-"+Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N").Substring(0,16);
            var security=new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
            using(var cancel=new CancellationTokenSource(TimeSpan.FromMinutes(5)))
            using(var pipe=new NamedPipeServerStream(name,PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security))
            {
                string code="& '"+script.Replace("'","''")+"' -Action '"+action+"' -PipeName '"+name+"'";
                string args="-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(code));
                var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),args) { UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden };
                using(var process=await Task.Run(()=>Process.Start(info)).ConfigureAwait(false)) {
                    var connect=pipe.WaitForConnectionAsync(cancel.Token);
                    var exited=Task.Run(()=>process.WaitForExit());
                    if(await Task.WhenAny(connect,exited).ConfigureAwait(false)==exited && !connect.IsCompleted) throw new InvalidOperationException("授权操作未返回结果");
                    await connect.ConfigureAwait(false);
                    using(var memory=new MemoryStream()) {
                        var buffer=new byte[8192]; int n;
                        while((n=await pipe.ReadAsync(buffer,0,buffer.Length,cancel.Token).ConfigureAwait(false))>0) { if(memory.Length+n>2*1024*1024) throw new InvalidDataException("响应过大"); memory.Write(buffer,0,n); }
                        var result=Parse(Encoding.UTF8.GetString(memory.ToArray()));
                        if(!Yes(Get(result,"success"))) throw new InvalidOperationException(Redact(Str(result,"error")));
                        return result;
                    }
                }
            }
        }
        internal static void Export(string file,Snapshot snapshot,List<LogLine> logs,string logError)
        {
            var report=new { formatVersion=1,exportedAt=DateTime.UtcNow.ToString("o"),snapshot,
                logs=logs.Select(x=>new {time=x.Time,level=x.Level,file=x.File,message=Redact(x.Message)}).ToArray(),logError=Redact(logError) };
            byte[] bytes=Encoding.UTF8.GetBytes(Serialize(report));
            if(bytes.Length>4*1024*1024) throw new InvalidDataException("诊断内容过大");
            using(var output=File.Create(file)) using(var gzip=new GZipStream(output,CompressionMode.Compress)) gzip.Write(bytes,0,bytes.Length);
        }
    }
}
