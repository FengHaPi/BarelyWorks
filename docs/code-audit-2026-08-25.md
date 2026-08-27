# 全项目代码审查报告（2026-08-25）

## 结论摘要

- 审查范围：仓库内 117 个源码、配置、脚本、Skill、测试与文档文件；排除 `node_modules/`、构建产物和本地运行时数据。
- 审查方式：静态调用链与数据流追踪、类型检查、服务端/UI 回归测试、生产构建、真实 FFmpeg 媒体链路、Phase 5 端到端验收、依赖树与依赖公告检查。
- 安全边界：只做源码逻辑、隔离测试和防御性修复；没有构造 exploit、伪造身份/Origin、访问其他项目或对外部目标进行扫描。
- 已直接修复：路径与项目边界、写操作竞态、资产投影、参考图解码、媒体导入、后台扫描、画幅语义、Codex 运行诊断、UI 错误状态/无障碍、跨标签并发、版本与 CI 等 18 组问题。
- 仍需专项改造：1 项高优先级数据一致性风险，以及若干备份、迁移、取消、长文本、跨进程协调、测试覆盖和架构债务。它们没有在本轮用高风险“大改”掩盖。

## 已确认并修复的问题

| ID | 位置 | 原因与实际影响 | 已实施修复 | 立即修复 |
|---|---|---|---|---|
| F-01 | `src/handoff/updream-package-builder.ts` | 镜头 ID、包版本若未经严格限制就参与路径拼接，可能读写错误包目录。 | 镜头 ID 固定为 `S###`，版本固定为正整数和 `v###`，解析后再次校验项目目录边界。 | 已完成 |
| F-02 | `src/projects/project-service.ts` | 手工另存可引用不存在、其他项目或错误类型的来源产物，破坏版本血缘。 | 创建版本前查询来源产物并校验项目、存在性和同类型约束。 | 已完成 |
| F-03 | `src/server/local-origin.ts`、`src/server.ts`、`vite.config.ts` | 固定端口来源规则会使自定义本地端口误拒绝合法界面；过宽规则又会扩大浏览器请求面。 | 依据实际 API 端口生成精确的 localhost/127.0.0.1 白名单，Vite 代理共用端口配置。 | 已完成 |
| F-04 | `src/server/operation-coordinator.ts`、`src/server.ts` | 重复点击、后台扫描和前台写入可并发修改同一项目，造成重复版本、阶段覆盖或 SQLite 唯一键冲突。 | 所有项目写路由和后台收件箱扫描统一使用每项目进程内互斥，冲突返回 409。 | 已完成 |
| F-05 | `src/server.ts` | 通用阶段跳转接口可绕过批准、连续性和制作就绪门禁。 | 移除通用跳转，只保留具备业务校验的专用动作。 | 已完成 |
| F-06 | `src/projects/project-service.ts` | 旧 Asset Bible 成员仍被投影为当前资产；同 ID 但身份已改变的资产会错误继承旧参考图。 | 当前投影只保留最新版成员；参考图仅在类型与身份/造型指纹兼容时继承；资产与镜头投影使用 SQLite 事务。 | 已完成 |
| F-07 | `src/media/image-validation.ts`、`tests/image-validation.test.ts` | 只看扩展名/文件头无法确认图片真实可解码，截断文件、伪格式、超大像素图会进入资产库。 | 使用 Sharp 完整解码 PNG/JPEG/WebP 像素，补充 PNG CRC/chunk/IEND、容器长度、尺寸和 1600 万像素上限。 | 已完成 |
| F-08 | `ui/src/upload.ts`、`src/projects/project-service.ts` | 参考图授权原来可能被界面默认确认，用户没有作出明确授权。 | 上传前必须由用户主动勾选，服务端继续记录授权状态。 | 已完成 |
| F-09 | `src/media/import-validation.ts`、`src/projects/quality-service.ts` | 导入视频缺少时长、画幅、最低清晰度门禁；接受后文件若改变，粗剪可能使用不同内容。 | 校验镜头时长、项目画幅和最低短边 480px；粗剪前重新计算已接受文件哈希。 | 已完成 |
| F-10 | `src/projects/quality-service.ts` | 收件箱定时复扫会把已成功导入的同文件报告成错误，失败文件又会每 15 秒重复进行昂贵探测。 | 同哈希复扫变为幂等跳过；确定性失败按文件指纹短时缓存；瞬态失败不缓存且界面显示完整原因。 | 已完成 |
| F-11 | `src/media/media-toolchain.ts` | 手机视频的旋转元数据未计入显示宽高，会误判横竖画幅；非 90 度旋转也会得出错误边界。 | 读取 side-data/tag 旋转，90/270 度交换宽高，其余角度计算旋转后的包围盒。 | 已完成 |
| F-12 | `src/ai/codex-cli-provider.ts`、`src/skills/provider-skill-registry.ts` | JSONL 只保留诊断尾部会丢线程/用量；供应端 Skill 只锁版本不能发现内容漂移；stdin 错误可能形成未处理异常。 | 流式累计关键 JSONL 事件；Skill 锁文件校验 SHA-256；处理 stdin EPIPE，并保留失败输出和诊断。 | 已完成 |
| F-13 | `src/projects/project-service.ts`、`tests/aspect-description.test.ts` | 简单替换画幅文本会改坏“不要 9:16”、墙上竖屏显示器和角色设定图，也可能错误继承参考图。 | 只处理最终构图语义，区分否定、转折、物体屏幕比例和方形画幅；新增聚焦回归。 | 已完成 |
| F-14 | `src/shared/schemas.ts`、`ui/src/App.tsx` | 尚未实现结构化导入却允许选择导演脚本/分镜，会创建无法继续的项目；分辨率与画幅方向可互相冲突。 | 暂时明确禁用两种未实现入口；校验画幅与输出规格，最低支持 480p。 | 已完成 |
| F-15 | `ui/src/api.ts`、`ui/src/async-state.ts`、`ui/src/App.tsx` | 网络失败统一显示 `Failed to fetch`，长任务缺少合理超时，提交成功但刷新失败会被误报为操作失败，对话框键盘焦点也不完整；部分工作区首屏失败后会永久显示加载动画。 | 分类本地服务不可达、超时、取消和非 JSON 错误；分离 mutate/refresh 状态；补充焦点陷阱、Esc、错误可见性和按钮状态；生成、质检、交付页提供失败详情、重试和返回入口。 | 已完成 |
| F-16 | `ui/src/App.tsx`、`ui/src/project-refresh.ts`、`src/projects/project-service.ts` | 流程侧栏永远显示 `01 / 09`；多标签页可把旧项目响应覆盖到新项目、在归档后静默切到另一项目，或用旧版本编辑覆盖新版本；恢复的旧会话草稿若改用当前最新 ID 保存，还会绕过版本冲突。 | 显示真实阶段；前台刷新项目/健康/详情，使用 request epoch 丢弃乱序结果；项目消失时退回总览并提示；工作区按项目隔离；文本和镜头另存携带草稿创建时的 expected-latest 基线，冲突返回 409；草稿写入 sessionStorage，前台刷新和跨阶段同步均不覆盖脏草稿。 | 已完成 |
| F-17 | `package.json`、`.github/workflows/verify.yml`、`scripts/setup-portable-ffmpeg.ps1` | Node/Vite 版本边界、前后端测试入口和 FFmpeg 包校验不完整，会出现本地能跑而 CI/安装失败。 | Node 最低版本固定为 22.12；服务端/UI 测试和构建纳入 `check`；FFmpeg 安装要求明确 SHA-256 后才解包。 | 已完成 |
| F-18 | `ui/src/App.tsx` | 首页把资产/镜头读取失败伪装成 0，交付版本长期硬编码为 0；提交期间继续编辑会在成功刷新时丢输入。 | 失败显示“—/读取失败”，读取真实粗剪/交付版本数；阶段、镜头、质检和终审提交期间冻结相关输入，避免提交后覆盖新草稿。 | 已完成 |

