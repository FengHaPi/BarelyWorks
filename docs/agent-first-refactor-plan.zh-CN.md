# AI Video Studio Agent-first 原地重构方案

> 日期：2026-08-27
> 状态：已实施并验证
> 约束：原项目原地改造；不建立备份；不删除现有项目、文件、数据库记录和历史版本；不另立新项目。

## 1. 结论

当前问题不是某个页面或某一处“锁定”逻辑写错，而是产品的主模型错了：系统把视频项目建模成一条只能向前推进的全局状态机，并让审批、生成、修复、质检和粗剪自动串联。它适合一次性流水线，不适合反复查看、比较、修改和重做的创作项目。

本次重构不再围绕“修好闯关模式”，而是将闯关模式从主架构中移除，改成：

- 一个长期存在的项目工作区；
- 多份可随时打开、比较和另存版本的项目文档；
- 一个能针对指定内容接受修改指令的项目 Agent；
- 所有耗时操作均可观察、可取消、可恢复；
- 下游内容与上游版本通过依赖关系关联，不再通过全局锁控制；
- 旧生成结果、旧粗剪和旧交付保留为历史快照，但不会冒充当前结果。

用户不需要删除现有项目，也不需要重新立项。现有项目、版本、素材、生成记录、质检记录和交付文件均在原数据库与原目录内迁移到新模型。

## 2. 已确认的根因

### 2.1 全局状态机被当成唯一事实

`projects.current_stage`、`projects.stale_stages` 和 `src/workflow/state-machine.ts` 共同决定整个项目“现在能做什么”。它把大纲、剧本、资产、导演脚本、分镜、生成、质检、粗剪和交付压在同一条线性顺序上。

直接后果：

- 回改前面的文档时，项目整体被退回；
- 后续所有环节被批量标记失效；
- 用户能看见历史内容，却不能自然地继续修改；
- 某一步异常会把整条项目线锁住；
- 只要状态字段被强行推进，界面就可能显示“已完成”，即使证据并不完整。

### 2.2 修改版本会触发全局失效传播

`ProjectService.createArtifactVersion()` 使用 `downstreamStages()` 把后续阶段统一加入 `staleStages`，同时把 `currentStage` 改回目标审核阶段。这是截图中“文字结构一致性未通过，批准已锁定”的架构来源，不是单个提示文案造成的。

真正需要表达的是“这个分镜版本基于哪一版导演脚本”，而不是“整个项目被锁住”。

### 2.3 UI 仍是闯关导航

`ui/src/project-workbench.ts` 把项目固定成九步，并根据全局阶段计算 `done/current/future/needs-update`。`ui/src/App.tsx` 又在同一文件内同时承担项目列表、阶段导航、文档审核、生成中心、质检、粗剪和交付。

直接后果：

- 想找某份内容，必须先理解系统阶段；
- 页面信息量巨大，主次不清；
- 技术审计、业务操作、历史记录和当前任务混在一起；
- 用户看到的是系统内部状态，不是自己的项目资料。

### 2.4 自动串联让错误继续向下扩散

当前存在以下自动推进：

- `approveAndContinue()`：批准后自动生成下一份文档；
- `nextArtifactAfterApproval()`：把审批与下一环节绑定；
- `generationPreparationPlan()`：自动锁素材、创建初始化包；
- `shouldAutoRenderAfterReview()`：最后一个镜头通过后自动生成粗剪；
- 连续性自动修复链：失败后由文字模型改写，再继续执行后续动作。

这会产生最严重的假完成：上游未批准、提示词未生成或质检未完成，下游却因为状态被推进而出现粗剪和交付记录。

### 2.5 长任务没有成为可靠的后台作业

`src/server/operation-coordinator.ts` 只在 Node 进程内保存一个操作 Map。当前作业缺少：

- 持久化状态；
- 进程重启恢复；
- 明确的取消请求；
- 子进程树终止；
- 分阶段进度；
- 结构化错误；
- 同一次请求的幂等控制。

所以页面可能长时间转圈，刷新后又无法确认后端究竟还在运行、失败还是已经失去关联。

### 2.6 核心服务和界面过度集中

当前 `src/projects/project-service.ts` 与 `ui/src/App.tsx` 都接近三千行。任何局部修复都容易碰到全局阶段、副作用和其他界面状态，导致“修一个点，另一个点又坏”。

已有代码审计中的 R-01、R-05、R-08、R-09、R-18 和 R-21 与这次实际暴露的问题一致：缺少操作日志、取消、版本化迁移、可靠互斥、职责拆分和真实浏览器恢复测试。

## 3. 产品目标与非目标

### 3.1 必须达到的目标

