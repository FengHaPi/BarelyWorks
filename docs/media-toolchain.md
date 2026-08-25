# 本地媒体工具链

AI Video Studio 不会把“命令存在”等同于“可完成粗剪”。媒体预检同时验证：

- `ffmpeg` 可执行；
- `ffprobe` 可执行；
- FFmpeg 提供 `libx264` 视频编码器；
- FFmpeg 提供 `aac` 音频编码器。

只有四项全部通过，程序才会启用“创建新粗剪版本”。视频导回只依赖 `ffprobe`，仍会逐文件探测真实时长、分辨率、帧率、编解码器和音轨。

## 路径优先级

程序按以下顺序解析工具：

1. `AI_VIDEO_STUDIO_FFMPEG_PATH` / `AI_VIDEO_STUDIO_FFPROBE_PATH` 指定的绝对路径；
2. 项目便携目录 `tools/ffmpeg/bin/ffmpeg.exe` 与 `tools/ffmpeg/bin/ffprobe.exe`；
3. 系统 `PATH` 中的 `ffmpeg` 与 `ffprobe`。

便携目录不会提交 Git。放入或更新二进制后需要重启本地服务，再在“生成中心 → MEDIA PREFLIGHT”查看真实探测结果。

## Windows Essentials ZIP

FFmpeg 官方下载页列出的 Windows 构建来源包含 gyan.dev。当前核验的发布版 Essentials ZIP：

- 版本：FFmpeg 9.0.1 Essentials Build；
- 大小：约 106.1 MB；
- 直链：<https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.1-essentials_build.zip>；
- SHA-256：`fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9`；
- 核验日期：2026-08-25。

下载完成后，在项目根目录运行：

```powershell
powershell.exe -NoProfile -File .\scripts\setup-portable-ffmpeg.ps1 `
  -ArchivePath "C:\path\to\ffmpeg-9.0.1-essentials_build.zip" `
  -ExpectedSha256 "fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9"
```

脚本会先校验 SHA-256，在临时目录解压并运行压缩包内工具，确认 `libx264` 和 `aac` 后才写入项目便携目录。已有版本会先备份；失败时恢复原版本。

安装并重启本地服务后，可运行真实媒体自检：

```powershell
npm run verify:media
```

自检会在系统临时目录生成一个带 AAC 音频的横向片段和一个无音频的竖向片段，调用程序自己的探测与粗剪实现合成为 640×360 H.264/AAC MP4，再次使用 ffprobe 验证。成功后自动删除测试文件；失败时保留诊断目录。

需要验证 Phase 5 的完整业务链路时运行：

```powershell
npm run verify:phase5
```

该命令会在临时运行目录创建隔离项目，以真实 FFmpeg 串联收件箱导入、ffprobe 探测、九维审核记录、粗剪、SRT、终审交付，以及 MP4/SRT/报告下载。成功后删除临时项目；失败时保留诊断目录，不会修改用户的真实项目。

## 安全边界

- 程序不会自动下载或安装 FFmpeg。
- 安装脚本只处理用户已经下载到本机的 ZIP，不发起网络请求。
- 未通过预检时不会创建虚假生成记录或粗剪记录。
- 收件箱原视频只复制归档，不覆盖、不删除。
- 粗剪固定输出 H.264 (`libx264`) + AAC，并保留 FFmpeg 日志和 ffprobe 报告。
