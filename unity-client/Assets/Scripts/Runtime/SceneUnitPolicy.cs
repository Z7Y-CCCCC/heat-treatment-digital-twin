using System;
using System.Globalization;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Runtime
{
    // Calibration is configuration, not telemetry. A declared line calibration
    // is inherited only when movement has no explicit value. Old layouts without
    // the new field retain their existing explicitly calibrated source behavior.
    public static class SceneUnitPolicy
    {
        private static readonly char[] TrimCharacters = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff".ToCharArray();
        private static readonly Regex Decimal = new Regex(@"\A[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z", RegexOptions.CultureInvariant);
        private static bool Read(JObject value, string key, bool legacyString, out double number, out bool present)
        {
            present = value?.Property(key) != null;
            number = 1;
            if (!present) return true;
            var token = value[key];
            if (token == null) return false;
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float) number = token.Value<double>();
            else
            {
                if (!legacyString || token.Type != JTokenType.String) return false;
                var text = token.Value<string>()?.Trim(TrimCharacters);
                if (text == null || !Decimal.IsMatch(text) || !double.TryParse(text,
                    NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent, CultureInfo.InvariantCulture, out number)) return false;
            }
            var native = (float)number;
            return !double.IsNaN(number) && !double.IsInfinity(number) && number > 0 && number <= 100000
                && !float.IsNaN(native) && !float.IsInfinity(native) && native > 0;
        }
        public static bool TryResolve(JObject movement, JObject lineLayout, out float units, out string reason)
        {
            units = float.NaN; reason = null;
            if (!Read(lineLayout, "sceneUnitsPerMeter", false, out var line, out var linePresent)
                || !Read(movement, "sceneUnitsPerMeter", true, out var current, out var currentPresent)
                || !Read(movement, "scene_units_per_meter", true, out var legacy, out var legacyPresent))
            { reason = "场景单位 / 米配置无效，请在产线结构或移动设置中填写有限正数"; return false; }
            var explicitMovement = currentPresent || legacyPresent;
            var selected = currentPresent ? current : legacyPresent ? legacy : line;
            if (linePresent && explicitMovement && selected != line)
            { reason = "产线与移动设备的场景单位 / 米不一致，请在现有配置中统一校准"; return false; }
            units = (float)selected;
            if (float.IsNaN(units) || float.IsInfinity(units) || units <= 0)
            { units = float.NaN; reason = "场景单位 / 米超出可表示范围"; return false; }
            return true;
        }
    }
}
