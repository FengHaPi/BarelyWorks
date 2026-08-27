import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { StudioDatabase } from "../database/client";
import { ArtifactRepository } from "../artifacts/artifact-repository";
import { ProjectRepository } from "../projects/project-repository";
import { ProjectService } from "../projects/project-service";
import { inspectShootingScriptPreflight } from "../shared/shooting-script-preflight";
import { CumulativeVerificationService } from "../projects/cumulative-verification-service";

const reviewStageByType = {
  outline: "OUTLINE_REVIEW",
  screenplay: "SCREENPLAY_REVIEW",
  "asset-bible": "ASSET_BIBLE_REVIEW",
  "shooting-script": "SHOOTING_SCRIPT_REVIEW",
  storyboard: "STORYBOARD_REVIEW",
} as const;

export class ApprovalService {
  constructor(
    private readonly studio: StudioDatabase,
    private readonly projects: ProjectRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly projectService: ProjectService,
    private readonly verification: CumulativeVerificationService,
  ) {}

  reconcileProjectionApprovals(): { approvedShots: number } {
    const result = this.studio.sqlite.prepare(`
      UPDATE shots SET status = 'approved'
      WHERE status <> 'approved' AND project_id IN (
        SELECT heads.project_id
        FROM project_heads AS heads
        JOIN artifacts AS artifact ON artifact.id = heads.artifact_id
        WHERE heads.artifact_type = 'shooting-script' AND artifact.status = 'approved'
      )
    `).run();
    return { approvedShots: result.changes };
  }

  async decide(projectId: string, artifactId: string, decision: "approved" | "rejected", comment?: string): Promise<{
    artifactId: string; approvalId: string; decision: "approved" | "rejected"; createdAt: string;
  }> {
    this.projects.require(projectId);
    const artifact = this.artifacts.require(projectId, artifactId);
    if (decision === "rejected" && !comment?.trim()) throw new Error("驳回时必须填写修改意见");
    const content = await fs.readFile(artifact.filePath);
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== artifact.contentHash) throw new Error("产物文件已在数据库外被修改，请先另存为新版本");
    if (decision === "approved" && (artifact.type === "asset-bible" || artifact.type === "shooting-script")) {
      const headId = this.artifacts.getHeads(projectId).get(artifact.type);
      if (headId !== artifact.id) throw new Error(`请先将该${artifact.type === "asset-bible" ? "资产定义" : "导演脚本"}版本选择为 Head，再批准`);
    }
    if (decision === "approved") await this.verification.assertCanApprove(projectId, artifactId);
    if (decision === "approved" && artifact.type === "asset-bible") {
      const currentAssets = await this.projectService.listAssets(projectId);
      if (!currentAssets.length || currentAssets.some((asset) => asset.version !== artifact.version)) {
        throw new Error("当前资产注册表与所选资产定义版本不一致，不能批准");
      }
      const readiness = await this.projectService.readAssetReadiness(projectId);
      if (!readiness.passed) throw new Error(`资产定义不能批准：${readiness.issues.join("；")}`);
    }
    if (decision === "approved" && artifact.type === "shooting-script") {
      const currentShots = await this.projectService.listShots(projectId);
      const issues = inspectShootingScriptPreflight(currentShots);
      if (!currentShots.length || issues.length) {
        throw new Error(`导演脚本不能批准：${!currentShots.length ? "没有结构化镜头" : issues.map((issue) => `${issue.code} ${issue.message}`).join("；")}`);
      }
    }
    if (decision === "approved" && artifact.type === "storyboard") {
      const verification = artifact.metadata.verification;
      const modelExecutability = verification && typeof verification === "object"
        ? (verification as Record<string, unknown>).modelExecutability
        : null;
      if (artifact.metadata.continuityPassed !== true || modelExecutability !== "passed") {
        throw new Error("分镜连续性或模型可执行性检查尚未通过，不能批准当前版本");
      }
    }
    const result = this.studio.sqlite.transaction(() => {
      const current = this.studio.sqlite.prepare("SELECT status FROM artifacts WHERE id = ?").get(artifact.id) as { status: string } | undefined;
      const existing = this.studio.sqlite.prepare(`
        SELECT id AS approvalId, decision, created_at AS createdAt
        FROM approvals
        WHERE artifact_id = ? AND decision = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(artifact.id, decision) as { approvalId: string; decision: "approved" | "rejected"; createdAt: string } | undefined;
      if (current?.status === decision && existing) {
        return { artifactId, ...existing };
      }
      const approvalId = randomUUID();
      const createdAt = new Date().toISOString();
      this.studio.sqlite.prepare(`
        INSERT INTO approvals(
          id, project_id, stage, artifact_path, artifact_hash, artifact_version,
          decision, comment, created_at, artifact_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(approvalId, projectId, reviewStageByType[artifact.type], artifact.filePath, artifact.contentHash,
        artifact.version, decision, comment?.trim() || null, createdAt, artifact.id);
      this.studio.sqlite.prepare("UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?")
        .run(decision, createdAt, artifact.id);
      if (artifact.type === "asset-bible") {
        this.studio.sqlite.prepare("UPDATE assets SET approved = ? WHERE project_id = ? AND version = ?")
          .run(decision === "approved" ? 1 : 0, projectId, artifact.version);
      }
      if (artifact.type === "shooting-script") {
        this.studio.sqlite.prepare("UPDATE shots SET status = ? WHERE project_id = ?")
          .run(decision === "approved" ? "approved" : "rejected", projectId);
      }
      return { artifactId, approvalId, decision, createdAt };
    })();
    return result;
  }
}
