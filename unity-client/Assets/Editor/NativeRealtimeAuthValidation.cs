#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Development-only regression player, never an installer/release build or
    // an overwrite of the running workspace's Builds/Windows client.
    public static class NativeRealtimeAuthValidation
    {
        public static void BuildTestPlayer()
        {
            var requested = Environment.GetEnvironmentVariable("NATIVE_RECONNECT_TEST_BUILD_DIR");
            if (string.IsNullOrWhiteSpace(requested)) throw new BuildFailedException("Isolated test directory is required.");
            var directory = Path.GetFullPath(requested);
            var root = Path.GetFullPath(Path.Combine(UnityEngine.Application.dataPath, "../../output")) + Path.DirectorySeparatorChar;
            if (!directory.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new BuildFailedException("Native reconnect regression may build only under workspace output.");
            Directory.CreateDirectory(directory);
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { "Assets/Scenes/Factory.unity" },
                locationPathName = Path.Combine(directory, "HeatTreatmentDigitalTwin.exe"),
                target = BuildTarget.StandaloneWindows64,
                targetGroup = BuildTargetGroup.Standalone,
                options = BuildOptions.Development
            });
            if (report.summary.result != BuildResult.Succeeded)
                throw new BuildFailedException("Native reconnect test player failed: " + report.summary.result);
        }
    }
}
#endif
