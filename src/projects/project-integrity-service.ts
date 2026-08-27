import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { StudioDatabase } from "../database/client";
import {
  approvals,
  artifacts,
  assets as assetRecords,
  generationJobs,
  projects,
  qualityReviews,
  renders,
  shots,
} from "../database/schema";
import { bindHandoffPackageToShot, UpdreamPackageBuilder } from "../handoff/updream-package-builder";
import {
  importedGenerationSchema,
  qualityReviewSchema,
  renderRecordSchema,
  type ImportedGeneration,
  type QualityReview,
  type RenderRecord,
} from "../shared/quality-schemas";
import {
  projectIntegrityAuditSchema,
  projectIntegrityStepIds,
  type ProjectIntegrityAudit,
  type ProjectIntegrityIssue,
  type ProjectIntegrityStepId,
} from "../shared/project-integrity";
import {
  approvalRecordSchema,
  artifactSchema,
  assetSchema,
  projectSchema,
  shotSpecSchema,
  type Artifact,
  type ArtifactType,
  type Project,
  type ProjectStage,
  type ShotSpec,
} from "../shared/schemas";
import {
  assetBibleSchema,
  continuityReportSchema,
  screenplaySchema,
  shootingScriptSchema,
  storyboardSchema,
  storyOutlineSchema,
} from "../shared/skill-schemas";
import { initialStageBySourceType, stageOrder } from "../workflow/state-machine";

const artifactContracts: Array<{
  type: ArtifactType;
  stepId: ProjectIntegrityStepId;
  reviewStage: ProjectStage;
  approvedStage: ProjectStage;
  requiresStructured: boolean;
}> = [
  { type: "outline", stepId: "outline", reviewStage: "OUTLINE_REVIEW", approvedStage: "OUTLINE_APPROVED", requiresStructured: false },
  { type: "screenplay", stepId: "screenplay", reviewStage: "SCREENPLAY_REVIEW", approvedStage: "SCREENPLAY_APPROVED", requiresStructured: false },
  { type: "asset-bible", stepId: "asset-bible", reviewStage: "ASSET_BIBLE_REVIEW", approvedStage: "ASSET_BIBLE_APPROVED", requiresStructured: true },
  { type: "shooting-script", stepId: "shooting-script", reviewStage: "SHOOTING_SCRIPT_REVIEW", approvedStage: "SHOOTING_SCRIPT_APPROVED", requiresStructured: true },
  { type: "storyboard", stepId: "storyboard", reviewStage: "STORYBOARD_REVIEW", approvedStage: "STORYBOARD_APPROVED", requiresStructured: true },
];

const structuredArtifactSchemas = {
  outline: storyOutlineSchema,
  screenplay: screenplaySchema,
  "asset-bible": assetBibleSchema,
  "shooting-script": shootingScriptSchema,
  storyboard: storyboardSchema,
};

const stageStep: Record<ProjectStage, ProjectIntegrityStepId> = {
  SOURCE_IMPORTED: "source",
  OUTLINE_REVIEW: "outline",
  OUTLINE_APPROVED: "outline",
  SCREENPLAY_REVIEW: "screenplay",
  SCREENPLAY_APPROVED: "screenplay",
  ASSET_BIBLE_REVIEW: "asset-bible",
  ASSET_BIBLE_APPROVED: "asset-bible",
  SHOOTING_SCRIPT_REVIEW: "shooting-script",
  SHOOTING_SCRIPT_APPROVED: "shooting-script",
  STORYBOARD_REVIEW: "storyboard",
  STORYBOARD_APPROVED: "storyboard",
  ASSETS_LOCKED: "asset-bible",
  READY_FOR_GENERATION: "generation",
  GENERATING: "generation",
  GENERATION_REVIEW: "quality",
  EDITING: "delivery",
  FINAL_REVIEW: "delivery",
  DELIVERED: "delivery",
};

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function stageAtLeast(project: Project, target: ProjectStage): boolean {
  return stageOrder.indexOf(project.currentStage) >= stageOrder.indexOf(target);
}

function sourceTypeIncludesArtifact(project: Project, contract: (typeof artifactContracts)[number]): boolean {
  return stageOrder.indexOf(contract.reviewStage) >= stageOrder.indexOf(initialStageBySourceType[project.sourceType]);
}

function isFullyAcceptedReview(review: QualityReview): boolean {
  return review.decision === "accepted"
    && review.dimensions.every((item) => item.status === "pass")
    && review.conditions.length === 0
    && review.unverifiedClaims.length === 0;
}