## 1. 严重 Bug / 数据损坏、崩溃或核心功能失效风险

### R-01：SQLite、项目文件、manifest 与日志没有统一提交边界

- 位置：`src/projects/project-service.ts` 的 `createArtifactVersion`、`moveToReview`、`transition`；`src/projects/quality-service.ts` 的收件箱导入、粗剪和交付审批。
- 原因：一次业务操作会依次写 Markdown/JSON/媒体文件、多个 SQLite 表、`project.yaml` 和 JSONL 日志。SQLite 事务不能覆盖文件系统；部分流程在数据库已提交后若 manifest/日志写入失败，异常清理仍可能删除数据库正在引用的文件。
- 实际影响：磁盘满、杀进程、杀毒软件占用或 I/O 失败时，可能出现“数据库有版本但文件不存在”、阶段已推进但 manifest 仍旧、交付目录半成品等不一致状态。
- 推荐修改：引入持久化 operation journal/outbox；先在临时目录完整写入并 `fsync`，再以一个 SQLite 事务提交记录和目标阶段，最后原子发布目录；启动时扫描未完成 journal 并恢复或回滚。针对每个写点增加故障注入测试。
- 是否建议立即修复：**是。在真实项目长期保存或公开 Beta 前必须完成。** 本轮没有做临时补丁，因为局部调整顺序不能真正保证跨存储原子性，反而可能制造新的丢失路径。

