using System;
using System.IO;
using Newtonsoft.Json;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Core
{
    [Serializable]
    public sealed class NativeClientSettings
    {
        public string backendHttpUrl = "http://127.0.0.1:3001";
        public string backendWebSocketUrl = "ws://127.0.0.1:3001/ws";
        public string adminUrl = "";
        public string adminHostExecutable = "";
        public string adminHostFixedRuntimeFolder = "";
        public string desktopControlUrl = "";
        public string desktopControlToken = "";
        public bool maximizeWindowOnStart = true;
        public bool showApplicationChrome = true;
        public string qualityProfile = "auto";
        public float autoReconnectSeconds = 2f;
        public float configurationRetrySeconds = 3f;
        public float modelLoadTimeoutSeconds = 30f;
        public bool showDiagnostics = true;
        public bool enableQualityHotkeys = true;

        public static NativeClientSettings Load()
        {
            var path = Path.Combine(Application.streamingAssetsPath, "runtime-config.json");
            NativeClientSettings settings;
            if (!File.Exists(path))
            {
                Debug.LogWarning($"[NativeClientSettings] Missing {path}; using defaults.");
                settings = new NativeClientSettings();
            }
            else
            {
                try
                {
                    settings = JsonConvert.DeserializeObject<NativeClientSettings>(File.ReadAllText(path))
                        ?? new NativeClientSettings();
                }
                catch (Exception exception)
                {
                    Debug.LogError($"[NativeClientSettings] Invalid runtime config: {exception}");
                    settings = new NativeClientSettings();
                }
            }

            // The packaged desktop supervisor can select a different free backend port on
            // each machine. Environment overrides avoid writing into Program Files and keep
            // the standalone Unity player usable outside the installer as well.
            settings.backendHttpUrl = EnvironmentValue(
                "DIGITAL_TWIN_BACKEND_HTTP_URL",
                settings.backendHttpUrl
            );
            settings.backendWebSocketUrl = EnvironmentValue(
                "DIGITAL_TWIN_BACKEND_WEBSOCKET_URL",
                settings.backendWebSocketUrl
            );
            settings.adminUrl = EnvironmentValue(
                "DIGITAL_TWIN_ADMIN_URL",
                string.IsNullOrWhiteSpace(settings.adminUrl)
                    ? $"{settings.backendHttpUrl.TrimEnd('/')}/admin"
                    : settings.adminUrl
            );
            settings.adminHostExecutable = EnvironmentValue(
                "DIGITAL_TWIN_ADMIN_HOST_PATH",
                settings.adminHostExecutable
            );
            settings.adminHostFixedRuntimeFolder = EnvironmentValue(
                "DIGITAL_TWIN_ADMIN_FIXED_RUNTIME",
                settings.adminHostFixedRuntimeFolder
            );
            settings.desktopControlUrl = EnvironmentValue(
                "DIGITAL_TWIN_DESKTOP_CONTROL_URL",
                settings.desktopControlUrl
            );
            settings.desktopControlToken = EnvironmentValue(
                "DIGITAL_TWIN_DESKTOP_CONTROL_TOKEN",
                settings.desktopControlToken
            );
            settings.maximizeWindowOnStart = EnvironmentBoolean(
                "DIGITAL_TWIN_MAXIMIZE_WINDOW",
                settings.maximizeWindowOnStart
            );
            settings.showApplicationChrome = EnvironmentBoolean("DIGITAL_TWIN_APPLICATION_CHROME", settings.showApplicationChrome);
            settings.qualityProfile = EnvironmentValue(
                "DIGITAL_TWIN_QUALITY_PROFILE",
                settings.qualityProfile
            );
            return settings;
        }

        private static string EnvironmentValue(string key, string fallback)
        {
            var value = Environment.GetEnvironmentVariable(key);
            return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        }

        private static bool EnvironmentBoolean(string key, bool fallback)
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (string.IsNullOrWhiteSpace(value)) return fallback;
            if (bool.TryParse(value, out var parsed)) return parsed;
            return value == "1" ? true : value == "0" ? false : fallback;
        }
    }
}
