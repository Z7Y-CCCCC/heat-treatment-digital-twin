#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.Build.Player;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Editor
{
    // Managed scripts only: no BuildPlayer, scene/bootstrap changes, model
    // generation, running-client restart or copy into an existing Player.
    public static class LoadingPortRuntimePatchValidation
    {
        private const string DirectoryVariable = "LOADING_PORT_PATCH_DIRECTORY";
        private static string HashBytes(byte[] bytes)
        {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
        private static string HashFile(string file) => HashBytes(File.ReadAllBytes(file));
        private static JObject ProductionHashes()
        {
            var workspace = Directory.GetParent(Application.dataPath).Parent.FullName;
            var build = Path.Combine(workspace, "unity-client", "Builds", "Windows");
            var files = new[] { Path.Combine(build, "HeatTreatmentDigitalTwin.exe"), Path.Combine(build, "HeatTreatmentDigitalTwin_Data", "Managed", "Assembly-CSharp.dll") };
            return new JObject(files.Select(file => new JProperty(file, File.Exists(file) ? HashFile(file) : "missing")));
        }
        private static void WriteReport(string directory, JObject report)
        {
            // CreateNew rejects existing files, including a preplaced link;
            // diagnostics never overwrite an unrelated artifact.
            using (var stream = new FileStream(Path.Combine(directory, "result.json"), FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(report.ToString(Formatting.Indented));
        }
        private static string SourceHash(string scripts, out int count)
        {
            var files = Directory.GetFiles(scripts, "*.cs", SearchOption.AllDirectories).OrderBy(file => file, StringComparer.Ordinal).ToArray();
            count = files.Length;
            var records = files.Select(file => file.Substring(scripts.Length).Replace('\\', '/') + "\0" + HashFile(file));
            return HashBytes(Encoding.UTF8.GetBytes(string.Join("\n", records)));
        }
        private static string OwnedDirectory()
        {
            var raw = Environment.GetEnvironmentVariable(DirectoryVariable);
            if (string.IsNullOrWhiteSpace(raw) || !Path.IsPathRooted(raw)) throw new InvalidOperationException("An absolute " + DirectoryVariable + " under this workspace output is required.");
            var workspace = Directory.GetParent(Application.dataPath).Parent.FullName;
            var output = Path.GetFullPath(Path.Combine(workspace, "output"));
            var directory = Path.GetFullPath(raw).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!directory.StartsWith(output + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The scripts-only output must remain below this workspace output directory.");
            for (var current = directory; ; current = Path.GetDirectoryName(current))
            {
                if (Directory.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("A linked output directory is not permitted.");
                if (string.Equals(current, output, StringComparison.OrdinalIgnoreCase)) break;
                if (string.IsNullOrEmpty(current)) throw new InvalidOperationException("Output boundary validation failed.");
            }
            Directory.CreateDirectory(directory);
            return directory;
        }
        private static bool Resolve(Assembly assembly, JObject model, JObject instance, string kind, out double[] position, out double[] direction)
        {
            var type = assembly.GetType("HeatTreatment.DigitalTwin.Runtime.LoadingPortPolicy", true);
            var method = type.GetMethod("TryResolve", BindingFlags.Public | BindingFlags.Static) ?? throw new InvalidOperationException("Candidate loading-port resolver is missing.");
            var arguments = new object[] { model, instance, kind, null, null };
            var resolved = (bool)method.Invoke(null, arguments);
            position = null; direction = null;
            if (resolved)
            {
                var pose = arguments[3];
                position = (double[])pose.GetType().GetField("Position").GetValue(pose);
                direction = (double[])pose.GetType().GetField("Direction").GetValue(pose);
            }
            return resolved;
        }
        private static void ValidateCandidate(Assembly assembly, List<string> checks)
        {
            void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); checks.Add(name); }
            bool Close(double[] actual, double[] expected) => actual != null && actual.Length == expected.Length && actual.Select((value, axis) => Math.Abs(value - expected[axis]) < 1e-9).All(value => value);
            var model = JObject.Parse("{loadingPorts:{version:1,inlet:{position:[-1,1,0],direction:[-1,0,0],nodeName:'mouth',region:{version:1,corners:[[-1,1,-2],[-1,1,2],[-1,4,2],[-1,4,-2]],surfaceNormal:[-1,0,0]}},outlet:null}}");
            var instance = JObject.Parse("{loadingPortOverrides:{version:1,inlet:{offset:[50,60,70],yawDegrees:-180},outlet:null}}");
            var originalModel = model.ToString(); var originalInstance = instance.ToString();
            Check(Resolve(assembly, model, instance, "inlet", out var point, out var normal) && Close(point, new[] { -1d, 1, 0 }) && Close(normal, new[] { -1d, 0, 0 }), "model-region-ignores-stored-offset-and-minus-180");
            Check(model.ToString() == originalModel && instance.ToString() == originalInstance, "resolution-never-migrates-stored-documents");
            var tolerant = (JObject)model.DeepClone(); tolerant["loadingPorts"]["inlet"]["position"][2] = 1e-7;
            tolerant["loadingPorts"]["inlet"]["direction"][2] = 1e-6;
            Check(Resolve(assembly, tolerant, instance, "inlet", out point, out normal) && Close(point, new[] { -1d, 1, 0 }) && Close(normal, new[] { -1d, 0, 0 }), "tolerance-never-introduces-a-second-scalar-geometry-source");
            var selected = (JObject)instance.DeepClone();
            var region = JObject.Parse("{version:1,corners:[[4,2,5],[8,2,5],[8,6,5],[4,6,5]],surfaceNormal:[0,0,1]}");
            selected["loadingPortOverrides"]["inlet"]["region"] = region;
            Check(Resolve(assembly, model, selected, "inlet", out point, out normal) && Close(point, new[] { 6d, 2, 5 }) && Close(normal, new[] { 0d, 0, 1 }), "device-region-is-absolute-lower-edge-and-normal");
            var changed = (JObject)model.DeepClone();
            changed["loadingPorts"]["inlet"] = JObject.Parse("{position:[9,10,0],direction:[1,0,0],nodeName:'changed',region:{version:1,corners:[[9,10,-2],[9,10,2],[9,14,2],[9,14,-2]],surfaceNormal:[1,0,0]}}");
            Check(Resolve(assembly, changed, selected, "inlet", out point, out normal) && Close(point, new[] { 6d, 2, 5 }) && Close(normal, new[] { 0d, 0, 1 }), "later-model-edits-do-not-relocate-device-selection");
            var missing = JObject.Parse("{loadingPortOverrides:{version:1,inlet:null,outlet:{offset:[0,0,0],yawDegrees:0}}}");
            missing["loadingPortOverrides"]["outlet"]["region"] = region.DeepClone();
            Check(!Resolve(assembly, model, missing, "outlet", out _, out _), "device-region-cannot-create-null-model-mouth");
            var legacy = JObject.Parse("{loadingPorts:{version:1,inlet:{position:[1,2,3],direction:[2,0,0],nodeName:'legacy'},outlet:null}}");
            var adjustment = JObject.Parse("{loadingPortOverrides:{version:1,inlet:{offset:[.1,.2,-.3],yawDegrees:90},outlet:null}}");
            Check(Resolve(assembly, legacy, adjustment, "inlet", out point, out normal) && Close(point, new[] { 1.1, 2.2, 2.7 }) && Close(normal, new[] { 0d, 0, -1 }), "point-only-legacy-retains-original-relative-contract");
            var malformed = (JObject)selected.DeepClone(); malformed["loadingPortOverrides"]["inlet"]["region"]["corners"][2][0] = 9;
            Check(!Resolve(assembly, model, malformed, "inlet", out _, out _), "malformed-region-is-rejected-without-fallback");
            malformed = (JObject)selected.DeepClone(); malformed["loadingPortOverrides"]["inlet"]["yawDegrees"] = "0";
            Check(!Resolve(assembly, model, malformed, "inlet", out _, out _), "region-priority-does-not-weaken-numeric-validation");
        }
        public static void Run()
        {
            var directory = OwnedDirectory();
            var managed = Path.Combine(directory, "managed");
            if (Directory.EnumerateFileSystemEntries(directory).Any(entry => string.Equals(Path.GetFileName(entry), "managed", StringComparison.OrdinalIgnoreCase)
                || string.Equals(Path.GetFileName(entry), "result.json", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("Use fresh scripts-only managed/report paths; existing entries or links will not be reused.");
            var scripts = Path.Combine(Application.dataPath, "Scripts");
            var policy = Path.Combine(scripts, "Runtime", "LoadingPortPolicy.cs");
            var sourceHash = SourceHash(scripts, out var sourceCount); var policyHash = HashFile(policy);
            var productionBefore = ProductionHashes();
            var checks = new List<string>();
            var report = new JObject { ["success"] = false, ["sourceSha256"] = sourceHash, ["sourceFileCount"] = sourceCount,
                ["policySha256"] = policyHash, ["target"] = "StandaloneWindows64", ["group"] = "Standalone", ["options"] = "None",
                ["playerBuildCalled"] = false, ["productionHashesBefore"] = productionBefore, ["checks"] = new JArray() };
            try
            {
                Directory.CreateDirectory(managed);
                var settings = new ScriptCompilationSettings { group = BuildTargetGroup.Standalone, target = BuildTarget.StandaloneWindows64, options = ScriptCompilationOptions.None };
                var result = PlayerBuildInterface.CompilePlayerScripts(settings, managed);
                var candidate = Path.Combine(managed, "Assembly-CSharp.dll");
                if (!File.Exists(candidate) || result.assemblies == null || result.assemblies.Count == 0) throw new InvalidOperationException("Player script compilation produced no candidate assembly.");
                if (Directory.GetFiles(directory, "*.exe", SearchOption.AllDirectories).Length != 0) throw new InvalidOperationException("Scripts-only compilation unexpectedly produced an executable.");
                if (SourceHash(scripts, out var finalCount) != sourceHash || finalCount != sourceCount || HashFile(policy) != policyHash) throw new InvalidOperationException("Runtime source changed during compilation; candidate will not be accepted.");
                var candidateBytes = File.ReadAllBytes(candidate);
                report["candidateAssemblySha256"] = HashBytes(candidateBytes);
                report["candidateAssembly"] = candidate;
                report["compiledAssemblies"] = new JArray(result.assemblies);
                report["candidateDllHashes"] = new JObject(Directory.GetFiles(managed, "*.dll", SearchOption.AllDirectories)
                    .OrderBy(file => file, StringComparer.Ordinal).Select(file => new JProperty(file, HashFile(file))));
                var candidateAssembly = Assembly.Load(candidateBytes);
                var editorAssembly = typeof(HeatTreatment.DigitalTwin.Runtime.LoadingPortPolicy).Assembly;
                if (ReferenceEquals(candidateAssembly, editorAssembly) || candidateAssembly.ManifestModule.ModuleVersionId == editorAssembly.ManifestModule.ModuleVersionId) throw new InvalidOperationException("Candidate validation must not resolve to the already-loaded Editor assembly.");
                if (candidateAssembly.GetReferencedAssemblies().Any(reference => reference.Name.StartsWith("UnityEditor", StringComparison.Ordinal))) throw new InvalidOperationException("Player candidate unexpectedly references Editor-only assemblies.");
                report["candidateModuleVersionId"] = candidateAssembly.ManifestModule.ModuleVersionId.ToString();
                report["candidateValidationUsedEditorAssembly"] = false;
                ValidateCandidate(candidateAssembly, checks);
                var productionAfter = ProductionHashes(); report["productionHashesAfter"] = productionAfter;
                report["productionArtifactsChanged"] = !JToken.DeepEquals(productionBefore, productionAfter);
                if (!JToken.DeepEquals(productionBefore, productionAfter)) throw new InvalidOperationException("Existing Player EXE or Managed assembly changed during the isolated compilation.");
                report["checks"] = new JArray(checks); report["success"] = true;
                WriteReport(directory, report);
                Debug.Log("[LoadingPortRuntimePatchValidation] scripts-only candidate verified; checks=" + checks.Count + "; output=" + directory);
            }
            catch (Exception error)
            {
                report["checks"] = new JArray(checks); report["error"] = error.ToString();
                try { WriteReport(directory, report); }
                catch (Exception writeError) { Debug.LogError("Unable to create failure report: " + writeError.Message); }
                throw;
            }
        }
    }
}
#endif
