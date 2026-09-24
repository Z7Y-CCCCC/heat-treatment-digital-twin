namespace HeatTreatmentAdminHost;

/// <summary>Retry only the latest permitted document navigation, never a POST or a blocked origin.</summary>
internal sealed class NavigationRetryPolicy
{
    private readonly string _applicationUrl;
    private ulong? _navigationId;
    private int _failures;
    public string Url { get; private set; }
    public bool IsCurrentNavigation(ulong id) => _navigationId == id;

    public NavigationRetryPolicy(string applicationUrl)
    {
        _applicationUrl = applicationUrl;
        Url = applicationUrl;
    }

    public bool Started(ulong navigationId, string url, bool cancelled = false)
    {
        if (cancelled || !WebContentPolicy.IsSameOrigin(url, _applicationUrl)) return false;
        if (!string.Equals(url, Url, StringComparison.Ordinal)) _failures = 0;
        Url = url;
        _navigationId = navigationId;
        return true;
    }

    public static bool IsUsable(bool success, int httpStatus) => success && httpStatus != 404 && httpStatus < 500;

    public int? Completed(ulong navigationId, bool success, int httpStatus, bool cancelled = false)
    {
        if (_navigationId != navigationId) return null;
        if (cancelled || IsUsable(success, httpStatus)) { _failures = 0; return null; }
        // A successful transport to a 401/403 is a real page requiring user
        // attention, not something to hammer with an automatic login retry.
        var delay = Math.Min(15000, 1000 * (1 << Math.Min(_failures, 4)));
        _failures = Math.Min(_failures + 1, 5);
        return delay;
    }
}