### R-02：只有备份策略说明，没有可执行、可验证的备份与恢复

- 位置：`docs/backup-policy.md`、`src/database/client.ts`、项目 `data/` 与 `projects/` 布局。
- 原因：SQLite 使用 WAL，但没有在线备份 API、checkpoint 协调、项目文件一致性快照、备份校验清单和恢复演练。
- 实际影响：磁盘损坏、误操作或升级失败后，没有被程序验证过的恢复路径；直接复制 WAL 活跃数据库与项目目录可能得到时间点不一致的副本。
- 推荐修改：使用 SQLite backup API 或停写快照，生成数据库+项目目录 manifest（路径、大小、SHA-256），备份到独立磁盘，并在临时目录执行自动恢复校验。
- 是否建议立即修复：**是。在把真实不可替代素材作为唯一副本保存前必须完成。**

## 2. 普通功能 Bug / 明确功能缺口

### R-03：导演脚本与分镜作为起始输入尚未实现

- 位置：`src/shared/schemas.ts` 的 `createProjectInputSchema`。
- 原因：`sourceType` 契约包含 `shooting-script`、`storyboard`，但缺少相应结构化解析、初始 artifact/projection 和阶段恢复逻辑；当前只能安全地拒绝。
- 实际影响：UI/产品宣称的“任意阶段接入”尚未完全兑现。
- 推荐修改：为两种输入定义稳定 JSON/文本导入格式、错误定位、预览与映射测试，再开放入口。
- 是否建议立即修复：正式宣称支持前修复；当前拒绝是安全降级。

### R-04：Updream 初始化包创建不是目录级原子操作

- 位置：`src/handoff/updream-package-builder.ts` 的 `createBootstrap`、`createShotPackage`。
- 原因：在最终目录中逐个复制/创建多个文件；中途失败会留下目录和部分文件，下一次可能因 `COPYFILE_EXCL`/`wx` 持续失败，或被读取端误认为有效版本。
- 实际影响：断电、磁盘满或单个素材不可读时，投递包可能卡在无法重试的半成品状态。
- 推荐修改：写入同父目录的唯一临时目录，所有文件完成并校验 manifest 后原子 rename；启动/列表时忽略并清理过期临时目录。
- 是否建议立即修复：是，进入真实批量投递前。

### R-05：长时间 Codex/FFmpeg 操作缺少用户取消与可靠进程树终止

- 位置：`src/ai/codex-cli-provider.ts`、`src/media/media-toolchain.ts`、`ui/src/api.ts`。
- 原因：HTTP 层已有 AbortController，但没有业务取消端点；Windows 上 `child.kill()` 只保证向直接子进程发信号，包装器的后代进程不一定退出。
- 实际影响：用户只能等待超时；极端情况下后台进程仍占用 CPU/GPU/文件，重新操作会被互斥锁阻塞。
- 推荐修改：保存 operation ID/PID/job object，提供取消端点；Windows 使用受控 Job Object 或明确的进程树终止方案，并记录取消结果。
- 是否建议立即修复：是，长篇项目或普通用户发布前。

