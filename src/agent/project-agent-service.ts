import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StudioDatabase } from "../database/client";
import { ArtifactRepository } from "../artifacts/artifact-repository";
import { ArtifactLineageService } from "../artifacts/artifact-lineage-service";
import { IssueRepository } from "../issues/issue-repository";
import { OperationRepository } from "../operations/operation-repository";
import { OperationExecutionError, OperationRunner } from "../operations/operation-runner";
import { ProjectRepository } from "../projects/project-repository";
import { RevisionService } from "../revisions/revision-service";
import type { ProjectAgentExecutor } from "./project-agent-executor";
import { continuityReportSchema } from "../shared/skill-schemas";
import { CumulativeVerificationService } from "../projects/cumulative-verification-service";

export interface AgentThread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  messageType: "user" | "explanation" | "plan" | "operation" | "error" | "legacy-template";
  targetType: string | null;
  targetId: string | null;
  operationId: string | null;
  createdAt: string;
}

interface ThreadRow { id: string; project_id: string; title: string; created_at: string; updated_at: string }
interface MessageRow {
  id: string; thread_id: string; role: "user" | "assistant"; content: string;
  message_type: AgentMessage["messageType"]; target_type: string | null; target_id: string | null;
  operation_id: string | null; created_at: string;
}

function mapThread(row: ThreadRow): AgentThread {
  return { id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id, threadId: row.thread_id, role: row.role, content: row.content,
    messageType: row.message_type, targetType: row.target_type, targetId: row.target_id,
    operationId: row.operation_id, createdAt: row.created_at,
  };
}

export interface AgentMessageCommand {
  content: string;
  mode: "ask" | "compare" | "revise" | "plan";
  targetArtifactId?: string;
  targetArtifactIds?: string[];
  intent?: "revise" | "rewrite-section" | "extend" | "fix-issue" | "compare";
  confirmedPlanId?: string;
  idempotencyKey?: string;
}

