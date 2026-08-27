import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StudioDatabase } from "../database/client";
import { reconcileAgentFirstWorkspace } from "../database/agent-first-backfill";
import { ArtifactRepository, type StoredArtifact } from "../artifacts/artifact-repository";
import { IssueRepository } from "../issues/issue-repository";
import { ProjectService } from "./project-service";
import {
  cumulativeVerificationStageIds,
  verificationBlockingChecks,
  type CumulativeVerificationCheck,
  type CumulativeVerificationLedger,
  type CumulativeVerificationStage,
  type CumulativeVerificationStageId,
  type CumulativeVerificationTarget,
  type VerificationDetector,
} from "../shared/cumulative-verification";
import { isReferenceRoleAllowed, supportsImageReferences } from "../shared/asset-reference-role";
import { inspectOutlineFeasibility, inspectScreenplayFeasibility } from "../shared/generation-readiness";
import { inspectShootingScriptPreflight } from "../shared/shooting-script-preflight";
import { continuityRepairTargetForIssue } from "../shared/continuity-repair";
import type { ArtifactType, Asset, ShotSpec } from "../shared/schemas";
import {
  assetBibleSchema,
  continuityReportSchema,
  screenplaySchema,
  shootingScriptSchema,
  storyboardSchema,
  storyOutlineSchema,
} from "../shared/skill-schemas";
import type { AssetBible, ShootingScript, Storyboard } from "../ai/text-provider";

const POLICY_VERSION = "cumulative-verification-v1";
const deterministicDetectorId = "deterministic:cumulative-verification-v1";
const humanDetectorId = "human:artifact-approval-v1";
const stageLabels: Record<CumulativeVerificationStageId, string> = {
  source: "原始输入",
  outline: "剧情大纲",
  screenplay: "影视剧本",
  "asset-bible": "资产定义",
  "shooting-script": "导演脚本",
  storyboard: "分镜设计",
  production: "制作准备",
};
const artifactOrder: ArtifactType[] = ["outline", "screenplay", "asset-bible", "shooting-script", "storyboard"];
const requiredInput: Partial<Record<ArtifactType, ArtifactType>> = {
  screenplay: "outline",
  "asset-bible": "screenplay",
  "shooting-script": "asset-bible",
  storyboard: "shooting-script",
};
const structuredSchemas = {
  outline: storyOutlineSchema,
  screenplay: screenplaySchema,
  "asset-bible": assetBibleSchema,
  "shooting-script": shootingScriptSchema,
  storyboard: storyboardSchema,
};

interface ProjectAuditRow {
  id: string;
  source_type: "story" | "screenplay" | "shooting-script" | "storyboard";
  source_path: string;
  project_dir: string;
  target_duration_sec: number;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function issueId(projectId: string, stage: string, code: string, scopeId: string | null, message: string): string {
  return `issue-${createHash("sha256").update(`${projectId}|cumulative|${stage}|${code}|${scopeId ?? "project"}|${message}`).digest("hex").slice(0, 32)}`;
}

function stageForArtifact(type: ArtifactType): CumulativeVerificationStageId {
  return type;
}

function firstArtifactIndex(sourceType: ProjectAuditRow["source_type"]): number {
  if (sourceType === "story") return 0;
  if (sourceType === "screenplay") return 1;
  if (sourceType === "shooting-script") return 3;
  return 4;
}

export class CumulativeVerificationService {
  constructor(
    private readonly studio: StudioDatabase,
    private readonly artifacts: ArtifactRepository,
    private readonly issues: IssueRepository,
    private readonly projectService: ProjectService,
  ) {}

