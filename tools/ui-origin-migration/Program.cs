using HeatTreatmentAdminHost;
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 1) { Environment.ExitCode = 1; return; }
        UiOriginStorageMigration.RunRequestFile(args[0]);
    }
}
