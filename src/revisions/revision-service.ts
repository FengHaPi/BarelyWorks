import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StudioDatabase } from "../database/client";
import { ArtifactRepository } from "../artifacts/artifact-repository";
import { IssueRepository } from "../issues/issue-repository";
import { OperationRepository } from "../operations/operation-repository";
import type { OperationContext } from "../operations/operation-runner";
import { OperationExecutionError, OperationRunner } from "../operations/operation-runner";
import { ProjectRepository } from "../projects/project-repository";
import type { ArtifactType } from "../shared/schemas";
import type { ArtifactRevisionExecutor } from "./artifact-revision-executor";

const artifactDirectoryByType: Record<ArtifactType, string> = {
  outline: "outline",
  screenplay: "screenplay",
  "asset-bible": "assets",
  "shooting-script": "shooting-script",
  storyboard: "storyboard",
};

export interface CreateRevisionRequest {
  targetArtifactId: string;
  instruction: string;
  intent: "revise" | "rewrite-section" | "extend" | "fix-issue" | "compare";
  idempotencyKey?: string;
}

interface RevisionRow {
  id: string; project_id: string; target_artifact_id: string; target_type: string; instruction: string;
  intent: CreateRevisionRequest["intent"]; status: string; operation_id: string | null;
  output_artifact_id: string | null; created_at: string; completed_at: string | null;
}

function stableIssueId(projectId: string, code: string, scopeId: string): string {
  return `issue-${createHash("sha256").update(`${projectId}|${code}|${scopeId}`).digest("hex").slice(0, 32)}`;
}

