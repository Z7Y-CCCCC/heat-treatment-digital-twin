using System;
namespace HeatTreatment.DigitalTwin.Runtime
{
    // Metre-space display geometry, kept in parity with shared/adaptiveTransferPath.mjs.
    public sealed class AdaptiveTransferPath
    {
        public bool Usable;
        public string Reason;
        public readonly double[] Home=new double[3],Source=new double[3],Mouth=new double[3],Seat=new double[3],Direction=new double[3];
        private readonly double[] _normal=new double[3],_drive=new double[3];
        public double GapMeters,StrokeMeters,BridgeMeters,UncoveredMeters,MouthFraction,TotalMeters;
        private static bool Finite(double n)=>!double.IsNaN(n)&&!double.IsInfinity(n);
        private static bool Vector(double[] v)=>v?.Length==3&&Finite(v[0])&&Finite(v[1])&&Finite(v[2]);
        private static double Norm(double x,double y,double z){var m=Math.Max(Math.Abs(x),Math.Max(Math.Abs(y),Math.Abs(z)));if(m==0)return 0;x/=m;y/=m;z/=m;return m*Math.Sqrt(x*x+y*y+z*z);}
        private static bool Unit(double[] v,double[] output){var n=Norm(v[0],v[1],v[2]);if(!Finite(n)||n<1e-8)return false;for(var i=0;i<3;i++)output[i]=v[i]/n;return true;}
        private static double Dot(double[] a,double[] b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
        private static double Angle(double cosine)=>Math.Acos(Math.Max(-1,Math.Min(1,cosine)))*180/Math.PI;
        private bool Fail(string reason){Reason=reason;return false;}
        private bool CheckPoint(double[] point,double[] source,double height,double lateral)
        {
            var x=point[0]-source[0];var y=point[1]-source[1];var z=point[2]-source[2];var along=x*Direction[0]+y*Direction[1]+z*Direction[2];
            if(Math.Abs(y)>height+.000001)return Fail("车上、设备口与内部承料面高度不一致");
            if(Norm(x-Direction[0]*along,0,z-Direction[2]*along)>lateral+.000001)return Fail("承料位或设备口存在侧向偏差，不能用示意桥绕过");
            return true;
        }
        public bool Build(double[] home,double[] source,double[] sourceDirection,double[] mouth,double[] targetDirection,double[] seat,double[] maximumDrive,double height,double lateral,double angle)
        {
            Usable=false;Reason="示意交接坐标无效";
            if(!Vector(home)||!Vector(source)||!Vector(sourceDirection)||!Vector(mouth)||!Vector(targetDirection)||!Vector(seat)||!Vector(maximumDrive))return false;
            if(!Finite(height)||height<0||height>1||!Finite(lateral)||lateral<0||lateral>1||!Finite(angle)||angle<0||angle>30)return Fail("示意交接公差无效");
            if(!Unit(sourceDirection,Direction)||!Unit(targetDirection,_normal)||!Unit(maximumDrive,_drive))return Fail("交接方向无效");
            if(Math.Abs(Direction[1])>.0001||Math.Abs(_normal[1])>.0001||Math.Abs(_drive[1])>.0001)return Fail("示意送料方向不是水平直线");
            if(Math.Max(Angle(-Dot(Direction,_normal)),Angle(Dot(Direction,_drive)))>angle+.0001)return Fail("进出料口或送料机构方向不相对");
            var gap=(mouth[0]-source[0])*Direction[0]+(mouth[1]-source[1])*Direction[1]+(mouth[2]-source[2])*Direction[2];var stroke=Dot(maximumDrive,Direction);
            if(!Finite(gap)||!Finite(stroke)||gap<-.0001||stroke<=0)return Fail("目标设备在送料方向后方");
            if(gap>stroke+.0001)return Fail("设备距离过远，请缩短设备与小车间距；已取消延长送料桥");
            if(!CheckPoint(home,source,height,lateral)||!CheckPoint(mouth,source,height,lateral)||!CheckPoint(seat,source,height,lateral))return false;
            var first=Norm(mouth[0]-home[0],mouth[1]-home[1],mouth[2]-home[2]);var second=Norm(seat[0]-mouth[0],seat[1]-mouth[1],seat[2]-mouth[2]);
            var firstAlong=(mouth[0]-home[0])*Direction[0]+(mouth[1]-home[1])*Direction[1]+(mouth[2]-home[2])*Direction[2];
            var secondAlong=(seat[0]-mouth[0])*Direction[0]+(seat[1]-mouth[1])*Direction[1]+(seat[2]-mouth[2])*Direction[2];
            if(firstAlong<=.0001||secondAlong<=.0001||!Finite(first+second))return Fail("设备口必须位于车上承料位与设备内承料位之间");
            Array.Copy(home,Home,3);Array.Copy(source,Source,3);Array.Copy(mouth,Mouth,3);Array.Copy(seat,Seat,3);
            GapMeters=Math.Max(0,gap);StrokeMeters=stroke;BridgeMeters=0;UncoveredMeters=0;TotalMeters=first+second;MouthFraction=first/TotalMeters;
            Usable=true;Reason="原机构交接路径有效";return true;
        }
        public void Sample(double progress,double[] output)
        {
            if(!Usable||!Finite(progress)||output?.Length!=3)throw new InvalidOperationException("物料路径进度无效");
            var p=Math.Max(0,Math.Min(1,progress));var before=p<=MouthFraction;var from=before?Home:Mouth;var to=before?Mouth:Seat;var t=before?p/MouthFraction:(p-MouthFraction)/(1-MouthFraction);
            for(var i=0;i<3;i++)output[i]=from[i]+(to[i]-from[i])*t;
        }
        public bool SameGeometry(AdaptiveTransferPath other,double tolerance=.0001)
        {
            if(!Usable||other==null||!other.Usable||!Finite(tolerance)||tolerance<0)return false;
            for(var i=0;i<3;i++)if(Math.Abs(Home[i]-other.Home[i])>tolerance||Math.Abs(Source[i]-other.Source[i])>tolerance||Math.Abs(Mouth[i]-other.Mouth[i])>tolerance||Math.Abs(Seat[i]-other.Seat[i])>tolerance||Math.Abs(Direction[i]-other.Direction[i])>tolerance)return false;
            return Math.Abs(GapMeters-other.GapMeters)<=tolerance&&Math.Abs(StrokeMeters-other.StrokeMeters)<=tolerance&&Math.Abs(MouthFraction-other.MouthFraction)<=tolerance;
        }
    }
}
