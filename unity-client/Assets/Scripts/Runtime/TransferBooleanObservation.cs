using System;
using System.Globalization;
using Newtonsoft.Json.Linq;
namespace HeatTreatment.DigitalTwin.Runtime
{
    // Owned BOOL observations, not an animation position. Bad typed/quality
    // reads are ordering barriers; replays never renew their original age.
    public sealed class TransferBooleanObservation
    {
        public bool Usable,HasSample,Value;
        public string Reason="等待开关量反馈";
        public double Timestamp=double.NaN,ReceivedAt=double.NegativeInfinity;
        private double _watermark=double.NaN,_sourceStaleMs=double.PositiveInfinity;
        private readonly string _device,_action,_item,_point,_group,_key;
        public TransferBooleanObservation(string device,string action,string item){_device=device;_action=action;_item=item;}
        public TransferBooleanObservation(string device,string point,string group,string key){_device=device;_point=point;_group=group;_key=key;}
        private static bool Finite(double n)=>!double.IsNaN(n)&&!double.IsInfinity(n);
        private static double Number(JToken t)=>t!=null&&t.Type!=JTokenType.Boolean&&double.TryParse(t.ToString(),NumberStyles.Float,CultureInfo.InvariantCulture,out var n)&&Finite(n)?n:double.NaN;
        private static bool Good(JToken t)=>t?.Type==JTokenType.String&&string.Equals(t.Value<string>(),"good",StringComparison.OrdinalIgnoreCase);
        public void Suspend(string why="采集连接中断"){Usable=false;Reason=why;}
        public void Receive(JObject frame,double now,double wallNow)
        {
            if(frame?.Value<bool?>("motionInputOnly")==true&&_point!=null)return;
            if(frame==null||frame.Value<string>("furnace_id")!=_device){Suspend("反馈设备不匹配");return;}
            JToken value,quality,stamp;var sourceStale=double.PositiveInfinity;var owned=false;var envelope=Number(frame["timestamp"]);
            if(_point==null){
                var input=(frame["motionInputs"] as JObject)?[_action] as JObject;owned=input?.Value<string>("dataItemId")==_item;
                value=input?["value"];quality=input?["quality"];stamp=input?["timestamp"];
                var timeout=Number(input?["staleMs"]);if(timeout>0)sourceStale=timeout;
            }else{
                var pointMeta=frame["pointMeta"] as JObject;var meta=pointMeta?[_group+"."+_key] as JObject;owned=meta?["id"]?.ToString()==_point;
                if(owned){var count=0;foreach(var p in pointMeta.Properties())if(p.Value is JObject row&&row["id"]?.ToString()==_point)count++;owned=count==1;}
                value=(frame[_group] as JObject)?[_key];quality=((frame["quality"] as JObject)?[_group] as JObject)?[_key];stamp=meta?["timestamp"];
                owned=owned&&meta?.Value<string>("category")==_group&&meta?.Value<string>("field_name")==_key
                    &&(frame["status"] as JObject)?["online"]?.ToString().Equals("false",StringComparison.OrdinalIgnoreCase)!=true;
            }
            var at=Number(stamp);
            if(!owned||!Finite(at)||at<=0||at>wallNow+1000||Finite(envelope)&&envelope>wallNow+1000){Suspend("开关量来源或时间无效");return;}
            if(Finite(_watermark)&&at<_watermark)return;
            _watermark=at;
            if(value?.Type!=JTokenType.Boolean||!Good(quality)){Suspend("开关量类型或质量无效");return;}
            var cached=frame["cachedAgeMs"]==null?0:Number(frame["cachedAgeMs"]);
            if(!Finite(cached)||cached<0){Suspend("缓存年龄无效");return;}
            var age=Math.Max(cached,Math.Max(0,Math.Max(wallNow,Finite(envelope)?envelope:wallNow)-at));
            ReceivedAt=Timestamp==at?Math.Min(ReceivedAt,now-age/1000):now-age/1000;
            Timestamp=at;_sourceStaleMs=sourceStale;Value=value.Value<bool>();HasSample=true;Usable=true;Reason="开关量反馈正常";
        }
        public bool Advance(double now,double staleMs){if(Usable&&(!Finite(now)||now-ReceivedAt>Math.Min(staleMs,_sourceStaleMs)/1000))Suspend("开关量反馈超时");return Usable&&HasSample;}
    }
}