  async audit(projectId: string, target: CumulativeVerificationTarget, targetArtifactId?: string | null): Promise<CumulativeVerificationLedger> {
    reconcileAgentFirstWorkspace(this.studio.sqlite);
    const project = this.requireProject(projectId);
    const targetIndex = target === "production" ? artifactOrder.length - 1 : artifactOrder.indexOf(target);
    if (targetIndex < 0) throw new Error("累计核查目标无效");
    const configuredStartIndex = firstArtifactIndex(project.source_type);
    const startIndex = target !== "production" && targetIndex < configuredStartIndex && targetArtifactId ? targetIndex : configuredStartIndex;
    const heads = this.artifacts.getHeads(projectId);
    const explicitTarget = targetArtifactId ? this.artifacts.require(projectId, targetArtifactId) : null;
    if (explicitTarget && (target === "production" || explicitTarget.type !== target)) throw new Error("累计核查目标版本类型不一致");

    const detectors = new Map<string, VerificationDetector>();
    detectors.set(deterministicDetectorId, {
      id: deterministicDetectorId, kind: "deterministic", name: "累计证据核查器", version: POLICY_VERSION,
      health: "healthy", model: null, runId: null, skillName: null, skillVersion: null, skillHash: null,
      detail: "本地确定性规则；核对 Head、血缘、文件哈希、结构合同、覆盖范围和门禁证据。",
    });
    detectors.set(humanDetectorId, {
      id: humanDetectorId, kind: "human", name: "人工版本批准", version: "artifact-approval-v1",
      health: "healthy", model: null, runId: null, skillName: null, skillVersion: null, skillHash: null,
      detail: "人工批准是独立语义判断；忽略问题不会替代批准，也不会绕过确定性门禁。",
    });

    const stages: CumulativeVerificationStage[] = [];
    const addStage = (id: CumulativeVerificationStageId, artifact: StoredArtifact | null = null): CumulativeVerificationStage => {
      const stage: CumulativeVerificationStage = {
        id, label: stageLabels[id], status: "passed",
        artifact: artifact ? {
          id: artifact.id, type: artifact.type, version: artifact.version, status: artifact.status,
          contentHash: artifact.contentHash, isHead: heads.get(artifact.type) === artifact.id,
        } : null,
        checks: [],
      };
      stages.push(stage);
      return stage;
    };
    const check = (
      stage: CumulativeVerificationStage,
      value: Omit<CumulativeVerificationCheck, "detectorId" | "responsibleStage" | "evidence"> & {
        detectorId?: string; responsibleStage?: CumulativeVerificationStageId; evidence?: string[];
      },
    ) => {
      stage.checks.push({
        detectorId: value.detectorId ?? deterministicDetectorId,
        responsibleStage: value.responsibleStage ?? stage.id,
        evidence: value.evidence ?? [],
        ...value,
      });
    };

    const sourceStage = addStage("source");
    if (!isInside(project.project_dir, project.source_path)) {
      check(sourceStage, { code: "SOURCE_PATH_OUTSIDE_PROJECT", status: "failed", severity: "error", blocking: true, message: "原始输入路径不在项目目录内", suggestedAction: "重新导入原始内容" });
    } else {
      const sourceExists = await fs.stat(project.source_path).then((stat) => stat.isFile()).catch(() => false);
      check(sourceStage, {
        code: "SOURCE_FILE_INTACT", status: sourceExists ? "passed" : "failed", severity: "error", blocking: true,
        message: sourceExists ? "原始输入文件存在且路径受项目目录约束" : "原始输入文件不存在",
        suggestedAction: sourceExists ? null : "恢复原始文件或重新建立项目", evidence: [project.source_path],
      });
    }

    const parsed = new Map<ArtifactType, unknown>();
    const selected = new Map<ArtifactType, StoredArtifact>();
    for (let index = startIndex; index <= targetIndex; index += 1) {
      const type = artifactOrder[index];
      const artifact = explicitTarget?.type === type ? explicitTarget : heads.get(type) ? this.artifacts.get(heads.get(type)!) : null;
      const stage = addStage(stageForArtifact(type), artifact);
      if (!artifact) {
        check(stage, { code: "HEAD_MISSING", status: "failed", severity: "error", blocking: true, message: type === "storyboard" ? "分镜设计没有当前 storyboard Head" : `${stage.label}没有当前 Head`, suggestedAction: `先创建${stage.label}版本并选择为 Head` });
        continue;
      }
      selected.set(type, artifact);
      const isHead = heads.get(type) === artifact.id;
      check(stage, {
        code: "CURRENT_HEAD", status: isHead ? "passed" : "failed", severity: "error", blocking: true,
        message: isHead ? `${stage.label} V${String(artifact.version).padStart(3, "0")} 是当前 Head` : "当前查看版本不是 Head，不能作为后续权威输入",
        suggestedAction: isHead ? null : "检查该版本后显式选择为 Head", evidence: [artifact.id],
      });
      if (artifact.status === "rejected" || artifact.status === "stale") {
        check(stage, { code: "ARTIFACT_STATUS_BLOCKED", status: "failed", severity: "error", blocking: true, message: `${stage.label}当前状态为 ${artifact.status}`, suggestedAction: "创建新版本并重新核查" });
      }
      const fileInside = isInside(project.project_dir, artifact.filePath);
      const content = fileInside ? await fs.readFile(artifact.filePath).catch(() => null) : null;
      const hashMatches = Boolean(content && sha256(content) === artifact.contentHash);
      check(stage, {
        code: "CONTENT_HASH_BOUND", status: fileInside && hashMatches ? "passed" : "failed", severity: "error", blocking: true,
        message: !fileInside ? "产物文件路径越界" : !content ? "产物文件不存在" : hashMatches ? "正文文件与数据库 SHA-256 一致" : "正文文件已在版本记录之外变化",
        suggestedAction: fileInside && hashMatches ? null : "恢复原文件或另存为新版本", evidence: [artifact.filePath, artifact.contentHash],
      });

      const structuredRequired = type === "asset-bible" || type === "shooting-script" || type === "storyboard";
      if (!artifact.structuredPath) {
        check(stage, {
          code: "STRUCTURED_EVIDENCE", status: structuredRequired ? "failed" : "unknown",
          severity: structuredRequired ? "error" : "warning", blocking: structuredRequired,
          message: structuredRequired ? `${stage.label}缺少结构化文件` : `${stage.label}是非结构化人工内容；语义正确性由人工批准承担`,
          suggestedAction: structuredRequired ? "使用对应生成/修订流程建立结构化版本" : "批准前人工通读并在意见中记录判断",
          detectorId: structuredRequired ? deterministicDetectorId : humanDetectorId,
        });
      } else {
        const structuredInside = isInside(project.project_dir, artifact.structuredPath);
        let value: unknown = null;
        let error: string | null = null;
        if (structuredInside) {
          try { value = structuredSchemas[type].parse(JSON.parse(await fs.readFile(artifact.structuredPath, "utf8"))); }
          catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
        }
        if (value) parsed.set(type, value);
        check(stage, {
          code: "STRUCTURED_CONTRACT", status: structuredInside && value ? "passed" : "failed", severity: "error", blocking: true,
          message: !structuredInside ? "结构化文件路径越界" : value ? `${stage.label}通过当前结构合同` : `结构化文件无法解析${error ? `：${error}` : ""}`,
          suggestedAction: structuredInside && value ? null : "用当前 Skill/编辑器创建新的结构化版本", evidence: [artifact.structuredPath],
        });
      }

      this.registerModelDetector(artifact, detectors, stage, check);

      const predecessorType = requiredInput[type];
      if (predecessorType && index > startIndex) {
        const predecessor = selected.get(predecessorType);
        const inputs = this.artifacts.listInputs(artifact.id);
        const currentInput = predecessor && this.hasLineageTo(artifact.id, predecessor.id);
        check(stage, {
          code: "CURRENT_INPUT_LINEAGE", status: currentInput ? "passed" : "failed", severity: "error", blocking: true,
          message: currentInput ? `可证明直接基于当前 ${stageLabels[predecessorType]} Head` : `没有证据证明当前版本基于当前 ${stageLabels[predecessorType]} Head`,
          suggestedAction: currentInput ? null : `从当前 ${stageLabels[predecessorType]} Head 重新生成或修订`, evidence: inputs.map((edge) => edge.inputArtifactId),
          responsibleStage: stage.id,
        });
      }

      const isCurrentTarget = target !== "production" && type === target;
      if (!isCurrentTarget || artifact.status === "approved") {
        const approved = artifact.status === "approved" && this.artifacts.listApprovals(artifact).some((approval) => approval.decision === "approved");
        check(stage, {
          code: "EXACT_HUMAN_APPROVAL", status: approved ? "passed" : "failed", severity: "error", blocking: true,
          message: approved ? "存在绑定该版本的人工批准证据" : `${stage.label}尚无绑定当前版本的人工批准证据`,
          suggestedAction: approved ? null : "在确认累计核查结果后批准当前 Head", detectorId: humanDetectorId, evidence: [artifact.id, artifact.contentHash],
        });
      }
    }

    await this.auditSemantics(project, stages, selected, parsed, check, detectors);

    if (target === "production") {
      const production = addStage("production");
      const allApproved = artifactOrder.slice(startIndex).every((type) => selected.get(type)?.status === "approved");
      check(production, {
        code: "ALL_HEADS_APPROVED", status: allApproved ? "passed" : "failed", severity: "error", blocking: true,
        message: allApproved ? "全部适用阶段的当前 Head 均已批准" : "仍有当前 Head 未批准，不能开始制作",
        suggestedAction: allApproved ? null : "从最早未通过阶段开始处理并重新累计核查", detectorId: humanDetectorId,
      });
    }

    for (const stage of stages) {
      if (!stage.checks.length) stage.status = "not-applicable";
      else if (stage.checks.some((item) => item.blocking && item.status === "failed")) stage.status = "blocked";
      else if (stage.checks.some((item) => item.status === "unknown")) stage.status = "incomplete";
      else stage.status = "passed";
    }
    const allChecks = stages.flatMap((stage) => stage.checks);
    const blockingFailed = allChecks.filter((item) => item.blocking && item.status === "failed");
    const blockingUnknown = allChecks.filter((item) => item.blocking && item.status === "unknown");
    const responsibilityOrder = new Map(cumulativeVerificationStageIds.map((id, index) => [id, index]));
    const earliestResponsibleStage = [...blockingFailed, ...blockingUnknown]
      .map((item) => item.responsibleStage)
      .sort((left, right) => (responsibilityOrder.get(left) ?? 99) - (responsibilityOrder.get(right) ?? 99))[0] ?? null;
    const ledger: CumulativeVerificationLedger = {
      schemaVersion: POLICY_VERSION,
      projectId,
      target,
      targetArtifactId: explicitTarget?.id ?? (target === "production" ? null : selected.get(target)?.id ?? null),
      status: blockingFailed.length ? "blocked" : blockingUnknown.length ? "incomplete" : "healthy",
      earliestResponsibleStage,
      blockerCount: blockingFailed.length,
      incompleteCount: allChecks.filter((item) => item.status === "unknown").length,
      checkedAt: new Date().toISOString(),
      detectors: [...detectors.values()],
      stages,
    };
    this.syncIssues(ledger);
    return ledger;
  }

