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
            if (_loadingTexture == null)
            {
                _loadingTexture = new Texture2D(1, 1, TextureFormat.RGBA32, false);
                _loadingTexture.SetPixel(0, 0, new Color(0.145f, 0.145f, 0.15f, 1f));
                _loadingTexture.Apply();
            }
            if (_loadingFactoryTexture == null) _loadingFactoryTexture = Resources.Load<Texture2D>("Loading/industrial-factory");
            GUI.DrawTexture(new Rect(0f, 0f, Screen.width, Screen.height), _loadingTexture, ScaleMode.StretchToFill);
            var scale = Mathf.Clamp(Screen.height / 1080f, 0.8f, 1.35f);
            var center = new Vector2(Screen.width * .5f, Screen.height * .5f);
            var panelWidth = Mathf.Min(1080f * scale, Screen.width * .9f);
            var panelHeight = Mathf.Min(700f * scale, Screen.height * .9f);
            var panel = new Rect(center.x - panelWidth * .5f, center.y - panelHeight * .5f, panelWidth, panelHeight);
            GUI.color = Color.white;
            GUI.DrawTexture(panel, _panelTexture, ScaleMode.StretchToFill);
            GUI.color = new Color(.72f, .75f, .71f, .5f);
            GUI.DrawTexture(new Rect(panel.x + 1f, panel.y + 1f, panel.width - 2f, 1f * scale), _loadingTexture, ScaleMode.StretchToFill);
            GUI.color = Color.white;

            var eyebrow = new GUIStyle(_mutedStyle) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(11f * scale) };
            var title = new GUIStyle(_titleStyle) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(27f * scale), normal = { textColor = new Color(.92f, .92f, .89f) } };
            var step = new GUIStyle(_lineStyle) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(14f * scale), normal = { textColor = new Color(.78f, .8f, .77f) } };
            GUI.Label(new Rect(panel.x + 24f * scale, panel.y + 24f * scale, panel.width - 48f * scale, 22f * scale), "HEAT TREATMENT  /  DIGITAL TWIN", eyebrow);
            GUI.Label(new Rect(panel.x + 24f * scale, panel.y + 48f * scale, panel.width - 48f * scale, 42f * scale), "正在准备生产现场", title);

            var imageWidth = Mathf.Min(panel.width * .72f, 820f * scale);
            var imageHeight = panel.height * .43f;
            var imageRect = new Rect(center.x - imageWidth * .5f, panel.y + 100f * scale, imageWidth, imageHeight);
            if (_loadingFactoryTexture != null)
            {
                GUI.color = Color.white;
                GUI.DrawTexture(imageRect, _loadingFactoryTexture, ScaleMode.ScaleToFit, true);
            }
            var stepRect = new Rect(panel.x + 24f * scale, imageRect.yMax + 4f * scale, panel.width - 48f * scale, 28f * scale);
            GUI.Label(stepRect, _loadingStep, step);

            var detailHeight = string.IsNullOrWhiteSpace(_loadingDetail) ? 0f : 36f * scale;
            if (detailHeight > 0f)
            {
                var detailRect = new Rect(panel.x + panel.width * .16f, stepRect.yMax + 1f * scale, panel.width * .68f, detailHeight);
                var detailStyle = new GUIStyle(_mutedStyle)
                {
                    alignment = TextAnchor.MiddleCenter,
                    wordWrap = true,
                    fontSize = Mathf.RoundToInt(11f * scale),
                    normal = { textColor = new Color(.9f, .69f, .57f) }
                };
                GUI.Label(detailRect, $"原因  {_loadingDetail}", detailStyle);
            }

            var barWidth = Mathf.Min(700f * scale, panel.width * .72f);
            var bar = new Rect(center.x - barWidth * .5f, stepRect.yMax + detailHeight + 13f * scale, barWidth, 7f * scale);
            GUI.color = new Color(.32f, .32f, .33f, 1f);
            GUI.DrawTexture(bar, _panelTexture, ScaleMode.StretchToFill);
            GUI.color = new Color(.55f, .78f, .7f, 1f);
            GUI.DrawTexture(new Rect(bar.x, bar.y, bar.width * _loadingProgress, bar.height), _panelTexture, ScaleMode.StretchToFill);
            GUI.color = Color.white;
            var labels = new[] { "现场配置", "三维场景", "设备模型", "实时数据" };
            var currentPhase = Mathf.Min(labels.Length - 1, Mathf.FloorToInt(_loadingProgress * labels.Length));
            var phaseStyle = new GUIStyle(_mutedStyle) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(10f * scale) };
            var phaseY = bar.yMax + 11f * scale;
            var phaseWidth = bar.width / labels.Length;
            for (var index = 0; index < labels.Length; index += 1)
            {
                var phaseRect = new Rect(bar.x + phaseWidth * index, phaseY, phaseWidth, 20f * scale);
                phaseStyle.normal.textColor = index < currentPhase
                    ? new Color(.67f, .79f, .7f)
                    : index == currentPhase ? new Color(.85f, .76f, .59f) : new Color(.48f, .49f, .47f);
                GUI.Label(phaseRect, $"{(index < currentPhase ? "✓" : "·")}  {labels[index]}", phaseStyle);
            }
            var percent = new GUIStyle(_mutedStyle) { alignment = TextAnchor.MiddleRight, fontSize = Mathf.RoundToInt(10f * scale) };
            GUI.Label(new Rect(bar.x, phaseY + 21f * scale, bar.width, 17f * scale), $"{Mathf.RoundToInt(_loadingProgress * 100f)}%", percent);
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
