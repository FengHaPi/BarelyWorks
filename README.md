# 小破软件 · AI Video Studio

> Windows 本地优先的 AI 视频生产控制台：把故事、大纲、剧本、资产、导演脚本、分镜、生成投递、质检和交付放进一条可审核、可追溯的工作流。

![Project status](https://img.shields.io/badge/status-alpha-7c3aed)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-22c55e)

AI Video Studio 不是一个“输入一句话后全自动花钱生成”的黑盒。它优先解决生产过程中的版本混乱、人物漂移、镜头断裂、审批失效和素材重复上传问题：文字阶段由本地 Skill 驱动 Codex，视频阶段默认生成可人工投递的 H3 / Updream 包，付费视频 API 保持关闭。

> [!IMPORTANT]
> 当前版本处于 Alpha。核心文字生产链路已经跑通，真实视频导回、FFmpeg 粗剪和完整成片验收仍在继续建设。

## 现在能做什么

- 创建本地视频项目，保存不可变原始内容，并在重启后恢复。
- 使用结构化 Skill 生成剧情大纲、影视剧本、资产定义、导演脚本和分镜。
- 对每个阶段执行批准、驳回和重新生成；上游改变后自动让下游版本失效。
- 建立人物、场景、道具、风格和声音资产，维护稳定 ID、版本、文件哈希及镜头引用。
- 在“原创完整设定”和“忠于已有文本／参考图”之间选择资产设计策略。
- 上传 JPG、PNG、WebP 参考图并保存在项目本地，不把私人项目素材提交到 Git。
- 生成带完整时间码的 ShotSpec，执行时长、资产引用和连续性检查。
- 固定加载 MiniMax H3 提示词 Skill，生成 Updream 初始化包和逐镜头增量包。
- 记录人工上传、生成版本、质量审核和交付状态，不伪造外部平台结果。
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
| Phase 0 · 环境与契约验证 | 基本完成 | Node、Codex JSONL、H3 Skill 已验证；FFmpeg 尚未安装 |
| Phase 1 · 项目骨架和数据层 | 已完成 | React/Vite、Fastify、SQLite/Drizzle、状态机和本地恢复 |
| Phase 2 · 故事、剧本和审批 | 已完成 | 大纲、剧本、版本、批准、驳回与失效链路 |
| Phase 3 · 资产、导演脚本和分镜 | 已完成 | 资产库、参考图、ShotSpec、分镜和连续性检查 |
| Phase 4 · H3 与 Updream 投递 | 已实现 | H3 预检、初始化包、逐镜头包和人工投递状态 |
| Phase 5 · 导回、质检和粗剪 | 进行中 | 质量审核与媒体工具链已搭建，等待真实视频和 FFmpeg 验收 |
| Phase 6 · 增强自动化 | 未开始 | 仅在 V1 真实项目通过后评估 |

最近一次本地端到端测试已完成新的资产定义 V002：15 项资产全部通过制作就绪校验，生成耗时约 4 分 29 秒，当前停在人工资产审核。运行时项目、日志和素材均由 `.gitignore` 排除，不会出现在公开仓库。

## 技术架构

| 层级 | 技术与职责 |
|---|---|
| UI | React 19 + Vite，生产流程、素材库、生成中心、质量审核和交付界面 |
| 本地服务 | Fastify，仅绑定 `127.0.0.1` |
| 数据 | SQLite + Drizzle，项目文件与数据库双重持久化 |
| 契约 | TypeScript + Zod + JSON Schema |
| 文字智能 | 本地 Codex CLI + 项目内 `SKILL.md` 路由 |
| 视频交接 | MiniMax H3 参数预检 + Updream 人工投递包 |
| 媒体处理 | FFmpeg / ffprobe 适配层（本机尚未安装） |

## 快速开始

### 环境要求

- Windows 10/11
- Node.js 22 或更高版本
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
- [Updream 能力检查清单](docs/updream-capability-checklist.md)

## 已知限制

- 当前是 Windows 本地单用户工作台，不提供远程多用户服务。
- FFmpeg / ffprobe 尚未在本机安装，因此真实视频导回和粗剪未完成验收。
- Updream 被视为人工生成端，不依赖未经验证的私有接口或网页自动化。
- H3 提示词结构已校验，但视觉效果必须以真实生成结果为准。
- 当前没有自动调用任何付费视频 API。

## 许可证

[MIT](LICENSE) © 2026 风诀