1. 用户可以随时打开大纲、剧本、资产定义、导演脚本、分镜、镜头包、质检和剪辑记录。
2. 用户可以在任何文档上发出修改指令，不受项目全局阶段限制。
3. 每次修改都产生不可变的新版本，旧版本可查看、比较和重新选为当前版本。
4. 下游内容继续可查看，不因上游改动而被锁；系统只提示其依赖了旧版本。
5. 用户明确点击的操作才会执行；系统不得偷偷批准、自动生成下一步、自动修复后继续或自动粗剪。
6. 长任务必须立即返回作业 ID，页面刷新后仍能看到状态，并能取消。
7. 失败必须停在失败点，完整汇报错误、已完成动作和未执行动作。
8. 当前项目在原地完成迁移，不要求用户重新创建项目。
9. 人工提交 Updream、H3 或其他付费生成平台仍保持人工控制，不把付费 API 或浏览器自动化作为依赖。

### 3.2 本次明确不做

- 不创建备份、副本或快照项目；
- 不删除旧文件、旧记录、旧版本或旧交付；
- 不把旧状态机换皮后继续作为主导航；
- 不做一次性全量重写；
- 不接入未经验证的付费接口；
- 不让 Agent 自动替用户批准内容；
- 不以更多警告框代替架构调整。

## 4. 保留、废弃与新增

| 类型 | 项目 | 处理方式 |
|---|---|---|
| 保留 | `artifacts` 的不可变版本 | 继续作为所有文字与结构化产物的版本事实 |
| 保留 | 原始输入、素材文件、生成视频、粗剪和交付文件 | 原地保留并补充来源关系 |
| 保留 | `approvals` | 改为针对具体 artifact 的证据，不再推进全局阶段 |
| 保留 | `assets`、`shots`、`generation_jobs`、`quality_reviews`、`renders` | 与选定 artifact 版本建立明确关联 |
| 保留 | Skills、提示词编译、Provider 适配、FFmpeg 工具链 | 从自动流水线中拆出，成为显式命令 |
| 退出主权 | `projects.current_stage` | 迁移期仅做兼容缓存，最终不再参与写操作与门禁 |
| 退出主权 | `projects.stale_stages` | 用 artifact 依赖差异和 issue 记录替代 |
| 废弃 | `downstreamStages()` 全局失效传播 | 不再因编辑上游而批量锁定下游 |
| 废弃 | 九步闯关式主导航 | 改为文档、素材、生成、质检、剪辑等工作区导航 |
| 废弃 | 批准后自动生成下一步 | 批准只记录当前版本决定 |
| 废弃 | 自动连续性修复并继续 | 修复建议必须等待用户确认，再单独执行 |
| 废弃 | 镜头通过后自动粗剪 | 粗剪只接受明确点击 |
| 废弃 | 原始审计数据占据主页面 | 默认只显示可操作的问题摘要，技术证据折叠 |
| 新增 | 当前选定版本 Head | 每种文档独立选定当前版本，不依赖单一阶段 |
| 新增 | Artifact 依赖边 | 精确记录“这一版使用了哪些上游版本” |
| 新增 | 项目问题中心 | 将错误、警告、待确认项统一为可处理 issue |
| 新增 | 持久化 Operations | 支持排队、运行、完成、失败、取消、恢复和事件流 |
| 新增 | 项目 Agent 会话 | 针对项目和指定 artifact 接受自然语言修改指令 |
| 新增 | Revision Request | 记录用户要求、目标版本、执行状态和产出版本 |

## 5. 新的数据模型

第一阶段只做新增表和新增字段，不执行 `DROP TABLE`、`DELETE` 或破坏性字段改名。迁移脚本必须可以重复执行。

### 5.1 `schema_migrations`

用于替代目前散落在启动代码中的临时迁移判断。

```text
version             TEXT PRIMARY KEY
name                TEXT NOT NULL
applied_at          TEXT NOT NULL
checksum            TEXT NOT NULL
```

### 5.2 `project_heads`

每个项目、每种产物独立选择当前版本。

```text
project_id          TEXT NOT NULL
artifact_type       TEXT NOT NULL
artifact_id         TEXT NOT NULL
selected_at         TEXT NOT NULL
selected_by         TEXT NOT NULL       -- user | migration | system
PRIMARY KEY(project_id, artifact_type)
```

示例：剧本当前选择 V003，导演脚本仍可选择基于剧本 V002 的旧版本；界面提示依赖不同，但两者均可查看和修改。

### 5.3 `artifact_edges`

```text
artifact_id         TEXT NOT NULL
input_artifact_id   TEXT NOT NULL
relation            TEXT NOT NULL       -- derived-from | references | compiled-from
created_at          TEXT NOT NULL
PRIMARY KEY(artifact_id, input_artifact_id, relation)
```