  async assertCanApprove(projectId: string, artifactId: string): Promise<CumulativeVerificationLedger> {
    const artifact = this.artifacts.require(projectId, artifactId);
    const ledger = await this.audit(projectId, artifact.type, artifact.id);
    const blockers = verificationBlockingChecks(ledger);
    if (blockers.length) throw new Error(`累计核查未通过：${blockers.slice(0, 8).map((item) => `${stageLabels[item.responsibleStage]} ${item.message}`).join("；")}`);
    return ledger;
  }

  async assertReadyForProduction(projectId: string): Promise<CumulativeVerificationLedger> {
    const ledger = await this.audit(projectId, "production");
    const blockers = verificationBlockingChecks(ledger);
    if (blockers.length) throw new Error(`制作前累计核查未通过：${blockers.slice(0, 8).map((item) => `${stageLabels[item.responsibleStage]} ${item.message}`).join("；")}`);
    return ledger;
  }

  private requireProject(projectId: string): ProjectAuditRow {
    const row = this.studio.sqlite.prepare(`
      SELECT id, source_type, source_path, project_dir, target_duration_sec
      FROM projects WHERE id = ? AND archived_at IS NULL
    `).get(projectId) as ProjectAuditRow | undefined;
    if (!row) throw new Error("项目不存在");
    return row;
  }

