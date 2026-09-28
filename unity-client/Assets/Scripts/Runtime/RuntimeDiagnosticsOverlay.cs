using System;
using System.Collections.Generic;
using HeatTreatment.DigitalTwin.Rendering;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed class RuntimeDiagnosticsOverlay : MonoBehaviour
    {
        private GUIStyle _titleStyle;
        private GUIStyle _lineStyle;
        private GUIStyle _mutedStyle;
        private GUIStyle _errorTitleStyle;
        private GUIStyle _errorStyle;
        private Texture2D _panelTexture;
        private Texture2D _loadingTexture;
        private Texture2D _loadingFactoryTexture;
        private Texture2D _loadingCardTexture;
        private Texture2D _loadingGlowTexture;
        private Texture2D _loadingDotTexture;
        private GUIStyle _loadingCardStyle;
        private GUIStyle _loadingKickerStyle;
        private GUIStyle _loadingTinyStyle;
        private GUIStyle _loadingCaptionStyle;
        private GUIStyle _loadingFooterStyle;
        private GUIStyle _loadingHeadingStyle;
        private GUIStyle _loadingStepStyle;
        private GUIStyle _loadingPercentStyle;
        private GUIStyle _loadingPhaseStyle;
        private GUIStyle _loadingPhaseCaptionStyle;
        private static readonly string[] LoadingPhases = { "现场配置", "三维场景", "设备模型", "实时数据" };
        private static readonly string[] LoadingPhaseCaptions = { "CONFIGURATION", "3D SCENE", "EQUIPMENT", "LIVE DATA" };
        private float _smoothedFps;
        private long _lastFrameTimestamp;
        private int _lastFrameDevices;
        private bool _loadingVisible;
        private float _loadingProgress;
        private string _loadingStep = "正在初始化渲染";
        private string _loadingDetail = string.Empty;
        private float _lastReportedLoadingProgress = -1f;
        private string _lastReportedLoadingStep = string.Empty;
        private string _lastReportedLoadingDetail = string.Empty;
        private readonly List<string> _modelErrors = new List<string>();

        public bool Visible { get; set; } = true;
        public string BackendState { get; set; } = "starting";
        public string PlcState { get; set; } = "unknown";
        public string Activity { get; set; } = "Initializing native renderer";
        public int DeviceCount { get; set; }
        public int ReadyDeviceCount { get; set; }
        public int FallbackDeviceCount { get; set; }
        public int TemplateCount { get; set; }
        public NativeQualityController QualityController { get; set; }
        public void RequireAuthentication(string message = null)
        {
            _loadingVisible = true;
            _loadingProgress = 0.01f;
            _loadingStep = "等待后台账户授权";
            _loadingDetail = string.IsNullOrWhiteSpace(message)
                ? "正在切换到后台管理登录页…"
                : message.Trim();
            ReportLoadingProgress();
        }

        public void SetLoginBusy(bool busy)
        {
            if (!busy) return;
            _loadingVisible = true;
            _loadingProgress = Mathf.Max(_loadingProgress, 0.06f);
            _loadingStep = "正在验证后台授权";
            _loadingDetail = "正在安全同步账户会话…";
            ReportLoadingProgress();
        }

        public void SetLoginError(string message)
        {
            RequireAuthentication(string.IsNullOrWhiteSpace(message)
                ? "后台授权同步失败，请重试或检查本地服务。"
                : $"后台授权同步失败：{message.Trim()}");
        }

        public void ClearModelErrors()
        {
            _modelErrors.Clear();
        }

        public void ReportModelError(string deviceName, string modelType, string reason)
        {
            var device = string.IsNullOrWhiteSpace(deviceName) ? "未命名设备" : deviceName;
            var model = string.IsNullOrWhiteSpace(modelType) ? "未设置模型" : modelType;
            var detail = string.IsNullOrWhiteSpace(reason) ? "未提供具体原因" : reason;
            var message = $"{device} / {model}：{detail}";
            if (!_modelErrors.Contains(message)) _modelErrors.Add(message);
        }

        public void BeginLoading()
        {
            ClearModelErrors();
            _loadingVisible = true;
            _loadingProgress = 0f;
            _loadingStep = "正在初始化渲染";
            _loadingDetail = string.Empty;
            _lastReportedLoadingProgress = -1f;
            _lastReportedLoadingStep = string.Empty;
            _lastReportedLoadingDetail = string.Empty;
            ReportLoadingProgress();
        }

        public void UpdateLoading(float progress, string step, string detail = null)
        {
            _loadingVisible = true;
            _loadingProgress = Mathf.Clamp01(progress);
            if (!string.IsNullOrWhiteSpace(step)) _loadingStep = step;
            _loadingDetail = string.IsNullOrWhiteSpace(detail) ? string.Empty : detail.Trim();
            ReportLoadingProgress();
        }

        public void CompleteLoading()
        {
            _loadingProgress = 1f;
            _loadingStep = "场景已就绪";
            _loadingDetail = string.Empty;
            ReportLoadingProgress();
            _loadingVisible = false;
        }

        private void ReportLoadingProgress()
        {
            if (Mathf.Abs(_lastReportedLoadingProgress - _loadingProgress) < 0.001f &&
                string.Equals(_lastReportedLoadingStep, _loadingStep, StringComparison.Ordinal) &&
                string.Equals(_lastReportedLoadingDetail, _loadingDetail, StringComparison.Ordinal)) return;
            _lastReportedLoadingProgress = _loadingProgress;
            _lastReportedLoadingStep = _loadingStep;
            _lastReportedLoadingDetail = _loadingDetail;
            var safeStep = (_loadingStep ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Replace('|', ' ');
            var safeDetail = (_loadingDetail ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Replace('|', ' ');
            var progressText = string.IsNullOrEmpty(safeDetail) ? safeStep : $"{safeStep} · 原因：{safeDetail}";
            Debug.Log($"[StartupProgress] {Mathf.RoundToInt(_loadingProgress * 100f)}|{progressText}");
        }

        public void RecordRealtimeFrame(long timestamp, int deviceCount)
        {
            _lastFrameTimestamp = timestamp;
            _lastFrameDevices = deviceCount;
        }

        private void Update()
        {
            var current = 1f / Mathf.Max(0.0001f, Time.unscaledDeltaTime);
            _smoothedFps = _smoothedFps <= 0f ? current : Mathf.Lerp(_smoothedFps, current, 0.08f);
            if (Input.GetKeyDown(KeyCode.F9)) Visible = !Visible;
        }

        private void OnGUI()
        {
            if (_loadingVisible)
            {
                DrawLoadingScreen();
                return;
            }
            if (!Visible && _modelErrors.Count == 0) return;
            EnsureStyles();
            var scale = Mathf.Clamp(Screen.height / 1080f, 0.78f, 1.25f);
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
            if (Visible)
            {
                var width = 410f;
                var height = 224f;
                GUI.DrawTexture(new Rect(18f, 18f, width, height), _panelTexture, ScaleMode.StretchToFill);
                GUI.Label(new Rect(36f, 31f, width - 36f, 28f), "NATIVE DIGITAL TWIN", _titleStyle);
                GUI.Label(new Rect(36f, 66f, width - 36f, 22f), $"FPS  {_smoothedFps:0}    GPU  {SystemInfo.graphicsDeviceName}", _lineStyle);
                GUI.Label(new Rect(36f, 91f, width - 36f, 22f), $"Backend  {BackendState}    PLC  {PlcState}", _lineStyle);
                GUI.Label(new Rect(36f, 116f, width - 36f, 22f), $"Devices  {ReadyDeviceCount}/{DeviceCount}    fallback  {FallbackDeviceCount}    templates  {TemplateCount}", _lineStyle);
                GUI.Label(new Rect(36f, 141f, width - 36f, 22f), FrameText(), _lineStyle);
                GUI.Label(new Rect(36f, 166f, width - 36f, 22f), $"Quality  {QualityController?.ActiveProfileName ?? "pending"} (full geometry)", _lineStyle);
                GUI.Label(new Rect(36f, 193f, width - 36f, 20f), Activity, _mutedStyle);
                GUI.Label(new Rect(36f, 217f, width - 36f, 18f), "F1/F2/F3 quality   F4 auto   F5 reload   Home frame   F9 hide", _mutedStyle);
            }
            DrawModelErrors(Visible ? 258f : 18f);
        }

        private void DrawModelErrors(float top)
        {
            if (_modelErrors.Count == 0) return;
            var width = Mathf.Min(760f, Mathf.Max(420f, Screen.width - 36f));
            var visibleCount = Mathf.Min(4, _modelErrors.Count);
            var extraLine = _modelErrors.Count > visibleCount ? 24f : 0f;
            var height = 54f + visibleCount * 30f + extraLine;
            GUI.color = new Color(0.28f, 0.035f, 0.03f, 0.94f);
            GUI.DrawTexture(new Rect(18f, top, width, height), _panelTexture, ScaleMode.StretchToFill);
            GUI.color = Color.white;
            GUI.Label(new Rect(34f, top + 12f, width - 32f, 22f), "模型未加载（当前显示占位几何体）", _errorTitleStyle);
            for (var index = 0; index < visibleCount; index += 1)
            {
                GUI.Label(new Rect(34f, top + 38f + index * 30f, width - 32f, 26f), TrimError(_modelErrors[index]), _errorStyle);
            }
            if (_modelErrors.Count > visibleCount)
            {
                GUI.Label(new Rect(34f, top + 38f + visibleCount * 30f, width - 32f, 22f), $"还有 {_modelErrors.Count - visibleCount} 个模型错误，请查看 Unity 日志。", _errorStyle);
            }
        }

        private static string TrimError(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "未知模型错误";
            return value.Length <= 150 ? value : value.Substring(0, 147) + "...";
        }

        private void DrawLoadingScreen()
        {
            EnsureStyles();
            EnsureLoadingStyles();
            if (_loadingTexture == null)
            {
                _loadingTexture = new Texture2D(1, 1, TextureFormat.RGBA32, false);
                _loadingTexture.SetPixel(0, 0, new Color(0.152f, 0.152f, 0.164f, 1f));
                _loadingTexture.Apply();
            }
            if (_loadingFactoryTexture == null) _loadingFactoryTexture = Resources.Load<Texture2D>("Loading/industrial-factory");
            var previousColor = GUI.color;
            var previousMatrix = GUI.matrix;
            GUI.color = Color.white;
            GUI.DrawTexture(new Rect(0f, 0f, Screen.width, Screen.height), _loadingTexture, ScaleMode.StretchToFill);
            var scale = Mathf.Min(1f, (Screen.width - 32f) / 900f, (Screen.height - 52f) / 518f);
            scale = Mathf.Max(.35f, scale);
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
            var canvasWidth = Screen.width / scale;
            var canvasHeight = Screen.height / scale;
            var panel = new Rect((canvasWidth - 900f) * .5f, (canvasHeight - 518f) * .5f, 900f, 518f);
            var x = panel.x;
            var y = panel.y;

            // Match the WebView loading card used after sign-in. This native
            // fallback must exist before the WebView/login page is available.
            GUI.color = new Color(.3f, .3f, .32f, .22f);
            GUI.DrawTexture(new Rect(x - 210f, y - 145f, 1320f, 800f), _loadingGlowTexture);
            GUI.color = new Color(0f, 0f, 0f, .28f);
            GUI.Box(new Rect(x + 8f, y + 20f, 900f, 518f), GUIContent.none, _loadingCardStyle);
            GUI.color = Color.white;
            GUI.Box(panel, GUIContent.none, _loadingCardStyle);

            DrawLoadingBlock(new Rect(x + 35f, y + 28f, 18f, 18f), new Color(.43f, .46f, .45f, .65f));
            DrawLoadingBlock(new Rect(x + 36f, y + 29f, 16f, 16f), new Color(.18f, .19f, .2f));
            DrawLoadingBlock(new Rect(x + 40f, y + 38f, 2f, 4f), new Color(.62f, .77f, .69f));
            DrawLoadingBlock(new Rect(x + 44f, y + 34f, 2f, 8f), new Color(.62f, .77f, .69f));
            DrawLoadingBlock(new Rect(x + 48f, y + 36f, 2f, 6f), new Color(.82f, .66f, .43f));
            GUI.Label(new Rect(x + 64f, y + 27f, 420f, 20f), "HEAT TREATMENT  /  DIGITAL TWIN", _loadingKickerStyle);
            DrawLoadingDot(new Rect(x + 774f, y + 34f, 6f, 6f), new Color(.56f, .72f, .63f));
            GUI.Label(new Rect(x + 784f, y + 28f, 90f, 18f), "SYSTEM STARTUP", _loadingTinyStyle);

            var pulse = .85f + .15f * Mathf.Sin(Time.realtimeSinceStartup * 1.5f);
            GUI.color = new Color(.63f, .7f, .68f, .17f * pulse);
            GUI.DrawTexture(new Rect(x + 235f, y + 95f, 430f, 270f), _loadingGlowTexture);
            if (_loadingFactoryTexture != null)
            {
                GUI.color = Color.white;
                var floatOffset = Mathf.Sin(Time.realtimeSinceStartup * 1.35f) * 3f;
                GUI.DrawTexture(new Rect(x + 160f, y + 66f + floatOffset, 580f, 286f), _loadingFactoryTexture, ScaleMode.ScaleToFit, true);
            }
            DrawLoadingDot(new Rect(x + 35f, y + 347f, 6f, 6f), new Color(.54f, .72f, .63f));
            GUI.Label(new Rect(x + 47f, y + 340f, 265f, 19f), "FACTORY SYSTEMS  INITIALIZING", _loadingCaptionStyle);
            if (!string.IsNullOrWhiteSpace(_loadingDetail))
            {
                GUI.Label(new Rect(x + 385f, y + 340f, 478f, 20f), _loadingDetail, _loadingTinyStyle);
            }
            DrawLoadingBlock(new Rect(x + 35f, y + 367f, 830f, 1f), new Color(.59f, .61f, .59f, .16f));

            GUI.Label(new Rect(x + 35f, y + 387f, 690f, 25f), "正在准备生产现场", _loadingHeadingStyle);
            GUI.Label(new Rect(x + 35f, y + 413f, 700f, 18f), _loadingStep, _loadingStepStyle);
            GUI.Label(new Rect(x + 785f, y + 386f, 80f, 34f), $"{Mathf.RoundToInt(_loadingProgress * 100f)}%", _loadingPercentStyle);
            DrawLoadingBlock(new Rect(x + 35f, y + 446f, 830f, 3f), new Color(.57f, .59f, .59f, .24f));
            DrawLoadingBlock(new Rect(x + 35f, y + 446f, 830f * _loadingProgress, 3f), new Color(.66f, .78f, .69f));
            var knobX = x + 35f + 830f * Mathf.Clamp01(_loadingProgress);
            DrawLoadingDot(new Rect(knobX - 5f, y + 442.5f, 10f, 10f), new Color(.82f, .68f, .47f));

            var currentPhase = Mathf.Min(LoadingPhases.Length - 1, Mathf.FloorToInt(_loadingProgress * LoadingPhases.Length));
            for (var index = 0; index < LoadingPhases.Length; index += 1)
            {
                var phaseX = x + 35f + index * 210f;
                var markerColor = index < currentPhase
                    ? new Color(.58f, .76f, .65f)
                    : index == currentPhase ? new Color(.83f, .69f, .46f) : new Color(.43f, .45f, .45f);
                DrawLoadingDot(new Rect(phaseX, y + 473f, 18f, 18f), markerColor);
                DrawLoadingDot(new Rect(phaseX + 6f, y + 479f, 6f, 6f), new Color(.16f, .17f, .18f));
                GUI.Label(new Rect(phaseX + 27f, y + 468f, 165f, 17f), LoadingPhases[index], _loadingPhaseStyle);
                GUI.Label(new Rect(phaseX + 27f, y + 484f, 165f, 15f), LoadingPhaseCaptions[index], _loadingPhaseCaptionStyle);
            }
            GUI.Label(new Rect((canvasWidth - 440f) * .5f, canvasHeight - 22f, 440f, 16f),
                "PRODUCTION OPERATIONS    ·    请稍候，正在同步现场状态", _loadingFooterStyle);
            GUI.matrix = previousMatrix;
            GUI.color = previousColor;
        }

        private static void DrawLoadingBlock(Rect rect, Color color)
        {
            GUI.color = color;
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = Color.white;
        }

        private void DrawLoadingDot(Rect rect, Color color)
        {
            GUI.color = color;
            GUI.DrawTexture(rect, _loadingDotTexture);
            GUI.color = Color.white;
        }

        private void EnsureLoadingStyles()
        {
            if (_loadingCardStyle != null) return;
            _loadingCardTexture = new Texture2D(32, 32, TextureFormat.RGBA32, false);
            for (var y = 0; y < 32; y += 1)
            for (var x = 0; x < 32; x += 1)
            {
                var dx = x - Mathf.Clamp(x, 8, 23);
                var dy = y - Mathf.Clamp(y, 8, 23);
                var distance = Mathf.Sqrt(dx * dx + dy * dy);
                var opacity = Mathf.Clamp01(8.5f - distance);
                var border = distance > 7f;
                var color = border ? new Color(.33f, .34f, .35f, opacity) : new Color(.177f, .179f, .19f, opacity);
                _loadingCardTexture.SetPixel(x, y, color);
            }
            _loadingCardTexture.Apply();
            _loadingCardStyle = new GUIStyle(GUI.skin.box)
            {
                normal = { background = _loadingCardTexture },
                border = new RectOffset(8, 8, 8, 8),
                padding = new RectOffset(0, 0, 0, 0)
            };
            _loadingGlowTexture = new Texture2D(128, 128, TextureFormat.RGBA32, false);
            for (var y = 0; y < 128; y += 1)
            for (var x = 0; x < 128; x += 1)
            {
                var radius = Vector2.Distance(new Vector2(x, y), new Vector2(63.5f, 63.5f)) / 64f;
                var alpha = Mathf.Pow(Mathf.Clamp01(1f - radius), 2f);
                _loadingGlowTexture.SetPixel(x, y, new Color(1f, 1f, 1f, alpha));
            }
            _loadingGlowTexture.Apply();
            _loadingDotTexture = new Texture2D(16, 16, TextureFormat.RGBA32, false);
            for (var y = 0; y < 16; y += 1)
            for (var x = 0; x < 16; x += 1)
            {
                var radius = Vector2.Distance(new Vector2(x, y), new Vector2(7.5f, 7.5f));
                _loadingDotTexture.SetPixel(x, y, new Color(1f, 1f, 1f, Mathf.Clamp01(8f - radius)));
            }
            _loadingDotTexture.Apply();
            _loadingKickerStyle = new GUIStyle(GUI.skin.label) { fontSize = 9, fontStyle = FontStyle.Bold, normal = { textColor = new Color(.76f, .76f, .72f) } };
            _loadingTinyStyle = new GUIStyle(GUI.skin.label) { fontSize = 8, alignment = TextAnchor.MiddleRight, normal = { textColor = new Color(.55f, .56f, .55f) } };
            _loadingCaptionStyle = new GUIStyle(_loadingTinyStyle) { alignment = TextAnchor.MiddleLeft };
            _loadingFooterStyle = new GUIStyle(_loadingTinyStyle) { alignment = TextAnchor.MiddleCenter };
            _loadingHeadingStyle = new GUIStyle(GUI.skin.label) { fontSize = 17, fontStyle = FontStyle.Bold, normal = { textColor = new Color(.93f, .94f, .93f) } };
            _loadingStepStyle = new GUIStyle(GUI.skin.label) { fontSize = 11, normal = { textColor = new Color(.65f, .66f, .63f) } };
            _loadingPercentStyle = new GUIStyle(GUI.skin.label) { fontSize = 22, alignment = TextAnchor.MiddleRight, normal = { textColor = new Color(.87f, .86f, .82f) } };
            _loadingPhaseStyle = new GUIStyle(GUI.skin.label) { fontSize = 9, normal = { textColor = new Color(.76f, .76f, .72f) } };
            _loadingPhaseCaptionStyle = new GUIStyle(GUI.skin.label) { fontSize = 7, normal = { textColor = new Color(.43f, .45f, .44f) } };
        }

        private string FrameText()
        {
            if (_lastFrameTimestamp <= 0) return "Realtime  waiting for first frame";
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var age = Mathf.Max(0f, (now - _lastFrameTimestamp) / 1000f);
            return $"Realtime  {_lastFrameDevices} devices    frame age  {age:0.00}s";
        }

        private void EnsureStyles()
        {
            if (_panelTexture != null) return;
            _panelTexture = new Texture2D(1, 1, TextureFormat.RGBA32, false);
            _panelTexture.SetPixel(0, 0, new Color(0.17f, 0.17f, 0.18f, 0.96f));
            _panelTexture.Apply();
            _titleStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 19,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.86f, 0.88f, 0.84f) }
            };
            _lineStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 14,
                normal = { textColor = new Color(0.82f, 0.83f, 0.8f) }
            };
            _mutedStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 12,
                normal = { textColor = new Color(0.62f, 0.63f, 0.61f) }
            };
            _errorTitleStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 16,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(1f, 0.83f, 0.78f) }
            };
            _errorStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 12,
                wordWrap = true,
                normal = { textColor = new Color(1f, 0.91f, 0.88f) }
            };
        }
    }
}