### R-06：业务错误大多被压成 HTTP 400，内部错误文本直接返回界面

- 位置：`src/server.ts` 的 `setErrorHandler`。
- 原因：除校验、互斥、项目不存在外，文件 I/O、SQLite、业务冲突和真正的服务端故障都变成 400；原始 `Error.message` 可能包含本地绝对路径或底层细节。
- 实际影响：界面无法区分可修输入、冲突和服务故障，日志/监控统计失真，也可能暴露不必要的本地路径信息。
- 推荐修改：建立 typed domain errors，映射 404/409/422/500；500 只返回关联 ID 和安全文案，完整堆栈留本地结构化日志。
- 是否建议立即修复：是，公开给非开发者使用前。

### R-06A：生产构建不是可独立搬运的完整发行包

- 位置：`scripts/build-server.mjs`、`package.json:start`、运行时 `configs/`、`skills/`、`provider-skills/`、`.codex-plugin/`、`tools/`。
- 原因：服务端构建把依赖 externalize，且构建步骤只生成 `dist/server` 与 `dist/ui`；启动仍依赖仓库根的 `node_modules`、配置、Skill 和工具目录。
- 实际影响：在仓库内 `npm start` 正常，但只复制 `dist/` 到另一目录会在运行中缺依赖/Skill/配置。CI 的 build 通过不能证明独立发行物可启动。
- 推荐修改：明确选择 npm-style 部署或桌面安装包；若做便携发行，生成带 manifest 的 staging 目录，复制并校验所有运行时资源，随后从该目录执行启动/health/Skill/media smoke test。
- 是否建议立即修复：桌面安装包或便携 ZIP 发布前立即修复；当前源码仓库运行不阻塞。

## 3. 潜在 Bug 与边界问题

### R-07：运行目录同时承担程序文件与可变数据目录

- 位置：`src/server.ts:runtimeRoot`、`src/database/client.ts:createStudioDatabase`。
- 原因：默认把 `data/`、`projects/`、工具、Skill、配置和 `dist/` 都放在 `process.cwd()` 下。
- 实际影响：安装到只读目录、从不同工作目录启动或升级覆盖程序时，会导致数据库创建失败、读取错误配置或误分裂成多个数据根。
- 推荐修改：分离只读 application root 与 `AI_VIDEO_STUDIO_DATA_ROOT`，Windows 默认使用 `%LOCALAPPDATA%/AI-Video-Studio`；启动日志明确显示两者的规范化路径。
- 是否建议立即修复：安装器/桌面封装前立即修复；当前开发目录可继续使用。

### R-08：数据库迁移没有版本表和可回滚迁移器

- 位置：`src/database/client.ts`。
- 原因：启动时直接执行 `CREATE TABLE IF NOT EXISTS`，目前只有 `archived_at` 做手工列检查；表已存在时，新的约束、索引或列默认值不会自动升级。
- 实际影响：旧用户数据库可能悄悄缺列/缺约束，升级后才在业务操作中报错。
- 推荐修改：增加 `schema_migrations` 和顺序迁移文件；迁移前创建已验证备份，失败时停止启动并给出恢复说明。
- 是否建议立即修复：是，在下一次 schema 变化之前。

### R-09：互斥只在单个 Node 进程内有效

- 位置：`src/server/operation-coordinator.ts`。
- 原因：状态保存在内存 `Set`；第二个服务实例、升级时短暂双实例或外部脚本不会共享锁。
- 实际影响：两个实例指向同一数据根时，版本号计算和文件独占写入仍会竞态。
- 推荐修改：启动时对数据根持有 OS 文件锁；关键版本分配同时使用 SQLite 事务/CAS/唯一约束重试。
- 是否建议立即修复：单进程开发模式可延后；桌面自动更新或允许多开前修复。

### R-09A：并非所有可变实体都有细粒度乐观锁