  private registerModelDetector(
    artifact: StoredArtifact,
    detectors: Map<string, VerificationDetector>,
    stage: CumulativeVerificationStage,
    add: (stage: CumulativeVerificationStage, value: Omit<CumulativeVerificationCheck, "detectorId" | "responsibleStage" | "evidence"> & { detectorId?: string; responsibleStage?: CumulativeVerificationStageId; evidence?: string[] }) => void,
  ): void {
    const metadata = artifact.metadata;
    const providerRun = metadata.providerRun && typeof metadata.providerRun === "object" ? metadata.providerRun as Record<string, unknown> : null;
    const skills = Array.isArray(metadata.skills) ? metadata.skills.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    const modelExpected = Boolean(providerRun || skills.length || metadata.origin === "codex-cli" || metadata.origin === "test-double");
    if (!modelExpected) return;
    const primarySkill = skills.find((skill) => typeof skill.name === "string") ?? null;
    const healthy = Boolean(
      providerRun && typeof providerRun.runId === "string" && providerRun.runId
      && primarySkill && typeof primarySkill.version === "string" && typeof primarySkill.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(String(primarySkill.sha256)),
    );
    const detectorId = `model:${artifact.id}`;
    detectors.set(detectorId, {
      id: detectorId,
      kind: "model-skill",
      name: "大模型 + 版本化 Skill",
      version: typeof metadata.schema === "string" ? metadata.schema : "unknown",
      health: healthy ? "healthy" : "unavailable",
      model: providerRun && typeof providerRun.model === "string" ? providerRun.model : null,
      runId: providerRun && typeof providerRun.runId === "string" ? providerRun.runId : null,
      skillName: primarySkill && typeof primarySkill.name === "string" ? primarySkill.name : null,
      skillVersion: primarySkill && typeof primarySkill.version === "string" ? primarySkill.version : null,
      skillHash: primarySkill && typeof primarySkill.sha256 === "string" ? primarySkill.sha256 : null,
      detail: healthy ? "生成运行、Skill 版本和内容哈希均有记录。" : "模型或 Skill 来源证据不完整；不能把模型沉默当作通过。",
    });
    add(stage, {
      code: "MODEL_SKILL_PROVENANCE", status: healthy ? "passed" : "unknown", severity: healthy ? "info" : "warning", blocking: !healthy,
      message: healthy ? "模型运行与 Skill 版本来源完整" : "模型/Skill 检查主体来源不完整",
      suggestedAction: healthy ? null : "使用当前已登记 Skill 重新生成或复检", detectorId,
      evidence: [artifact.id, String(metadata.schema ?? "unknown")],
    });
  }