它取代“顺序靠后就全部失效”的模糊规则。有效性由当前 Head 与实际依赖边比较得出。

### 5.4 `operations`

```text
id                  TEXT PRIMARY KEY
project_id          TEXT NOT NULL
kind                TEXT NOT NULL
target_type         TEXT
target_id           TEXT
status              TEXT NOT NULL       -- queued | running | succeeded | failed | cancel_requested | cancelled
phase               TEXT
progress_current    INTEGER
progress_total      INTEGER
request_payload     TEXT NOT NULL
result_payload      TEXT
error_code          TEXT
error_message       TEXT
process_id          INTEGER
idempotency_key     TEXT
created_at          TEXT NOT NULL
started_at          TEXT
finished_at         TEXT
heartbeat_at        TEXT
```

### 5.5 `operation_events`

```text
operation_id        TEXT NOT NULL
sequence            INTEGER NOT NULL
event_type          TEXT NOT NULL
payload             TEXT NOT NULL
created_at          TEXT NOT NULL
PRIMARY KEY(operation_id, sequence)
```

所有阶段变化、Provider 输出、重试、错误和取消结果均写成事件。UI 可以从事件恢复，不再依赖内存中的 spinner。

### 5.6 `project_issues`

```text
id                  TEXT PRIMARY KEY
project_id          TEXT NOT NULL
scope_type          TEXT NOT NULL       -- project | artifact | asset | shot | generation | render
scope_id            TEXT
severity            TEXT NOT NULL       -- error | warning | info
code                TEXT NOT NULL
title               TEXT NOT NULL
detail              TEXT NOT NULL
suggested_action    TEXT
status              TEXT NOT NULL       -- open | resolved | ignored
source              TEXT NOT NULL       -- validator | migration | operation | user
created_at          TEXT NOT NULL
resolved_at         TEXT
```

例如“分镜 V004 未通过文字结构一致性”会成为分镜 V004 的一个 issue，不再锁整个项目。旧粗剪若基于分镜 V002，则显示“历史快照，未基于当前分镜 V004”。

### 5.7 `agent_threads` 与 `agent_messages`

```text
agent_threads:
  id, project_id, title, created_at, updated_at

agent_messages:
  id, thread_id, role, content, target_type, target_id,
  operation_id, created_at
```

项目 Agent 的讨论、修改命令和执行结果都可以回顾。

### 5.8 `revision_requests`

```text
id                  TEXT PRIMARY KEY
project_id          TEXT NOT NULL
target_artifact_id  TEXT NOT NULL
target_type         TEXT NOT NULL
instruction         TEXT NOT NULL
intent              TEXT NOT NULL       -- revise | rewrite-section | extend | fix-issue | compare
status              TEXT NOT NULL
operation_id        TEXT
output_artifact_id  TEXT
created_at          TEXT NOT NULL
completed_at        TEXT
```

### 5.9 现有表的兼容调整

- `approvals` 新增 `artifact_id`，以后以 artifact ID 为主，路径、hash、version 继续保留用于核验；
- `generation_jobs` 明确关联输入的 shot/package/storyboard artifact；
- `renders` 明确记录使用的 generation job 集合或 manifest artifact；
- `projects.current_stage` 与 `stale_stages` 暂时保留字段，迁移完成后停止作为业务门禁；
- 所有表继续保留已有 ID 和文件路径，不重新写文件树。

## 6. 新的业务规则

### 6.1 文档可以独立工作

每一种 artifact 都有自己的状态：

- `absent`：尚无版本；
- `draft`：有草稿，尚未批准；
- `approved`：该具体版本已批准；
- `superseded`：历史版本，已被另一版本取代；
- `needs-review`：当前 Head 发生变化或检测到问题，等待复核；
- `historical-snapshot`：生成、粗剪或交付基于旧输入，仅作为历史结果。

项目本身不再有“当前只能做第六步”的业务含义。项目首页只汇总哪些资料存在、哪些有问题、当前有哪些任务运行。

### 6.2 修改前一环节时不锁后续

以“剧本 V003 修改”为例：

1. 创建剧本 V004；
2. 用户决定是否将剧本 Head 切到 V004；
3. 原导演脚本、分镜、生成视频和粗剪继续可见；
4. 系统比较其依赖边，产生“仍基于剧本 V003”的提示；
5. 用户可以选择重做导演脚本、只改某场戏，或暂时保持旧结果；
6. 系统不得替用户自动重做整条链路。

### 6.3 审批只影响目标版本

- 批准：将当前 artifact 记录为 approved；
- 驳回：记录 rejected/needs-review 和意见；
- 不自动生成下一种 artifact；
- 不改变其他文档状态；
- 不自动移动导航；
- 不自动触发付费或耗时任务。