- 位置：资产参考图/上传状态、Updream 包上传状态等更新路由。
- 原因：文本产物和 ShotSpec 已校验 expected latest；部分简单状态仍采用最后写入者生效。单进程协调器可串行执行，但不知道客户端基线是否已过期。
- 实际影响：两个标签同时切换同一上传状态时，较晚请求可能覆盖较早用户意图；不可变审核记录和历史文件不会丢失。
- 推荐修改：为可编辑实体增加 `version`/`updatedAt` CAS；冲突返回 409，并在 UI 展示服务端当前值。对纯幂等“设为某状态”操作可保留现状但必须在响应后刷新。
- 是否建议立即修复：低到中；多人/多窗口高频操作前完成。

### R-10：已导入媒体在质检阶段仍可被外部修改

- 位置：`src/projects/quality-service.ts` 的 `scanGenerationInbox`、质量审核和粗剪。
- 原因：导入后保存 probe 元数据和哈希，但直到粗剪才强制重哈希；质检关键帧和用户看到的媒体可能与之后磁盘内容不同。
- 实际影响：审核通过的内容与最终粗剪输入不一致；当前粗剪会阻断而不是静默交付，但用户需要重新导入/审核。
- 推荐修改：导入副本设为只读并在打开质检、提交审核、生成粗剪三个边界校验哈希；发生变化时使已有审核失效。
- 是否建议立即修复：建议，真实素材目录可被同步软件/用户修改时优先。

### R-11：画幅语义依赖中文规则解析，不能覆盖所有自然语言表达

- 位置：`src/projects/project-service.ts` 的 `extractAspectRatios`、`repairAspectText`、`referenceCompatibilityKey`。
- 原因：否定、转折、物体屏幕和最终构图目前由正则/分句启发式判断。
- 实际影响：罕见句式仍可能误报或漏报画幅冲突；现有测试覆盖常见句式但不能证明自然语言完备。
- 推荐修改：把最终输出画幅从自由文本移到结构化字段，文本只作说明；规则解析仅用于旧数据迁移和警告。
- 是否建议立即修复：不阻塞 Alpha；在支持大量外部文本导入前完成结构化迁移。

### R-12：媒体画幅未使用 SAR/DAR 处理变形像素

- 位置：`src/media/media-toolchain.ts` 的 `probe`/`displayDimensionsFromProbeStream`。
- 原因：已处理旋转，但画幅仍主要按 coded width/height，未把 sample/display aspect ratio 纳入最终显示比例。
- 实际影响：少量 anamorphic、老 DV 或特殊转码视频会被误判项目画幅。
- 推荐修改：优先解析合法 `display_aspect_ratio`，否则用 width × SAR 推导，并增加 ffprobe fixture 回归。
- 是否建议立即修复：低到中；常规手机/平台输出不阻塞，接受广播/老素材前修复。

### R-13：无 Origin 请求被视为可信，只适合本机单用户威胁模型

- 位置：`src/server/local-origin.ts:isAllowedBrowserOrigin`。
- 原因：浏览器 Origin 白名单能防网页跨源写入，但 curl、本机恶意进程和部分原生客户端没有 Origin，当前直接允许。
- 实际影响：同一 Windows 用户权限下的其他进程可调用 API；监听地址仍限制在 loopback，风险不扩展到局域网。
- 推荐修改：启动时生成短期随机会话令牌，由静态 UI 通过安全 bootstrap 获取并在写请求携带；或使用命名管道/桌面 WebView 的受控通道。
- 是否建议立即修复：若始终是本机单用户 Alpha，可列为已接受风险；任何 LAN/多用户模式前必须修复。

## 4. 性能问题

### R-14：最大 500 万字符原文一次性读入并一次性提交 Codex

- 位置：`src/shared/schemas.ts`、`src/projects/project-service.ts`、`src/ai/codex-cli-provider.ts`。
- 原因：接口允许 5,000,000 字符，生成链路整文件读取、JSON 序列化并写入一个子进程 stdin，没有 token 预算、分块或层级摘要。
- 实际影响：大文本会产生高内存峰值、极长等待、模型上下文溢出和不可预测费用/配额消耗。
- 推荐修改：按章节建立导入索引，预估 token，超过阈值时执行可追溯的分块抽取→章节摘要→全局合并，并保留证据定位。
- 是否建议立即修复：是，在宣称支持长篇小说前。