  private async auditSemantics(
    project: ProjectAuditRow,
    stages: CumulativeVerificationStage[],
    selected: Map<ArtifactType, StoredArtifact>,
    parsed: Map<ArtifactType, unknown>,
    add: (stage: CumulativeVerificationStage, value: Omit<CumulativeVerificationCheck, "detectorId" | "responsibleStage" | "evidence"> & { detectorId?: string; responsibleStage?: CumulativeVerificationStageId; evidence?: string[] }) => void,
    detectors: Map<string, VerificationDetector>,
  ): Promise<void> {
    const stage = (id: CumulativeVerificationStageId) => stages.find((item) => item.id === id);
    const outlineStage = stage("outline");
    const outline = parsed.get("outline");
    if (outlineStage && outline) {
      const report = inspectOutlineFeasibility(storyOutlineSchema.parse(outline), project.target_duration_sec);
      add(outlineStage, {
        code: "NARRATIVE_FEASIBILITY", status: report.status === "ready" ? "passed" : "failed", severity: "error", blocking: true,
        message: report.status === "ready" ? "大纲满足当前时长的镜头容量预算" : report.issues.map((item) => item.message).join("；"),
        suggestedAction: report.status === "ready" ? null : report.issues.map((item) => item.suggestedFix).join("；"), evidence: [report.policyVersion],
      });
    }
    const screenplayStage = stage("screenplay");
    const screenplay = parsed.get("screenplay");
    if (screenplayStage && screenplay) {
      const report = inspectScreenplayFeasibility(screenplaySchema.parse(screenplay), project.target_duration_sec);
      add(screenplayStage, {
        code: "NARRATIVE_FEASIBILITY", status: report.status === "ready" ? "passed" : "failed", severity: "error", blocking: true,
        message: report.status === "ready" ? "剧本满足当前时长的镜头容量预算" : report.issues.map((item) => item.message).join("；"),
        suggestedAction: report.status === "ready" ? null : report.issues.map((item) => item.suggestedFix).join("；"), evidence: [report.policyVersion],
      });
    }

    const assetStage = stage("asset-bible");
    const assetBible = parsed.get("asset-bible") as AssetBible | undefined;
    let currentAssets: Asset[] = [];
    if (assetStage && assetBible && selected.get("asset-bible")) {
      currentAssets = await this.projectService.listAssets(project.id);
      const versionMatches = currentAssets.length > 0 && currentAssets.every((asset) => asset.version === selected.get("asset-bible")!.version);
      add(assetStage, {
        code: "ASSET_PROJECTION_CURRENT", status: versionMatches ? "passed" : "failed", severity: "error", blocking: true,
        message: versionMatches ? "资产注册表与当前资产定义 Head 版本一致" : "资产注册表没有投影当前资产定义 Head",
        suggestedAction: versionMatches ? null : "重新选择资产定义 Head 以同步资产注册表",
      });
      if (versionMatches) {
        const readiness = await this.projectService.readAssetReadiness(project.id);
        add(assetStage, {
          code: "ASSET_PRODUCTION_READINESS", status: readiness.passed ? "passed" : "failed", severity: "error", blocking: true,
          message: readiness.passed ? "视觉资产具有可执行定义或有效参考图" : readiness.issues.join("；"),
          suggestedAction: readiness.passed ? null : "补齐资产定义或参考图后重新核查",
        });
        for (const asset of currentAssets) {
          const arraysAligned = asset.localFiles.length === asset.sha256.length && asset.localFiles.length === asset.fileRoles.length;
          if (asset.localFiles.length && supportsImageReferences(asset.type)) {
            add(assetStage, {
              code: `REFERENCE_ROLE_ALIGNMENT:${asset.id}`, status: arraysAligned && asset.fileRoles.every((role) => isReferenceRoleAllowed(asset.type, role)) ? "passed" : "failed",
              severity: "error", blocking: true,
              message: arraysAligned && asset.fileRoles.every((role) => isReferenceRoleAllowed(asset.type, role))
                ? `${asset.id} 每张参考图都有适用的用途角色`
                : `${asset.id} 的参考文件、哈希和用途角色没有一一对应或角色不适用`,
              suggestedAction: "重新上传或整理该资产参考图", evidence: asset.fileRoles,
            });
          }
          if (asset.type === "audio" && asset.localFiles.some((file) => /\.(png|jpe?g|webp|bmp)$/iu.test(file))) {
            add(assetStage, { code: `AUDIO_IMAGE_REFERENCE:${asset.id}`, status: "failed", severity: "error", blocking: true, message: `${asset.id} 音频资产错误绑定了图片参考`, suggestedAction: "移除图片并使用音频素材入口" });
          }
        }
      }
    }

    const shootingStage = stage("shooting-script");
    const shooting = parsed.get("shooting-script") as ShootingScript | undefined;
    if (shootingStage && shooting) {
      const projectedShots = await this.projectService.listShots(project.id);
      const projectedIds = projectedShots.map((shot) => shot.id).sort().join("|");
      const structuredIds = shooting.shots.map((shot) => shot.id).sort().join("|");
      const projectionMatches = projectedIds === structuredIds && projectedShots.length === shooting.shots.length;
      add(shootingStage, {
        code: "SHOT_PROJECTION_CURRENT", status: projectionMatches ? "passed" : "failed", severity: "error", blocking: true,
        message: projectionMatches ? "结构化导演脚本与当前镜头注册表一致" : "镜头注册表没有投影当前导演脚本 Head",
        suggestedAction: projectionMatches ? null : "重新选择导演脚本 Head 以同步镜头注册表",
      });
      const preflight = inspectShootingScriptPreflight(shooting.shots);
      add(shootingStage, {
        code: "SHOOTING_SCRIPT_PREFLIGHT", status: preflight.length ? "failed" : "passed", severity: "error", blocking: true,
        message: preflight.length ? preflight.map((item) => `${item.code} ${item.message}`).join("；") : "全部镜头通过时长、连续性与模型执行预算预检",
        suggestedAction: preflight.length ? "重构导演脚本并重新执行全量预检" : null,
      });
      if (assetBible) {
        const assetProblems = this.shotAssetProblems(assetBible, shooting);
        add(shootingStage, {
          code: "SHOT_ASSET_REFERENCES", status: assetProblems.length ? "failed" : "passed", severity: "error", blocking: true,
          message: assetProblems.length ? assetProblems.join("；") : "导演脚本资产引用存在且类型正确",
          suggestedAction: assetProblems.length ? "修订最早出错的资产定义或导演脚本" : null,
          responsibleStage: assetProblems.some((item) => item.includes("不存在")) ? "asset-bible" : "shooting-script",
        });
      }
    }

    const storyboardStage = stage("storyboard");
    const storyboard = parsed.get("storyboard") as Storyboard | undefined;
    const storyboardArtifact = selected.get("storyboard");
    if (storyboardStage && storyboard && shooting && assetBible && storyboardArtifact) {
      const coverageProblems = this.storyboardProblems(assetBible, shooting, storyboard);
      add(storyboardStage, {
        code: "STORYBOARD_COVERAGE", status: coverageProblems.length ? "failed" : "passed", severity: "error", blocking: true,
        message: coverageProblems.length ? coverageProblems.join("；") : "分镜与导演脚本一镜一项且资产引用完整",
        suggestedAction: coverageProblems.length ? "从责任上游重建分镜并重新复检" : null,
      });
      await this.auditContinuityReport(storyboardStage, storyboardArtifact, shooting.shots, add, detectors);
    }
  }

