import { createHash } from "node:crypto";
import { ArtifactRepository } from "../artifacts/artifact-repository";
import { OperationRepository } from "../operations/operation-repository";
import type { OperationContext } from "../operations/operation-runner";
import { OperationExecutionError, OperationRunner } from "../operations/operation-runner";
import { ProjectRepository } from "../projects/project-repository";
import { ProjectService } from "../projects/project-service";

export class ContinuityRepairOperationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly projectRepository: ProjectRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly operations: OperationRepository,
    private readonly runner: OperationRunner,
  ) {
    runner.register("artifact.continuity-repair", (context) => this.execute(context));
  }

  plan(projectId: string, artifactId: string) {
    return this.projects.planContinuityRepair(projectId, artifactId);
  }

  create(projectId: string, artifactId: string, idempotencyKey?: string) {
    this.projectRepository.require(projectId);
    const artifact = this.artifacts.require(projectId, artifactId);
    const action = artifact.type === "storyboard" ? "start" : "continue";
    if (action === "continue" && (artifact.metadata.origin !== "continuity-targeted-repair"
      || (artifact.type !== "asset-bible" && artifact.type !== "shooting-script"))) {
      throw new Error("该版本不属于可继续的结构化连续性修复流程");
    }
    const normalizedKey = idempotencyKey?.trim() || createHash("sha256")
      .update(`${projectId}|${artifact.id}|${artifact.contentHash}|continuity-repair|${action}`).digest("hex");
    const created = this.operations.create({
      projectId,
      kind: "artifact.continuity-repair",
      targetType: "artifact",
      targetId: artifact.id,
      requestPayload: { artifactId: artifact.id, action },
      idempotencyKey: normalizedKey,
      phase: "等待结构化修复",
      progressTotal: 4,
    });
    this.runner.schedule(created.operation.id);
    return created.operation;
  }

  private async execute(context: OperationContext): Promise<Record<string, unknown>> {
    const artifactId = String(context.operation.requestPayload.artifactId ?? "");
    const completedActions: string[] = [];
    try {
      context.progress("读取连续性报告", 1, 4, { artifactId });
      const source = this.artifacts.require(context.operation.projectId, artifactId);
      const action = context.operation.requestPayload.action === "continue" ? "continue" : "start";
      if (action === "start" && source.type !== "storyboard") throw new Error("结构化修复起点不是分镜版本");
      completedActions.push(action === "start" ? "读取并校验目标分镜版本" : "读取并校验已批准的上一步修复版本");
      if (context.signal.aborted) throw new Error("结构化修复作业已取消，未创建新版本");

      context.progress("执行定点结构化修复", 2, 4);
      const result = action === "start"
        ? await this.projects.startContinuityRepair(context.operation.projectId, artifactId, {
          workflowMode: "agent-first",
          signal: context.signal,
        })
        : await this.projects.continueAgentFirstContinuityRepair(context.operation.projectId, artifactId, context.signal);
      completedActions.push("执行连续性报告指向的结构化修改", "创建带 JSON 投影与复检报告的新版本");
      context.progress("核对修复结果", 3, 4, {
        artifactId: result.artifact.id,
        version: result.artifact.version,
        remainingIssueCount: result.repair.remainingIssueCodes.length,
      });
      if (context.signal.aborted) {
        throw new OperationExecutionError(
          "CANCEL_AFTER_COMMIT",
          "取消请求到达时新版本已经安全写入；系统未删除该版本，也未切换 Head",
          false,
          { artifactId: result.artifact.id, version: result.artifact.version, completedActions },
        );
      }
      context.progress("等待用户选择 Head 并审批", 4, 4);
      return {
        artifactId: result.artifact.id,
        artifactType: result.artifact.type,
        version: result.artifact.version,
        fixedIssueCodes: result.repair.fixedIssueCodes,
        remainingIssueCodes: result.repair.remainingIssueCodes,
        nextTarget: result.repair.nextTarget,
        continuationTarget: typeof result.artifact.metadata.continuityRepairNext === "string"
          ? result.artifact.metadata.continuityRepairNext
          : null,
        headChanged: false,
        completedActions,
        unexecutedActions: ["未切换 Head", "未批准新版本", "未生成下一环节", "未提交付费平台"],
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (error instanceof OperationExecutionError) throw error;
      throw new OperationExecutionError(
        "CONTINUITY_REPAIR_FAILED",
        error instanceof Error ? error.message : "结构化连续性修复失败",
        true,
        {
          completedActions,
          unexecutedActions: ["未创建可确认的结构化修复版本", "未切换 Head", "未批准", "未生成下一环节"],
        },
        { cause: error },
      );
    }
  }
}
