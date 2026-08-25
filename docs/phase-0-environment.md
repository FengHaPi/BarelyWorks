# Phase 0 环境与契约证据

首次检查：2026-08-24；最近更新：2026-08-25（Asia/Shanghai）

| 项目 | 当前证据 | 状态 |
|---|---|---|
| Node.js | `v24.14.1` | 可用 |
| npm | `11.11.0` | 可用 |
| pnpm | `11.19.0` | 可用 |
| Git | `2.53.0.windows.3` | 可用 |
| FFmpeg / ffprobe | 项目便携 `9.0.1-essentials_build-www.gyan.dev`；ffmpeg、ffprobe、libx264、AAC 全部通过预检 | 可用 |
| Codex CLI | Microsoft Store 入口不可用，项目固定使用 npm 版 `@openai/codex 0.149.1` | 可用 |
| npm Codex CLI | `codex-cli 0.149.1`，已完成真实结构化生成 | 可用 |
| H3 Skill | `provider-skills/h3-prompt-writing`，`main@d21241f0a4b3` | 已加载并校验 |

## Codex CLI 最小真实 JSONL 测试

使用 npm 版、`--ephemeral`、只读沙箱和非 Git 目录豁免执行极小测试。实际观察到的事件顺序：

```text
thread.started
turn.started
item.completed (item.type = agent_message, text = READY)
turn.completed (usage 包含 input_tokens、cached_input_tokens、cache_write_input_tokens、output_tokens、reasoning_output_tokens)
```

程序实现不得假设未来版本仍有完全相同的字段。最终答案提取、用量统计和日志归档必须分离；统计解析失败不能丢失答案。

## 已完成的媒体契约

- FFmpeg/ffprobe：程序按环境变量、项目便携目录、系统 PATH 三层解析；当前使用项目便携版本。已用正式 `FfmpegMediaToolchain` 生成并探测有声/无声测试片段，合成为 640×360 H.264/AAC MP4，输出时长、分辨率、编码器和音轨全部通过验证。复验命令为 `npm run verify:media`，详见 `docs/media-toolchain.md`。

## 未完成的外部契约

- H3 官方 Skill：已固定到项目并通过结构校验；尚未经过真实视频生成的提示词只能标记为“结构已验证，视觉效果未验证”。
- Updream：不作为稳定 API。正式使用前由用户在已登录网页确认上传、项目、生成、下载和平台规则。