### 6.4 Agent 的执行合同

项目 Agent 必须遵守：

1. 所有指令必须有明确目标：项目、artifact、场次、镜头或问题；
2. 只读问答、比较和解释不创建版本；
3. 产生修改时永远另存新 artifact；
4. 单一文档修改可以直接执行；若会改动多个 artifact，先返回影响清单并等待用户确认；
5. 不拥有“批准”权限；
6. 不自动执行下一个操作；
7. 不自动修复失败后继续；
8. 不自动提交 Updream/H3 等付费生成；
9. 操作失败时必须报告失败点、已写入内容、未执行内容和可选处理方式；
10. 只有 operation 成功后才能更新项目 Head；失败产物如需要保留，应标为未选中的 draft 并附 issue。

## 7. 新的服务边界

不再继续向 `ProjectService` 和 `App.tsx` 添加分支。按下面边界渐进拆分：

### 7.1 后端

```text
src/database/
  migration-runner.ts
  migrations/*.ts

src/projects/
  project-repository.ts
  project-workspace-service.ts

src/artifacts/
  artifact-repository.ts
  artifact-service.ts
  artifact-lineage-service.ts
  artifact-validity-service.ts

src/revisions/
  revision-service.ts

src/approvals/
  approval-service.ts

src/operations/
  operation-repository.ts
  operation-service.ts
  operation-runner.ts
  process-controller.ts
  recovery-service.ts

src/issues/
  issue-repository.ts
  issue-service.ts

src/agent/
  project-agent-service.ts
  agent-command-router.ts

src/generation/
  generation-service.ts

src/quality/
  quality-service.ts

src/editing/
  render-service.ts
  delivery-service.ts
```

`src/projects/project-service.ts` 在迁移期只保留兼容门面，新功能禁止继续写入该文件。每迁出一个能力，先用现有行为测试固定兼容范围，再切换路由。

### 7.2 前端

```text
ui/src/pages/
  ProjectWorkspacePage.tsx

ui/src/features/artifacts/
  ArtifactNavigator.tsx
  ArtifactEditor.tsx
  ArtifactVersionList.tsx
  ArtifactDiff.tsx

ui/src/features/agent/
  ProjectAgentPanel.tsx
  AgentMessageList.tsx
  AgentComposer.tsx

ui/src/features/operations/
  ActiveOperationCard.tsx
  OperationHistory.tsx

ui/src/features/issues/
  IssueSummary.tsx
  IssueDrawer.tsx

ui/src/features/generation/
  ShotPackageWorkspace.tsx
  GenerationWorkspace.tsx

ui/src/features/quality/
  QualityWorkspace.tsx

ui/src/features/editing/
  EditingWorkspace.tsx

ui/src/hooks/
  useProjectWorkspace.ts
  useOperation.ts
  useAgentThread.ts
```

`ui/src/App.tsx` 最终只负责路由、全局错误边界和顶层布局。

## 8. API 方案

现有 `/stages/*` 接口在迁移期保留兼容，但内部逐步转交新服务。新 UI 不再依赖其全局推进语义。

### 8.1 工作区与版本

```http
GET   /api/projects/:projectId/workspace
GET   /api/projects/:projectId/artifacts/:artifactId
GET   /api/projects/:projectId/artifacts/:artifactId/lineage
PATCH /api/projects/:projectId/heads/:artifactType
```

`workspace` 一次返回：项目摘要、各 artifact Head、版本摘要、开放 issues、当前 operations 和历史快照摘要。正文按需加载，避免首页堆满信息。

### 8.2 修改请求

```http
POST /api/projects/:projectId/revisions
```

最小请求：

```json
{
  "targetArtifactId": "artifact-id",
  "instruction": "把第二场的冲突提前，但保留结尾反转",
  "intent": "revise"
}
```

响应必须立即返回：

```json
{
  "revisionRequestId": "revision-id",
  "operationId": "operation-id"
}
```

### 8.3 Operations

```http
GET  /api/operations/:operationId
GET  /api/operations/:operationId/events
POST /api/operations/:operationId/cancel
```

第一版用轮询即可，先保证契约和恢复；SSE 可以后加，不应成为首版阻塞项。

所有耗时接口在 500ms 内返回 `202 Accepted + operationId`，不得保持十分钟的同步 HTTP 请求。

### 8.4 Issues

```http
GET   /api/projects/:projectId/issues
PATCH /api/projects/:projectId/issues/:issueId
```

Issue 可被解决或忽略，但忽略必须记录操作人和理由。它不会改变文件，也不会隐式执行修复。

### 8.5 Agent

