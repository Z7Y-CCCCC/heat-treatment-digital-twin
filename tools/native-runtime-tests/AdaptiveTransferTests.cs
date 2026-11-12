using HeatTreatment.DigitalTwin.Runtime;
internal static partial class Program
{
    private static Task AdaptiveTransferGeometryMatches()
    {
        var path=new AdaptiveTransferPath();var home=new[]{0d,1.25,0};var source=new[]{.7,1.25,0};var direction=new[]{1d,0,0};var mouth=new[]{1.7,1.25,0};var normal=new[]{-1d,0,0};var seat=new[]{3d,1.25,0};var drive=new[]{1.085,0,0};var a=new double[3];
        Check(path.Build(home,source,direction,mouth,normal,seat,drive,.01,.01,2),path.Reason);Check(Math.Abs(path.MouthFraction-1.7/3)<1e-12&&path.BridgeMeters==0&&path.UncoveredMeters==0,"Original-stroke path differs from Three");
        path.Sample(0,a);Check(a.SequenceEqual(home),"Wrong cart home");path.Sample(path.MouthFraction,a);Check(a.SequenceEqual(mouth),"Path misses mouth");path.Sample(1,a);Check(a.SequenceEqual(seat),"Wrong inside seat");
        Check(!path.Build(home,source,direction,new[]{3d,1.25,0},normal,seat,drive,.01,.01,2),"Long extension was not rejected");path.Build(home,source,direction,mouth,normal,seat,drive,.01,.01,2);
        var candidate=new AdaptiveTransferPath();Check(candidate.Build(home,source,direction,mouth,normal,seat,drive,.01,.01,2)&&path.SameGeometry(candidate),"Identical geometry rejected");
        var shift=new Func<double[],double[]>(v=>new[]{v[0]+.01,v[1],v[2]});candidate.Build(shift(home),shift(source),direction,shift(mouth),normal,shift(seat),drive,.01,.01,2);Check(Math.Abs(path.MouthFraction-candidate.MouthFraction)<1e-12&&!path.SameGeometry(candidate),"Same fraction concealed changed datums");
        for(var sign=-1;sign<=1;sign+=2){var reflect=new Func<double[],double[]>(v=>new[]{v[0]*sign,v[1],v[2]});Check(path.Build(reflect(home),reflect(source),reflect(direction),reflect(mouth),reflect(normal),reflect(seat),reflect(drive),.01,.01,2),"Reflected path rejected");path.Sample(path.MouthFraction,a);Check(a.SequenceEqual(reflect(mouth)),"Reflected path differs");}
        Check(!path.Build(home,source,direction,mouth,normal,new[]{4d,2,0},drive,.01,.01,2),"Bridge bypassed height check");
        Check(!path.Build(home,source,direction,new[]{3d,1.25,.2},normal,seat,drive,.01,.01,2),"Bridge bypassed lateral check");
        Check(!path.Build(home,source,direction,mouth,direction,seat,drive,.01,.01,2),"Bridge bypassed facing check");
        Check(!path.Build(home,source,direction,mouth,normal,new[]{1d,1.25,0},drive,.01,.01,2),"Mouth is not between seats");
        path.Build(home,source,direction,mouth,normal,seat,drive,.01,.01,2);for(var i=0;i<100;i++)path.Sample(.5,a);var before=GC.GetAllocatedBytesForCurrentThread();for(var i=0;i<10000;i++)path.Sample(.5,a);Check(GC.GetAllocatedBytesForCurrentThread()==before,"Path sampling allocates per frame");
        return Task.CompletedTask;
    }
}
