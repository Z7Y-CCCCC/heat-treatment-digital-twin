using System;
namespace HeatTreatment.DigitalTwin.Runtime
{
    // Keep in parity with shared/transferCycle.mjs; shared trace fixtures test
    // both engines. This owns display time, never PLC writes or actual travel.
    public sealed class TransferCycleConfig
    {
        public double ExtendSeconds=4,LatchSeconds=.75,RetractSeconds=4,ConveySeconds=3,ConfirmTimeoutSeconds=10;
    }
    public struct TransferCycleInput
    {
        public bool Valid,Docked,Start,Pickup,SourcePresent,TargetPresent;
        public double MouthFraction;
    }
    public sealed class TransferCycleState
    {
        public string Phase="idle",Reason="等待进出料命令";
        public double Elapsed,Convey,Feed,Hook,Cargo;
        public bool Armed=true,Pickup,Confirmed,Paused;
        public bool Active => Phase!="idle"&&Phase!="done";
        private static double Clamp(double v)=>Math.Max(0,Math.Min(1,v));
        private static double Smooth(double v){v=Clamp(v);return v*v*(3-2*v);}
        public void Advance(TransferCycleInput input,double delta,TransferCycleConfig c)
        {
            Paused=false;
            if(double.IsNaN(input.MouthFraction)||double.IsInfinity(input.MouthFraction)||input.MouthFraction<0||input.MouthFraction>1){Paused=true;Reason="口位几何无效";return;}
            if(!input.Valid||!input.Docked){Paused=true;Reason=!input.Valid?"开关量反馈无效或过期，显示冻结":"尚未确认停靠或送料几何不可达";return;}
            if(!input.Start)Armed=true;
            if(Phase=="idle"||Phase=="done"){
                if(!input.Start||!Armed)return;
                if(input.Pickup?input.SourcePresent||!input.TargetPresent:!input.SourcePresent||input.TargetPresent){Reason="物料在位状态不满足本次取放命令";return;}
                Phase="extend";Elapsed=Convey=Feed=0;Armed=false;Pickup=input.Pickup;Hook=Pickup?1:0;Cargo=Pickup?1:0;Confirmed=false;
            }
            if(input.Pickup!=Pickup){Paused=true;Reason="取料/送料命令途中改变，显示冻结";return;}
            var remaining=!double.IsNaN(delta)&&!double.IsInfinity(delta)&&delta>0?delta:0;
            var mouth=Clamp(input.MouthFraction);
            for(var guard=0;guard<8;guard++){
                if(Phase=="wait"){
                    var confirmed=Pickup?input.SourcePresent&&!input.TargetPresent:!input.SourcePresent&&input.TargetPresent;
                    if(!confirmed){Elapsed+=remaining;Reason=Elapsed>=c.ConfirmTimeoutSeconds?"等待双方物料反馈确认（超时，保持机构）":"等待双方物料反馈确认";return;}
                    Confirmed=true;Phase="latch";Elapsed=0;
                }
                if(Phase=="done")return;
                var duration=Phase=="extend"?c.ExtendSeconds:Phase=="latch"?c.LatchSeconds:c.RetractSeconds;
                var used=Math.Min(remaining,Math.Max(0,duration-Elapsed));Elapsed+=used;remaining-=used;
                if(Phase!="extend")Convey+=used;
                var p=Smooth(Elapsed/duration);
                if(Phase=="extend"){
                    Feed=p;Hook=Pickup?1:0;Cargo=Pickup?1-(1-mouth)*p:mouth*p;Reason=Pickup?"取料：空钩伸出，设备辊道出料（显示估算）":"送料：推料进入设备口（显示估算）";
                }else if(Phase=="latch"){
                    Feed=1;Hook=Pickup?1-p:p;Cargo=Pickup?mouth:mouth+(1-mouth)*Smooth(Convey/c.ConveySeconds);Reason=Pickup?"双方反馈已确认，勾合物料":"双方反馈已确认，脱钩并由设备辊道接料";
                }else{
                    Feed=1-p;Hook=Pickup?0:1;Cargo=Pickup?mouth*(1-p):mouth+(1-mouth)*Smooth(Convey/c.ConveySeconds);Reason=Pickup?"取料：物料回车，机构退回（显示估算）":"送料：空钩退回，物料进入承料位（显示估算）";
                }
                if(Elapsed<duration)return;
                if(Phase=="extend"){Phase="wait";Elapsed=0;continue;}
                if(Phase=="latch"){Phase="retract";Elapsed=0;continue;}
                Phase="done";Feed=0;Cargo=Pickup?0:1;Reason=Pickup?"取料显示完成（双方在位反馈已确认）":"送料显示完成（双方在位反馈已确认）";return;
            }
        }
    }
}