```http
GET  /api/projects/:projectId/agent/threads
POST /api/projects/:projectId/agent/threads
GET  /api/projects/:projectId/agent/threads/:threadId/messages
POST /api/projects/:projectId/agent/threads/:threadId/messages
```

消息响应分三类：解释/比较、建议计划、已创建 operation。前端必须区分，不用一只无限 spinner 覆盖全部状态。

### 8.6 共享契约

- 请求与响应 schema 统一放入 `src/shared/api-contracts/`；
- 服务端 Zod schema 与 UI 类型从同一来源生成或导入；
- 错误统一为 `{ code, message, details, operationId?, retryable }`；
- 不在前后端各写一套阶段判断。

## 9. 工作区界面重做

### 9.1 主布局

```text
┌────────────项目资料────────────┬────────────当前内容─────────────┬────────项目 Agent────────┐
│ 大纲             V003 已批准   │ 标题 / 版本 / 来源关系          │ 对当前内容提问或发修改指令 │
│ 剧本             V004 草稿     │ 编辑 / 预览 / 对比              │ 任务计划、结果与错误汇报   │
│ 资产定义         V001 已批准   │                                │ 当前作业：进度 / 取消      │
│ 导演脚本         V002 已批准   │                                │                          │
│ 分镜             V004 待复核   │                                │                          │
│ 镜头与视频                     │                                │                          │
│ 质检                           │                                │                          │
│ 剪辑与交付                     │                                │                          │
└───────────────────────────────┴────────────────────────────────┴──────────────────────────┘
                         问题抽屉：只显示当前内容有关的问题
```

### 9.2 信息分级

一级信息：

- 当前打开的内容；
- 当前版本；
- 是否有未处理问题；
- 当前正在执行的任务；
- 用户可以采取的下一动作。

二级信息：

- 版本历史；
- 上游依赖；
- 相关下游内容；
- 审批记录；
- Agent 会话历史。

三级信息（默认折叠）：

- hash；
- 文件路径；
- manifest；
- 原始校验项；
- Provider 原始输出；
- operation event 明细。

### 9.3 导航规则

- 所有资料始终可点击，不存在“未来步骤锁定”；
- 未生成的资料显示“尚未创建”，而不是灰色锁；
- 有旧版但依赖旧输入的资料显示“基于旧版本”，仍可打开；
- 导航按资料类型组织，不按数字关卡组织；
- 九阶段图如仍需保留，只放到“项目关系图/高级视图”，不承担业务门禁。

### 9.4 Agent 交互

用户打开剧本 V004 后，可以直接输入：

- “把第三场重写得更压抑”；
- “找出这一版与 V003 的差异”；
- “只修改角色对白，不动动作描述”；
- “根据这个问题生成一个修订版”；
- “先告诉我会影响哪些下游，不要执行”。

Agent 必须在消息内明确显示目标版本。任何创建版本的动作都显示 operation 卡片，完成后给出“创建了什么、没有做什么、是否改变 Head”的汇报。

## 10. 必须删除的自动行为

这里的“删除”是删除代码中的自动触发关系，不是删除项目数据。

| 当前行为 | 改法 |
|---|---|
| `approveAndContinue()` | 拆成 `approveArtifact()`；批准后停留在当前页面 |
| `nextArtifactAfterApproval()` | 从交互流程移除；可保留为兼容测试期间的废弃函数，随后删除 |
| `generationPreparationPlan()` 自动串联 | 每个动作成为独立显式命令 |
| `shouldAutoRenderAfterReview()` | 删除自动触发；显示“可以创建粗剪”按钮 |
| `continuity-repair/auto` | 默认禁用；改成“提出修复建议”和“执行所选修复”两个动作 |
| `downstreamStages()` 失效传播 | 改为依赖边比较并创建 issue |
| `assertArtifactRoute()` 全局阶段门禁 | 改为检查目标 artifact 是否存在、是否可写和是否有并发冲突 |
| UI 中 `currentStage` 导航与按钮门禁 | 改为 capability 数据和资源实际状态 |
| 成功后静默启动下一个请求 | 全部禁止；每个 operation 只能有一个明确目标 |

## 11. 长任务与取消机制

### 11.1 标准生命周期

```text
queued -> running -> succeeded
                 -> failed
                 -> cancel_requested -> cancelled
```

### 11.2 运行规则

1. API 先写 `operations`，再返回 operationId；
2. Runner 从数据库领取任务，并写 `started_at` 与 heartbeat；
3. 每个外部进程都必须绑定 `AbortSignal` 和进程树句柄；
4. UI 取消时先写 `cancel_requested`，Runner 再终止完整子进程树；
5. 终止结果写入事件，不能只让前端停止转圈；
6. 应用启动时扫描 `running` 且 heartbeat 过期的任务；
7. 可安全重试的标成 failed/retryable，不可安全重试的先核验文件与 artifact 是否已写入；
8. operation 的 idempotency key 防止双击和页面重试重复创建结果。

