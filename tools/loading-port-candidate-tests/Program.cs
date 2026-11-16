using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

internal sealed class CandidateContext : AssemblyLoadContext
{
    internal CandidateContext() : base("AbsoluteLoadingPortCandidate", isCollectible: true) { }
    protected override Assembly Load(AssemblyName name) => name.Name == "Newtonsoft.Json" ? typeof(JObject).Assembly : null;
}
internal static class Program
{
    private static string Hash(string file) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant();
    private static string SourceHash(string scripts, out int count)
    {
        var files = Directory.GetFiles(scripts, "*.cs", SearchOption.AllDirectories).OrderBy(file => file, StringComparer.Ordinal).ToArray();
        count = files.Length;
        var records = files.Select(file => file.Substring(scripts.Length).Replace('\\', '/') + "\0" + Hash(file));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", records)))).ToLowerInvariant();
    }
    private static string OutputPath(string raw, string output)
    {
        if (!Path.IsPathRooted(raw)) throw new InvalidOperationException("Candidate and report paths must be absolute.");
        var full = Path.GetFullPath(raw);
        if (!full.StartsWith(output + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Candidate validation is restricted to this workspace output.");
        for (var current = Path.GetDirectoryName(full); ; current = Path.GetDirectoryName(current))
        {
            if (Directory.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Linked output paths are not allowed.");
            if (string.Equals(current, output, StringComparison.OrdinalIgnoreCase)) break;
            if (string.IsNullOrEmpty(current)) throw new InvalidOperationException("Output boundary validation failed.");
        }
        return full;
    }
    private static bool Resolve(Type policy, JObject model, JObject instance, string kind, out double[] position, out double[] direction)
    {
        var arguments = new object[] { model, instance, kind, null, null };
        var result = (bool)policy.GetMethod("TryResolve", BindingFlags.Public | BindingFlags.Static).Invoke(null, arguments);
        position = null; direction = null;
        if (result)
        {
            var pose = arguments[3]; position = (double[])pose.GetType().GetField("Position").GetValue(pose);
            direction = (double[])pose.GetType().GetField("Direction").GetValue(pose);
        }
        return result;
    }
    private static void Validate(Type policy, List<string> checks)
    {
        void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); checks.Add(name); }
        bool Close(double[] actual, double[] expected) => actual != null && actual.Length == expected.Length && actual.Select((value, axis) => Math.Abs(value - expected[axis]) < 1e-9).All(value => value);
        var model = JObject.Parse("{loadingPorts:{version:1,inlet:{position:[-1,1,0],direction:[-1,0,0],nodeName:'mouth',region:{version:1,corners:[[-1,1,-2],[-1,1,2],[-1,4,2],[-1,4,-2]],surfaceNormal:[-1,0,0]}},outlet:null}}");
        var instance = JObject.Parse("{loadingPortOverrides:{version:1,inlet:{offset:[50,60,70],yawDegrees:-180},outlet:null}}");
        var modelBefore = model.ToString(); var instanceBefore = instance.ToString();
        Check(Resolve(policy, model, instance, "inlet", out var point, out var normal) && Close(point, new[] { -1d, 1, 0 }) && Close(normal, new[] { -1d, 0, 0 }), "model-region-ignores-offset-and-minus-180");
        Check(model.ToString() == modelBefore && instance.ToString() == instanceBefore, "candidate-does-not-migrate-documents");
        var tolerant = (JObject)model.DeepClone(); tolerant["loadingPorts"]["inlet"]["position"][2] = 1e-7; tolerant["loadingPorts"]["inlet"]["direction"][2] = 1e-6;
        Check(Resolve(policy, tolerant, instance, "inlet", out point, out normal) && Close(point, new[] { -1d, 1, 0 }) && Close(normal, new[] { -1d, 0, 0 }), "region-remains-sole-source-within-scalar-tolerance");
        var selected = (JObject)instance.DeepClone();
        var region = JObject.Parse("{version:1,corners:[[4,2,5],[8,2,5],[8,6,5],[4,6,5]],surfaceNormal:[0,0,1]}"); selected["loadingPortOverrides"]["inlet"]["region"] = region;
        Check(Resolve(policy, model, selected, "inlet", out point, out normal) && Close(point, new[] { 6d, 2, 5 }) && Close(normal, new[] { 0d, 0, 1 }), "device-region-uses-own-absolute-corners-and-normal");
        var changed = (JObject)model.DeepClone(); changed["loadingPorts"]["inlet"] = JObject.Parse("{position:[9,10,0],direction:[1,0,0],nodeName:'changed',region:{version:1,corners:[[9,10,-2],[9,10,2],[9,14,2],[9,14,-2]],surfaceNormal:[1,0,0]}}");
        Check(Resolve(policy, changed, selected, "inlet", out point, out normal) && Close(point, new[] { 6d, 2, 5 }) && Close(normal, new[] { 0d, 0, 1 }), "model-edit-does-not-relocate-device-region");
        var missing = JObject.Parse("{loadingPortOverrides:{version:1,inlet:null,outlet:{offset:[0,0,0],yawDegrees:0}}}"); missing["loadingPortOverrides"]["outlet"]["region"] = region.DeepClone();
        Check(!Resolve(policy, model, missing, "outlet", out _, out _), "device-region-cannot-create-null-model-mouth");
        var legacy = JObject.Parse("{loadingPorts:{version:1,inlet:{position:[1,2,3],direction:[2,0,0],nodeName:'legacy'},outlet:null}}");
        var adjustment = JObject.Parse("{loadingPortOverrides:{version:1,inlet:{offset:[.1,.2,-.3],yawDegrees:90},outlet:null}}");
        Check(Resolve(policy, legacy, adjustment, "inlet", out point, out normal) && Close(point, new[] { 1.1, 2.2, 2.7 }) && Close(normal, new[] { 0d, 0, -1 }), "point-only-legacy-stays-relative");
        var malformed = (JObject)selected.DeepClone(); malformed["loadingPortOverrides"]["inlet"]["region"]["corners"][2][0] = 9;
        Check(!Resolve(policy, model, malformed, "inlet", out _, out _), "invalid-region-does-not-fall-back");
        malformed = (JObject)selected.DeepClone(); malformed["loadingPortOverrides"]["inlet"]["yawDegrees"] = "0";
        Check(!Resolve(policy, model, malformed, "inlet", out _, out _), "region-does-not-weaken-scalar-validation");
    }
    private static int Main(string[] args)
    {
        string reportFile = null; CandidateContext context = null; var checks = new List<string>(); var report = new JObject { ["success"] = false };
        try
        {
            if (args.Length != 2) throw new InvalidOperationException("Usage: candidate assembly absolute path, then new output report absolute path.");
            var workspace = Path.GetFullPath(Directory.GetCurrentDirectory()); var output = Path.Combine(workspace, "output");
            var candidate = OutputPath(args[0], output); reportFile = OutputPath(args[1], output);
            if ((File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Candidate must not be a link.");
            if (Directory.EnumerateFileSystemEntries(Path.GetDirectoryName(reportFile)).Any(entry => string.Equals(entry, reportFile, StringComparison.OrdinalIgnoreCase))) throw new InvalidOperationException("Report must be new; existing files/links will not be overwritten.");
            var compileReport = JObject.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(candidate)), "result.json")));
            if (compileReport.Value<bool>("success") != true) throw new InvalidOperationException("Scripts-only compiler validation has not succeeded.");
            var hash = Hash(candidate); if (hash != compileReport.Value<string>("candidateAssemblySha256")) throw new InvalidOperationException("Candidate does not match the scripts-only compilation report.");
            var scripts = Path.Combine(workspace, "unity-client", "Assets", "Scripts");
            var sourceHash = SourceHash(scripts, out var sourceCount); var policyHash = Hash(Path.Combine(scripts, "Runtime", "LoadingPortPolicy.cs"));
            if (sourceHash != compileReport.Value<string>("sourceSha256") || policyHash != compileReport.Value<string>("policySha256") || sourceCount != compileReport.Value<int>("sourceFileCount")) throw new InvalidOperationException("Source changed after candidate compilation.");
            context = new CandidateContext(); var assembly = context.LoadFromAssemblyPath(candidate);
            var policy = assembly.GetType("HeatTreatment.DigitalTwin.Runtime.LoadingPortPolicy", throwOnError: true);
            if (!ReferenceEquals(assembly, policy.Assembly) || AssemblyLoadContext.GetLoadContext(policy.Assembly) != context || !string.Equals(Path.GetFullPath(policy.Assembly.Location), candidate, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Resolver did not load from the exact candidate path in the isolated context.");
            if (assembly.ManifestModule.ModuleVersionId.ToString() != compileReport.Value<string>("candidateModuleVersionId")) throw new InvalidOperationException("Loaded candidate module does not match the compiled module.");
            if (assembly.GetReferencedAssemblies().Any(reference => reference.Name.StartsWith("UnityEditor", StringComparison.Ordinal))) throw new InvalidOperationException("Candidate depends on Editor-only assemblies.");
            Validate(policy, checks);
            if (Hash(candidate) != hash) throw new InvalidOperationException("Candidate changed while being validated.");
            report["success"] = true; report["candidateAssembly"] = policy.Assembly.Location; report["candidateAssemblySha256"] = hash;
            report["candidateModuleVersionId"] = assembly.ManifestModule.ModuleVersionId.ToString(); report["loadContext"] = context.Name;
            report["sourceSha256"] = sourceHash; report["sourceFileCount"] = sourceCount; report["policySha256"] = policyHash;
            report["checks"] = new JArray(checks);
            using (var stream = new FileStream(reportFile, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(report.ToString(Formatting.Indented));
            Console.WriteLine("PASS " + checks.Count + "/" + checks.Count + " exact candidate loading-port reflection checks; path=" + policy.Assembly.Location);
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { context?.Unload(); }
    }
}
