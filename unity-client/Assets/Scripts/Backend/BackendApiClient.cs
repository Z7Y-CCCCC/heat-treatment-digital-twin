using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace HeatTreatment.DigitalTwin.Backend
{
    public sealed class BackendApiClient
    {
        private readonly string _baseUrl;
        private readonly CookieContainer _sessionCookies = new CookieContainer();
        private readonly HttpClient _client;

        public CookieContainer SessionCookies => _sessionCookies;

        public BackendApiClient(string baseUrl)
        {
            _baseUrl = (baseUrl ?? string.Empty).TrimEnd('/');
            _client = new HttpClient(new HttpClientHandler
            {
                UseProxy = false,
                UseCookies = true,
                CookieContainer = _sessionCookies,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
            })
            {
                Timeout = TimeSpan.FromSeconds(30)
            };
        }

        public async Task<NativeLoginResult> ExchangeNativeTicketAsync(string ticket, CancellationToken cancellationToken)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/admin-auth/native-exchange");
            request.Headers.TryAddWithoutValidation("X-Admin-Request", "1");
            request.Headers.TryAddWithoutValidation("Origin", _baseUrl);
            request.Content = new StringContent(JsonConvert.SerializeObject(new { ticket }), Encoding.UTF8, "application/json");

            using var response = await _client.SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync();
            var document = ParseResponse(body);
            if (!response.IsSuccessStatusCode)
            {
                throw new BackendRequestException(
                    (int)response.StatusCode,
                    document?.Value<string>("code"),
                    document?.Value<string>("error") ?? $"大屏会话同步失败（HTTP {(int)response.StatusCode}）"
                );
            }

            var permissions = document?["permissions"];
            return new NativeLoginResult
            {
                Authenticated = document?.Value<bool?>("authenticated") == true,
                CanView = permissions?.Value<bool?>("view") == true,
                CanLaunch = permissions?.Value<bool?>("launch") == true,
                DisplayName = document?["user"]?.Value<string>("displayName") ?? "现场用户"
            };
        }

        public async Task<FactoryConfigDto> GetFactoryConfigAsync(CancellationToken cancellationToken)
        {
            var url = $"{_baseUrl}/api/config";
            using var response = await _client.GetAsync(url, cancellationToken);
            var json = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                var document = ParseResponse(json);
                throw new BackendRequestException((int)response.StatusCode,
                    document?.Value<string>("code"),
                    document?.Value<string>("error") ?? $"现场配置读取失败（HTTP {(int)response.StatusCode}）");
            }
            return JsonConvert.DeserializeObject<FactoryConfigDto>(json)
                ?? throw new InvalidOperationException("Backend returned an empty configuration document.");
        }

        public void ScopeSessionForWebSocket(string endpoint)
        {
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var webSocketUri)
                || (webSocketUri.Scheme != "ws" && webSocketUri.Scheme != "wss")) return;
            var apiUri = new Uri($"{_baseUrl}/api");
            var cookieUri = new UriBuilder(webSocketUri)
            {
                Scheme = webSocketUri.Scheme == "wss" ? Uri.UriSchemeHttps : Uri.UriSchemeHttp,
                Path = "/ws",
                Query = string.Empty,
                Fragment = string.Empty
            }.Uri;
            foreach (Cookie cookie in _sessionCookies.GetCookies(apiUri))
            {
                if (!cookie.Name.StartsWith("dt_admin_session_", StringComparison.Ordinal)) continue;
                var realtimeCookie = new Cookie(cookie.Name, cookie.Value, "/ws")
                {
                    HttpOnly = true,
                    Secure = webSocketUri.Scheme == "wss",
                    Expires = cookie.Expires
                };
                _sessionCookies.Add(cookieUri, realtimeCookie);
            }
        }

        public void ClearSession()
        {
            ClearCookiesAt(new Uri($"{_baseUrl}/api"));
            ClearCookiesAt(new Uri($"{_baseUrl}/ws"));
        }

        private void ClearCookiesAt(Uri uri)
        {
            foreach (Cookie cookie in _sessionCookies.GetCookies(uri))
            {
                _sessionCookies.Add(uri, new Cookie(cookie.Name, string.Empty, cookie.Path)
                {
                    Expires = DateTime.UtcNow.AddDays(-1),
                    HttpOnly = true
                });
            }
        }

        private static JObject ParseResponse(string body)
        {
            try { return JObject.Parse(body ?? string.Empty); }
            catch { return null; }
        }
    }

    public sealed class NativeLoginResult
    {
        public bool Authenticated { get; set; }
        public bool CanView { get; set; }
        public bool CanLaunch { get; set; }
        public string DisplayName { get; set; }
    }

    public sealed class BackendRequestException : InvalidOperationException
    {
        public int StatusCode { get; }
        public string Code { get; }

        public BackendRequestException(int statusCode, string code, string message) : base(message)
        {
            StatusCode = statusCode;
            Code = code ?? string.Empty;
        }
    }
}