### R-15：没有全局 Codex/FFmpeg 并发上限

- 位置：`src/server.ts`、`src/server/operation-coordinator.ts`。
- 原因：只限制“同一项目一次写操作”，不同项目仍可同时启动多个大模型或转码进程。
- 实际影响：多标签/多项目操作可占满内存、CPU、磁盘和 Codex 配额，导致所有任务超时。
- 推荐修改：为 Codex 和 FFmpeg 分别建立有界队列、并发数和等待状态；UI 显示排队位置并允许取消。
- 是否建议立即修复：普通单项目 Alpha 可延后；批量项目或自动化前修复。

### R-16：后台每 15 秒遍历所有活动项目收件箱

- 位置：`src/server.ts`、`src/projects/quality-service.ts:scanAllGenerationInboxes`。
- 原因：固定轮询所有项目目录；当前已有状态和失败缓存，仍会随项目数量增加产生目录 I/O。
- 实际影响：项目很多或项目目录位于慢盘时，会形成持续磁盘唤醒和延迟。
- 推荐修改：只轮询 `GENERATING/GENERATION_REVIEW` 项目，或使用文件系统 watcher + 低频兜底扫描；记录扫描耗时。
- 是否建议立即修复：低；项目数量增长后处理。

### R-17：JSONL 日志只追加、不轮转

- 位置：`src/projects/project-service.ts`、`src/projects/quality-service.ts`、`src/ai/codex-cli-provider.ts` 的 `appendLog`。
- 原因：每次操作持续 append，没有大小/日期轮转、压缩或保留期。
- 实际影响：长期项目日志无限增长，备份变慢，极端情况下占满磁盘并触发 R-01。
- 推荐修改：按大小/日期轮转并保留索引；备份前纳入容量预检；诊断日志和审计日志采用不同保留策略。
- 是否建议立即修复：中；长期使用前完成。

## 5. 架构和代码质量问题

### R-18：核心服务和主界面职责过度集中

- 位置：`src/projects/project-service.ts`（约 1500 行）、`src/projects/quality-service.ts`（约 780 行）、`ui/src/App.tsx`（约 1500 行）。
- 原因：项目仓储、工作流、产物、资产、连续性、handoff、媒体、审批和多个页面组件混在大文件中。
- 实际影响：修改一个阶段容易影响其他阶段；难以做局部测试、故障注入和代码所有权划分。
- 推荐修改：按 bounded context 拆分 repository、workflow service、artifact service、asset service、generation/quality service；UI 按页面与领域 hooks 拆分。先补 characterization tests，再渐进迁移。
- 是否建议立即修复：不做一次性重写；从解决 R-01/R-05 时开始渐进拆分。

### R-19：服务端 Zod 契约与 UI TypeScript 类型手工重复

- 位置：`src/shared/*.ts`、`ui/src/types.ts`。
- 原因：UI 类型不是由共享契约或生成产物自动导出，新增字段需要人工同步。
- 实际影响：编译可以通过，但运行时返回字段与前端声明可能漂移。
- 推荐修改：建立仅含纯契约的共享包，或从 JSON Schema/OpenAPI 生成客户端类型和请求层；CI 校验生成文件无差异。
- 是否建议立即修复：中；下一轮新增 API 前处理收益最高。

### R-20：配置入口分散，启动时缺少一次性完整校验

- 位置：`src/server.ts`、`src/media/media-toolchain.ts`、`src/projects/project-service.ts:loadH3Capabilities`、`vite.config.ts`。
- 原因：端口、host、runtime root、FFmpeg 路径和供应端配置分别在使用点解析。
- 实际影响：错误在流程中段才暴露，日志难以说明实际生效配置；开发/生产可能读取不同根目录。
- 推荐修改：启动时用一个 Zod config schema 解析环境，输出脱敏后的有效配置摘要，并在 readiness 中报告依赖项。
- 是否建议立即修复：中；桌面打包前完成。

