using HeatTreatment.DigitalTwin.Runtime;
using Newtonsoft.Json.Linq;

internal static partial class Program
{
    private static Task SimpleCartUsesTwoSignals()
    {
        var device = LinkageMobile(); device.DataPoints[0].DataType = "WORD"; device.DataPoints[1].DataType = "BOOL";
        var signal = new SimpleStationMotionState(device, "1", "2");
        LinkageCheck(signal.Receive(LinkageFrame(1000000, 1, true), 0, 1000000, 5000) && signal.Confirmed, "Startup dock was not established from the two owned observations.");
        LinkageCheck(signal.Receive(LinkageFrame(1000100, 2, true), .1, 1000100, 5000) && signal.TargetChanged && !signal.Confirmed, "Held arrival from the previous station confirmed a new target.");
        var oldLow = LinkageFrame(1000200, 2, false); oldLow["pointMeta"]["motors.start"]["timestamp"] = 1000050;
        signal.Receive(oldLow, .2, 1000200, 5000);
        LinkageCheck(signal.Receive(LinkageFrame(1000300, 2, true), .3, 1000300, 5000) && !signal.Confirmed, "A low sample older than the new command armed its arrival.");
        signal.Receive(LinkageFrame(1000400, 2, false), .4, 1000400, 5000);
        LinkageCheck(signal.Receive(LinkageFrame(1000500, 2, true), .5, 1000500, 5000) && signal.Confirmed && signal.ArrivalChanged, "Fresh low/high arrival did not confirm the commanded station.");
        LinkageCheck(signal.Receive(LinkageFrame(1000550, 2, false), .55, 1000550, 5000) && signal.Confirmed,
            "The falling edge of a captured arrival pulse erased the completed trip.");
        signal.Receive(LinkageFrame(1000550, 2, false), .8, 1000800, 5000);
        LinkageCheck(!signal.TargetChanged && !signal.ArrivalChanged, "Repeated state restarted visual movement or alignment.");
        LinkageCheck(!signal.Advance(5.6, 5000) && !signal.Confirmed, "Cached arrival renewed a stale docking observation.");
        var bad = LinkageFrame(1000600, 2, true); bad["quality"]["motors"]["start"] = "bad";
        LinkageCheck(!signal.Receive(bad, .6, 1000600, 5000), "Bad arrival quality remained usable.");
        var numeric = LinkageFrame(1000700, 2, true); numeric["motors"]["start"] = 1;
        LinkageCheck(!signal.Receive(numeric, .7, 1000700, 5000), "Numeric payload masqueraded as a BOOL arrival.");
        var wrong = LinkageFrame(1000800, 2, true); wrong["furnace_id"] = "another-cart";
        LinkageCheck(!signal.Receive(wrong, .8, 1000800, 5000), "Another device's arrival was accepted.");
        device.DataPoints[1].DataType = "WORD";
        LinkageCheck(!new SimpleStationMotionState(device, "1", "2").Receive(LinkageFrame(1000000), 0, 1000000, 5000), "An arrival number was accepted instead of the configured BOOL.");
        device.DataPoints[1].DataType = "BOOL"; device.DataPoints[0].DataType = "STRING";
        LinkageCheck(!new SimpleStationMotionState(device, "1", "2").Receive(LinkageFrame(1000000), 0, 1000000, 5000), "A text target definition masqueraded as a configured numeric point.");
        LinkageCheck(SimpleStationMotionState.TravelSeconds == 3 && SimpleStationMotionState.ArrivalSeconds == .6, "Display-only timings require physical calibration.");
        var sameDockDevice=LinkageMobile();sameDockDevice.DataPoints[0].DataType="WORD";sameDockDevice.DataPoints[1].DataType="BOOL";
        var turntable=new SimpleStationMotionState(sameDockDevice,"1","2");turntable.Receive(LinkageFrame(1000000,1,true),0,1000000,5000);
        turntable.Receive(LinkageFrame(1000100,1,false),.1,1000100,5000);
        LinkageCheck(turntable.Receive(LinkageFrame(1000200,2,false),.2,1000200,5000,(before,after)=>before==1&&after==2)&&turntable.Confirmed,"Opposite-side work at the same confirmed parking position demanded a new arrival pulse.");
        turntable.Receive(LinkageFrame(1000300,3,true),.3,1000300,5000,(before,after)=>false);
        LinkageCheck(!turntable.Confirmed,"A different physical parking inherited same-dock confirmation.");
        return Task.CompletedTask;
    }
}