### 11.3 原子性边界

- 数据库状态、artifact 元数据和 operation 事件在同一事务中提交；
- 文件先写入同目录临时文件，校验完成后原子改名；
- 只有文件落盘并校验成功后才能将 operation 标为 succeeded；
- Head 更新与最终 artifact 写入同一数据库事务；
- 失败时不伪造“完成”状态。

## 12. 现有项目原地迁移

### 12.1 迁移原则

- 不复制项目目录；
- 不创建备份；
- 不删除任何行或文件；
- 新表用迁移脚本创建；
- 回填只做 `INSERT ... ON CONFLICT DO NOTHING/UPDATE`；
- 同一迁移连续运行两次必须得到相同结果；
- 迁移失败时依靠数据库事务回滚本次新增写入，而不是依靠备份恢复；
- 旧程序字段在兼容期保留，确保可以逐模块切换。

### 12.2 Head 回填规则

每种 artifact 独立处理：

1. 优先选择有有效 approval 且文件、hash、结构化内容一致的最新版本；
2. 若最新版本为 draft，则将最新 draft 设为 Head，并保留最近批准版本作为可选历史版本；
3. 若 artifact 文件或结构化文件缺失，不伪造 Head，创建 issue；
4. 所有选择写明 `selected_by = migration`；
5. 不依据 `projects.current_stage` 强行推定某份内容完成。

### 12.3 依赖边回填规则

优先从 artifact metadata、sourceArtifactId、manifest、shot package 和 render manifest 中读取真实 ID/hash；没有足够证据时不猜测，只创建 `lineage-unknown` issue。

### 12.4 当前“午夜洗衣房”项目的处理

- 所有原始输入和既有 artifact 原地保留；
- 按上述规则选择大纲、剧本、资产定义和导演脚本 Head；
- 已确认的导演脚本 V002 保留为批准版本；
- 分镜 V004 作为当前草稿/待复核版本，V001-V003 作为历史版本；
- 分镜 V004 的文字结构一致性错误成为 scoped issue，不再锁项目；
- 已生成镜头、旧粗剪和旧交付仍可打开，但按其真实输入关系标为历史快照；
- 如果无法证明旧粗剪使用了哪些镜头版本，显示“来源关系待确认”，不能显示为当前交付完成；
- 不自动补提示词、不自动补审批、不自动重跑、不自动粗剪。

## 13. 分阶段实施顺序

### Phase 0：立即冻结错误扩散

目标：新重构期间不再产生新的假完成。

- 禁止审批后自动生成下一文档；
- 禁止自动连续性修复并继续；
- 禁止最后镜头通过后自动粗剪；
- 所有失败只汇报，不自动推进；
- UI 明确标出旧粗剪/交付为历史快照；
- 为当前行为增加字符化测试，固定哪些旧行为将被移除。

退出条件：任何单一按钮最多触发一个 operation；失败后没有隐式后续请求。

### Phase 1：数据与 Operation 地基（P0）

- 建立版本化 migration runner；
- 新增 `project_heads`、`artifact_edges`、`operations`、`operation_events`、`project_issues`；
- 实现 operation repository、runner、heartbeat、恢复和 cancel；
- Codex CLI、FFmpeg 等 Provider 接受 AbortSignal；
- 现有耗时路由返回 `202 + operationId`；
- 建立 typed error 契约。

退出条件：刷新页面后仍能看到长任务；点击取消后后台进程树实际退出；重启应用后任务状态可恢复。

### Phase 2：剧本 Agent 纵向切片（P0）

先选择“剧本”而不是一次铺开全部模块。原因是它最接近用户拿网站剧本助手 Agent 对比的核心能力，同时能最小范围验证新模型。

- 剧本版本列表、选定 Head 和版本对比；
- 针对剧本版本的 Agent 会话；
- 修改指令创建 revision request 和新 artifact；
- 成功后由用户选择是否切换 Head；
- 下游只出现依赖提示，不锁定；
- 审批不自动生成资产定义。

退出条件：用户可以在任意项目阶段回到任意剧本版本，发出修改指令，得到新版本，且其他内容仍可打开。

### Phase 3：新工作区主界面（P0）

- 建立三栏工作区；
- 左栏改为项目资料和版本状态；
- 中栏只展示当前内容；
- 右栏展示 Agent 和当前 operation；
- issues 放入上下文抽屉；
- 原九阶段页面移到兼容入口，不再作为默认页面；
- 拆分 `App.tsx`。

