# 小破软件 · AI Video Studio

> Windows 本地优先的 AI 视频生产控制台：把故事、大纲、剧本、资产、导演脚本、分镜、生成投递、质检和交付放进一条可审核、可追溯的工作流。

![Project status](https://img.shields.io/badge/status-alpha-7c3aed)
![Version](https://img.shields.io/badge/version-v0.2.0--alpha-6366f1)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12.0-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-22c55e)

AI Video Studio 不是一个“输入一句话后全自动花钱生成”的黑盒。它优先解决生产过程中的版本混乱、人物漂移、镜头断裂、审批失效和素材重复上传问题：文字阶段由本地 Skill 驱动 Codex，视频阶段默认生成可人工投递的 H3 / Updream 包，付费视频 API 保持关闭。

> [!IMPORTANT]
> 当前版本为 **v0.2.0 Alpha**。本次升级把“付费生成前可执行性”提升为硬门禁：先计算剧情容量，再限制每镜头 Beat、运镜、事件门和高风险任务，未通过的导演脚本、分镜或 H3 提示词不能进入付费投递。

## 现在能做什么

- 创建本地视频项目，保存不可变原始内容，并在重启后恢复。
- 可恢复地删除项目，并从“已归档”列表恢复，不物理清除项目文件与历史版本。
- 使用结构化 Skill 生成剧情大纲、影视剧本、资产定义、导演脚本和分镜。
- 批准文字产物后自动生成下一阶段草案；批准最终分镜后自动锁定素材、创建初始化包并打开生成中心。
- 对每个阶段执行批准、驳回和重新生成；上游改变后自动让下游版本失效。
- 建立人物、场景、道具、风格和声音资产，维护稳定 ID、版本、文件哈希及镜头引用。
- 在“原创完整设定”和“忠于已有文本／参考图”之间选择资产设计策略。
- 对人物、场景、道具、服装和风格一键调用本地 Codex 生成中英文参考图提示词；提示词版本化保存并可直接复制。
- 图像生成 API 通过独立 Provider 接口预留，默认关闭且不产生费用；配置后才会生成、校验并绑定真实图片。
- 上传 JPG、PNG、WebP 参考图并保存在项目本地，不把私人项目素材提交到 Git。
- 生成带完整时间码的 ShotSpec，执行时长、资产引用和连续性检查。
- 大纲和剧本生成后先进行确定性容量计算；内容超出目标时长时直接给出最低可靠时长，并可保留历史后一键调整项目时长重新开始。
- 新生成 ShotSpec 带结构化物理计划，硬校验摄影机与人物视线、手机/显示面朝向、正常镜像与镜面异常实体数量，以及灯光/故障等事件的首次发生时间。
- 每个生产镜头限制主要剧情 Beat、运镜阶段、精确事件门和屏幕/镜面/群体/反常空间高风险层；超限必须拆镜，不能依靠长提示词硬塞。
- 固定加载 MiniMax H3 提示词 Skill，生成 Updream 初始化包和逐镜头增量包。
- Codex CLI 文字模型固定为可配置的明确型号；H3 只读取当前模式需要的指南，并只接收确定性编译出的紧凑执行简报，不再重复灌入整套上游对象。
- H3 提示词的结构、长度、参考标签重复度与模型可执行性最多内部重试三次；仍不合格时不保存、不进入投递。
- 一键补齐全部预检通过且尚未生成的镜头包；已有版本不会重复生成，失败镜头独立报告。
- 成片输出规格最低支持 480p；供应端生成清晰度在每次镜头投递时单独选择，不写入提示词。
- 记录人工上传、生成版本、质量审核和交付状态，不伪造外部平台结果。
- 最后一个镜头通过审核后自动创建本地粗剪；内容质量与成片交付仍由用户明确批准。
- 保存 Codex 运行路由、Skill 哈希、线程、用量、耗时和失败诊断。

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

## 当前开发进度

| 实施阶段 | 状态 | 当前结果 |
|---|---|---|
| Phase 0 · 环境与契约验证 | 已完成 | Node、Codex JSONL、H3 Skill 已验证；项目便携 FFmpeg 9.0.1、ffprobe、libx264 与 AAC 已通过真实媒体自检 |
| Phase 1 · 项目骨架和数据层 | 已完成 | React/Vite、Fastify、SQLite/Drizzle、状态机和本地恢复 |
| Phase 2 · 故事、剧本和审批 | 已完成 | 大纲、剧本、版本、批准、驳回与失效链路 |
| Phase 3 · 资产、导演脚本和分镜 | 已完成 | 资产库、参考图、ShotSpec、分镜和连续性检查 |
| Phase 4 · H3 与 Updream 投递 | 已实现 | H3 预检、初始化包、逐镜头包和人工投递状态 |
| Phase 5 · 导回、质检和粗剪 | 本地实现完成 | 合成媒体已完整跑通导回、三点关键帧、九维审核、1080p 粗剪、SRT、终审交付与文件下载；等待真实供应端视频的视觉质量验收 |
| Phase 6 · 增强自动化 | 未开始 | 仅在 V1 真实项目通过后评估 |

v0.2.0 发布前回归已通过 122 项服务端测试与 35 项 UI 测试。旧投递包会按新的 `model-executability-v2` 策略自动标记为过期；运行时项目、日志和素材均由 `.gitignore` 排除，不会出现在公开仓库。

## 技术架构

| 层级 | 技术与职责 |
|---|---|
| UI | React 19 + Vite，生产流程、素材库、生成中心、质量审核和交付界面 |
| 本地服务 | Fastify，仅绑定 `127.0.0.1` |
| 数据 | SQLite + Drizzle，项目文件与数据库双重持久化 |
| 契约 | TypeScript + Zod + JSON Schema |
| 文字智能 | 本地 Codex CLI + 项目内 `SKILL.md` 路由 |
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
| `npm test` | 运行 Vitest 测试 |
| `npm run build` | 构建服务端和前端 |
| `npm run check` | 类型检查、测试和完整构建 |
| `npm run verify:media` | 生成临时测试片段并验证探测、H.264/AAC 粗剪与输出参数 |
| `npm run verify:phase5` | 用真实 FFmpeg 验证视频导回、九维审核、粗剪、SRT、终审交付和文件下载 |
| `npm run verify:v1` | 执行完整构建测试、媒体自检和 Phase 5 端到端发布门禁 |
| `npm start` | 启动已构建的本地应用 |

## Skill 路由

仓库当前包含 9 个生产 Skill 和 2 个供应端 Skill：

```text
ai-video-producer
├─ project-intake
├─ story-architect
├─ screenplay-writer
├─ asset-bible-builder
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
- [环境与契约证据](docs/phase-0-environment.md)
- [本地项目与备份策略](docs/backup-policy.md)
- [本地媒体工具链](docs/media-toolchain.md)
- [V1 验收状态](docs/v1-acceptance.md)
- [2026-08-25 全项目代码审查](docs/code-audit-2026-08-25.md)
- [Updream 能力检查清单](docs/updream-capability-checklist.md)

## 已知限制

- 当前是 Windows 本地单用户工作台，不提供远程多用户服务。
- FFmpeg 合成媒体探测与粗剪已通过；真实供应端视频的导回、质量审核和完整项目交付仍需实际验收。
- Updream 被视为人工生成端，不依赖未经验证的私有接口或网页自动化。
- H3 提示词结构已校验，但视觉效果必须以真实生成结果为准。
- 当前没有自动调用任何付费视频 API。

## 许可证

[MIT](LICENSE) © 2026 风诀
