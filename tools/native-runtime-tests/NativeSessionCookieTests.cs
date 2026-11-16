using System.Net;
using HeatTreatment.DigitalTwin.Backend;

internal static partial class Program
{
    private static Task NativeSessionCookieMatchesWebSocket()
    {
        const string name = "dt_admin_session_0123456789abcdef";
        var api = new BackendApiClient("http://127.0.0.1:3990");
        var origin = new Uri("http://127.0.0.1:3990");
        void Set(string value) => api.SessionCookies.Add(origin, new Cookie(name, value, "/api") { HttpOnly = true });
        Set("first-session");
        // Reproduce Unity/Mono's response jar with only the API cookie; do not
        // assume every Set-Cookie from the exchange has reached ClientWebSocket.
        api.SessionCookies.Add(origin, new Cookie(name + "_active", "main", "/api"));
        api.SessionCookies.Add(origin, new Cookie(name + "_account_" + new string('a', 24), "other-account", "/api"));
        api.ScopeSessionForWebSocket("ws://127.0.0.1:64974/ws");
        var wsUri = new Uri("http://127.0.0.1:64974/ws");
        var first = api.SessionCookies.GetCookies(wsUri)[name + "_ws"];
        Check(first?.Value == "first-session" && first.Path == "/ws" && first.HttpOnly,
            "Upgrade must carry the server's _ws cookie, not an API cookie with the wrong name.");
        Check(api.SessionCookies.GetCookies(wsUri)[name + "_active_ws"] == null,
            "Account selectors must never be mirrored as credentials.");
        Set("new-child-session");
        api.ScopeSessionForWebSocket("ws://127.0.0.1:64974/ws");
        Check(api.SessionCookies.GetCookies(wsUri)[name + "_ws"]?.Value == "new-child-session",
            "Reconnect must replace the old socket identity with the newly exchanged child session.");
        Check(api.SessionCookies.GetCookies(new Uri("http://127.0.0.1:64974/"))[name + "_ws"] == null,
            "Realtime cookie cannot escape /ws.");
        api.ScopeSessionForWebSocket("wss://127.0.0.1:64974/ws");
        Check(api.SessionCookies.GetCookies(new Uri("https://127.0.0.1:64974/ws"))[name + "_ws"]?.Secure == true,
            "WSS cookie must remain Secure.");
        api.ClearSession();
        Check(api.SessionCookies.GetCookies(new Uri("http://127.0.0.1:3990/api"))[name] == null,
            "Clearing authentication must remove the API credential.");
        Check(api.SessionCookies.GetCookies(new Uri("https://127.0.0.1:64974/ws"))[name + "_ws"] == null,
            "Clearing authentication must remove the realtime credential.");
        return Task.CompletedTask;
    }
}
