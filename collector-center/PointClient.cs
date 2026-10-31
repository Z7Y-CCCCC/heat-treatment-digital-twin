using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace HeatTreatmentCollectorCenter
{
    internal sealed class PointClient : IDisposable
    {
        readonly HttpClient client;
        internal readonly string Origin;
        internal bool LoggedIn;
        internal string Csrf="";
        internal PointClient(string origin)
        {
            if(!System.Text.RegularExpressions.Regex.IsMatch(origin,@"^http://127\.0\.0\.1:\d+$")) throw new InvalidDataException("只允许本机后台");
            Origin=origin;
            client=new HttpClient(new HttpClientHandler { CookieContainer=new CookieContainer(),UseCookies=true,UseProxy=false,AllowAutoRedirect=false }) { Timeout=TimeSpan.FromSeconds(8) };
        }
        async Task<object> Request(string route,string method="GET",object body=null)
        {
            if(!route.StartsWith("/api/",StringComparison.Ordinal) || route.Contains("\r") || route.Contains("\n")) throw new InvalidDataException("接口地址无效");
            using(var cancel=new CancellationTokenSource(TimeSpan.FromSeconds(8)))
            using(var request=new HttpRequestMessage(new HttpMethod(method),Origin+route)) {
                request.Headers.TryAddWithoutValidation("Origin",Origin); request.Headers.TryAddWithoutValidation("X-Admin-Request","1");
                if(Csrf!="" && method!="GET") request.Headers.TryAddWithoutValidation("X-CSRF-Token",Csrf);
                if(body!=null) request.Content=new StringContent(Ops.Serialize(body),Encoding.UTF8,"application/json");
                using(var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancel.Token).ConfigureAwait(false))
                using(var stream=await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using(var memory=new MemoryStream()) {
                    var buffer=new byte[8192]; int count;
                    while((count=await stream.ReadAsync(buffer,0,buffer.Length,cancel.Token).ConfigureAwait(false))>0) {
                        if(memory.Length+count>4*1024*1024) throw new InvalidDataException("点位响应过大，请选择单台设备"); memory.Write(buffer,0,count);
                    }
                    var result=Ops.Parse(Encoding.UTF8.GetString(memory.ToArray()));
                    if(!response.IsSuccessStatusCode) {
                        if(response.StatusCode==HttpStatusCode.Unauthorized) { LoggedIn=false; Csrf=""; }
                        throw new InvalidOperationException(Ops.Redact(Ops.Str(result,"error")=="" ? "后台接口 "+(int)response.StatusCode : Ops.Str(result,"error")));
                    }
                    return result;
                }
            }
        }
        internal async Task Login(string username,string password)
        {
            var data=await Request("/api/admin-auth/login","POST",new { username,password }).ConfigureAwait(false);
            LoggedIn=Ops.Yes(Ops.Get(data,"authenticated")) || Ops.Yes(Ops.Get(data,"displayAuthenticated")); Csrf=Ops.Str(data,"csrfToken");
            if(!LoggedIn) throw new InvalidOperationException("请使用已启用的后台账号登录");
        }
        internal async Task Logout()
        {
            try { if(LoggedIn) await Request("/api/admin-auth/accounts/logout","POST",new {}).ConfigureAwait(false); }
            finally { LoggedIn=false; Csrf=""; }
        }
        internal Task<object> Factories() { return Request("/api/factories"); }
        internal Task<object> Devices(string factory) { return Request("/api/devices?factory_id="+Uri.EscapeDataString(factory)); }
        internal Task<object> Points(string factory,string device) { return Request("/api/plc/points/realtime?factory_id="+Uri.EscapeDataString(factory)+"&device_id="+Uri.EscapeDataString(device)); }
        public void Dispose() { LoggedIn=false; Csrf=""; client.Dispose(); }
    }
    internal sealed class Choice
    {
        internal string Id,Name;
        public override string ToString() { return Name; }
    }
    internal sealed class PointRow
    {
        internal string Name,Address,Type,Value,Quality,Time,Unit;
        internal static List<PointRow> From(object result)
        {
            return Ops.Items(Ops.Get(result,"points")).Take(10000).Select(p=>{
                string quality=Ops.Str(p,"quality"); object value=Ops.Get(p,"value");
                string address=Ops.Str(p,"plc_tag");
                if(address=="" && Ops.Get(p,"db_number")!=null && Ops.Get(p,"db_byte_offset")!=null) address="DB"+Ops.Str(p,"db_number")+" / 字节 "+Ops.Str(p,"db_byte_offset")+(Ops.Str(p,"data_type")=="BOOL" ? " / 位 "+Ops.Str(p,"bit_offset") : "");
                string name=Ops.Str(p,"label"); if(name=="") name=Ops.Str(p,"name");
                string timestamp=Ops.Str(p,"lastReadAt"); DateTime parsed; double epoch;
                string time=DateTime.TryParse(timestamp,null,System.Globalization.DateTimeStyles.RoundtripKind,out parsed) ? parsed.ToLocalTime().ToString("HH:mm:ss")
                    : double.TryParse(timestamp,out epoch) && epoch>0 && epoch<253402300799000 ? new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddMilliseconds(epoch).ToLocalTime().ToString("HH:mm:ss") : "—";
                return new PointRow { Name=name,Address=address=="" ? "未配置" : address,Type=Ops.Str(p,"data_type"),Unit=Ops.Str(p,"unit"),
                    Value=value==null || quality=="bad" || quality=="stale" ? "—" : value is bool ? ((bool)value ? "1" : "0") : Ops.Text(value),
                    Quality=quality=="good" ? "有效" : quality=="bad" ? "无效" : quality=="stale" ? "过期" : quality=="" ? "未知" : quality,Time=time };
            }).ToList();
        }
    }
}
