using HeatTreatment.DigitalTwin.Rendering;

internal static partial class Program
{
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
