using System.Formats.Tar;

namespace HeatTreatment.Shared;

/// <summary>
/// Reuses the .NET runtime already shipped with both native hosts. Windows
/// bsdtar's active-code-page conversion can discard otherwise valid UTF-8 names.
/// This headless mode runs before any UI, instance mutex, service or data access.
/// </summary>
internal static class DependencyArchive
{
    internal static bool TryRun(string[] args, out int exitCode)
    {
        exitCode = 0;
        if (args.Length == 0 || args[0] != "--extract-dependencies") return false;
        try
        {
            if (args.Length != 3) throw new ArgumentException("Requires --extract-dependencies <archive> <empty staging directory>");
            var archive = Path.GetFullPath(args[1]);
            var staging = Path.GetFullPath(args[2]);
            if (!File.Exists(archive)) throw new FileNotFoundException("Dependency archive is missing", archive);
            if (!Directory.Exists(staging)) throw new DirectoryNotFoundException("Staging directory must already exist");
            if (Directory.EnumerateFileSystemEntries(staging).Any())
                throw new IOException("Refusing to extract into a nonempty directory");
            // Framework extraction rejects entries/links that escape staging.
            // A partial failure never publishes dependencies or writes a marker.
            TarFile.ExtractToDirectory(archive, staging, overwriteFiles: false);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Dependency extraction failed: {error.Message}");
            exitCode = 1;
        }
        return true;
    }
}