export class ProjectIntegrityService {
  private readonly updreamPackages = new UpdreamPackageBuilder();
  private readonly fileHashCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; hash: string }>();

  constructor(private readonly studio: StudioDatabase) {}

  async audit(projectId: string): Promise<ProjectIntegrityAudit> {
    const project = await this.requireProject(projectId);
    const issues: ProjectIntegrityIssue[] = [];
    const add = (stepId: ProjectIntegrityStepId, code: string, message: string, severity: ProjectIntegrityIssue["severity"] = "error") => {
      if (!issues.some((issue) => issue.stepId === stepId && issue.code === code && issue.message === message)) {
        issues.push({ stepId, code, message, severity });
      }
    };

    await this.auditSource(project, add);
    const approvedArtifacts = await this.auditArtifacts(project, add);
    const shotList = await this.readShots(project, add);
    await this.auditAssets(project, add);
    await this.auditStoryboard(project, approvedArtifacts.get("storyboard") ?? null, shotList, add);
    const acceptedJobs = await this.auditGenerationAndQuality(project, shotList, add);
    await this.auditDelivery(project, acceptedJobs, add);

    for (const staleStage of project.staleStages) {
      add(stageStep[staleStage], "STALE_STAGE", `${staleStage} 已因上游修订失效，必须重新处理`);
    }

    const errors = issues.filter((issue) => issue.severity === "error");
    const firstBlockedStepId = projectIntegrityStepIds.find((stepId) => errors.some((issue) => issue.stepId === stepId)) ?? null;
    return projectIntegrityAuditSchema.parse({
      projectId,
      status: errors.length ? "blocked" : "healthy",
      firstBlockedStepId,
      issues,
      checkedAt: new Date().toISOString(),
    });
  }

  async assertCanContinue(projectId: string, action: string): Promise<void> {
    const audit = await this.audit(projectId);
    const blockers = audit.issues.filter((issue) => issue.severity === "error");
    if (!blockers.length) return;
    throw new Error(`${action}前的项目证据审计未通过：${blockers.slice(0, 8).map((issue) => `${issue.stepId}：${issue.message}`).join("；")}`);
  }

  private async auditSource(
    project: Project,
    add: (stepId: ProjectIntegrityStepId, code: string, message: string, severity?: ProjectIntegrityIssue["severity"]) => void,
  ): Promise<void> {
    if (!isInside(project.projectDir, project.sourcePath)) {
      add("source", "SOURCE_PATH_OUTSIDE_PROJECT", "原始输入路径不在项目目录内");
      return;
    }
    if (!(await this.fileExists(project.sourcePath))) add("source", "SOURCE_FILE_MISSING", "原始输入文件不存在");
  }

  private async auditArtifacts(
    project: Project,
    add: (stepId: ProjectIntegrityStepId, code: string, message: string, severity?: ProjectIntegrityIssue["severity"]) => void,
  ): Promise<Map<ArtifactType, Artifact>> {
    const [artifactRows, approvalRows] = await Promise.all([
      this.studio.db.select().from(artifacts).where(eq(artifacts.projectId, project.id)).orderBy(desc(artifacts.version)),
      this.studio.db.select().from(approvals).where(eq(approvals.projectId, project.id)).orderBy(desc(approvals.createdAt)),
    ]);
    const parsedApprovals = approvalRows.flatMap((row) => {
      const parsed = approvalRecordSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    const approved = new Map<ArtifactType, Artifact>();

    for (const contract of artifactContracts) {
      if (!sourceTypeIncludesArtifact(project, contract) || !stageAtLeast(project, contract.approvedStage)) continue;
      const rows = artifactRows.filter((row) => row.type === contract.type);
      if (!rows.length) {
        add(contract.stepId, "ARTIFACT_MISSING", `${contract.type} 阶段已被标记通过，但没有任何版本记录`);
        continue;
      }
      const parsed = artifactSchema.safeParse({ ...rows[0], structuredPath: rows[0].structuredPath ?? null, sourceArtifactId: rows[0].sourceArtifactId ?? null });
      if (!parsed.success) {
        add(contract.stepId, "ARTIFACT_RECORD_INVALID", `${contract.type} 最新版本记录无法解析`);
        continue;
      }
      const artifact = parsed.data;
      if (artifact.status !== "approved") {
        add(contract.stepId, "LATEST_ARTIFACT_NOT_APPROVED", `${contract.type} 最新版本 V${String(artifact.version).padStart(3, "0")} 不是已批准状态`);
        continue;
      }
      approved.set(contract.type, artifact);
      if (!isInside(project.projectDir, artifact.filePath)) {
        add(contract.stepId, "ARTIFACT_PATH_OUTSIDE_PROJECT", `${contract.type} 文件路径越界`);
      } else if (!(await this.fileExists(artifact.filePath))) {
        add(contract.stepId, "ARTIFACT_FILE_MISSING", `${contract.type} 已批准文件不存在`);
      } else if ((await this.sha256File(artifact.filePath)) !== artifact.contentHash) {
        add(contract.stepId, "ARTIFACT_HASH_MISMATCH", `${contract.type} 已批准文件内容与审批哈希不一致`);
      }
      if (contract.requiresStructured) {
        if (!artifact.structuredPath) {
          add(contract.stepId, "STRUCTURED_ARTIFACT_MISSING", `${contract.type} 缺少结构化文件记录`);
        } else if (!isInside(project.projectDir, artifact.structuredPath)) {
          add(contract.stepId, "STRUCTURED_ARTIFACT_OUTSIDE_PROJECT", `${contract.type} 结构化文件路径越界`);
        } else if (!(await this.fileExists(artifact.structuredPath))) {
          add(contract.stepId, "STRUCTURED_ARTIFACT_FILE_MISSING", `${contract.type} 结构化文件不存在`);
        } else {
          try {
            structuredArtifactSchemas[contract.type].parse(JSON.parse(await fs.readFile(artifact.structuredPath, "utf8")));
          } catch (error) {
            add(contract.stepId, "STRUCTURED_ARTIFACT_INVALID", `${contract.type} 结构化文件无法按当前数据合同解析：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const matchingApproval = parsedApprovals.find((approval) => approval.decision === "approved"
        && approval.stage === contract.reviewStage
        && approval.artifactPath === artifact.filePath
        && approval.artifactHash === artifact.contentHash
        && approval.artifactVersion === artifact.version);
      if (!matchingApproval) {
        add(contract.stepId, "APPROVAL_EVIDENCE_MISSING", `${contract.type} V${String(artifact.version).padStart(3, "0")} 缺少与路径、版本和哈希完全匹配的批准记录`);
      }
    }
    return approved;
  }

  private async readShots(
    project: Project,
    add: (stepId: ProjectIntegrityStepId, code: string, message: string, severity?: ProjectIntegrityIssue["severity"]) => void,
  ): Promise<ShotSpec[]> {
    const rows = await this.studio.db.select().from(shots).where(eq(shots.projectId, project.id));
    const shotList: ShotSpec[] = [];
    for (const row of rows) {
      const parsed = shotSpecSchema.safeParse({ ...row.payload, id: row.id, projectId: row.projectId, sequence: row.sequence, status: row.status });
      if (parsed.success) shotList.push(parsed.data);
      else add("shooting-script", "SHOT_RECORD_INVALID", `镜头 ${row.id} 的 ShotSpec 记录无法解析`);
    }
    shotList.sort((left, right) => left.sequence - right.sequence);
    if (stageAtLeast(project, "SHOOTING_SCRIPT_APPROVED") && !shotList.length) {
      add("shooting-script", "SHOTS_MISSING", "导演脚本已标记通过，但没有任何 ShotSpec 镜头记录");
    }
    return shotList;
  }

  private async auditAssets(
    project: Project,
    add: (stepId: ProjectIntegrityStepId, code: string, message: string, severity?: ProjectIntegrityIssue["severity"]) => void,
  ): Promise<void> {
    if (!stageAtLeast(project, "ASSETS_LOCKED")) return;
    const rows = await this.studio.db.select().from(assetRecords).where(eq(assetRecords.projectId, project.id));
    const currentVersion = rows.reduce((latest, row) => Math.max(latest, row.version), 0);
    const currentRows = rows.filter((row) => row.version === currentVersion);
    if (!currentRows.length) {
      add("asset-bible", "ASSETS_MISSING", "项目已锁定素材，但当前资产版本为空");
      return;
    }
    for (const row of currentRows) {
      const parsed = assetSchema.safeParse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
      if (!parsed.success) {
        add("asset-bible", "ASSET_RECORD_INVALID", `资产 ${row.id} 记录无法解析`);
        continue;
      }
      const asset = parsed.data;
      if (!asset.approved) add("asset-bible", "ASSET_NOT_APPROVED", `资产 ${asset.id} 未批准，不能视为已锁定`);
      if (asset.type !== "audio" && !asset.productionReady && !asset.localFiles.length) {
        add("asset-bible", "ASSET_NOT_PRODUCTION_READY", `资产 ${asset.id} 尚未形成可制作设定或有效参考图`);
      }
      for (const [index, filePath] of asset.localFiles.entries()) {
        if (!isInside(project.projectDir, filePath)) {
          add("asset-bible", "ASSET_FILE_OUTSIDE_PROJECT", `资产 ${asset.id} 的参考文件路径越界`);
        } else if (!(await this.fileExists(filePath))) {
          add("asset-bible", "ASSET_FILE_MISSING", `资产 ${asset.id} 的参考文件不存在`);
        } else if (!asset.sha256[index] || (await this.sha256File(filePath)) !== asset.sha256[index]) {
          add("asset-bible", "ASSET_HASH_MISMATCH", `资产 ${asset.id} 的参考文件哈希已变化`);
        }
      }
    }
  }

  private async auditStoryboard(
    project: Project,
    storyboard: Artifact | null,
    shotList: ShotSpec[],
    add: (stepId: ProjectIntegrityStepId, code: string, message: string, severity?: ProjectIntegrityIssue["severity"]) => void,
  ): Promise<void> {
    if (!stageAtLeast(project, "STORYBOARD_APPROVED") || !storyboard) return;
    const reportPath = storyboard.metadata.continuityReportPath;
    const structuredPath = storyboard.metadata.continuityReportStructuredPath;
    if (typeof reportPath !== "string" || !reportPath.trim() || !isInside(project.projectDir, reportPath) || !(await this.fileExists(reportPath))) {
      add("storyboard", "CONTINUITY_REPORT_MISSING", "已批准分镜缺少可读取的连续性报告");
    }
    if (typeof structuredPath !== "string" || !structuredPath.trim()) {
      add("storyboard", "CONTINUITY_REPORT_STRUCTURED_MISSING", "已批准分镜缺少结构化连续性报告路径");
      return;
    }
    if (!isInside(project.projectDir, structuredPath)) {
      add("storyboard", "CONTINUITY_REPORT_PATH_OUTSIDE_PROJECT", "结构化连续性报告路径越界");
      return;
    }
    try {
      const report = continuityReportSchema.parse(JSON.parse(await fs.readFile(structuredPath, "utf8")));
      if (!report.passed) add("storyboard", "CONTINUITY_NOT_PASSED", "分镜连续性报告没有通过");
      const expected = shotList.map((shot) => shot.id).sort();
      const checked = [...new Set(report.checkedShotIds)].sort();
      if (expected.join("|") !== checked.join("|")) add("storyboard", "CONTINUITY_COVERAGE_INCOMPLETE", "连续性报告没有覆盖当前全部镜头");
    } catch (error) {
      add("storyboard", "CONTINUITY_REPORT_INVALID", `结构化连续性报告不可读取或格式无效：${error instanceof Error ? error.message : String(error)}`);
    }
    if (storyboard.metadata.continuityPassed !== true) {
      add("storyboard", "CONTINUITY_METADATA_INCONSISTENT", "分镜元数据没有记录连续性正式通过");
    }
    const verification = storyboard.metadata.verification;
    if (!verification || typeof verification !== "object" || (verification as Record<string, unknown>).modelExecutability !== "passed") {
      add("storyboard", "MODEL_EXECUTABILITY_NOT_PASSED", "分镜缺少模型可执行性正式通过证据");
    }
  }

  private async auditGenerationAndQuality(
    project: Project,
    shotList: ShotSpec[],
    add: (stepId: ProjectIntegrityStepId, code: string, message: string, severity?: ProjectIntegrityIssue["severity"]) => void,
  ): Promise<Map<string, ImportedGeneration>> {
    const acceptedByShot = new Map<string, ImportedGeneration>();
    if (!stageAtLeast(project, "READY_FOR_GENERATION")) return acceptedByShot;
    if (!(await this.updreamPackages.readBootstrap(project))) {
      add("generation", "BOOTSTRAP_MISSING", "项目已进入生成阶段，但 Updream 初始化包不存在或无法解析");
    }
    if (!stageAtLeast(project, "GENERATION_REVIEW")) return acceptedByShot;

    const [jobRows, reviewRows] = await Promise.all([
      this.studio.db.select().from(generationJobs).where(eq(generationJobs.projectId, project.id)),
      this.studio.db.select().from(qualityReviews).where(eq(qualityReviews.projectId, project.id)).orderBy(desc(qualityReviews.createdAt)),
    ]);
    const generations = jobRows.flatMap((row) => {
      const parsed = importedGenerationSchema.safeParse({ ...row.payload, id: row.id, projectId: row.projectId, shotId: row.shotId, provider: row.provider, model: row.model, mode: row.mode, status: row.status, parameterHash: row.parameterHash });
      if (!parsed.success) {
        add("generation", "GENERATION_RECORD_INVALID", `镜头 ${row.shotId} 的生成记录无法解析`);
        return [];
      }
      return [parsed.data];
    }).sort((left, right) => right.generationVersion - left.generationVersion || right.createdAt.localeCompare(left.createdAt));
    const reviews = reviewRows.flatMap((row) => {
      const parsed = qualityReviewSchema.safeParse({ ...row.payload, id: row.id, projectId: row.projectId, jobId: row.jobId, shotId: row.shotId, decision: row.decision, createdAt: row.createdAt });
      if (!parsed.success) {
        add("quality", "QUALITY_REVIEW_RECORD_INVALID", `镜头 ${row.shotId} 的质量审核记录无法解析`);
        return [];
      }
      return [parsed.data];
    });

    for (const shot of shotList) {
      const generation = generations.find((item) => item.shotId === shot.id);
      if (!generation) {
        add("generation", "GENERATION_MISSING", `${shot.id} 尚无已导入的生成视频`);
        continue;
      }
      if (!isInside(project.projectDir, generation.importedPath)) {
        add("generation", "GENERATION_PATH_OUTSIDE_PROJECT", `${shot.id} 的导入视频路径越界`);
      } else if (!(await this.fileExists(generation.importedPath))) {
        add("generation", "GENERATION_FILE_MISSING", `${shot.id} 的导入视频不存在`);
      } else if ((await this.sha256File(generation.importedPath)) !== generation.sourceHash) {
        add("generation", "GENERATION_HASH_MISMATCH", `${shot.id} 的导入视频已在审核记录之外发生变化`);
      }
      try {
        const packageSummary = (await this.updreamPackages.listShotPackages(project, shot.id)).find((item) => item.version === generation.promptVersion);
        if (!packageSummary) {
          add("generation", "PROMPT_PACKAGE_MISSING", `${shot.id} V${String(generation.promptVersion).padStart(3, "0")} 缺少对应提示词投递包`);
        } else {
          const bound = bindHandoffPackageToShot(packageSummary, shot);
          if (bound.isStale) add("generation", "PROMPT_PACKAGE_STALE", `${shot.id} 的提示词投递包已失效：${bound.staleReasons.join("；")}`);
          if (!isInside(project.projectDir, bound.promptPath) || !(await this.fileExists(bound.promptPath)) || !(await fs.readFile(bound.promptPath, "utf8")).trim()) {
            add("generation", "PROMPT_FILE_INVALID", `${shot.id} 的提示词文件缺失、为空或路径越界`);
          }
        }
      } catch (error) {
        add("generation", "PROMPT_PACKAGE_UNREADABLE", `${shot.id} 的提示词证据不可读取：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!stageAtLeast(project, "EDITING")) continue;
      const latestReview = reviews.find((review) => review.jobId === generation.id);
      if (!latestReview) {
        add("quality", "QUALITY_REVIEW_MISSING", `${shot.id} 最新生成版本没有人工九维审核`);
      } else if (latestReview.decision === "conditional-pass") {
        add("quality", "CONDITIONAL_PASS_NOT_CLOSED", `${shot.id} 仅为有条件通过，条件尚未闭环`);
      } else if (!isFullyAcceptedReview(latestReview)) {
        add("quality", "QUALITY_REVIEW_NOT_ACCEPTED", `${shot.id} 最新生成版本没有九维全部正式通过`);
      } else if (generation.status !== "accepted") {
        add("quality", "QUALITY_STATUS_INCONSISTENT", `${shot.id} 审核记录与生成状态不一致`);
      } else {
        acceptedByShot.set(shot.id, generation);
      }
    }
    return acceptedByShot;
  }

  private async auditDelivery(
    project: Project,
    acceptedByShot: Map<string, ImportedGeneration>,
    add: (stepId: ProjectIntegrityStepId, code: string, message: string, severity?: ProjectIntegrityIssue["severity"]) => void,
  ): Promise<void> {
    if (!stageAtLeast(project, "FINAL_REVIEW")) return;
    const [renderRows, approvalRows] = await Promise.all([
      this.studio.db.select().from(renders).where(eq(renders.projectId, project.id)).orderBy(desc(renders.version)),
      this.studio.db.select().from(approvals).where(and(eq(approvals.projectId, project.id), eq(approvals.stage, "FINAL_REVIEW"))).orderBy(desc(approvals.createdAt)),
    ]);
    if (!renderRows.length) {
      add("delivery", "RENDER_MISSING", "项目已进入成片终审或交付阶段，但没有粗剪记录");
      return;
    }
    const parsed = renderRecordSchema.safeParse({ ...renderRows[0].payload, id: renderRows[0].id, projectId: renderRows[0].projectId, version: renderRows[0].version, status: renderRows[0].status, videoPath: renderRows[0].videoPath, subtitlePath: renderRows[0].subtitlePath, reportPath: renderRows[0].reportPath, createdAt: renderRows[0].createdAt, updatedAt: renderRows[0].updatedAt });
    if (!parsed.success) {
      add("delivery", "RENDER_RECORD_INVALID", "最新粗剪记录无法解析");
      return;
    }
    const render: RenderRecord = parsed.data;
    const expectedJobIds = [...acceptedByShot.values()].map((generation) => generation.id).sort();
    if (expectedJobIds.join("|") !== [...render.sourceJobIds].sort().join("|")) {
      add("delivery", "RENDER_SOURCE_MISMATCH", "最新粗剪绑定的生成版本不是当前全部正式通过版本");
    }
    for (const [label, filePath] of [["粗剪视频", render.videoPath], ["粗剪报告", render.reportPath], ["粗剪字幕", render.subtitlePath]] as const) {
      if (!filePath) continue;
      if (!isInside(project.projectDir, filePath) || !(await this.fileExists(filePath))) add("delivery", "RENDER_FILE_MISSING", `${label}不存在或路径越界`);
    }
    if (!render.media) add("delivery", "RENDER_MEDIA_EVIDENCE_MISSING", "粗剪缺少 ffprobe 媒体实测记录");
    if (!stageAtLeast(project, "DELIVERED")) {
      if (render.status !== "review") add("delivery", "RENDER_STATUS_INCONSISTENT", `成片终审阶段的最新粗剪状态为 ${render.status}，不是待审核`);
      return;
    }
    if (render.status !== "approved") add("delivery", "DELIVERY_NOT_APPROVED", "项目标记为已交付，但最新粗剪并未正式批准");
    const requiredDeliveryFiles = [render.deliveryVideoPath, render.deliveryReportPath];
    if (render.subtitlePath) requiredDeliveryFiles.push(render.deliverySubtitlePath);
    const deliveryFileChecks = await Promise.all(requiredDeliveryFiles.map(async (filePath) =>
      filePath !== null && isInside(project.projectDir, filePath) && await this.fileExists(filePath)));
    if (deliveryFileChecks.some((exists) => !exists)) {
      add("delivery", "DELIVERY_FILE_MISSING", "已交付项目缺少成片、报告或应有字幕文件");
    }
    if (!render.deliveryVideoPath || !(await this.fileExists(render.deliveryVideoPath))) return;
    const deliveryHash = await this.sha256File(render.deliveryVideoPath);
    const approval = approvalRows.map((row) => approvalRecordSchema.safeParse(row)).find((result) => result.success
      && result.data.decision === "approved"
      && result.data.artifactPath === render.deliveryVideoPath
      && result.data.artifactVersion === render.version
      && result.data.artifactHash === deliveryHash);
    if (!approval) add("delivery", "DELIVERY_APPROVAL_EVIDENCE_MISSING", "交付成片缺少与实际文件、版本和哈希完全匹配的终审批记录");
  }

  private async requireProject(projectId: string): Promise<Project> {
    const [row] = await this.studio.db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.archivedAt))).limit(1);
    if (!row) throw new Error("项目不存在");
    return projectSchema.parse({ ...row, sourceType: row.sourceType, currentStage: row.currentStage, staleStages: row.staleStages });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(() => true).catch(() => false);
  }

  private async sha256File(filePath: string): Promise<string> {
    const stat = await fs.stat(filePath);
    const cached = this.fileHashCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return cached.hash;
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    const digest = hash.digest("hex");
    this.fileHashCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: digest });
    return digest;
  }
}
