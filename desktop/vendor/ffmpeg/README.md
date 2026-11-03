# 固定 FFmpeg 运行依赖

旧版上游自动构建的下载链接已失效。这里通过 Git LFS 保存 2026-11-02 的 Windows x64 LGPL shared 原始压缩包，首次构建不再依赖上游是否保留当天的资产。

- 版本：`n8.1.3-32-g760d10603e-20261102`。
- SHA-256：`8f8219f9a6a99da57c6fce6ab285b7dc7aed1d1dba26c1b50146677e63e59371`，与 GitHub 原始资产 digest 一致。
- [原始发布](https://github.com/BtbN/FFmpeg-Builds/releases/tag/latest)，该链接会更新，实际交付以本目录的压缩包和固定摘要为准。
- [构建脚本版本](https://github.com/BtbN/FFmpeg-Builds/tree/5ece628)、[FFmpeg 对应源码](https://github.com/FFmpeg/FFmpeg/tree/760d10603e)。

`prepare-ffmpeg.cjs` 在使用前校验摘要、实际版本、`h264_mf` 编码器和禁用 `libx264` 的构建参数；许可证、动态链接 DLL、来源与版本信息随安装包一并分发。更换依赖时必须同时更新脚本中的固定摘要与实际版本，不自动跟随 latest。

如果压缩包只有约 130 字节，先运行 `git lfs pull` 下载实际内容。