退出条件：用户无需理解阶段名即可在三次点击内找到任意文档、镜头、质检或剪辑记录。

### Phase 4：其余文字与结构化产物（P1）

按“大纲 → 资产定义 → 导演脚本 → 分镜”迁移：

- 每种 artifact 有独立 Head；
- 每次生成或修改都声明输入 artifact IDs；
- 批准只针对目标版本；
- 连续性审计输出 issues；
- 修复成为显式 revision request；
- 删除阶段门禁。

退出条件：四种产物均可独立修改、比较、批准和选择版本。

### Phase 5：镜头包、视频生成与质检（P1）

- Shot/package 与具体分镜/导演脚本 artifact 建立依赖；
- “锁素材”改成创建一个不可变 generation manifest，不再锁项目；
- 提示词编译按单镜头或显式批次执行；
- 人工上传和下载状态继续保留；
- 质检只决定某个 generation job，不推进项目；
- 所有批处理都有逐项进度、错误隔离和取消。

退出条件：某个镜头失败不会阻止查看、修改或质检其他镜头，也不会自动进入粗剪。

### Phase 6：剪辑与交付（P1）

- 粗剪基于明确选择的 generation jobs 创建 render manifest；
- 创建粗剪必须显式点击；
- 旧粗剪显示其输入版本；
- 交付审批只针对具体 render；
- 新上游版本不会删除旧交付，只会让它显示为历史快照。

退出条件：任何“当前粗剪/当前交付”都能追溯到明确的视频、镜头包、分镜和上游文档版本。

### Phase 7：停用旧状态机写入（P2）

- 所有新 UI 和新 API 不再读取 `currentStage/staleStages`；
- 兼容适配器可从新模型计算一个旧阶段，仅供旧入口显示；
- 观察一个完整发布周期；
- 确认无旧调用后移除状态机业务写入；
- 字段是否最终删除另行决定，本方案不执行破坏性删除。

退出条件：修改任何 artifact 都不会写 `staleStages`，所有能力由资源、Head、依赖和 operation 状态决定。

## 14. 文件级改动清单

| 文件/目录 | 必须修改的内容 |
|---|---|
| `src/database/schema.ts` | 新增迁移、Head、依赖、operation、issue、agent、revision 表定义 |
| `src/database/client.ts` | 移除散落式字段补丁，接入版本化 migration runner |
| `src/workflow/state-machine.ts` | 降级为兼容适配层；禁止新业务依赖 |
| `src/server/operation-coordinator.ts` | 由持久化 operation service 替代 |
| `src/server.ts` | 拆分路由模块；耗时接口改成 202 作业契约 |
| `src/projects/project-service.ts` | 按 artifact、approval、generation、quality、editing 职责逐步拆分 |
| `src/projects/project-integrity-service.ts` | 从否决全局完成状态改为产生 scoped issues 和 workspace summary |
| `src/projects/quality-service.ts` | 删除 `currentStage` 门禁；以资源存在、依赖和具体 job 状态判断 |
| `src/ai/codex-cli-provider.ts` | 接受 operation context、AbortSignal、事件回调；不再依赖 currentStage 作为权限 |
| `src/shared/schemas.ts` | 添加共享 API contracts；currentStage 标记 deprecated |
| `ui/src/App.tsx` | 拆成页面与 feature；移除阶段主导航和自动串联 |
| `ui/src/project-workbench.ts` | 由 ArtifactNavigator/WorkspaceSummary 替代 |
| `ui/src/auto-flow.ts` | 删除自动批准推进与自动粗剪；只保留无副作用的显示辅助（若仍需要） |
| `ui/src/api.ts` | 新增 workspace、revision、operation、issue、agent API |
| `ui/src/types.ts` | 从共享契约获取类型，删除重复的阶段业务判断 |
| `ui/src/styles.css` | 按页面/feature 拆分样式，建立清晰信息层级 |
| `tests/` 与 `ui/src/*.test.ts` | 删除自动闯关期望，新增原地迁移、Agent、取消、恢复和 E2E 测试 |

## 15. 验收清单

### 15.1 访问与修改

- [ ] 任意项目状态下都可打开大纲、剧本、资产定义、导演脚本和分镜；
- [ ] 未创建的内容显示“尚未创建”，不显示锁；
- [ ] 任意历史版本均可查看和比较；
- [ ] 修改历史版本会新建版本，不覆盖旧文件；
- [ ] 用户可以明确选择哪个版本作为当前 Head；
- [ ] 修改上游后，下游继续可打开。

### 15.2 依赖与历史真实性

