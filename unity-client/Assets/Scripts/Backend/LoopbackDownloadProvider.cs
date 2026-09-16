using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using GLTFast.Loading;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Backend
{
    /// <summary>
    /// UnityWebRequest follows the Windows user proxy even for some loopback requests.
    /// Use a proxy-free HttpClient for the packaged local backend while preserving
    /// glTFast's default downloader for external HTTP(S) assets.
    /// </summary>
    public sealed class LoopbackDownloadProvider : IDownloadProvider
    {
        private static readonly HttpClient LoopbackClient = new HttpClient(new HttpClientHandler
        {
            UseProxy = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        })
        {
            Timeout = TimeSpan.FromSeconds(45)
        };

        private readonly DefaultDownloadProvider _defaultProvider = new DefaultDownloadProvider();
        private readonly CancellationToken _cancellationToken;

        public LoopbackDownloadProvider(CancellationToken cancellationToken = default)
        {
            _cancellationToken = cancellationToken;
        }

        public Task<IDownload> Request(Uri url)
        {
            return ShouldBypassProxy(url)
                ? RequestLoopback(url, _cancellationToken)
                : _defaultProvider.Request(url);
        }

        public Task<ITextureDownload> RequestTexture(Uri url, bool nonReadable)
        {
            return ShouldBypassProxy(url)
                ? RequestLoopbackTexture(url, nonReadable, _cancellationToken)
                : _defaultProvider.RequestTexture(url, nonReadable);
        }

        private static bool ShouldBypassProxy(Uri url)
        {
            if (url == null || !url.IsAbsoluteUri) return false;
            if (url.IsFile || url.IsLoopback) return true;
            var host = url.Host?.Trim('[', ']');
            return string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase);
        }

        private static async Task<IDownload> RequestLoopback(Uri url, CancellationToken cancellationToken)
        {
            try
            {
                if (url.IsFile)
                {
                    var data = await File.ReadAllBytesAsync(url.LocalPath, cancellationToken);
                    return new MemoryDownload(data, null, GuessBinary(data, null), null);
                }

                using var response = await LoopbackClient.GetAsync(url, cancellationToken);
                var dataBytes = await response.Content.ReadAsByteArrayAsync();
                var contentType = response.Content.Headers.ContentType?.MediaType;
                if (!response.IsSuccessStatusCode)
                {
                    return new MemoryDownload(
                        dataBytes,
                        contentType,
                        null,
                        $"HTTP {(int)response.StatusCode} {response.ReasonPhrase}"
                    );
                }
                return new MemoryDownload(dataBytes, contentType, GuessBinary(dataBytes, contentType), null);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception exception)
            {
                return new MemoryDownload(Array.Empty<byte>(), null, null, exception.Message);
            }
        }

        private static async Task<ITextureDownload> RequestLoopbackTexture(Uri url, bool nonReadable, CancellationToken cancellationToken)
        {
            var download = await RequestLoopback(url, cancellationToken) as MemoryDownload;
            if (download == null || !download.Success)
            {
                return new MemoryTextureDownload(download, null);
            }

            Texture2D texture = null;
            try
            {
                texture = new Texture2D(2, 2, TextureFormat.RGBA32, false, false)
                {
                    name = Path.GetFileName(url.LocalPath)
                };
                if (!texture.LoadImage(download.Data, nonReadable))
                {
                    UnityEngine.Object.Destroy(texture);
                    return new MemoryTextureDownload(download, null, "Unity could not decode the image data.");
                }
                return new MemoryTextureDownload(download, texture);
            }
            catch (Exception exception)
            {
                if (texture != null) UnityEngine.Object.Destroy(texture);
                return new MemoryTextureDownload(download, null, exception.Message);
            }
        }

        private static bool? GuessBinary(byte[] data, string contentType)
        {
            if (string.Equals(contentType, "model/gltf-binary", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(contentType, "model/gltf+json", StringComparison.OrdinalIgnoreCase)) return false;
            if (data != null && data.Length >= 4)
            {
                return data[0] == (byte)'g' && data[1] == (byte)'l' && data[2] == (byte)'T' && data[3] == (byte)'F';
            }
            return null;
        }

        private sealed class MemoryDownload : IDownload
        {
            private readonly string _contentType;

            public MemoryDownload(byte[] data, string contentType, bool? isBinary, string error)
            {
                Data = data ?? Array.Empty<byte>();
                _contentType = contentType;
                IsBinary = isBinary;
                Error = error;
            }

            public bool Success => string.IsNullOrEmpty(Error);
            public string Error { get; }
            public byte[] Data { get; }
            public string Text => Encoding.UTF8.GetString(Data);
            public bool? IsBinary { get; }
            public void Dispose() { }
        }

        private sealed class MemoryTextureDownload : ITextureDownload
        {
            private readonly MemoryDownload _download;
            private readonly string _decodeError;

            public MemoryTextureDownload(MemoryDownload download, Texture2D texture, string decodeError = null)
            {
                _download = download ?? new MemoryDownload(Array.Empty<byte>(), null, null, "Download failed.");
                Texture = texture;
                _decodeError = decodeError;
            }

            public bool Success => _download.Success && Texture != null && string.IsNullOrEmpty(_decodeError);
            public string Error => _decodeError ?? _download.Error;
            public byte[] Data => _download.Data;
            public string Text => _download.Text;
            public bool? IsBinary => _download.IsBinary;
            public Texture2D Texture { get; }
            public void Dispose() => _download.Dispose();
        }
    }
}
