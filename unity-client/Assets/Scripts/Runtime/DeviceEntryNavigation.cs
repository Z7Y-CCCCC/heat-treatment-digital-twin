using System;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // One device-browsing session has one entry view, not a stack of device
    // selections. Hierarchy/breadcrumb configuration is intentionally untouched.
    public sealed class DeviceEntryNavigation<TCameraState>
    {
        public sealed class Entry
        {
            private readonly JObject _context;
            public JObject Context => (JObject)_context.DeepClone();
            public TCameraState Camera { get; }
            internal Entry(JObject context, TCameraState camera) { _context = (JObject)context.DeepClone(); Camera = camera; }
            public bool Matches(string factoryId, string sceneId) =>
                string.Equals(_context.Value<string>("factoryId"), factoryId, StringComparison.Ordinal)
                && string.Equals(_context.Value<string>("sceneId"), sceneId, StringComparison.Ordinal);
            public JObject PublicContext() => new JObject
            {
                ["factoryId"] = _context.Value<string>("factoryId"), ["sceneId"] = _context.Value<string>("sceneId"),
                ["viewId"] = _context.Value<string>("viewId"), ["viewMode"] = _context.Value<string>("viewMode"),
                ["viewName"] = _context.Value<string>("viewName") ?? string.Empty,
                ["workshopId"] = _context.Value<string>("workshopId") ?? string.Empty,
                ["lineId"] = _context.Value<string>("lineId") ?? string.Empty
            };
        }

        public Entry Current { get; private set; }
        public void Clear() { Current = null; }

        public bool Capture(JObject context, TCameraState camera)
        {
            var mode = context?.Value<string>("viewMode") ?? string.Empty;
            if (string.Equals(mode, "device", StringComparison.OrdinalIgnoreCase)) return false;
            if (context?.Value<bool?>("sceneReady") != true
                || string.IsNullOrWhiteSpace(context.Value<string>("factoryId"))
                || string.IsNullOrWhiteSpace(context.Value<string>("sceneId"))
                || string.IsNullOrWhiteSpace(context.Value<string>("viewId"))
                || mode != "factory" && mode != "workshop" && mode != "line") { Clear(); return false; }
            Current = new Entry(context, camera);
            return true;
        }

        public void Observe(JObject context)
        {
            if (Current == null) return;
            if (context?.Value<bool?>("sceneReady") == false
                || !Current.Matches(context?.Value<string>("factoryId"), context?.Value<string>("sceneId"))
                || !string.Equals(context?.Value<string>("viewMode"), "device", StringComparison.OrdinalIgnoreCase)) Clear();
        }

        public bool TryTake(string factoryId, string sceneId, out Entry entry)
        {
            entry = Current;
            Clear();
            if (entry != null && entry.Matches(factoryId, sceneId)) return true;
            entry = null;
            return false;
        }
    }
}
