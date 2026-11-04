using System;
using System.Text.RegularExpressions;

namespace HeatTreatment.DigitalTwin.Backend
{
    // Authoring outputs live in writable user data, never in the installed
    // read-only assets directory. Keep downloads same-origin and hash-verified.
    public static class MotionAssetPolicy
    {
        public static bool IsAllowed(string relative)
        {
            return !string.IsNullOrEmpty(relative)
                && !relative.Contains("..")
                && !relative.Contains("//")
                && Regex.IsMatch(relative, @"\A/(?:assets/motions|uploads/models/motions|uploads/projects)/[a-zA-Z0-9_./\-\p{L}]+\.(?:glb|json)\z", RegexOptions.CultureInvariant);
        }
    }
}
