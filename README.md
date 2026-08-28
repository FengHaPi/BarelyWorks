# 小破软件 · AI Video Studio

> Windows 本地优先、Agent-first 的 AI 视频生产控制台：用版本化产物、累计核查和人工门禁管理故事、剧本、资产、导演脚本、分镜、生成投递、质检与交付。

![Project status](https://img.shields.io/badge/status-alpha-7c3aed)
![Version](https://img.shields.io/badge/version-v0.2.0--alpha-6366f1)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12.0-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-22c55e)
[![Build](https://github.com/FengHaPi/BarelyWorks/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/FengHaPi/BarelyWorks/actions/workflows/verify.yml)
[![Release](https://img.shields.io/github/v/release/FengHaPi/BarelyWorks?include_prereleases&label=release)](https://github.com/FengHaPi/BarelyWorks/releases)

> **📦 [查看版本历史与下载源码](https://github.com/FengHaPi/BarelyWorks/releases)**

AI Video Studio 不是一个“输入一句话后全自动花钱生成”的黑盒。它优先解决版本混乱、上游错误向下扩散、人物漂移、镜头断裂、参考图语义丢失和假完成问题：文字阶段由项目内 Skill 驱动真实 Codex 执行，视频阶段默认编译可人工投递的 H3 / Updream 包，付费视频 API 保持关闭。

> [!IMPORTANT]
> 当前版本为 **v0.2.0 Alpha**。本次原地重构引入独立 Head、版本血缘、真实项目 Agent、可恢复 Operation、问题中心和逐级累计核查；每次进入后续环节都会重新核对适用上游，检查器缺失或失败不会被当作通过。

## 版本与下载

- GitHub Releases 保存公开发布的 **v0.1.0、v0.1.1 和 v0.2.0**，每个版本都固定到独立 Tag 与提交。
- v0.1.2～v0.1.6 是未单独发布的内部开发构建，相关改动已合并进入 v0.2.0，不作为可下载 Release。
- 当前 Alpha 版本仅提供源码压缩包，尚未提供 Windows 安装包或便携包；开发者可按下方“快速开始”运行。
- 发布版本时必须同步更新 package、插件清单、README、CHANGELOG、Tag 与 Release，流程见 [发布检查清单](docs/release-process.md)。

## 现在能做什么

- 创建、归档和恢复本地视频项目；原始输入、历史产物、审批记录和项目文件均保留。
- 为大纲、剧本、资产定义、导演脚本和分镜维护独立版本与 Head；新版本不会自动覆盖 Head，也不会偷偷批准或推进下一环节。
- 使用 10 个版本化生产 Skill 与真实 Codex 生成结构化产物，并记录模型、Skill 哈希、线程、用量、耗时和失败诊断。
- 项目 Agent 支持针对明确版本进行询问、比较、修改和影响分析；生产环境不使用固定回答兜底。
- 长任务统一进入持久化 Operation，提供进度、事件、幂等、刷新恢复、失败停止和取消。
- 问题中心把错误定位到最早责任产物，给出证据、检查主体、健康状态、修复顺序和显式修订入口。
- 从原始输入到当前环节执行累计核查：核对 Head、批准、文件哈希、版本血缘、结构合同、覆盖范围、模型/Skill 来源和人工证据。
- 建立人物、场景、道具、服装、风格和声音资产，维护稳定 ID、版本、文件哈希及镜头引用。
- 视觉资产支持 PNG/JPEG/WebP 参考图的上传、预览、替换和归档删除；音频资产不会出现图片上传入口。
- 每张参考图必须声明主参考、正面、侧面、背面、表情、服装或其他角色；角色约束会进入 Ref2VA 预检、模型输入、提示词优化和交付清单。没有参考图时明确使用 T2VA。
- 大纲和剧本先做确定性容量计算；内容超出目标时长时给出最低可靠时长并阻止继续。
- ShotSpec 使用结构化物理计划，校验摄影机、人物视线、显示面、反射拓扑、事件门、剧情 Beat、运镜和高风险任务预算。
- H3 只接收确定性编译的紧凑执行简报；提示词结构、字符预算、参考标签和模型可执行性失败时不生成可投递版本。
- 通过显式操作创建素材清单和逐镜头 H3 / Updream 投递包；外部平台提交仍由用户人工完成。
- 导入供应端视频后记录文件哈希和具体生成版本，执行九维人工质检；全部最新镜头通过后才允许显式创建本地粗剪并单独审核交付。
- 成片输出最低支持 480p；本地 FFmpeg / ffprobe、H.264/AAC 粗剪、SRT 和文件下载已通过合成媒体验收。

## 九阶段生产流程

```text
01 输入内容
  → 02 剧情大纲
  → 03 影视剧本
  → 04 资产定义
  → 05 导演脚本
  → 06 分镜设计
  → 07 视频生成
  → 08 质量审核
  → 09 剪辑导出
```

每个关键阶段都会停在人工审核门禁。系统不会自动批准结果，也不会因为页面等待而重复提交生成任务。

这九个区域不是只能向前的“闯关状态机”。用户可以独立查看和修订任意产物；进入更后环节时，系统会重新验证全部适用上游及其证据，并把问题定位到最早应修复的责任版本。

## 当前开发进度

| 实施阶段 | 状态 | 当前结果 |
|---|---|---|
| 项目、历史与迁移 | 已完成 | SQLite 增量迁移、不可变源文件、独立 Head、血缘边、原地兼容和可恢复归档 |
| Agent-first 工作区 | 已完成 | 三栏工作区、版本选择、真实项目 Agent、问题中心及显式生产入口 |
| Operation 基础设施 | 已完成 | 持久化进度与事件、幂等、失败停止、刷新恢复和取消 |
| 累计核查 | 已完成 | 确定性规则、模型 + Skill、人工批准三类检查主体及健康状态可见 |
| 资产与参考图 | 已完成 | 视觉资产角色约束、T2VA/Ref2VA 分流、服务端上传门禁；图像生成 Provider 默认关闭 |
| 导演脚本、分镜与 H3 | 已完成 | 物理计划、模型可执行性、连续性复检、紧凑执行简报和投递包失效检查 |
| 导回、质检与粗剪 | 本地实现完成 | 合成媒体已跑通导入、关键帧、九维审核、1080p 粗剪、SRT、终审与下载；真实供应端视频仍需人工视觉验收 |

v0.2.0 发布回归已通过 **33 个服务端测试文件 / 154 项测试、14 个 UI 测试文件 / 47 项测试和 1 条真实浏览器 E2E**；TypeScript 类型检查与前后端生产构建通过。旧投递包会按新的 `model-executability-v2` 策略标记为过期；运行时项目、日志和素材均由 `.gitignore` 排除，不会出现在公开仓库。

## 技术架构

| 层级 | 技术与职责 |
|---|---|
| UI | React 19 + Vite，Agent-first 工作区、问题中心、生产、质量审核和交付界面 |
| 本地服务 | Fastify，仅绑定 `127.0.0.1`；显式命令端点与持久化 Operation |
| 数据 | SQLite + Drizzle，项目文件、版本 Head、血缘、审批、问题和操作日志双重持久化 |
| 契约 | TypeScript + Zod + JSON Schema |
| 文字智能 | 本地 Codex CLI + 项目内版本化 `SKILL.md` 路由 + 真实项目 Agent |
| 累计核查 | 确定性证据、模型 + Skill 语义检查和人工批准相互独立，缺失结果不算通过 |
| 视频交接 | MiniMax H3 参数预检 + Updream 人工投递包 |
| 媒体处理 | 项目便携 FFmpeg 9.0.1 / ffprobe，libx264/AAC 能力预检与正式粗剪实现均已通过合成媒体自检 |

## 快速开始

### 环境要求

- Windows 10/11
- Node.js 22.12.0 或更高版本
- npm
- 可正常运行的 Codex CLI
- FFmpeg / ffprobe：仅在视频导回与粗剪阶段需要

### 开发模式

```powershell
git clone https://github.com/FengHaPi/BarelyWorks.git
cd BarelyWorks
npm install
npm run dev
```

- 前端开发地址：`http://127.0.0.1:5173`
- 本地 API：`http://127.0.0.1:4317`

### 构建并运行

```powershell
npm run check
npm start
```

生产构建由本地服务在 `http://127.0.0.1:4317` 提供。常用命令：

| 命令 | 用途 |
|---|---|
| `npm run dev` | 同时启动 API 和 Vite 开发服务 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行服务端与 UI Vitest 测试 |
| `npm run build` | 构建服务端和前端 |
| `npm run check` | 类型检查、服务端/UI 测试、完整构建和真实浏览器 E2E |
| `npm run verify:media` | 生成临时测试片段并验证探测、H.264/AAC 粗剪与输出参数 |
| `npm run verify:phase5` | 用真实 FFmpeg 验证视频导回、九维审核、粗剪、SRT、终审交付和文件下载 |
| `npm run verify:v1` | 执行完整构建测试、媒体自检和 Phase 5 端到端发布门禁 |
| `npm start` | 启动已构建的本地应用 |

## Skill 路由

仓库当前包含 10 个生产 Skill 和 2 个供应端 Skill：

```text
ai-video-producer
├─ project-intake
├─ story-architect
├─ screenplay-writer
├─ asset-bible-builder
├─ asset-reference-prompt-writer
├─ shooting-script-director
├─ storyboard-director
├─ continuity-supervisor
└─ video-quality-reviewer

provider-skills
├─ h3-prompt-writing
└─ updream-handoff
```

每次文字生成都会记录实际使用的 Skill 名称、版本、SHA-256、Schema 版本和运行诊断，避免只在界面上声称“用了 Skill”。

## 数据与安全边界

- 服务默认只监听本机 `127.0.0.1`。
- `.env`、SQLite、项目原文、参考图、生成视频、交付文件和运行日志不会提交 Git。
- 付费视频 API 默认关闭；当前不自动操作 Updream 网页。
- 已批准产物只新增版本，不覆盖历史。
- 超时或失败不会改变项目阶段；若 Codex 已写出部分结果，会保存在项目日志目录用于诊断。
- 不要把 Cookie、Token、API Key 或个人登录信息写进仓库。

## 仓库结构

```text
src/                 Fastify 服务、工作流、数据与生成逻辑
ui/                  React 本地控制台
skills/              项目生产 Skill
provider-skills/     H3 与 Updream 供应端 Skill
templates/schemas/   结构化输出 JSON Schema
tests/               状态机、契约、持久化和完整工作流测试
docs/                环境证据、备份策略和外部能力清单
projects/             本地运行时项目，仅保留 .gitkeep
```

## 文档

- [更新日志](CHANGELOG.md)
- [发布检查清单](docs/release-process.md)
- [v0.2.0 发布说明](docs/releases/v0.2.0.md)
- [Agent-first 原地重构方案与验收](docs/agent-first-refactor-plan.zh-CN.md)
- [Agent-first 二次核查与修复汇总](docs/agent-first-remediation-audit.zh-CN.md)
- [环境与契约证据](docs/phase-0-environment.md)
- [本地项目与备份策略](docs/backup-policy.md)
- [本地媒体工具链](docs/media-toolchain.md)
- [V1 验收状态](docs/v1-acceptance.md)
- [2026-08-25 全项目代码审查](docs/code-audit-2026-08-25.md)
- [Updream 能力检查清单](docs/updream-capability-checklist.md)

## 参与贡献与安全报告

- 普通缺陷和功能建议请使用 [Issues](https://github.com/FengHaPi/BarelyWorks/issues)。
- 提交代码前请阅读 [贡献指南](CONTRIBUTING.md)，并确保 `npm run check` 完整通过。
- 安全漏洞不要发布为公开 Issue，请按 [安全政策](SECURITY.md) 私密报告。

## 已知限制

- 当前是 Windows 本地单用户工作台，不提供远程多用户服务。
- FFmpeg 合成媒体探测与粗剪已通过；真实供应端视频的导回、质量审核和完整项目交付仍需实际验收。
- Updream 被视为人工生成端，不依赖未经验证的私有接口或网页自动化。
- H3 提示词结构已校验，但视觉效果必须以真实生成结果为准。
- 当前没有自动调用任何付费视频 API。

## 许可证

[MIT](LICENSE) © 2026 风诀