  private async auditContinuityReport(
    stage: CumulativeVerificationStage,
    artifact: StoredArtifact,
    shots: ShotSpec[],
    add: (stage: CumulativeVerificationStage, value: Omit<CumulativeVerificationCheck, "detectorId" | "responsibleStage" | "evidence"> & { detectorId?: string; responsibleStage?: CumulativeVerificationStageId; evidence?: string[] }) => void,
    detectors: Map<string, VerificationDetector>,
  ): Promise<void> {
    const reportPath = typeof artifact.metadata.continuityReportStructuredPath === "string" ? artifact.metadata.continuityReportStructuredPath : null;
    const attempts = Array.isArray(artifact.metadata.continuityReviewAttempts) ? artifact.metadata.continuityReviewAttempts : [];
    const latestAttempt = attempts.at(-1) && typeof attempts.at(-1) === "object" ? attempts.at(-1) as Record<string, unknown> : null;
    const skill = Array.isArray(artifact.metadata.skills)
      ? artifact.metadata.skills.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).name === "continuity-supervisor") as Record<string, unknown> | undefined
      : undefined;
    const modelHealthy = Boolean(
      artifact.metadata.continuityReviewStatus === "completed"
      && latestAttempt?.status === "completed"
      && typeof latestAttempt.runId === "string"
      && skill && typeof skill.version === "string" && typeof skill.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(String(skill.sha256)),
    );
    const detectorId = `model:continuity:${artifact.id}`;
    detectors.set(detectorId, {
      id: detectorId, kind: "model-skill", name: "连续性语义复检", version: "continuity-supervisor",
      health: modelHealthy ? "healthy" : "unavailable", model: null,
      runId: typeof latestAttempt?.runId === "string" ? latestAttempt.runId : null,
      skillName: typeof skill?.name === "string" ? skill.name : null,
      skillVersion: typeof skill?.version === "string" ? skill.version : null,
      skillHash: typeof skill?.sha256 === "string" ? skill.sha256 : null,
      detail: modelHealthy ? "连续性模型运行与 Skill 哈希完整。" : "连续性检查器来源或运行状态不完整。",
    });
    add(stage, {
      code: "CONTINUITY_CHECKER_HEALTH", status: modelHealthy ? "passed" : "unknown", severity: "error", blocking: true,
      message: modelHealthy ? "连续性语义检查器运行健康且来源可追溯" : "连续性语义检查器健康状态无法证明",
      suggestedAction: modelHealthy ? null : "重新运行连续性复检；不得把缺失结果当作通过", detectorId,
    });
    if (!reportPath || !isInside(this.requireProject(artifact.projectId).project_dir, reportPath)) {
      add(stage, { code: "CONTINUITY_REPORT", status: "failed", severity: "error", blocking: true, message: "连续性结构化报告缺失或路径越界", suggestedAction: "重新运行连续性复检", detectorId });
      return;
    }
    try {
      const report = continuityReportSchema.parse(JSON.parse(await fs.readFile(reportPath, "utf8")));
      const expected = shots.map((shot) => shot.id).sort().join("|");
      const actual = [...new Set(report.checkedShotIds)].sort().join("|");
      add(stage, {
        code: "CONTINUITY_REPORT_COVERAGE", status: expected === actual ? "passed" : "failed", severity: "error", blocking: true,
        message: expected === actual ? "连续性报告覆盖当前全部镜头" : "连续性报告没有覆盖当前全部镜头",
        suggestedAction: expected === actual ? null : "对当前全部镜头重新复检", detectorId, evidence: report.checkedShotIds,
      });
      add(stage, {
        code: "CONTINUITY_REPORT_RESULT", status: report.passed && report.issues.length === 0 ? "passed" : "failed", severity: "error", blocking: true,
        message: report.passed && report.issues.length === 0 ? "连续性报告通过且没有遗留问题" : `连续性报告仍有 ${report.issues.length} 项问题`,
        suggestedAction: report.passed && report.issues.length === 0 ? null : "按最早责任产物建立新版本，随后重建下游并复检", detectorId,
      });
      for (const item of report.issues) {
        const target = continuityRepairTargetForIssue(item);
        add(stage, {
          code: `CONTINUITY:${item.code}`, status: "failed", severity: item.severity === "error" ? "error" : "warning", blocking: item.severity === "error",
          message: item.message, suggestedAction: item.suggestedFix, detectorId,
          responsibleStage: target ?? "storyboard", evidence: item.affectedIds,
        });
      }
      const metadataPassed = artifact.metadata.continuityPassed === report.passed
        && (artifact.metadata.verification as Record<string, unknown> | undefined)?.modelExecutability === "passed";
      add(stage, {
        code: "CONTINUITY_METADATA_BOUND", status: metadataPassed ? "passed" : "failed", severity: "error", blocking: true,
        message: metadataPassed ? "分镜元数据与复检报告及模型可执行性结果一致" : "分镜元数据与复检报告或模型可执行性结果不一致",
        suggestedAction: metadataPassed ? null : "重新生成分镜复检证据，不要手工修改状态字段",
      });
    } catch (reason) {
      add(stage, { code: "CONTINUITY_REPORT", status: "failed", severity: "error", blocking: true, message: `连续性报告无法解析：${reason instanceof Error ? reason.message : String(reason)}`, suggestedAction: "重新运行连续性复检", detectorId });
    }
  }

  private shotAssetProblems(assetBible: AssetBible, shooting: ShootingScript): string[] {
    const byId = new Map(assetBible.assets.map((asset) => [asset.id, asset]));
    const problems: string[] = [];
    for (const shot of shooting.shots) {
      const refs: Array<[string, Asset["type"]]> = [
        [shot.sceneId, "scene"],
        ...shot.characterIds.map((id) => [id, "character"] as [string, Asset["type"]]),
        ...shot.propIds.map((id) => [id, "prop"] as [string, Asset["type"]]),
        ...shot.styleIds.map((id) => [id, "style"] as [string, Asset["type"]]),
        ...shot.dialogue.map((line) => [line.speakerId, "character"] as [string, Asset["type"]]),
      ];
      for (const [id, expected] of refs) {
        const asset = byId.get(id);
        if (!asset) problems.push(`${shot.id} 引用了不存在的资产 ${id}`);
        else if (asset.type !== expected) problems.push(`${shot.id} 的 ${id} 应为 ${expected}，实际为 ${asset.type}`);
      }
    }
    return [...new Set(problems)];
  }

  private hasLineageTo(artifactId: string, expectedInputId: string, visited = new Set<string>()): boolean {
    if (artifactId === expectedInputId) return true;
    if (visited.has(artifactId)) return false;
    visited.add(artifactId);
    return this.artifacts.listInputs(artifactId).some((edge) => this.hasLineageTo(edge.inputArtifactId, expectedInputId, visited));
  }

  private storyboardProblems(assetBible: AssetBible, shooting: ShootingScript, storyboard: Storyboard): string[] {
    const problems: string[] = [];
    const expected = shooting.shots.map((shot) => shot.id).sort();
    const actual = storyboard.shots.map((shot) => shot.shotId).sort();
    if (new Set(actual).size !== actual.length || expected.join("|") !== actual.join("|")) problems.push("分镜镜头编号没有与导演脚本一一对应");
    const assetIds = new Set(assetBible.assets.map((asset) => asset.id));
    for (const board of storyboard.shots) {
      const shot = shooting.shots.find((item) => item.id === board.shotId);
      if (!shot) continue;
      const required = new Set([shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds]);
      const actualAssets = new Set(board.requiredAssetIds);
      const missing = [...required].filter((id) => !actualAssets.has(id));
      const unknown = [...actualAssets].filter((id) => !assetIds.has(id));
      if (missing.length) problems.push(`${board.shotId} 缺少资产 ${missing.join("、")}`);
      if (unknown.length) problems.push(`${board.shotId} 引用未知资产 ${unknown.join("、")}`);
      if (board.sceneId !== shot.sceneId || [...board.characterIds].sort().join("|") !== [...shot.characterIds].sort().join("|")) problems.push(`${board.shotId} 人物或场景与导演脚本不一致`);
    }
    return [...new Set(problems)];
  }

  private syncIssues(ledger: CumulativeVerificationLedger): void {
    const activeIds = new Set<string>();
    for (const stage of ledger.stages) {
      for (const item of stage.checks) {
        if (item.status === "passed" || (!item.blocking && item.status === "unknown")) continue;
        const scopeId = stage.artifact?.id ?? null;
        const id = issueId(ledger.projectId, stage.id, item.code, scopeId, item.message);
        activeIds.add(id);
        this.issues.upsertOpen({
          id, projectId: ledger.projectId, scopeType: scopeId ? "artifact" : "project", scopeId,
          severity: item.severity === "info" ? "warning" : item.severity,
          code: item.code, title: `${stage.label}累计核查${item.status === "unknown" ? "证据不完整" : "未通过"}`,
          detail: item.message, suggestedAction: item.suggestedAction,
          source: `cumulative-verification:${item.detectorId}`,
        });
      }
    }
    for (const issue of this.issues.list(ledger.projectId)) {
      if (issue.status === "open" && issue.source.startsWith("cumulative-verification:") && !activeIds.has(issue.id)) {
        this.issues.resolveIfOpen(issue.id, "cumulative-verification", "重新累计核查后条件已通过");
      }
    }
  }
}