- [ ] 每个当前 artifact 都能显示其输入版本；
- [ ] 基于旧输入的下游内容显示“基于旧版本”，不显示为锁定；
- [ ] 每个生成视频能追溯到镜头包与分镜版本；
- [ ] 每个粗剪能追溯到所用视频集合；
- [ ] 无法证明来源时显示未知 issue，不猜测关系；
- [ ] 旧粗剪和交付作为历史快照保留，不冒充当前完成。

### 15.3 Agent

- [ ] 用户能指定 artifact 版本发问或要求修改；
- [ ] 只读问题不会创建版本；
- [ ] 修改会创建 revision request、operation 和新 artifact；
- [ ] 多 artifact 改动先展示影响并等待确认；
- [ ] Agent 不能自动批准；
- [ ] Agent 不能自动执行下一环节；
- [ ] 失败后完整汇报已完成、未完成和错误原因。

### 15.4 Operations

- [ ] 耗时请求在 500ms 内返回 operationId；
- [ ] 刷新页面后状态仍存在；
- [ ] 操作有明确 phase、进度和最近事件；
- [ ] 取消后外部子进程树实际退出；
- [ ] 应用重启后能识别遗留 running 作业；
- [ ] 双击或重试不会创建重复产物；
- [ ] 一个 operation 只能完成一个明确目标；
- [ ] 不存在操作成功后静默启动下一个 operation。

### 15.5 原地迁移

- [ ] 迁移前后项目 ID 与项目目录不变；
- [ ] 迁移期间没有执行备份；
- [ ] 迁移没有删除数据库行或文件；
- [ ] 同一迁移连续运行两次结果一致；
- [ ] Head 选择有可解释的证据；
- [ ] 缺少来源证据时创建 issue，不自动补造；
- [ ] “午夜洗衣房”现有各版本、生成视频、粗剪和交付均可访问。

### 15.6 UI 与真实浏览器

- [ ] 在 1280×720 和常用桌面分辨率下主操作无遮挡；
- [ ] 用户三次点击内能找到任意项目资料；
- [ ] 首页不展示大片原始审计文本；
- [ ] 当前问题与当前文档关联，技术细节默认折叠；
- [ ] Playwright 覆盖打开旧版本、回改前文、取消长任务、刷新恢复、失败停止和历史快照；
- [ ] 故障注入覆盖 Provider 超时、进程被杀、文件写入失败、数据库事务失败和应用重启。

## 16. 推荐优先级

### P0：先解决“继续制造错误”的部分

1. 冻结所有自动串联；
2. 建立版本化迁移；
3. 建立持久化、可取消 operation；
4. 建立 project_heads、artifact_edges 和 issues；
5. 完成剧本 Agent 纵向切片；
6. 上线新工作区主界面。

### P1：完成项目核心能力

1. 迁移全部文字 artifact；
2. 迁移镜头包、生成与质检；
3. 迁移剪辑与交付；
4. 完成来源追踪和历史快照显示；
5. 补齐真实浏览器 E2E 与恢复测试。

### P2：清理兼容层

1. 停止写入 `currentStage/staleStages`；
2. 移除旧九步入口；
3. 删除无调用的自动流函数；
4. 将大文件职责完全拆出；
5. 评估是否需要物理删除废弃字段——不在本轮默认执行。

## 17. 实施纪律

- 不允许为了“先跑通”而强制修改数据库阶段；
- 不允许把校验失败改成 warning 后继续整条链；
- 不允许用 mock 成功伪造完整项目结果；
- 不允许一次性重写全部后端或全部 UI；
- 不允许在没有真实输入关系时猜 artifact 依赖；
- 不允许只修当前“文字结构一致性”这一条报错；
- 不允许用 toast 提示替代持久化 operation 状态；
- 不允许在没有进程终止验证时宣称“已取消”；
- 不允许在上游未批准、提示词未生成或视频未质检时显示当前粗剪已完成；
- 每个 Phase 必须先有自动测试，再切换现有路由或页面；
- 每个 Phase 完成后必须在本地预览中走一遍真实项目，不以单元测试代替用户路径验证。

## 18. Definition of Done

这次重构只有同时满足以下条件才算完成：

1. 用户不再被全局阶段锁住；
2. 用户能随时找到、查看和修改任意历史环节；
3. 所有修改均有版本，所有下游均有可追溯输入；
4. 所有耗时任务可观察、可取消、可恢复；
5. 所有自动推进、自动修复后继续和自动粗剪已移除；
6. 项目 Agent 能围绕明确内容完成问答、比较和修订；
7. 失败不会产生下游假完成；
8. 当前“午夜洗衣房”项目无需重建即可在新工作区正常使用；
9. 没有为本次重构创建备份，也没有删除任何既有项目数据；
10. 真实浏览器 E2E 和故障恢复测试全部通过。
