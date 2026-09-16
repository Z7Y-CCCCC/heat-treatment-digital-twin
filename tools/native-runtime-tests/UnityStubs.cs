// Compile the actual connection code without starting Unity or a GPU renderer.
namespace UnityEngine
{
    public class MonoBehaviour { }
    public class Object
    {
        public static void Destroy(Object instance) { }
    }
    public enum TextureFormat { RGBA32 }
    public class Texture2D : Object
    {
        public string name;
        public Texture2D(int width, int height, TextureFormat format, bool mipChain, bool linear) { }
        public bool LoadImage(byte[] data, bool nonReadable) => true;
    }
    public static class Mathf
    {
        public static float Max(float left, float right) => Math.Max(left, right);
    }
    public static class Debug
    {
        public static void LogWarning(object message) => Console.Error.WriteLine(message);
    }
}

// Only the glTFast downloader contract is needed to test the real HTTP path.
namespace GLTFast.Loading
{
    public interface IDownload : IDisposable
    {
        bool Success { get; }
        string Error { get; }
        byte[] Data { get; }
        string Text { get; }
        bool? IsBinary { get; }
    }
    public interface ITextureDownload : IDownload { UnityEngine.Texture2D Texture { get; } }
    public interface IDownloadProvider
    {
        Task<IDownload> Request(Uri url);
        Task<ITextureDownload> RequestTexture(Uri url, bool nonReadable);
    }
    public sealed class DefaultDownloadProvider : IDownloadProvider
    {
        public Task<IDownload> Request(Uri url) => throw new NotSupportedException("External downloads are not test fixtures.");
        public Task<ITextureDownload> RequestTexture(Uri url, bool nonReadable) => throw new NotSupportedException("External textures are not test fixtures.");
    }
}