export class RevisionService {
  private readonly finalizationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly studio: StudioDatabase,
    private readonly projects: ProjectRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly issues: IssueRepository,
    private readonly operations: OperationRepository,
    private readonly runner: OperationRunner,
    private readonly executor: ArtifactRevisionExecutor,
  ) {
    runner.register("artifact.revise", (context) => this.execute(context));
  }

  create(projectId: string, input: CreateRevisionRequest): { revisionRequestId: string; operationId: string } {
    this.projects.require(projectId);
    const artifact = this.artifacts.require(projectId, input.targetArtifactId);
    if (input.intent === "compare") throw new Error("比较是只读操作，不应创建 revision request");
    const normalizedInstruction = input.instruction.trim();
    const idempotencyKey = input.idempotencyKey?.trim() || createHash("sha256")
      .update(`${projectId}|${artifact.id}|${input.intent}|${normalizedInstruction}`).digest("hex");
    const created = this.operations.create({
      projectId, kind: "artifact.revise", targetType: "artifact", targetId: artifact.id,
      requestPayload: { targetArtifactId: artifact.id, instruction: normalizedInstruction, intent: input.intent },
      idempotencyKey, phase: "queued", progressTotal: 4,
    });
    if (!created.created) {
      const existing = this.studio.sqlite.prepare("SELECT id FROM revision_requests WHERE operation_id = ?").get(created.operation.id) as { id: string } | undefined;
      if (!existing) throw new Error("幂等作业缺少修订请求记录");
      this.runner.schedule(created.operation.id);
      return { revisionRequestId: existing.id, operationId: created.operation.id };
    }
    const revisionRequestId = randomUUID();
    const now = new Date().toISOString();
    try {
      this.studio.sqlite.prepare(`
        INSERT INTO revision_requests(
          id, project_id, target_artifact_id, target_type, instruction, intent,
          status, operation_id, created_at
        ) VALUES(?,?,?,?,?,?,'queued',?,?)
      `).run(revisionRequestId, projectId, artifact.id, artifact.type, normalizedInstruction, input.intent, created.operation.id, now);
    } catch (error) {
      this.operations.fail(created.operation.id, "REVISION_REQUEST_WRITE_FAILED", "修订请求未能持久化", true, {
        completedActions: ["创建持久化作业记录"],
        unexecutedActions: ["未创建修订请求", "未调用 Agent", "未创建新版本", "未切换 Head", "未启动下游"],
      });
      throw error;
    }
    this.runner.schedule(created.operation.id);
    return { revisionRequestId, operationId: created.operation.id };
  }

  get(id: string): RevisionRow | null {
    return this.studio.sqlite.prepare("SELECT * FROM revision_requests WHERE id = ?").get(id) as RevisionRow | undefined ?? null;
  }

  private async execute(context: OperationContext): Promise<Record<string, unknown>> {
    const revision = this.studio.sqlite.prepare("SELECT * FROM revision_requests WHERE operation_id = ?").get(context.operation.id) as RevisionRow | undefined;
    if (!revision) throw new Error("修订请求不存在");
    const project = this.projects.require(revision.project_id);
    const target = this.artifacts.require(project.id, revision.target_artifact_id);
    const completedActions: string[] = [];
    let activePhase = "reading-target";
    this.studio.sqlite.prepare("UPDATE revision_requests SET status = 'running' WHERE id = ?").run(revision.id);
    try {
      context.progress("reading-target", 1, 4, { targetArtifactId: target.id });
      const content = await this.artifacts.readContent(target);
      completedActions.push("读取并校验目标版本");
      activePhase = "agent-revision";
      context.progress("agent-revision", 2, 4);
      const result = await this.executor.revise({
        project: {
          id: project.id, title: project.title, projectDir: project.projectDir,
          targetDurationSec: project.targetDurationSec, aspectRatio: project.aspectRatio,
        },
        artifact: { id: target.id, type: target.type, version: target.version, content },
        instruction: revision.instruction,
        intent: revision.intent,
        signal: context.signal,
        onEvent: (eventType, payload = {}) => context.event(eventType, payload),
        onProcessId: context.setProcessId,
      });
      completedActions.push("Agent 已返回修订候选内容");
      if (context.signal.aborted) throw new Error("修订作业已取消，未写入新版本");
      const revisedContent = result.content.trimEnd() + "\n";
      const targetNormalized = content.trimEnd() + "\n";
      if (revisedContent === targetNormalized) throw new Error("Agent 返回内容与目标版本完全相同，未创建重复版本");
      context.progress("writing-version", 3, 4);
      activePhase = "installing-file";
      const output = await this.withProjectFinalizationLock(project.id, async () => {
        if (context.signal.aborted) throw new Error("修订作业已取消，未写入新版本");
        const version = this.artifacts.latestVersion(project.id, target.type) + 1;
        const stem = `${target.type}-v${String(version).padStart(3, "0")}`;
        const directory = path.join(project.projectDir, artifactDirectoryByType[target.type]);
        await fs.mkdir(directory, { recursive: true });
        const filePath = path.join(directory, `${stem}.md`);
        const temporaryPath = path.join(directory, `.${stem}.${context.operation.id}.tmp`);
        const artifactId = randomUUID();
        const now = new Date().toISOString();
        const contentHash = createHash("sha256").update(revisedContent, "utf8").digest("hex");
        let installed = false;
        let committed = false;
        try {
          await fs.writeFile(temporaryPath, revisedContent, { encoding: "utf8", flag: "wx" });
          // Linking a complete temporary file is an atomic, no-overwrite install on both
          // Windows and POSIX. A pre-existing version file is evidence, never cleanup.
          await fs.link(temporaryPath, filePath);
          installed = true;
          activePhase = "committing-database";
          this.studio.sqlite.transaction(() => {
            const operation = this.operations.require(context.operation.id);
            if (operation.status === "cancel_requested" || context.signal.aborted) throw new Error("取消请求已生效，未提交新版本");
            this.studio.sqlite.prepare(`
              INSERT INTO artifacts(
                id, project_id, type, version, file_path, structured_path, content_hash,
                status, source_artifact_id, metadata, created_at, updated_at
              ) VALUES(?,?,?,?,?,NULL,?,'draft',?,?,?,?)
            `).run(artifactId, project.id, target.type, version, filePath, contentHash, target.id, JSON.stringify({
              origin: "project-agent-revision", revisionRequestId: revision.id, operationId: context.operation.id,
              intent: revision.intent, instruction: revision.instruction, changeSummary: result.changeSummary,
              provider: result.provider, providerRunId: result.runId, basedOnArtifactId: target.id,
            }), now, now);
            this.studio.sqlite.prepare(`
              INSERT OR IGNORE INTO artifact_edges(artifact_id, input_artifact_id, relation, created_at) VALUES(?,?, 'derived-from', ?)
            `).run(artifactId, target.id, now);
            this.studio.sqlite.prepare(`
              UPDATE revision_requests SET status = 'succeeded', output_artifact_id = ?, completed_at = ? WHERE id = ?
            `).run(artifactId, now, revision.id);
          })();
          committed = true;
          activePhase = "completed";
        } finally {
          if (installed && !committed) await fs.rm(filePath, { force: true }).catch(() => undefined);
          await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
        return { artifactId, version, filePath };
      });
      completedActions.push("创建不可变新版本", "记录 derived-from 依赖");
      if (!["outline", "screenplay"].includes(target.type)) {
        this.issues.upsertOpen({
          id: stableIssueId(project.id, "structured-content-pending", output.artifactId), projectId: project.id,
          scopeType: "artifact", scopeId: output.artifactId, severity: "warning", code: "structured-content-pending",
          title: "结构化内容等待复核", detail: "Agent 已创建完整 Markdown 修订版，但没有伪造对应 JSON 投影；依赖结构化数据的生成命令会保持停用。",
          suggestedAction: "在结构化编辑器中复核并生成对应投影后再用于下游", source: "operation",
        });
      }
      context.progress("verified", 4, 4, { artifactId: output.artifactId, version: output.version });
      return {
        revisionRequestId: revision.id,
        artifactId: output.artifactId,
        version: output.version,
        headChanged: false,
        changeSummary: result.changeSummary,
        completedActions,
        unexecutedActions: ["未切换 Head", "未批准", "未生成下一环节", "未提交付费平台"],
      };
    } catch (error) {
      const status = context.signal.aborted ? "cancelled" : "failed";
      this.studio.sqlite.prepare("UPDATE revision_requests SET status = ?, completed_at = ? WHERE id = ?")
        .run(status, new Date().toISOString(), revision.id);
      if (!context.signal.aborted) {
        this.issues.upsertOpen({
          id: stableIssueId(project.id, "revision-failed", revision.id), projectId: project.id,
          scopeType: "artifact", scopeId: target.id, severity: "error", code: "revision-failed",
          title: "项目 Agent 修订失败", detail: error instanceof Error ? error.message : "修订失败",
          suggestedAction: "查看 operation 事件后修改指令或重试；失败没有切换 Head 或启动后续任务", source: "operation",
        });
      }
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : "修订失败";
      const normalized = message.toLowerCase();
      const code = activePhase === "agent-revision" && /timeout|timed out|超时/u.test(normalized)
        ? "PROVIDER_TIMEOUT"
        : activePhase === "agent-revision" && /process|进程|exited|killed|被杀/u.test(normalized)
          ? "PROVIDER_PROCESS_EXITED"
          : activePhase === "committing-database" ? "ARTIFACT_COMMIT_FAILED"
            : activePhase === "installing-file" ? "ARTIFACT_WRITE_FAILED" : "REVISION_FAILED";
      throw new OperationExecutionError(code, message, code === "PROVIDER_TIMEOUT" || code === "PROVIDER_PROCESS_EXITED", {
        failedPhase: activePhase,
        completedActions,
        unexecutedActions: ["未创建新版本", "未切换 Head", "未批准", "未生成下一环节", "未提交付费平台"],
      }, { cause: error });
    }
  }

  private async withProjectFinalizationLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.finalizationLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.finalizationLocks.set(projectId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.finalizationLocks.get(projectId) === tail) this.finalizationLocks.delete(projectId);
    }
  }
}
