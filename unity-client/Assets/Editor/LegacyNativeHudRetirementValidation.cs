using System;
using System.Collections.Generic;
using System.Reflection;
using HeatTreatment.DigitalTwin.Runtime;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Editor
{
    /// <summary>The configured overlay owns dashboard painting; Unity owns the scene and interaction.</summary>
    public static class LegacyNativeHudRetirementValidation
    {
        public static void Validate()
        {
            var type = typeof(FactoryDashboardController);
            const BindingFlags hidden = BindingFlags.Instance | BindingFlags.NonPublic;
            foreach (var name in new[] { "OnGUI", "DrawHeader", "DrawOverview", "DrawOverviewLeftPanel",
                "DrawOverviewDeviceList", "DrawWorldLabels", "DrawDetail", "DrawInspectionControlsAndLabels", "EnsureStyles" })
                if (type.GetMethod(name, hidden) != null) throw new Exception("Retired native dashboard painter remains: " + name);
            var root = new GameObject("__RetiredNativeHudValidation") { hideFlags = HideFlags.HideAndDontSave };
            try
            {
                var dashboard = root.AddComponent<FactoryDashboardController>();
                var hit = type.GetMethod("IsPointerOverDashboard", hidden);
                var controls = (List<Rect>)type.GetField("_inspectionHitRects", hidden).GetValue(dashboard);
                Func<Vector2, bool> blocks = point => (bool)hit.Invoke(dashboard, new object[] { point });
                foreach (var active in new[] { false, true, false })
                {
                    dashboard.SetWebOverlayActive(active);
                    foreach (var point in new[] { new Vector2(80, 50), new Vector2(100, 300),
                        new Vector2(1800, 300), new Vector2(960, 540), new Vector2(960, 1000) })
                        if (blocks(point)) throw new Exception("A retired header, sidebar, label or detail mask still intercepts the scene.");
                }
                controls.Add(new Rect(80, 200, 40, 40));
                if (!blocks(new Vector2(100, 220)) || blocks(new Vector2(500, 220)))
                    throw new Exception("Explicitly registered interaction controls lost their pointer contract.");
                dashboard.ClearFactory();
                if (blocks(new Vector2(100, 220))) throw new Exception("Scene cleanup retained a stale control hit rectangle.");
                foreach (var name in new[] { "SetWebOverlayActive", "ApplyInspectionCommand", "FocusPreviewDevice", "ApplySettings", "ApplyPublishedViews", "NavigateBack" })
                    if (type.GetMethod(name, BindingFlags.Instance | BindingFlags.Public) == null)
                        throw new Exception("Current overlay/navigation contract was removed: " + name);
                Debug.Log("[LegacyNativeHudRetirementValidation] PASS: no fallback painter, no phantom masks; current overlay and explicit interaction retained.");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }
    }
}
