namespace HeatTreatmentAdminHost;

internal static class DashboardMapEntry
{
    internal static string BuildUrl(string sourceUrl)
    {
        if (!Uri.TryCreate(sourceUrl, UriKind.Absolute, out var source)
            || (source.Scheme != Uri.UriSchemeHttp && source.Scheme != Uri.UriSchemeHttps))
            throw new ArgumentException("后台服务地址无效", nameof(sourceUrl));
        return new UriBuilder(source)
        {
            Path = "/group",
            Query = "embedded=unity&surface=overlay&level=world",
            Fragment = string.Empty
        }.Uri.AbsoluteUri;
    }
}
