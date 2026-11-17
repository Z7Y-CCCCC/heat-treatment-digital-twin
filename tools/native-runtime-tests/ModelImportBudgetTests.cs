using HeatTreatment.DigitalTwin.Rendering;

internal static partial class Program
{
    private static async Task ModelImportBudgetRemainsCooperative()
    {
        double now = 0; var yields = 0;
        var agent = new ModelImportDeferAgent(clock: () => now, yield: () => { yields++; now += 10; return Task.CompletedTask; });
        if (agent.ShouldDefer()) throw new Exception("Fresh import slice should have a work budget");
        await agent.BreakPoint();
        if (yields != 0) throw new Exception("Small import steps must not yield a whole frame each");
        now += .009;
        if (!agent.ShouldDefer()) throw new Exception("Long import work must yield");
        await agent.BreakPoint();
        if (yields != 1 || agent.ShouldDefer()) throw new Exception("A busy intervening frame must not consume the new import work slice");
        if (!agent.ShouldDefer(1) || !agent.ShouldDefer(float.NaN)) throw new Exception("Predicted long/invalid work must yield conservatively");
        now += .009; await agent.BreakPoint();
        if (yields != 2) throw new Exception("Import must continue yielding, not become uninterrupted");
        foreach (var value in new[] { 0d, -1d, double.NaN, double.PositiveInfinity, 1d })
        {
            try { new ModelImportDeferAgent(value); throw new Exception("Unbounded import budget was accepted"); }
            catch (ArgumentOutOfRangeException) { }
        }
    }
}