export class ProjectAgentService {
  constructor(
    private readonly studio: StudioDatabase,
    private readonly projects: ProjectRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly issues: IssueRepository,
    private readonly lineage: ArtifactLineageService,
    private readonly revisions: RevisionService,
    private readonly operations: OperationRepository,
    private readonly runner: OperationRunner,
    private readonly executor: ProjectAgentExecutor,
    private readonly verification: CumulativeVerificationService,
  ) {
    this.studio.sqlite.prepare(`
      UPDATE agent_messages SET message_type = 'legacy-template'
      WHERE role = 'assistant' AND operation_id IS NULL AND message_type IN ('explanation', 'plan')
    `).run();
    this.runner.register("agent.respond", async (context) => {
      const payload = context.operation.requestPayload as {
        threadId?: string; mode?: "ask" | "compare" | "plan"; content?: string; targetArtifactIds?: string[];
      };
      if (!payload.threadId || !payload.mode || !payload.content || !payload.targetArtifactIds?.length) {
        throw new OperationExecutionError("INVALID_AGENT_REQUEST", "项目 Agent 作业参数不完整", false, {
          completedActions: [], unexecutedActions: ["agent.respond"],
        });
      }
      try {
        context.progress("loading-context", 0, payload.targetArtifactIds.length);
        const project = this.projects.require(context.operation.projectId);
        const heads = this.artifacts.getHeads(project.id);
        const artifactInputs = [];
        for (let index = 0; index < payload.targetArtifactIds.length; index += 1) {
          const artifact = this.artifacts.require(project.id, payload.targetArtifactIds[index]);
          const reportPath = typeof artifact.metadata.continuityReportStructuredPath === "string"
            ? path.resolve(artifact.metadata.continuityReportStructuredPath)
            : null;
          const projectRoot = `${path.resolve(project.projectDir)}${path.sep}`;
          const continuityReport = reportPath && reportPath.startsWith(projectRoot)
            ? await fs.readFile(reportPath, "utf8")
              .then((content) => continuityReportSchema.parse(JSON.parse(content)))
              .catch(() => null)
            : null;
          const previous = this.artifacts.list(project.id, artifact.type).find((item) => item.version < artifact.version) ?? null;
          const dependencies = this.artifacts.listInputs(artifact.id).map((edge) => {
            const input = this.artifacts.require(project.id, edge.inputArtifactId);
            return { type: input.type, version: input.version, relation: edge.relation, isCurrentHead: heads.get(input.type) === input.id };
          });
          artifactInputs.push({
            id: artifact.id,
            type: artifact.type,
            version: artifact.version,
            status: artifact.status,
            isHead: heads.get(artifact.type) === artifact.id,
            content: await this.artifacts.readContent(artifact),
            previousVersion: previous ? { version: previous.version, content: await this.artifacts.readContent(previous) } : null,
            dependencies,
            dependentCount: this.artifacts.listDependents(artifact.id).length,
            openIssues: this.issues.listForScope(project.id, "artifact", artifact.id)
              .filter((issue) => issue.status === "open")
              .map((issue) => ({ severity: issue.severity, code: issue.code, title: issue.title, detail: issue.detail, suggestedAction: issue.suggestedAction })),
            continuityReport,
            verificationLedger: await this.verification.audit(project.id, artifact.type, artifact.id),
          });
          context.progress("loading-context", index + 1, payload.targetArtifactIds.length);
        }
        const recentMessages = this.listMessages(project.id, payload.threadId)
          .filter((message) => message.operationId !== context.operation.id)
          .slice(-10)
          .map((message) => ({ role: message.role, content: message.content }));
        context.progress("model-response", payload.targetArtifactIds.length, payload.targetArtifactIds.length);
        const result = await this.executor.respond({
          project,
          mode: payload.mode,
          userInstruction: payload.content,
          artifacts: artifactInputs,
          recentMessages,
          signal: context.signal,
          onEvent: context.event,
          onProcessId: context.setProcessId,
        });
        const messageType = payload.mode === "plan" ? "plan" : "explanation";
        this.updateOperationMessage(payload.threadId, context.operation.id, result.answer, messageType);
        return {
          provider: result.provider,
          runId: result.runId,
          messageType,
          targetArtifactIds: payload.targetArtifactIds,
          sideEffects: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "项目 Agent 未返回有效结果";
        this.updateOperationMessage(payload.threadId, context.operation.id, `项目 Agent 执行失败：${message}`, "error");
        throw new OperationExecutionError("AGENT_PROVIDER_FAILED", message, true, {
          completedActions: ["保存用户消息", "读取项目上下文"],
          unexecutedActions: ["生成真实 Agent 回答"],
        }, { cause: error });
      }
    });
  }

  listThreads(projectId: string): AgentThread[] {
    this.projects.require(projectId);
    return (this.studio.sqlite.prepare("SELECT * FROM agent_threads WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as ThreadRow[]).map(mapThread);
  }

  createThread(projectId: string, title: string): AgentThread {
    this.projects.require(projectId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.studio.sqlite.prepare("INSERT INTO agent_threads(id, project_id, title, created_at, updated_at) VALUES(?,?,?,?,?)")
      .run(id, projectId, title.trim(), now, now);
    return { id, projectId, title: title.trim(), createdAt: now, updatedAt: now };
  }

  listMessages(projectId: string, threadId: string): AgentMessage[] {
    this.requireThread(projectId, threadId);
    return (this.studio.sqlite.prepare("SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY created_at, rowid").all(threadId) as MessageRow[]).map(mapMessage);
  }

  async send(projectId: string, threadId: string, command: AgentMessageCommand): Promise<{
    kind: "explanation" | "plan" | "operation";
    message: AgentMessage;
    operationId?: string;
    revisionRequestId?: string;
    planId?: string;
    impactedArtifactIds?: string[];
  }> {
    this.requireThread(projectId, threadId);
    const targetIds = [...new Set([...(command.targetArtifactIds ?? []), ...(command.targetArtifactId ? [command.targetArtifactId] : [])])];
    for (const id of targetIds) this.artifacts.require(projectId, id);
    this.insertMessage(threadId, "user", command.content, "user", command.targetArtifactId ?? null, null);

    if (!targetIds.length) throw new Error("项目 Agent 指令必须指定目标 artifact 版本");

    const isReadOnly = command.mode !== "revise" || targetIds.length > 1;
    if (isReadOnly) {
      const mode = command.mode === "revise" || command.mode === "plan" || targetIds.length > 1 ? "plan" : command.mode;
      const created = this.operations.create({
        projectId,
        kind: "agent.respond",
        targetType: "artifact",
        targetId: command.targetArtifactId ?? targetIds[0],
        requestPayload: { threadId, mode, content: command.content, targetArtifactIds: targetIds },
        idempotencyKey: command.idempotencyKey ?? null,
        phase: "queued",
        progressTotal: targetIds.length,
      });
      const message = this.insertMessage(
        threadId,
        "assistant",
        "真实项目 Agent 已排队，完成后此处会显示基于当前版本的回答；如果模型不可用会明确显示失败。",
        "operation",
        command.targetArtifactId ?? targetIds[0],
        created.operation.id,
      );
      if (created.created) this.runner.schedule(created.operation.id);
      return {
        kind: "operation",
        message,
        operationId: created.operation.id,
        ...(mode === "plan" ? { planId: message.id, impactedArtifactIds: targetIds } : {}),
      };
    }

    const target = this.artifacts.require(projectId, command.targetArtifactId!);

    const created = this.revisions.create(projectId, {
      targetArtifactId: target.id,
      instruction: command.content,
      intent: command.intent && command.intent !== "compare" ? command.intent : "revise",
      idempotencyKey: command.idempotencyKey,
    });
    const content = `已为 ${target.type} V${String(target.version).padStart(3, "0")} 创建单目标修订作业。完成后会另存新版本；不会自动切换 Head、批准或继续下游。`;
    const message = this.insertMessage(threadId, "assistant", content, "operation", target.id, created.operationId);
    return { kind: "operation", message, operationId: created.operationId, revisionRequestId: created.revisionRequestId };
  }

  private requireThread(projectId: string, threadId: string): AgentThread {
    const row = this.studio.sqlite.prepare("SELECT * FROM agent_threads WHERE id = ? AND project_id = ?").get(threadId, projectId) as ThreadRow | undefined;
    if (!row) throw new Error("Agent 会话不存在");
    return mapThread(row);
  }

  private insertMessage(
    threadId: string,
    role: "user" | "assistant",
    content: string,
    messageType: AgentMessage["messageType"],
    targetId: string | null,
    operationId: string | null,
  ): AgentMessage {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      this.studio.sqlite.prepare(`
        INSERT INTO agent_messages(id, thread_id, role, content, message_type, target_type, target_id, operation_id, created_at)
        VALUES(?,?,?,?,?,'artifact',?,?,?)
      `).run(id, threadId, role, content, messageType, targetId, operationId, now);
      this.studio.sqlite.prepare("UPDATE agent_threads SET updated_at = ? WHERE id = ?").run(now, threadId);
    })();
    return { id, threadId, role, content, messageType, targetType: "artifact", targetId, operationId, createdAt: now };
  }

  private updateOperationMessage(
    threadId: string,
    operationId: string,
    content: string,
    messageType: "explanation" | "plan" | "error",
  ): void {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      const result = this.studio.sqlite.prepare(`
        UPDATE agent_messages SET content = ?, message_type = ?
        WHERE thread_id = ? AND operation_id = ? AND role = 'assistant'
      `).run(content, messageType, threadId, operationId);
      if (!result.changes) throw new Error("项目 Agent 占位消息不存在");
      this.studio.sqlite.prepare("UPDATE agent_threads SET updated_at = ? WHERE id = ?").run(now, threadId);
    })();
  }
}