## 6. 可优化、可简化、可重构与测试缺口

### R-21：自动化测试缺少真实浏览器组件/E2E、故障注入与恢复测试

- 位置：`tests/`、`ui/src/*.test.ts`、`.github/workflows/verify.yml`。
- 原因：当前测试强项是 schema、服务层和真实 FFmpeg Phase 5；UI 仍是纯函数/API 测试，没有渲染 `App`，CI 不运行真实 FFmpeg，也没有磁盘满、进程中止、SQLite 错误、备份恢复和真正并发 HTTP 请求测试。
- 实际影响：按钮可见性、焦点、跨标签刷新、部分提交恢复和打包后启动仍主要靠人工发现。
- 推荐修改：增加 Playwright 本地 E2E；为文件/数据库适配层提供可控故障注入；增加真实并发请求、built-dist 启动、备份恢复和 Windows nightly FFmpeg 作业。
- 是否建议立即修复：R-01 修复必须先配故障注入；E2E 建议在下一功能迭代前加入。

### R-22：缺少 lint、覆盖率阈值和持续的在线依赖公告门禁

- 位置：`package.json`、`.github/workflows/verify.yml`。
- 原因：`check` 包含类型、测试和构建，但没有 ESLint/静态规则、覆盖率阈值、CodeQL/依赖更新策略；离线 audit 只反映本地缓存的公告。
- 实际影响：未使用分支、Promise 误用、React hooks 依赖和新公布供应链风险可能不能及时阻断。
- 推荐修改：加入 ESLint（TypeScript/React/hooks）、Vitest coverage 基线、Dependabot/Renovate 与 GitHub dependency review；定期联网执行 `npm audit` 并人工复核。
- 是否建议立即修复：中；不阻塞本轮 Alpha，但应在公开仓库持续开发前加入。

### R-23：健康检查只证明进程存活，不能证明核心依赖可用

- 位置：`src/server.ts:/api/health`。
- 原因：未统一报告 SQLite 可写、项目根可写、Skill 锁完整性、Codex CLI 与媒体工具状态。
- 实际影响：UI 可能显示“服务在线”，直到用户开始生成/导入才发现环境不完整。
- 推荐修改：分离 `/health/live` 与 `/health/ready`；readiness 缓存并报告各依赖状态，避免每次请求启动昂贵探测。
- 是否建议立即修复：低到中；打包交付前完成。

## 验证记录

最终交付前实际门禁结果：

- `npm run typecheck`：通过。
- `npm run test:server`：18 个测试文件、77 项测试全部通过。
- `npm run test:ui`：4 个测试文件、14 项测试全部通过。
- `npm run build`：服务端与 Vite 生产构建通过。
- `npm run verify:media`：FFmpeg/ffprobe 9.0.1、H.264、AAC、有声/无声输入和正式粗剪通过。
- `npm run verify:phase5`：真实 4 秒媒体完成导入、三点关键帧、九维审核、1920×1080 粗剪、SRT、终审及 MP4/SRT/Markdown 下载。
- `npm audit --json`：联网查询结果为 0 个已知漏洞；共解析 278 个依赖（121 production、125 development，含可选依赖重叠统计）。
- `npm ls --all --json`：退出码 0，无 invalid/extraneous 依赖错误。
- `git diff --check`：通过。

## 推荐实施顺序

1. 先做 R-01 跨存储 operation journal、故障注入和启动恢复。
2. 同步完成 R-02 可执行备份/恢复与 R-08 版本化迁移，避免修数据库时没有退路。
3. 处理 R-04 原子投递包、R-05 取消/进程树和 R-06 typed errors。
4. 桌面打包前完成 R-07 数据根分离、R-09 单实例锁、R-20 集中配置。
5. 长篇/批量能力开放前完成 R-14 分块、R-15 全局队列、R-16 扫描优化。
6. 以 R-21 的 E2E/故障注入保护渐进式拆分 R-18/R-19，避免一次性重写。
