using HeatTreatment.DigitalTwin.Rendering;

internal static partial class Program
{
    private static Task WheelZoomIsResponsiveAndBounded()
    {
        float Zoom(float distance, float detents, float multiplier = 1f) => OrbitCameraMotion.WheelDistance(distance, detents, .22f * multiplier, .3f, 1000f);
        var normal = Zoom(100f, 1f);
        Check(normal > 79f && normal < 81f, "one detent must close about 20 percent, not the legacy 10 percent");
        Check(Zoom(100f, 4f) < 50f, "four normal detents must more than halve the distance");
        Check(Zoom(100f, 1f, 2.5f) < normal && Zoom(100f, 1f, .25f) > normal, "Shift acceleration and Ctrl fine mode must differ from normal");
        var split = 100f;
        for (var i = 0; i < 10; i++) split = Zoom(split, .1f);
        Check(Math.Abs(split - normal) < .0001f, "fractional touchpad wheel samples must not be lost or accelerated");
        Check(Math.Abs(Zoom(normal, -1f) - 100f) < .0001f, "opposite detents must reverse without zoom drift");
        Check(Zoom(.3f, 1f) == .3f && Zoom(1000f, -1f) == 1000f, "zoom must respect near and far limits");
        Check(Zoom(.3f, -1f) > .3f && Zoom(1000f, 1f) < 1000f, "zoom must immediately reverse away from either limit");
        foreach (var invalid in new[] { float.NaN, float.NegativeInfinity, float.PositiveInfinity })
            Check(Zoom(100f, invalid) == 100f, "invalid wheel samples cannot poison camera coordinates");
        Check(Zoom(100f, 0) == 100f, "no wheel input must not move the camera");
        Check(Zoom(100f, 10000f) > 20f && Zoom(100f, -10000f) < 450f, "a broken device's huge single delta must stay bounded");
        return Task.CompletedTask;
    }

    private static Task OrbitRetainsWinding()
    {
        // Old LerpAngle chooses -120 instead of the user's +240 degree input.
        foreach (var direction in new[] { -1f, 1f })
        {
            var current = 170f * direction;
            var desired = current + 240f * direction;
            var before = current;
            OrbitCameraMotion.StepYaw(ref current, ref desired, .1f);
            Check(Math.Abs(OrbitCameraMotion.NearestYaw(before, current) - before - 24f * direction) < .001f,
                "fast large drag reversed across the shortest-angle boundary");
            for (var frame = 0; frame < 50000; frame++)
            {
                before = current;
                desired += 7f * direction;
                OrbitCameraMotion.StepYaw(ref current, ref desired, .4f);
                var delta = OrbitCameraMotion.NearestYaw(before, current) - before;
                Check(delta * direction > 0f && Math.Abs(delta) <= 90.001f, "continuous orbit reversed or jumped");
                Check(current >= -180f && current < 180f, "yaw must stay numerically bounded");
            }
            for (var frame = 0; frame < 100; frame++) OrbitCameraMotion.StepYaw(ref current, ref desired, .5f);
            Check(Math.Abs(current - desired) < .001f, "release must settle at the last manual target");
            var settled = current;
            for (var frame = 0; frame < 1000; frame++) OrbitCameraMotion.StepYaw(ref current, ref desired, .1f);
            Check(Math.Abs(current - settled) < .001f, "idle recentered the user's orbit");
        }
        Check(Math.Abs(OrbitCameraMotion.NearestYaw(179, -179) - 181) < .001f, "explicit navigation should use a short 2-degree route");
        Check(Math.Abs(OrbitCameraMotion.NearestYaw(-179, 179) + 181) < .001f, "reverse navigation should take the short route");
        return Task.CompletedTask;
    }

    private static Task WorldClickRetainsGesture()
    {
        var click = new PointerClickGesture();
        click.Begin(100, 100, true); click.Move(300, 100); click.Move(100, 100);
        Check(!click.End(100, 100, true), "out-and-back orbit was interpreted as a click");
        click.Begin(100, 100, true);
        Check(!click.End(150, 100, true), "release displacement must also count on a low-FPS frame");
        click.Begin(100, 100, false);
        Check(!click.End(100, 100, true), "gesture beginning on a HUD cannot select the scene");
        click.Begin(100, 100, true); click.Cancel();
        Check(!click.End(100, 100, true), "lost focus must cancel the click");
        click.Begin(100, 100, true);
        Check(click.End(102, 101, true), "small normal click must remain selectable");
        Check(!click.End(102, 101, true), "release cannot fire twice");
        return Task.CompletedTask;
    }
}
