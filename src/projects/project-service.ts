import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { stringify as toYaml } from "yaml";
import { z } from "zod";
import type { StudioDatabase } from "../database/client";
import { approvals, artifacts, assets as assetRecords, projects, shots } from "../database/schema";
import {
  renderAssetBible,
  renderContinuityReport,
  renderOutline,
  renderScreenplay,
  renderShootingScript,
  renderStoryboard,
} from "../ai/artifact-renderers";
import type {
  AssetBible,
  AssetDesignMode,
  ApprovedAssetBibleLock,
  ContinuityReport,
  ShootingScript,
  Storyboard,
  StoryOutline,
  TextGenerationTrace,
  TextIntelligenceProvider,
} from "../ai/text-provider";
import { DisabledImageGenerationProvider, type ImageGenerationProvider, type ImageProviderCapabilities } from "../ai/image-provider";
import { preflightH3Shot } from "../handoff/h3-preflight";
import { optimizeH3Prompt } from "../handoff/h3-prompt-optimizer";
import { bindHandoffPackageToShot, shotSpecFingerprint, UpdreamPackageBuilder, type BootstrapSummary } from "../handoff/updream-package-builder";
import { WindowsFileClipboard, type FileClipboard } from "../handoff/file-clipboard";
import { validateImageBytes } from "../media/image-validation";
import {
  generationCenterSchema,
  generationResolutionSchema,
  h3CapabilitiesSchema,
  h3PromptOutputSchema,
  type GenerationResolution,
  type GenerationCenter,
  type HandoffPackageSummary,
} from "../shared/handoff-schemas";
import {
  assetBibleSchema,
  continuityReportSchema,
  screenplaySchema,
  shootingScriptSchema,
  storyboardSchema,
  storyOutlineSchema,
} from "../shared/skill-schemas";
import {
  approvalRecordSchema,
  artifactSchema,
  assetSchema,
  assetReferencePromptRecordSchema,
  createProjectInputSchema,
  projectSchema,
  shotSpecSchema,
  type ApprovalRecord,
  type Artifact,
  type ArtifactType,
  type Asset,
  type AssetReferencePromptRecord,
  type AssetReferenceRole,
  type CreateProjectInput,
  type Project,
  type ProjectStage,
  type ShotSpec,
} from "../shared/schemas";
import { assetReferenceStorageFileName } from "../shared/asset-reference-naming";
import { assertReferenceRoleAllowed } from "../shared/asset-reference-role";
import {
  continuityRepairKind,
  continuityRepairKindForIssue,
  continuityRepairTargetForIssue,
  type ContinuityRepairPlan,
  type ContinuityRepairPlanStep,
} from "../shared/continuity-repair";
import { h3ProductDurationMin, isH3ProductDurationCompatible } from "../shared/h3-duration-policy";
import { inspectPhysicalPlan, inspectPhysicalVerification } from "../shared/physical-plan";
import { inspectShootingScriptPreflight } from "../shared/shooting-script-preflight";
import { H3_EXECUTION_POLICY_VERSION, inspectH3PromptExecutability } from "../shared/h3-executability";
import {
  GENERATION_READINESS_POLICY_VERSION,
  inspectOutlineFeasibility,
  inspectScreenplayFeasibility,
  type NarrativeFeasibilityReport,
} from "../shared/generation-readiness";
import {
  assertTransition,
  downstreamStages,
  initialStageBySourceType,
  nextStage,
  stageOrder,
} from "../workflow/state-machine";
import { ProviderSkillRegistry } from "../skills/provider-skill-registry";

const PROJECT_DIRECTORIES = [
  "source", "outline", "screenplay", "assets/characters", "assets/scenes", "assets/props",
  "assets/costumes", "assets/styles", "assets/audio", "assets/references", "shooting-script",
  "storyboard", "prompts", "handoff/updream/bootstrap", "handoff/updream/shots", "generated/inbox",
  "audio", "edit", "qa", "deliverables", "logs",
];

const reviewStageByType: Record<ArtifactType, ProjectStage> = {
  outline: "OUTLINE_REVIEW",
  screenplay: "SCREENPLAY_REVIEW",
  "asset-bible": "ASSET_BIBLE_REVIEW",
  "shooting-script": "SHOOTING_SCRIPT_REVIEW",
  storyboard: "STORYBOARD_REVIEW",
};

export function bindHandoffPackageToCurrentShot(summary: HandoffPackageSummary, shot: ShotSpec): HandoffPackageSummary {
  return bindHandoffPackageToShot(summary, shot);
}

function mergePhysicalContinuityReport(
  shootingScript: ShootingScript,
  storyboard: Storyboard,
  report: ContinuityReport,
): ContinuityReport {
  const issues = [...report.issues];
  const existing = new Set(issues.map((issue) => `${issue.code}|${issue.affectedIds.join("|")}`));
  for (const shot of shootingScript.shots) {
    if (!shot.physicalPlan) continue;
    const board = storyboard.shots.find((item) => item.shotId === shot.id);
    const problems = [
      ...inspectPhysicalPlan(shot.physicalPlan, shot.durationSec, shot.characterIds, shot.propIds),
      ...inspectPhysicalVerification(shot.physicalPlan, board?.physicalVerification),
    ];
    for (const problem of problems) {
      const key = `${problem.code}|${shot.id}`;
      if (existing.has(key)) continue;
      existing.add(key);
      issues.push({
        severity: problem.severity,
        code: problem.code,
        message: `${shot.id}：${problem.message}`,
        affectedIds: [shot.id],
        suggestedFix: "返回导演脚本或分镜，按 physicalPlan 修正机位、朝向、实体拓扑或事件门后重新审批；不要只改最终 H3 提示词。",
        requiresReapproval: true,
      });
    }
  }
  return continuityReportSchema.parse({
    ...report,
    issues,
    passed: !issues.some((issue) => issue.severity === "error"),
  });
}

function mergeModelExecutionContinuityReport(
  shootingScript: ShootingScript,
  report: ContinuityReport,
): ContinuityReport {
  const issues = [...report.issues];
  const existing = new Set(issues.map((issue) => `${issue.code}|${issue.affectedIds.join("|")}`));
  for (const issue of inspectShootingScriptPreflight(shootingScript.shots)) {
    const key = `${issue.code}|${issue.affectedIds.join("|")}`;
    if (existing.has(key)) continue;
    existing.add(key);
    issues.push({
      severity: "error",
      code: issue.code,
      message: issue.message,
      affectedIds: issue.affectedIds,
      suggestedFix: issue.suggestedFix,
      requiresReapproval: true,
    });
  }
  return continuityReportSchema.parse({
    ...report,
    issues,
    passed: !issues.some((issue) => issue.severity === "error"),
  });
}

export class ArtifactVersionConflictError extends Error {
  constructor() {
    super("当前版本已被另一个标签页更新。为避免覆盖较新内容，请刷新后对比并重新编辑");
    this.name = "ArtifactVersionConflictError";
  }
}

const artifactTypeByReviewStage: Partial<Record<ProjectStage, ArtifactType>> = Object.fromEntries(
  Object.entries(reviewStageByType).map(([type, stage]) => [stage, type]),
) as Partial<Record<ProjectStage, ArtifactType>>;

const artifactDirectoryByType: Record<ArtifactType, string> = {
  outline: "outline",
  screenplay: "screenplay",
  "asset-bible": "assets",
  "shooting-script": "shooting-script",
  storyboard: "storyboard",
};

const dependentArtifactTypes: Record<ArtifactType, ArtifactType[]> = {
  outline: ["screenplay", "asset-bible", "shooting-script", "storyboard"],
  screenplay: ["asset-bible", "shooting-script", "storyboard"],
  "asset-bible": ["shooting-script", "storyboard"],
  "shooting-script": ["storyboard"],
  storyboard: [],
};

const assetFolderByType: Record<Asset["type"], string> = {
  character: "characters",
  scene: "scenes",
  prop: "props",
  costume: "costumes",
  style: "styles",
  audio: "audio",
  reference: "references",
};

const assetReferenceMimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const visualAssetTypes = new Set<Asset["type"]>(["character", "scene", "prop", "costume", "style", "reference"]);
const aspectConstrainedAssetTypes = new Set<Asset["type"]>(["scene", "style"]);
const unresolvedVisualPattern = /(尚未确定|未确定|待定|未描述|具体[^，。；]*未知|需要补充|等待参考)/;
const aspectRatioPattern = /\b\d{1,3}\s*[:：]\s*\d{1,3}\b/g;
const continuityRepairContextSchema = z.object({
  schemaVersion: z.literal("continuity-targeted-repair-v1"),
  sourceStoryboardArtifactId: z.string().min(1),
  issueCodes: z.array(z.string().min(1)).min(1),
  createdAt: z.string().min(1),
});

type ContinuityRepairContext = z.infer<typeof continuityRepairContextSchema>;
export type ContinuityIssue = ContinuityReport["issues"][number];

export const MIRROR_PARITY_CONTINUITY_RULE = "镜面奇偶规则：现实人物与镜中复制体保持解剖侧完全一致；经过金属镜面时采用正常的屏幕左右反转，左眉痣、右侧外翘发尾及左肩至右髋包带始终按解剖侧锁定，不得发生镜像错位。";

export interface ContinuityRepairResult {
  project: Project;
  artifact: ArtifactWithContent;
  repair: {
    fixedIssueCodes: string[];
    remainingIssueCodes: string[];
    nextTarget: "asset-bible" | "shooting-script" | "storyboard";
  };
}

export interface AutoContinuityRepairResult {
  project: Project;
  artifact: ArtifactWithContent;
  autoRepair: {
    passed: boolean;
    attempts: number;
    maxAttempts: number;
    fixedIssueCodes: string[];
    remainingIssueCodes: string[];
    intermediateArtifactIds: string[];
    blockedReason: string | null;
    finalHumanApprovalRequired: true;
  };
}

function normalizeAspectRatio(value: string): string {
  return value.replace(/\s+/g, "").replace("：", ":");
}

export function extractAspectRatios(value: string): string[] {
  return [...new Set([...value.matchAll(aspectRatioPattern)]
    .filter((match) => !isNegatedDescription(value, match.index) && isFramingDescription(value, match.index, match[0]))
    .map((match) => normalizeAspectRatio(match[0])))];
}

function descriptionClause(value: string, index: number, matchedLength: number): string {
  const before = value.slice(0, index);
  const clauseStart = Math.max(
    before.lastIndexOf("，"), before.lastIndexOf("。"), before.lastIndexOf("；"), before.lastIndexOf(";"), before.lastIndexOf("\n"),
  ) + 1;
  const after = value.slice(index + matchedLength);
  const nextDelimiters = ["，", "。", "；", ";", "\n"]
    .map((delimiter) => after.indexOf(delimiter))
    .filter((position) => position >= 0);
  const clauseEnd = nextDelimiters.length ? index + matchedLength + Math.min(...nextDelimiters) : value.length;
  return value.slice(clauseStart, clauseEnd);
}

function isFramingDescription(value: string, index: number, matched: string): boolean {
  const clause = descriptionClause(value, index, matched.length);
  if (clause.trim() === matched.trim()) return true;
  const before = value.slice(0, index);
  const clauseStart = Math.max(
    before.lastIndexOf("，"),
    before.lastIndexOf("。"),
    before.lastIndexOf("；"),
    before.lastIndexOf(";"),
    before.lastIndexOf("\n"),
  ) + 1;
  const beforeMatched = value.slice(Math.max(clauseStart, index - 24), index);
  const afterMatched = value.slice(index + matched.length, index + matched.length + 18);
  const objectBefore = /(?:手机|显示器|电视|屏幕|海报|照片|画作|招牌|终端|设备|窗口|面板)(?:的)?(?:宽高比|画面比例|比例)(?:为)?\s*$/.test(beforeMatched)
    || /(?:手机|显示器|电视|屏幕|海报|照片|画作|招牌|终端|设备|窗口|面板)(?:的)?(?:宽高比|画面比例|比例|为)?\s*\d{1,3}\s*[:：]\s*\d{1,3}\s*$/.test(beforeMatched);
  const objectDisplay = objectBefore || (/[:：]/.test(matched)
    ? /^\s*(?:横屏|竖屏|横幅|竖幅)?\s*(?:手机|显示器|电视|屏幕|海报|照片|画作|招牌|终端|设备|窗口|面板)/.test(afterMatched)
    : /^\s*(?:手机|显示器|电视|屏幕|海报|照片|画作|招牌|终端|设备|窗口|面板)/.test(afterMatched));
  if (objectDisplay) return false;
  if (/(?:画幅|构图|取景|版式|画面比例|宽高比|横版|竖版|全片|成片|输出画面|项目画面|镜头画面|视频画面|最终画面)/.test(clause)) return true;
  if (/(?:最终|项目|全片|成片|输出|镜头|视频).{0,12}(?:采用|使用|保持|设为|改为)/.test(clause)) return true;
  if (/[:：]/.test(matched)) return /(?:横幅|竖幅|横屏|竖屏|横向画面|纵向画面)/.test(clause);
  return /\d{1,3}\s*[:：]\s*\d{1,3}/.test(clause)
    || /(?:采用|保持|改为|设为|使用)\s*(?:横幅|竖幅|横屏|竖屏|横向|纵向)/.test(clause)
    || clause.trimStart().startsWith(matched);
}

function isNegatedDescription(value: string, index = value.length): boolean {
  const clause = value.slice(0, index).split(/[，。；;！？!?\n]/).at(-1) ?? "";
  const negations = [...clause.matchAll(/(?:不得|不可|禁止|避免|不要|严禁|拒绝|防止|不应|不能|并非|并不是|不是|不(?=\s*(?:采用|使用|设为|裁成|裁切为|改为))|无[需须](?=\s*(?:采用|使用|设为|裁成|裁切为|改为))|勿(?=\s*(?:用|采用|使用|设为|裁成|裁切为|改为|横|竖|\d))|非(?=\s*(?:\d{1,3}\s*[:：]|横幅|竖幅|横屏|竖屏|横向|纵向)))/g)];
  if (!negations.length) return false;
  const positivePivots = [...clause.matchAll(/而是|而应为|但应为|而(?:采用|改用|使用|设为|改为)|必须(?:采用|为|改为)|应改为|(?:但|不过|却|并|同时)(?:最终)?(?:采用|改为|设置为|保持为|将画幅设为|将构图设为)|(?:正确|目标|最终)(?:画幅|构图)?(?:应为|为|采用)/g)];
  const lastNegation = negations.at(-1)?.index ?? -1;
  const lastPositivePivot = positivePivots.at(-1)?.index ?? -1;
  return lastNegation > lastPositivePivot;
}

function replaceFramingDescriptions(value: string, pattern: RegExp, replacement: string): string {
  return value.replace(pattern, (matched: string, offset: number) =>
    isNegatedDescription(value, offset) || !isFramingDescription(value, offset, matched) ? matched : replacement);
}

export function repairAspectText(value: string, aspectRatio: string): string {
  let repaired = value.replace(aspectRatioPattern, (matched: string, offset: number) =>
    isNegatedDescription(value, offset) || !isFramingDescription(value, offset, matched) ? matched : aspectRatio);
  const [width, height] = aspectRatio.split(":").map(Number);
  if (Number.isFinite(width) && Number.isFinite(height) && width > height) {
    repaired = replaceFramingDescriptions(repaired, /竖幅/g, "横幅");
    repaired = replaceFramingDescriptions(repaired, /竖屏/g, "横屏");
    repaired = replaceFramingDescriptions(repaired, /纵向(?=(?:画面|构图|取景|版式))/g, "横向");
  } else if (Number.isFinite(width) && Number.isFinite(height) && width < height) {
    repaired = replaceFramingDescriptions(repaired, /横幅/g, "竖幅");
    repaired = replaceFramingDescriptions(repaired, /横屏/g, "竖屏");
    repaired = replaceFramingDescriptions(repaired, /横向(?=(?:画面|构图|取景|版式))/g, "纵向");
  } else if (Number.isFinite(width) && width === height) {
    repaired = replaceFramingDescriptions(repaired, /(?:横幅|竖幅)/g, "方形画幅");
    repaired = replaceFramingDescriptions(repaired, /(?:横屏|竖屏)/g, "方形画面");
    repaired = replaceFramingDescriptions(repaired, /(?:横向|纵向)(?=(?:画面|构图|取景|版式))/g, "方形");
  }
  return repaired;
}

export function conflictingOrientationTerms(value: string, aspectRatio: string): string[] {
  const [width, height] = aspectRatio.split(":").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return [];
  const pattern = width > height
    ? /竖幅|竖屏|纵向(?=(?:画面|构图|取景|版式))/g
    : width < height
      ? /横幅|横屏|横向(?=(?:画面|构图|取景|版式))/g
      : /横幅|竖幅|横屏|竖屏|(?:横向|纵向)(?=(?:画面|构图|取景|版式))/g;
  return [...new Set([...value.matchAll(pattern)]
    .filter((match) => !isNegatedDescription(value, match.index) && isFramingDescription(value, match.index, match[0]))
    .map((match) => match[0]))];
}

export function referenceCompatibilityKey(asset: Pick<Asset, "type" | "name" | "identity" | "appearance" | "designSummary" | "distinctiveFeatures">): string {
  const framingTokenPattern = /\b\d{1,3}\s*[:：]\s*\d{1,3}\b|横幅|竖幅|横屏|竖屏|横向(?=(?:画面|构图|取景|版式))|纵向(?=(?:画面|构图|取景|版式))/g;
  const withoutFraming = (value: string) => {
    const normalized = aspectConstrainedAssetTypes.has(asset.type)
      ? value.replace(framingTokenPattern, (matched: string, offset: number) => {
        return isFramingDescription(value, offset, matched) ? "" : matched;
      })
      : value;
    return normalized.replace(/\s+/g, "").trim();
  };
  return JSON.stringify({
    type: asset.type,
    name: withoutFraming(asset.name),
    identity: withoutFraming(asset.identity),
    appearance: withoutFraming(asset.appearance),
    designSummary: withoutFraming(asset.designSummary),
    distinctiveFeatures: asset.distinctiveFeatures.map(withoutFraming),
  });
}

function timingRangeFromIssue(issue: ContinuityIssue): { startSec: number; endSec: number } | null {
  const match = issue.message.match(/(\d+(?:\.\d+)?)\s*[—–-]\s*(\d+(?:\.\d+)?)\s*秒/);
  if (!match) return null;
  const startSec = Number(match[1]);
  const endSec = Number(match[2]);
  return Number.isFinite(startSec) && Number.isFinite(endSec) ? { startSec, endSec } : null;
}

function repairTimingText(value: string, issue: ContinuityIssue, targetEndSec: number): string {
  const range = timingRangeFromIssue(issue);
  if (!range) return value;
  const escape = (input: number) => String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escape(range.startSec)}\\s*[—–-]\\s*${escape(range.endSec)}\\s*秒`, "g");
  return value.replace(pattern, `${range.startSec}—${targetEndSec.toFixed(1)}秒`);
}

function timingTargetEndFromIssue(issue: ContinuityIssue): number | null {
  const suggested = issue.suggestedFix.match(/(?:持续至|延续至|直到|至)\s*(\d+(?:\.\d+)?)\s*秒/);
  if (suggested) return Number(suggested[1]);
  const mentioned = [...issue.message.matchAll(/(\d+(?:\.\d+)?)\s*秒/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  return mentioned.length ? Math.max(...mentioned) : null;
}

function issueTimes(issue: ContinuityIssue): number[] {
  return [...`${issue.message} ${issue.suggestedFix}`.matchAll(/(\d+(?:\.\d+)?)\s*秒/g)]
    .map((match) => Number(match[1]))
    .filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);
}

function timePattern(value: number): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function repairCausalRevealText(value: string, issue: ContinuityIssue): string {
  const [partialRevealSec, clearRevealSec] = issueTimes(issue);
  if (partialRevealSec == null || clearRevealSec == null) return appendUniqueText(value, `物理显露关系修复：${issue.suggestedFix}`);
  let repaired = value;
  const partialPattern = new RegExp(`(${timePattern(partialRevealSec)}\\s*秒[^；。]*(?:打开|分离)[^；。]*)(?=[；。]|$)`, "u");
  repaired = repaired.replace(partialPattern, (matched) => /部分(?:显露|露出)|逐渐(?:显露|暴露)/u.test(matched)
    ? matched
    : `${matched}，门缝形成时直连空间同步首次部分显露`);
  const clearPattern = new RegExp(`${timePattern(clearRevealSec)}\\s*秒[^；。]*(?:首次显露|首次露出)[^；。]*`, "u");
  repaired = repaired.replace(clearPattern, `${clearRevealSec}秒门缝扩大，群体首次清晰可辨`);
  repaired = repaired.replace(/[^；。]*(?:无法保证|不能保证)[^；。]*(?:[；。]|$)/gu, "");
  return appendUniqueText(repaired, `物理显露关系锁定：${partialRevealSec}秒首次部分显露，${clearRevealSec}秒主体首次清晰可辨`);
}

export function repairPropHandoffText(value: string, issue: ContinuityIssue): string {
  const repaired = value.replace(/低位(?:持握|握持|持机)?/gu, "承接上一镜结束时的胸口阅读高度持握");
  return appendUniqueText(repaired, `道具边界锁定：${issue.suggestedFix}`);
}

export function repairSoundTimingText(value: string, issue: ContinuityIssue): string {
  const targetMatch = issue.suggestedFix.match(/(?:起点|开始时间|开始时刻|时间码)(?:改为|调整为|设为)?\s*(\d+(?:\.\d+)?)\s*秒/);
  if (!targetMatch) return value;
  const targetValue = Number(targetMatch[1]);
  const sourceCandidates = [...issue.message.matchAll(/(\d+(?:\.\d+)?)\s*秒/g)]
    .map((match) => Number(match[1]))
    .filter((candidate) => Number.isFinite(candidate) && Math.abs(candidate - targetValue) > 0.0001);
  const sourceValue = sourceCandidates.at(-1);
  if (sourceValue == null) return value;
  const [integer, decimal] = String(sourceValue).split(".");
  const sourcePattern = decimal
    ? `${integer}\\.${decimal}0*`
    : `${integer}(?:\\.0+)?`;
  return value.replace(new RegExp(`${sourcePattern}\\s*秒`, "g"), `${targetMatch[1]}秒`);
}

function appendUniqueText(value: string, addition: string): string {
  return value.includes(addition) ? value : `${value.replace(/[；。\s]+$/u, "")}；${addition}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function assertContinuityRepairActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("结构化修复作业已取消，未写入新版本");
}

function createApprovedAssetBibleLock(artifact: Artifact): ApprovedAssetBibleLock {
  const reference = `asset-bible-v${String(artifact.version).padStart(3, "0")}:${artifact.contentHash}`;
  return {
    artifactId: artifact.id,
    version: artifact.version,
    contentHash: artifact.contentHash,
    reference,
    appliesTo: ["approvedShootingScript", "storyboardUnderReview"],
  };
}

export function repairStoryboardContinuityIssues(
  current: Storyboard,
  issues: ContinuityIssue[],
  aspectRatio: string,
  approvedAssetBibleRef?: string,
  approvedShootingScript?: ShootingScript,
): { storyboard: Storyboard; changedShotIds: string[]; fixedIssueCodes: string[] } {
  const actionable = issues.filter((issue) => issue.severity !== "info" && continuityRepairKind(issue.code));
  const timingIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "shooting-timing");
  const aspectIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "asset-aspect");
  const sceneReferenceIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "storyboard-scene-reference");
  const boundaryIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "storyboard-boundary-state");
  const mirrorIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "asset-mirror-parity");
  const orientationIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "shooting-orientation-state");
  const causalVisibilityIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "shooting-causal-visibility");
  const propHandoffIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "shooting-prop-handoff");
  const physicalVerificationIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "storyboard-physical-verification");
  const versionLockIssues = actionable.filter((issue) => continuityRepairKind(issue.code) === "asset-version-lock");
  if (versionLockIssues.length && !approvedAssetBibleRef) throw new Error("资产版本锁定修复缺少已批准 Asset Bible 的版本与哈希");
  const shotIndexById = new Map(current.shots.map((shot, index) => [shot.shotId, index]));
  const previousByShotId = new Map(current.shots.map((shot, index) => [shot.shotId, index > 0 ? current.shots[index - 1] : null]));
  const changedShotIds = new Set<string>();

  const shots = current.shots.map((board) => {
    let startFrame = repairAspectText(board.startFrame, aspectRatio);
    let endFrame = repairAspectText(board.endFrame, aspectRatio);
    let composition = repairAspectText(board.composition, aspectRatio);
    let motionPlan = repairAspectText(board.motionPlan, aspectRatio);
    let requiredAssetIds = [...board.requiredAssetIds];
    let continuityRisks = [...board.continuityRisks];
    let physicalVerification = board.physicalVerification;

    for (const issue of timingIssues.filter((candidate) => candidate.affectedIds.includes(board.shotId))) {
      const targetEndSec = timingTargetEndFromIssue(issue);
      if (targetEndSec == null) throw new Error(`${issue.code} 缺少可执行的目标结束时间`);
      const updated = repairTimingText(motionPlan, issue, targetEndSec);
      if (updated === motionPlan) throw new Error(`${issue.code} 指向 ${board.shotId}，但分镜运动计划中没有可安全替换的时间段`);
      motionPlan = updated;
    }

    for (const issue of sceneReferenceIssues.filter((candidate) => candidate.affectedIds.includes(board.shotId))) {
      const additionalSceneIds = issue.affectedIds.filter((id) => /^SCENE-\d{3}$/.test(id) && id !== board.sceneId);
      if (!additionalSceneIds.length) throw new Error(`${issue.code} 没有指出可追加的近端场景资产`);
      requiredAssetIds = uniqueStrings([...requiredAssetIds, ...additionalSceneIds]);
      composition = appendUniqueText(composition, `场景承接锁定：${issue.suggestedFix}`);
    }

    for (const issue of boundaryIssues.filter((candidate) => candidate.affectedIds.includes(board.shotId))) {
      const previous = previousByShotId.get(board.shotId);
      if (previous && issue.affectedIds.includes(previous.shotId)) {
        startFrame = `${previous.endFrame.replace(/[；。\s]+$/u, "")}；边界状态锁定：${issue.suggestedFix}`;
      }
    }

    for (const issue of orientationIssues.filter((candidate) => candidate.affectedIds.includes(board.shotId))) {
      const affectedShotIds = issue.affectedIds
        .filter((id) => shotIndexById.has(id))
        .sort((left, right) => (shotIndexById.get(left) ?? 0) - (shotIndexById.get(right) ?? 0));
      if (affectedShotIds[0] === board.shotId) {
        endFrame = appendUniqueText(endFrame, `人物朝向边界锁定：${issue.suggestedFix}`);
      } else {
        startFrame = appendUniqueText(startFrame, `人物朝向边界锁定：${issue.suggestedFix}`);
      }
    }

    for (const issue of causalVisibilityIssues.filter((candidate) => candidate.affectedIds.includes(board.shotId))) {
      startFrame = repairCausalRevealText(startFrame, issue);
      motionPlan = repairCausalRevealText(motionPlan, issue);
      continuityRisks = continuityRisks.map((risk) => /(?:无法保证|不能保证|门禁.*冲突|物理冲突)/u.test(risk)
        ? `已按物理因果修复：${issue.suggestedFix}`
        : risk);
    }

    for (const issue of propHandoffIssues.filter((candidate) => candidate.affectedIds.includes(board.shotId))) {
      const combined = `${startFrame}；${motionPlan}；${composition}`;
      if (/低位(?:持握|握持|持机)?/u.test(combined)) {
        startFrame = repairPropHandoffText(startFrame, issue);
        motionPlan = repairPropHandoffText(motionPlan, issue);
        composition = repairPropHandoffText(composition, issue);
      }
    }

    for (const issue of physicalVerificationIssues.filter((candidate) => candidate.affectedIds.includes(board.shotId))) {
      const shotSpec = approvedShootingScript?.shots.find((shot) => shot.id === board.shotId);
      if (!shotSpec?.physicalPlan || !physicalVerification) continue;
      const planErrors = inspectPhysicalPlan(shotSpec.physicalPlan, shotSpec.durationSec, shotSpec.characterIds, shotSpec.propIds)
        .filter((problem) => problem.severity === "error");
      const dimension = issue.code.match(/^PHYSICAL_(.+)_STORYBOARD_FAILED$/)?.[1] ?? "";
      if (dimension.includes("TIMED_GATE") && !planErrors.some((problem) => problem.code.includes("TIMED_GATE"))) {
        physicalVerification = { ...physicalVerification, timedStateGates: "pass", notes: uniqueStrings([...physicalVerification.notes, `定点修复后重新核验：${issue.suggestedFix}`]) };
      } else if (dimension.includes("DISPLAY") && !planErrors.some((problem) => problem.code.includes("DISPLAY"))) {
        physicalVerification = { ...physicalVerification, displayGeometry: "pass", notes: uniqueStrings([...physicalVerification.notes, `定点修复后重新核验：${issue.suggestedFix}`]) };
      } else if (dimension.includes("REFLECTION") && !planErrors.some((problem) => problem.code.includes("REFLECTION"))) {
        physicalVerification = { ...physicalVerification, reflectionTopology: "pass", notes: uniqueStrings([...physicalVerification.notes, `定点修复后重新核验：${issue.suggestedFix}`]) };
      } else if (dimension.includes("CAMERA") && !planErrors.some((problem) => problem.code.includes("CAMERA"))) {
        physicalVerification = { ...physicalVerification, cameraBlocking: "pass", notes: uniqueStrings([...physicalVerification.notes, `定点修复后重新核验：${issue.suggestedFix}`]) };
      }
    }

    if (mirrorIssues.some((issue) => issue.affectedIds.includes(board.shotId))) {
      composition = appendUniqueText(composition, MIRROR_PARITY_CONTINUITY_RULE);
    }

    const repaired = { ...board, startFrame, endFrame, composition, motionPlan, requiredAssetIds, continuityRisks, physicalVerification };
    if (JSON.stringify(repaired) !== JSON.stringify(board)) changedShotIds.add(board.shotId);
    return repaired;
  });

  const repairNotes = [
    ...sceneReferenceIssues.map((issue) => `场景资产定点修复（${issue.code}）：${issue.suggestedFix}`),
    ...boundaryIssues.map((issue) => `边界状态定点修复（${issue.code}）：${issue.suggestedFix}`),
    ...orientationIssues.map((issue) => `人物朝向定点修复（${issue.code}）：${issue.suggestedFix}`),
    ...causalVisibilityIssues.map((issue) => `物理显露定点修复（${issue.code}）：${issue.suggestedFix}`),
    ...propHandoffIssues.map((issue) => `道具边界定点修复（${issue.code}）：${issue.suggestedFix}`),
    ...physicalVerificationIssues.map((issue) => `物理核验重算（${issue.code}）：${issue.suggestedFix}`),
    ...(versionLockIssues.length ? [`资产版本锁定：${approvedAssetBibleRef}；该批准版本同时绑定导演脚本与当前分镜。`] : []),
    ...(mirrorIssues.length ? [MIRROR_PARITY_CONTINUITY_RULE] : []),
    ...(aspectIssues.length ? [`项目画幅与相关风格资产已统一为 ${aspectRatio}，构图与机位以该硬参数为唯一标准。`] : []),
  ];
  const globalContinuityNotes = uniqueStrings([
    ...repairNotes,
    ...current.globalContinuityNotes
      .filter((note) => !aspectIssues.some((issue) => issue.affectedIds.some((id) => note.includes(id)) && /冲突|不一致|确认/.test(note)))
      .map((note) => repairAspectText(note, aspectRatio)),
  ]);

  return {
    storyboard: storyboardSchema.parse({ ...current, shots, globalContinuityNotes }),
    changedShotIds: [...changedShotIds],
    fixedIssueCodes: uniqueStrings(actionable.map((issue) => issue.code)),
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function mapProjectRow(row: typeof projects.$inferSelect): Project {
  return projectSchema.parse({ ...row, archivedAt: row.archivedAt ?? null, sourceType: row.sourceType, currentStage: row.currentStage, staleStages: row.staleStages });
}

function mapArtifactRow(row: typeof artifacts.$inferSelect): Artifact {
  return artifactSchema.parse({ ...row, structuredPath: row.structuredPath ?? null, sourceArtifactId: row.sourceArtifactId ?? null });
}

function generationMetadata(trace: TextGenerationTrace, relatedTraces: TextGenerationTrace[] = []): Record<string, unknown> {
  const allSkills = [trace, ...relatedTraces].flatMap((item) => item.skills);
  const skills = [...new Map(allSkills.map((skill) => [`${skill.name}:${skill.sha256}`, skill])).values()];
  return {
    origin: trace.provider,
    schema: trace.schemaVersion,
    route: trace.route,
    skills,
    providerRun: {
      model: trace.model ?? null,
      runId: trace.runId,
      threadId: trace.threadId,
      usage: trace.usage,
      durationMs: trace.durationMs ?? null,
      eventTypes: trace.eventTypes,
      completedAt: trace.completedAt,
    },
    relatedRuns: relatedTraces.map((item) => ({
      runId: item.runId,
      threadId: item.threadId,
      usage: item.usage,
      eventTypes: item.eventTypes,
      schema: item.schemaVersion,
      route: item.route,
      completedAt: item.completedAt,
    })),
  };
}

export interface ArtifactWithContent extends Artifact {
  content: string;
}

export type StoryboardGenerationPhase = "storyboard" | "continuity" | "auto-repair";

export interface StoryboardContinuityReviewSummary {
  status: "completed" | "failed";
  message: string | null;
}

export class ProjectService {
  private readonly providerSkills: ProviderSkillRegistry;
  private readonly updreamPackages: UpdreamPackageBuilder;

  constructor(
    private readonly studio: StudioDatabase,
    private readonly textProvider: TextIntelligenceProvider,
    private readonly imageProvider: ImageGenerationProvider = new DisabledImageGenerationProvider(),
    fileClipboard: FileClipboard = new WindowsFileClipboard(),
  ) {
    this.providerSkills = new ProviderSkillRegistry(studio.runtimeRoot);
    this.updreamPackages = new UpdreamPackageBuilder(fileClipboard);
  }

  async reviseTargetDuration(id: string, targetDurationSec: number, restartNarrative = false): Promise<Project> {
    const project = await this.requireProject(id);
    const parsedDuration = z.number().int().min(5).max(21_600).parse(targetDurationSec);
    if (parsedDuration === project.targetDurationSec && !restartNarrative) return project;
    const updatedAt = new Date().toISOString();
    const staleStages = stageOrder.filter((stage) => stage !== "SOURCE_IMPORTED");
    this.studio.db.transaction((transaction) => {
      transaction.update(projects).set({
        targetDurationSec: parsedDuration,
        currentStage: "SOURCE_IMPORTED",
        staleStages,
        updatedAt,
      }).where(eq(projects.id, project.id)).run();
      transaction.update(artifacts).set({ status: "stale", updatedAt }).where(eq(artifacts.projectId, project.id)).run();
      transaction.update(shots).set({ status: "stale" }).where(eq(shots.projectId, project.id)).run();
      transaction.update(assetRecords).set({ approved: false }).where(eq(assetRecords.projectId, project.id)).run();
    });
    const updated = projectSchema.parse({
      ...project,
      targetDurationSec: parsedDuration,
      currentStage: "SOURCE_IMPORTED",
      staleStages,
      updatedAt,
    });
    await this.writeProjectManifest(updated);
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: "project.target-duration.revised",
      projectId: project.id,
      fromDurationSec: project.targetDurationSec,
      toDurationSec: parsedDuration,
      fromStage: project.currentStage,
      toStage: "SOURCE_IMPORTED",
      restartNarrative,
      preservedHistory: true,
      createdAt: updatedAt,
    });
    return updated;
  }

  async list(): Promise<Project[]> {
    const rows = await this.studio.db.select().from(projects).where(isNull(projects.archivedAt)).orderBy(desc(projects.updatedAt));
    return rows.map(mapProjectRow);
  }

  async listArchived(): Promise<Project[]> {
    const rows = await this.studio.db.select().from(projects).where(isNotNull(projects.archivedAt)).orderBy(desc(projects.archivedAt));
    return rows.map(mapProjectRow);
  }

  async get(id: string): Promise<Project | null> {
    const [row] = await this.studio.db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.archivedAt))).limit(1);
    return row ? mapProjectRow(row) : null;
  }

  async archive(id: string): Promise<Project> {
    const [row] = await this.studio.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!row || row.archivedAt) throw new Error("项目不存在");
    const project = mapProjectRow(row);
    await fs.access(project.projectDir);
    const archivedAt = new Date().toISOString();
    const archived = projectSchema.parse({ ...project, archivedAt, updatedAt: archivedAt });
    await this.writeProjectManifest(archived);
    await this.appendLog(project.projectDir, "app.log.jsonl", { type: "project.archived", projectId: id, archivedAt });
    await this.studio.db.update(projects).set({ archivedAt, updatedAt: archivedAt }).where(and(eq(projects.id, id), isNull(projects.archivedAt)));
    return archived;
  }

  async restore(id: string): Promise<Project> {
    const [row] = await this.studio.db.select().from(projects).where(and(eq(projects.id, id), isNotNull(projects.archivedAt))).limit(1);
    if (!row) throw new Error("归档项目不存在");
    const project = mapProjectRow(row);
    await fs.access(project.projectDir);
    const restoredAt = new Date().toISOString();
    const restored = projectSchema.parse({ ...project, archivedAt: null, updatedAt: restoredAt });
    await this.writeProjectManifest(restored);
    await this.appendLog(project.projectDir, "app.log.jsonl", { type: "project.restored", projectId: id, restoredAt });
    await this.studio.db.update(projects).set({ archivedAt: null, updatedAt: restoredAt }).where(and(eq(projects.id, id), isNotNull(projects.archivedAt)));
    return restored;
  }

  async readSource(id: string): Promise<{ sourceText: string; sourcePath: string }> {
    const project = await this.requireProject(id);
    return { sourceText: await fs.readFile(project.sourcePath, "utf8"), sourcePath: project.sourcePath };
  }

  async create(rawInput: CreateProjectInput): Promise<Project> {
    const input = createProjectInputSchema.parse(rawInput);
    const id = randomUUID();
    const now = new Date().toISOString();
    const projectDir = path.join(this.studio.projectsRoot, id);
    if (!isInside(this.studio.projectsRoot, projectDir)) throw new Error("项目路径越界");

    await fs.mkdir(projectDir, { recursive: false });
    try {
      await Promise.all(PROJECT_DIRECTORIES.map((directory) => fs.mkdir(path.join(projectDir, directory), { recursive: true })));
      const sourcePath = path.join(projectDir, "source", "original-v001.txt");
      await fs.writeFile(sourcePath, input.sourceText, { encoding: "utf8", flag: "wx" });
      const project = projectSchema.parse({
        id,
        title: input.title,
        sourceType: input.sourceType,
        targetDurationSec: input.targetDurationSec,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        videoType: input.videoType ?? null,
        visualStyle: input.visualStyle ?? null,
        releasePlatform: input.releasePlatform ?? null,
        targetAudience: input.targetAudience ?? null,
        allowStorySuggestions: input.allowStorySuggestions,
        currentStage: initialStageBySourceType[input.sourceType],
        staleStages: [],
        sourcePath,
        projectDir,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await this.studio.db.insert(projects).values(project);
      await this.writeProjectManifest(project);
      await this.appendLog(projectDir, "app.log.jsonl", { type: "project.created", projectId: id, sourceType: project.sourceType, createdAt: now });

      if (input.sourceType === "screenplay") {
        return (await this.createArtifactVersion(id, "screenplay", input.sourceText, { metadata: { origin: "imported-source" } })).project;
      }
      return project;
    } catch (error) {
      try {
        await this.studio.db.delete(approvals).where(eq(approvals.projectId, id));
        await this.studio.db.delete(artifacts).where(eq(artifacts.projectId, id));
        await this.studio.db.delete(assetRecords).where(eq(assetRecords.projectId, id));
        await this.studio.db.delete(shots).where(eq(shots.projectId, id));
        await this.studio.db.delete(projects).where(eq(projects.id, id));
      } catch {
        // Preserve the original creation failure; startup integrity checks can report any cleanup failure.
      }
      await fs.rm(projectDir, { recursive: true, force: true });
      throw error;
    }
  }

  async listArtifacts(projectId: string, type: ArtifactType): Promise<ArtifactWithContent[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type)))
      .orderBy(desc(artifacts.version));
    return Promise.all(rows.map(async (row) => ({ ...mapArtifactRow(row), content: await fs.readFile(row.filePath, "utf8") })));
  }

  async readContinuityReport(projectId: string, artifactId: string): Promise<ContinuityReport> {
    const project = await this.requireProject(projectId);
    const [row] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
    if (!row || row.projectId !== project.id || row.type !== "storyboard") throw new Error("分镜版本不存在");
    const artifact = mapArtifactRow(row);
    const reportPath = artifact.metadata.continuityReportStructuredPath;
    if (typeof reportPath !== "string" || !reportPath.trim()) throw new Error("该分镜版本没有结构化连续性报告");
    if (!isInside(project.projectDir, reportPath)) throw new Error("连续性报告路径越界");
    const reportContent = await fs.readFile(reportPath, "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error("结构化连续性报告文件不存在，当前分镜不能作为有效审批版本");
        throw error;
      });
    const storedReport = continuityReportSchema.parse(JSON.parse(reportContent));
    const [sourceShootingRow] = row.sourceArtifactId
      ? await this.studio.db.select().from(artifacts).where(eq(artifacts.id, row.sourceArtifactId)).limit(1)
      : [];
    const sourceShootingScript = sourceShootingRow?.projectId === projectId && sourceShootingRow.type === "shooting-script"
      ? mapArtifactRow(sourceShootingRow)
      : null;
    const shootingScriptArtifact = sourceShootingScript?.structuredPath
      ? sourceShootingScript
      : await this.approvedHeadArtifact(projectId, "shooting-script") ?? await this.latestApprovedArtifact(projectId, "shooting-script");
    if (!shootingScriptArtifact?.structuredPath) return storedReport;
    const shootingScript = shootingScriptSchema.parse(JSON.parse(await fs.readFile(shootingScriptArtifact.structuredPath, "utf8")));
    return mergeModelExecutionContinuityReport(shootingScript, storedReport);
  }

  async planContinuityRepair(projectId: string, storyboardArtifactId: string): Promise<ContinuityRepairPlan> {
    await this.requireProject(projectId);
    const [storyboardRow] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, storyboardArtifactId)).limit(1);
    if (!storyboardRow || storyboardRow.projectId !== projectId || storyboardRow.type !== "storyboard") throw new Error("分镜版本不存在");
    const report = await this.readContinuityReport(projectId, storyboardArtifactId);
    const actionable = report.issues.filter((issue) => issue.severity !== "info");
    const grouped = new Map<"asset-bible" | "shooting-script" | "storyboard", ContinuityIssue[]>();
    for (const issue of actionable) {
      const target = continuityRepairTargetForIssue(issue);
      if (!target) continue;
      grouped.set(target, [...(grouped.get(target) ?? []), issue]);
    }
    const definitions: Array<Pick<ContinuityRepairPlanStep, "target" | "label" | "actionLabel">> = [
      { target: "asset-bible", label: "资产定义", actionLabel: "重构资产定义" },
      { target: "shooting-script", label: "导演脚本", actionLabel: "重构导演脚本" },
      { target: "storyboard", label: "分镜设计", actionLabel: "重构并复检分镜" },
    ];
    const directSteps: ContinuityRepairPlanStep[] = definitions.flatMap((definition) => {
      const issues = grouped.get(definition.target) ?? [];
      if (!issues.length) return [];
      return [{
        order: 0,
        ...definition,
        issueCount: issues.length,
        issues: issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          suggestedFix: issue.suggestedFix,
          affectedIds: issue.affectedIds,
        })),
        issueCodes: [...new Set(issues.map((issue) => issue.code))],
        affectedIds: [...new Set(issues.flatMap((issue) => issue.affectedIds))],
        purpose: "repair",
      }];
    });
    if (actionable.length && !directSteps.some((step) => step.target === "storyboard")) {
      directSteps.push({
        order: 0,
        target: "storyboard",
        label: "分镜设计",
        actionLabel: "按新上游重构并复检分镜",
        issueCount: 0,
        issues: [],
        issueCodes: [],
        affectedIds: [...new Set(actionable.flatMap((issue) => issue.affectedIds))],
        purpose: "rebuild-and-review",
      });
    }
    const steps = directSteps.map((step, index) => ({ ...step, order: index + 1 }));
    const repairableIssueCodes = [...new Set(actionable
      .filter((issue) => continuityRepairTargetForIssue(issue))
      .map((issue) => issue.code))];
    return {
      sourceStoryboardArtifactId: storyboardArtifactId,
      totalIssueCount: actionable.length,
      repairableIssueCodes,
      manualIssueCodes: [...new Set(actionable
        .filter((issue) => !continuityRepairTargetForIssue(issue))
        .map((issue) => issue.code))],
      steps,
      currentStep: steps[0] ?? null,
      requiresApprovalBetweenSteps: true,
    };
  }

  async startContinuityRepair(
    projectId: string,
    storyboardArtifactId: string,
    options: { workflowMode?: "legacy" | "agent-first"; signal?: AbortSignal } = {},
  ): Promise<ContinuityRepairResult> {
    const project = await this.requireProject(projectId);
    if (options.workflowMode !== "agent-first" && project.currentStage !== "STORYBOARD_REVIEW") {
      throw new Error("只有分镜审核阶段可以从连续性报告启动定点修复");
    }
    assertContinuityRepairActive(options.signal);
    const [storyboardRow] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, storyboardArtifactId)).limit(1);
    if (!storyboardRow || storyboardRow.projectId !== projectId || storyboardRow.type !== "storyboard") throw new Error("分镜版本不存在");
    const [latestStoryboardRow] = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, "storyboard")))
      .orderBy(desc(artifacts.version)).limit(1);
    const allowedStatuses = options.workflowMode === "agent-first" ? ["draft", "rejected"] : ["draft"];
    if (!latestStoryboardRow || latestStoryboardRow.id !== storyboardRow.id || !allowedStatuses.includes(storyboardRow.status)) {
      throw new Error(options.workflowMode === "agent-first" ? "只能修复当前最新的草稿或已驳回分镜版本" : "只能修复当前最新的待审核分镜版本");
    }
    const report = await this.readContinuityReport(projectId, storyboardArtifactId);
    const actionable = report.issues.filter((issue) => issue.severity !== "info");
    const repairable = actionable.filter((issue) => continuityRepairKindForIssue(issue));
    const aspectIssues = repairable.filter((issue) => continuityRepairKindForIssue(issue) === "asset-aspect");
    const mirrorIssues = repairable.filter((issue) => continuityRepairKindForIssue(issue) === "asset-mirror-parity");
    const assetIssues = [...aspectIssues, ...mirrorIssues];
    const storyboardOnlyIssues = repairable.filter((issue) => {
      const kind = continuityRepairKindForIssue(issue);
      return kind === "storyboard-scene-reference" || kind === "storyboard-boundary-state" || kind === "storyboard-physical-verification" || kind === "generic-storyboard";
    });
    const supportedCodes = new Set(repairable.map((issue) => issue.code));
    if (!supportedCodes.size) throw new Error("当前报告没有可自动定点修复的问题；请按报告建议人工修改");
    const context = continuityRepairContextSchema.parse({
      schemaVersion: "continuity-targeted-repair-v1",
      sourceStoryboardArtifactId: storyboardArtifactId,
      issueCodes: actionable.map((issue) => issue.code),
      createdAt: new Date().toISOString(),
    });

    if (assetIssues.length) {
      const approvedAssetBible = options.workflowMode === "agent-first"
        ? await this.approvedHeadArtifact(projectId, "asset-bible") ?? await this.latestApprovedArtifact(projectId, "asset-bible")
        : await this.latestApprovedArtifact(projectId, "asset-bible");
      if (!approvedAssetBible?.structuredPath) throw new Error("没有可定点修复的已批准资产定义");
      const current = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
      const affectedIds = new Set(assetIssues.flatMap((issue) => issue.affectedIds));
      const changedAssetIds = new Set<string>();
      const repaired = assetBibleSchema.parse({
        ...current,
        assets: current.assets.map((asset) => {
          if (!affectedIds.has(asset.id)) return asset;
          const hasAspectIssue = aspectIssues.some((issue) => issue.affectedIds.includes(asset.id)) && aspectConstrainedAssetTypes.has(asset.type);
          const hasMirrorIssue = mirrorIssues.some((issue) => issue.affectedIds.includes(asset.id));
          const updated = {
            ...asset,
            appearance: hasAspectIssue ? repairAspectText(asset.appearance, project.aspectRatio) : asset.appearance,
            designSummary: hasAspectIssue ? repairAspectText(asset.designSummary, project.aspectRatio) : asset.designSummary,
            distinctiveFeatures: hasAspectIssue ? asset.distinctiveFeatures.map((item) => repairAspectText(item, project.aspectRatio)) : asset.distinctiveFeatures,
            negativeConstraints: asset.negativeConstraints,
            continuityRules: uniqueStrings([
              ...(hasAspectIssue ? asset.continuityRules.map((item) => repairAspectText(item, project.aspectRatio)) : asset.continuityRules),
              ...(hasMirrorIssue ? [MIRROR_PARITY_CONTINUITY_RULE] : []),
            ]),
          };
          if (JSON.stringify(updated) !== JSON.stringify(asset)) changedAssetIds.add(asset.id);
          return updated;
        }),
        conflicts: current.conflicts.filter((issue) => !assetIssues.some((candidate) => candidate.code === issue.code)),
      });
      if (!changedAssetIds.size) throw new Error("报告指出资产连续性问题，但受影响资产中没有可安全执行的定点修改");
      assertContinuityRepairActive(options.signal);
      const result = await this.createArtifactVersion(projectId, "asset-bible", renderAssetBible(repaired), {
        structured: repaired,
        sourceArtifactId: approvedAssetBible.id,
        workflowMode: options.workflowMode,
        metadata: {
          origin: "continuity-targeted-repair",
          continuityRepair: context,
          continuityRepairNext: "shooting-script",
          fixedIssueCodes: assetIssues.map((issue) => issue.code),
          changedAssetIds: [...changedAssetIds],
        },
      });
      if (options.workflowMode !== "agent-first") await this.syncAssetProjection(project, result.artifact.version, repaired);
      return {
        ...result,
        repair: {
          fixedIssueCodes: assetIssues.map((issue) => issue.code),
          remainingIssueCodes: actionable.filter((issue) => !assetIssues.includes(issue)).map((issue) => issue.code),
          nextTarget: "asset-bible",
        },
      };
    }

    if (storyboardOnlyIssues.length === repairable.length) {
      return this.createTargetedStoryboardRepair(project, context, report, options.signal, options.workflowMode);
    }
    return this.createTargetedShootingScriptRepair(project, context, report, options.signal, options.workflowMode);
  }

  async continueAgentFirstContinuityRepair(
    projectId: string,
    approvedArtifactId: string,
    signal?: AbortSignal,
  ): Promise<ContinuityRepairResult> {
    const project = await this.requireProject(projectId);
    const [row] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, approvedArtifactId)).limit(1);
    if (!row || row.projectId !== projectId) throw new Error("连续性修复版本不存在");
    const artifact = mapArtifactRow(row);
    if (artifact.status !== "approved") throw new Error("请先批准当前结构化修复版本，再继续下一步");
    const head = this.studio.sqlite.prepare(`
      SELECT artifact_id AS artifactId FROM project_heads WHERE project_id = ? AND artifact_type = ?
    `).get(projectId, artifact.type) as { artifactId: string } | undefined;
    if (head?.artifactId !== artifact.id) throw new Error("请先将当前结构化修复版本选择为 Head，再继续下一步");
    const context = this.continuityRepairContextFromArtifact(artifact);
    const report = await this.readContinuityReport(projectId, context.sourceStoryboardArtifactId);
    const next = artifact.metadata.continuityRepairNext;
    if (artifact.type === "asset-bible" && next === "shooting-script") {
      return this.createTargetedShootingScriptRepair(project, context, report, signal, "agent-first");
    }
    if (artifact.type === "shooting-script" && next === "storyboard") {
      return this.createTargetedStoryboardRepair(project, context, report, signal, "agent-first");
    }
    throw new Error("当前版本没有待执行的连续性修复下一步");
  }

  async continueContinuityRepair(projectId: string): Promise<ContinuityRepairResult> {
    const project = await this.requireProject(projectId);
    if (project.currentStage === "ASSET_BIBLE_APPROVED") {
      const approvedAssetBible = await this.latestApprovedArtifact(projectId, "asset-bible");
      if (!approvedAssetBible) throw new Error("没有已批准的定点修复资产版本");
      const context = this.continuityRepairContextFromArtifact(approvedAssetBible);
      const report = await this.readContinuityReport(projectId, context.sourceStoryboardArtifactId);
      return this.createTargetedShootingScriptRepair(project, context, report);
    }
    if (project.currentStage === "SHOOTING_SCRIPT_APPROVED") {
      const approvedShootingScript = await this.latestApprovedArtifact(projectId, "shooting-script");
      if (!approvedShootingScript) throw new Error("没有已批准的定点修复导演脚本版本");
      const context = this.continuityRepairContextFromArtifact(approvedShootingScript);
      const report = await this.readContinuityReport(projectId, context.sourceStoryboardArtifactId);
      return this.createTargetedStoryboardRepair(project, context, report);
    }
    throw new Error("当前阶段没有可继续的定点修复步骤");
  }

  async autoRepairContinuity(
    projectId: string,
    storyboardArtifactId: string,
    options: { maxAttempts?: number } = {},
  ): Promise<AutoContinuityRepairResult> {
    const maxAttempts = Math.max(1, Math.min(5, Math.floor(options.maxAttempts ?? 3)));
    const intermediateArtifactIds: string[] = [];
    const fixedIssueCodes = new Set<string>();
    const seenSignatures = new Set<string>();
    let attempts = 0;
    let currentStoryboardArtifactId = storyboardArtifactId;

    const readArtifact = async (artifactId: string): Promise<ArtifactWithContent> => {
      const [row] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
      if (!row || row.projectId !== projectId) throw new Error("自动修复产物不存在或不属于当前项目");
      const artifact = mapArtifactRow(row);
      return { ...artifact, content: await fs.readFile(artifact.filePath, "utf8") };
    };
    let currentArtifact = await readArtifact(storyboardArtifactId);

    const finish = async (passed: boolean, remainingIssueCodes: string[], blockedReason: string | null): Promise<AutoContinuityRepairResult> => ({
      project: await this.requireProject(projectId),
      artifact: currentArtifact,
      autoRepair: {
        passed,
        attempts,
        maxAttempts,
        fixedIssueCodes: [...fixedIssueCodes],
        remainingIssueCodes: uniqueStrings(remainingIssueCodes),
        intermediateArtifactIds,
        blockedReason,
        finalHumanApprovalRequired: true,
      },
    });

    while (attempts < maxAttempts) {
      const report = await this.readContinuityReport(projectId, currentStoryboardArtifactId);
      const actionable = report.issues.filter((issue) => issue.severity !== "info");
      if (report.passed) return finish(true, actionable.map((issue) => issue.code), null);
      const repairable = actionable.filter((issue) => continuityRepairKindForIssue(issue));
      if (!repairable.length) {
        return finish(false, actionable.map((issue) => issue.code), "剩余问题需要创作判断或人工改写，不能由确定性定点修复安全处理");
      }
      const signature = repairable
        .map((issue) => `${issue.code}:${[...issue.affectedIds].sort().join(",")}`)
        .sort()
        .join("|");
      if (seenSignatures.has(signature)) {
        return finish(false, actionable.map((issue) => issue.code), "连续两轮出现相同问题，已停止无效循环并保留全部版本");
      }
      seenSignatures.add(signature);
      attempts += 1;

      try {
        let repair = await this.startContinuityRepair(projectId, currentStoryboardArtifactId);
        currentArtifact = repair.artifact;
        intermediateArtifactIds.push(repair.artifact.id);
        repair.repair.fixedIssueCodes.forEach((code) => fixedIssueCodes.add(code));

        while (repair.artifact.type !== "storyboard") {
          const stage = repair.artifact.type === "asset-bible" ? "ASSET_BIBLE_REVIEW" : "SHOOTING_SCRIPT_REVIEW";
          await this.recordDecision({
            projectId,
            stage,
            decision: "approved",
            artifactId: repair.artifact.id,
            comment: "系统自动连续性修复的中间技术签核，仅用于生成下一修复版本；不代表用户批准最终分镜或授权付费视频生成。",
          });
          repair = await this.continueContinuityRepair(projectId);
          currentArtifact = repair.artifact;
          intermediateArtifactIds.push(repair.artifact.id);
          repair.repair.fixedIssueCodes.forEach((code) => fixedIssueCodes.add(code));
        }
        currentStoryboardArtifactId = repair.artifact.id;
      } catch (reason) {
        const latestReport = await this.readContinuityReport(projectId, currentStoryboardArtifactId);
        return finish(
          false,
          latestReport.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.code),
          reason instanceof Error ? reason.message : "后台自动修复中断",
        );
      }
    }

    const finalReport = await this.readContinuityReport(projectId, currentStoryboardArtifactId);
    if (finalReport.passed) return finish(true, finalReport.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.code), null);
    return finish(
      false,
      finalReport.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.code),
      `已达到 ${maxAttempts} 轮后台修复上限，避免无限生成和无效 Token 消耗`,
    );
  }

  async listAssets(projectId: string): Promise<Asset[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(assetRecords).where(eq(assetRecords.projectId, projectId));
    const currentVersion = rows.reduce((latest, row) => Math.max(latest, row.version), 0);
    const currentAssets = rows
      .filter((row) => row.version === currentVersion)
      .map((row) => assetSchema.parse({
        ...row.payload,
        id: row.id,
        projectId: row.projectId,
        type: row.type,
        name: row.name,
        version: row.version,
        approved: row.approved,
      }));
    const currentShots = await this.listShots(projectId);
    return currentAssets
      .map((asset) => ({
        ...asset,
        referencedBy: currentShots
          .filter((shot) => [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds].includes(asset.id))
          .map((shot) => shot.id),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async readAssetReadiness(projectId: string): Promise<{ passed: boolean; issues: string[] }> {
    const project = await this.requireProject(projectId);
    const issues = await this.assetReadinessIssues(project, await this.listAssets(projectId));
    return { passed: issues.length === 0, issues };
  }

  async activateArtifactProjection(projectId: string, artifactId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const [row] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
    if (!row || row.projectId !== projectId) throw new Error("产物版本不存在");
    const artifact = mapArtifactRow(row);
    if (artifact.type !== "asset-bible" && artifact.type !== "shooting-script") return;
    if (!artifact.structuredPath) throw new Error(`${artifact.type} 缺少结构化数据，不能选择为 Head`);
    if (artifact.type === "asset-bible") {
      const value = assetBibleSchema.parse(JSON.parse(await fs.readFile(artifact.structuredPath, "utf8")));
      await this.syncAssetProjection(project, artifact.version, value);
      return;
    }
    const value = shootingScriptSchema.parse(JSON.parse(await fs.readFile(artifact.structuredPath, "utf8")));
    const approvedAssetBible = await this.approvedHeadArtifact(projectId, "asset-bible");
    if (!approvedAssetBible?.structuredPath) throw new Error("必须先选择并批准资产定义 Head，才能启用导演脚本版本");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    this.assertShotAssetReferences(assetBible, value);
    await this.syncShotProjection(project, value);
  }

  async getImageProviderCapabilities(): Promise<ImageProviderCapabilities> {
    return this.imageProvider.getCapabilities();
  }

  async generateAssetReferencePrompt(projectId: string, assetId: string, role: AssetReferenceRole): Promise<{
    asset: Asset;
    prompt: AssetReferencePromptRecord;
    imageProvider: ImageProviderCapabilities;
  }> {
    const project = await this.requireProject(projectId);
    if (project.currentStage !== "ASSET_BIBLE_REVIEW") throw new Error("只有资产定义待审核时才能生成参考图提示词");
    const row = await this.requireCurrentAssetRow(projectId, assetId);
    const current = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    if (!visualAssetTypes.has(current.type)) throw new Error("该资产类型不支持图片参考提示词");
    assertReferenceRoleAllowed(current.type, role);
    const allAssets = await this.listAssets(projectId);
    const generated = await this.textProvider.generateAssetReferencePrompt({ project, asset: current, allAssets, role });
    const nextVersion = current.referencePrompts.reduce((latest, item) => Math.max(latest, item.version), 0) + 1;
    const prompt = assetReferencePromptRecordSchema.parse({
      ...generated.value,
      id: randomUUID(),
      version: nextVersion,
      provider: generated.trace.provider,
      providerRunId: generated.trace.runId,
      createdAt: generated.trace.completedAt,
    });
    const promptDirectory = path.join(project.projectDir, "prompts", "assets", current.id, `v${String(current.version).padStart(3, "0")}`);
    const promptPath = path.join(promptDirectory, `prompt-v${String(nextVersion).padStart(3, "0")}.json`);
    if (!isInside(project.projectDir, promptPath)) throw new Error("参考图提示词路径越界");
    await fs.mkdir(promptDirectory, { recursive: true });
    await fs.writeFile(promptPath, `${JSON.stringify({ prompt, generation: generationMetadata(generated.trace) }, null, 2)}\n`, { flag: "wx" });
    const updated = assetSchema.parse({ ...current, referencePrompts: [...current.referencePrompts, prompt], approved: false });
    try {
      await this.studio.db.update(assetRecords).set({ payload: updated, approved: false })
        .where(and(eq(assetRecords.projectId, projectId), eq(assetRecords.id, assetId), eq(assetRecords.version, row.version)));
    } catch (error) {
      await fs.rm(promptPath, { force: true });
      throw error;
    }
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: "asset.reference-prompt.generated", projectId, assetId, role, promptId: prompt.id,
      version: prompt.version, provider: prompt.provider, providerRunId: prompt.providerRunId, createdAt: prompt.createdAt,
    });
    return { asset: updated, prompt, imageProvider: await this.imageProvider.getCapabilities() };
  }

  async generateAssetReferenceImage(projectId: string, assetId: string, promptId: string): Promise<{
    asset: Asset;
    providerTaskId: string | null;
  }> {
    const project = await this.requireProject(projectId);
    if (project.currentStage !== "ASSET_BIBLE_REVIEW") throw new Error("只有资产定义待审核时才能生成参考图");
    const row = await this.requireCurrentAssetRow(projectId, assetId);
    const current = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    const prompt = current.referencePrompts.find((item) => item.id === promptId);
    if (!prompt) throw new Error("参考图提示词不存在或不属于当前资产版本");
    const capabilities = await this.imageProvider.getCapabilities();
    if (!capabilities.configured || !capabilities.enabled) {
      throw new Error(capabilities.reason ?? "图像生成 Provider 尚未配置");
    }
    const generated = await this.imageProvider.generateAssetReferenceImage({ project, asset: current, prompt });
    const bytes = Buffer.from(generated.dataBase64, "base64");
    const asset = await this.saveAssetReferenceBytes(project, row, current, {
      bytes,
      mimeType: generated.mimeType,
      role: prompt.role,
      authorizationState: "not-required",
      sourceFileName: generated.fileName,
      eventType: "asset.reference.generated",
      providerTaskId: generated.providerTaskId,
    });
    return { asset, providerTaskId: generated.providerTaskId };
  }

  async addAssetReferenceFile(projectId: string, assetId: string, input: {
    fileName: string;
    mimeType: string;
    dataBase64: string;
    role: string;
    authorizationConfirmed: true;
  }, options: { agentFirst?: boolean } = {}): Promise<Asset> {
    const project = await this.requireProject(projectId);
    if (!options.agentFirst && project.currentStage !== "ASSET_BIBLE_REVIEW") throw new Error("只有资产定义待审核时才能添加参考图；请先重做资产定义版本");
    const row = await this.requireCurrentAssetRow(projectId, assetId);
    const bytes = Buffer.from(input.dataBase64, "base64");
    const current = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    assertReferenceRoleAllowed(current.type, input.role);
    return this.saveAssetReferenceBytes(project, row, current, {
      bytes,
      mimeType: input.mimeType,
      role: input.role,
      authorizationState: "confirmed",
      sourceFileName: input.fileName,
      eventType: "asset.reference.added",
      providerTaskId: null,
    });
  }

  async replaceAssetReferenceFile(projectId: string, assetId: string, index: number, input: {
    fileName: string;
    mimeType: string;
    dataBase64: string;
    authorizationConfirmed: true;
  }, options: { agentFirst?: boolean } = {}): Promise<Asset> {
    const project = await this.requireProject(projectId);
    if (!options.agentFirst && project.currentStage !== "ASSET_BIBLE_REVIEW") throw new Error("只有资产定义待审核时才能更换参考图");
    const row = await this.requireCurrentAssetRow(projectId, assetId);
    const current = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    const previousPath = current.localFiles[index];
    if (!previousPath || !current.sha256[index] || !current.fileRoles[index] || !isInside(project.projectDir, previousPath)) throw new Error("参考图不存在或索引无效");
    if (!visualAssetTypes.has(current.type)) throw new Error("该资产类型不支持图片参考");
    const extension = assetReferenceMimeExtensions[input.mimeType];
    if (!extension) throw new Error("人物参考图仅支持 JPG、PNG 或 WebP");
    const bytes = Buffer.from(input.dataBase64, "base64");
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("参考图必须小于 4 MB");
    await validateImageBytes(bytes, input.mimeType);
    const destinationDirectory = path.dirname(previousPath);
    const destinationPath = path.join(destinationDirectory, assetReferenceStorageFileName({
      assetId: current.id,
      assetName: current.name,
      role: current.fileRoles[index],
      version: current.version,
      index,
      extension,
      uniqueSuffix: randomUUID().replaceAll("-", "").slice(0, 8),
    }));
    if (!isInside(project.projectDir, destinationPath)) throw new Error("参考图路径越界");
    await fs.mkdir(destinationDirectory, { recursive: true });
    await fs.writeFile(destinationPath, bytes, { flag: "wx" });
    const digest = createHash("sha256").update(bytes).digest("hex");
    let archivePath: string;
    try {
      archivePath = await this.archiveAssetReferenceFile(project, current, index);
    } catch (error) {
      await fs.rm(destinationPath, { force: true });
      throw error;
    }
    const localFiles = [...current.localFiles];
    const sha256 = [...current.sha256];
    localFiles[index] = destinationPath;
    sha256[index] = digest;
    const updated = assetSchema.parse({
      ...current,
      localFiles,
      sha256,
      authorizationState: "confirmed",
      approved: false,
    });
    try {
      this.saveAssetProjectionAndInvalidateApproval(project, updated, row.version);
    } catch (error) {
      await fs.rename(archivePath, previousPath).catch(() => undefined);
      await fs.rm(destinationPath, { force: true });
      throw error;
    }
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: "asset.reference.replaced", projectId: project.id, assetId: current.id, version: row.version,
      role: current.fileRoles[index], sourceFileName: input.fileName, previousFileName: path.basename(previousPath),
      archivedFileName: path.basename(archivePath), fileName: path.basename(destinationPath), sha256: digest,
      createdAt: new Date().toISOString(),
    });
    return updated;
  }

  async removeAssetReferenceFile(projectId: string, assetId: string, index: number, options: { agentFirst?: boolean } = {}): Promise<{ asset: Asset; archivedFileName: string }> {
    const project = await this.requireProject(projectId);
    if (!options.agentFirst && project.currentStage !== "ASSET_BIBLE_REVIEW") throw new Error("只有资产定义待审核时才能删除参考图");
    const row = await this.requireCurrentAssetRow(projectId, assetId);
    const current = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    const previousPath = current.localFiles[index];
    if (!previousPath || !current.sha256[index] || !current.fileRoles[index] || !isInside(project.projectDir, previousPath)) throw new Error("参考图不存在或索引无效");
    const archivePath = await this.archiveAssetReferenceFile(project, current, index);
    const localFiles = current.localFiles.filter((_, itemIndex) => itemIndex !== index);
    const sha256 = current.sha256.filter((_, itemIndex) => itemIndex !== index);
    const fileRoles = current.fileRoles.filter((_, itemIndex) => itemIndex !== index);
    const fallbackProductionReady = current.productionReady
      && current.designSummary.trim().length >= 20
      && current.distinctiveFeatures.length >= 2
      && current.negativeConstraints.length >= 1
      && !unresolvedVisualPattern.test(current.appearance);
    const baseline = localFiles.length ? null : current.referenceBaseline;
    const updated = assetSchema.parse({
      ...current,
      localFiles,
      sha256,
      fileRoles,
      authorizationState: localFiles.length ? current.authorizationState : "unknown",
      productionReady: localFiles.length ? current.productionReady : baseline?.productionReady ?? fallbackProductionReady,
      designBasis: localFiles.length ? current.designBasis : baseline?.designBasis ?? current.designBasis,
      designSummary: localFiles.length ? current.designSummary : baseline?.designSummary ?? current.designSummary,
      referenceBaseline: localFiles.length ? current.referenceBaseline : null,
      approved: false,
    });
    try {
      this.saveAssetProjectionAndInvalidateApproval(project, updated, row.version);
    } catch (error) {
      await fs.rename(archivePath, previousPath).catch(() => undefined);
      throw error;
    }
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: "asset.reference.removed", projectId: project.id, assetId: current.id, version: row.version,
      role: current.fileRoles[index], previousFileName: path.basename(previousPath), archivedFileName: path.basename(archivePath),
      sha256: current.sha256[index], createdAt: new Date().toISOString(),
    });
    return { asset: updated, archivedFileName: path.basename(archivePath) };
  }

  private async archiveAssetReferenceFile(project: Project, current: Asset, index: number): Promise<string> {
    const sourcePath = current.localFiles[index];
    if (!sourcePath || !isInside(project.projectDir, sourcePath)) throw new Error("参考图不存在或路径无效");
    await fs.access(sourcePath);
    const archiveDirectory = path.join(project.projectDir, "history", "reference-images", current.id, `v${String(current.version).padStart(3, "0")}`);
    const archivePath = path.join(archiveDirectory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}${path.extname(sourcePath)}`);
    if (!isInside(project.projectDir, archivePath)) throw new Error("参考图历史路径越界");
    await fs.mkdir(archiveDirectory, { recursive: true });
    await fs.rename(sourcePath, archivePath);
    return archivePath;
  }

  private async saveAssetReferenceBytes(
    project: Project,
    row: typeof assetRecords.$inferSelect,
    current: Asset,
    input: {
      bytes: Buffer;
      mimeType: string;
      role: string;
      authorizationState: "confirmed" | "not-required";
      sourceFileName: string;
      eventType: "asset.reference.added" | "asset.reference.generated";
      providerTaskId: string | null;
    },
  ): Promise<Asset> {
    const extension = assetReferenceMimeExtensions[input.mimeType];
    if (!extension) throw new Error("人物参考图仅支持 JPG、PNG 或 WebP");
    if (!input.bytes.length || input.bytes.length > 4 * 1024 * 1024) throw new Error("参考图必须小于 4 MB");
    await validateImageBytes(input.bytes, input.mimeType);
    if (!visualAssetTypes.has(current.type)) throw new Error("该资产类型不支持图片参考");
    const destinationDirectory = path.join(project.projectDir, "assets", assetFolderByType[current.type], current.id, `v${String(current.version).padStart(3, "0")}`);
    const destinationPath = path.join(destinationDirectory, assetReferenceStorageFileName({
      assetId: current.id,
      assetName: current.name,
      role: input.role,
      version: current.version,
      index: current.localFiles.length,
      extension,
      uniqueSuffix: randomUUID().replaceAll("-", "").slice(0, 8),
    }));
    if (!isInside(project.projectDir, destinationPath)) throw new Error("参考图路径越界");
    await fs.mkdir(destinationDirectory, { recursive: true });
    await fs.writeFile(destinationPath, input.bytes, { flag: "wx" });
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const updated = assetSchema.parse({
      ...current,
      localFiles: [...current.localFiles, destinationPath],
      sha256: [...current.sha256, digest],
      fileRoles: [...current.fileRoles, input.role],
      authorizationState: input.authorizationState,
      designBasis: "reference-guided",
      productionReady: current.type === "character" ? true : current.productionReady,
      designSummary: current.designSummary || `以${input.eventType === "asset.reference.generated" ? "生成的" : "已上传的"}${input.role}参考图为视觉身份基准。`,
      referenceBaseline: current.localFiles.length ? current.referenceBaseline : {
        productionReady: current.productionReady,
        designBasis: current.designBasis,
        designSummary: current.designSummary,
      },
      approved: false,
    });
    try {
      this.saveAssetProjectionAndInvalidateApproval(project, updated, row.version);
    } catch (error) {
      await fs.rm(destinationPath, { force: true });
      throw error;
    }
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: input.eventType, projectId: project.id, assetId: current.id, version: row.version, role: input.role,
      sourceFileName: input.sourceFileName, fileName: path.basename(destinationPath), sha256: digest,
      providerTaskId: input.providerTaskId, createdAt: new Date().toISOString(),
    });
    return updated;
  }

  private saveAssetProjectionAndInvalidateApproval(project: Project, updated: Asset, version: number): void {
    const now = new Date().toISOString();
    this.studio.sqlite.transaction(() => {
      const result = this.studio.sqlite.prepare(`
        UPDATE assets SET payload = ?, approved = 0 WHERE project_id = ? AND id = ? AND version = ?
      `).run(JSON.stringify(updated), project.id, updated.id, version);
      if (!result.changes) throw new Error("资产投影版本已变化，参考图修改未提交");
      this.studio.sqlite.prepare(`
        UPDATE artifacts SET status = 'draft', updated_at = ?
        WHERE id = (
          SELECT artifact_id FROM project_heads WHERE project_id = ? AND artifact_type = 'asset-bible'
        ) AND status = 'approved'
      `).run(now, project.id);
    })();
  }

  async readAssetReferenceFile(projectId: string, assetId: string, index: number): Promise<{ filePath: string; fileName: string }> {
    const project = await this.requireProject(projectId);
    const asset = (await this.listAssets(projectId)).find((item) => item.id === assetId);
    if (!asset) throw new Error("资产不存在");
    const filePath = asset.localFiles[index];
    if (!filePath || !isInside(project.projectDir, filePath)) throw new Error("参考图不存在或路径无效");
    await fs.access(filePath);
    return { filePath, fileName: path.basename(filePath) };
  }

  async listShots(projectId: string): Promise<ShotSpec[]> {
    await this.requireProject(projectId);
    const rows = await this.studio.db.select().from(shots).where(eq(shots.projectId, projectId));
    return rows
      .map((row) => shotSpecSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, sequence: row.sequence, status: row.status }))
      .sort((left, right) => left.sequence - right.sequence);
  }

  async getGenerationCenter(projectId: string): Promise<GenerationCenter> {
    const project = await this.requireProject(projectId);
    const [capabilities, skills, bootstrap, assets, shotList] = await Promise.all([
      this.loadH3Capabilities(),
      this.providerSkills.loadMany(["h3-prompt-writing", "updream-handoff"]),
      this.updreamPackages.readBootstrap(project),
      this.listAssets(projectId),
      this.listShots(projectId),
    ]);
    const shotsWithStatus = await Promise.all(shotList.map(async (shot) => {
      const packages = await this.updreamPackages.listShotPackages(project, shot.id);
      return {
        shot,
        preflight: await preflightH3Shot(shot, assets, capabilities, project.aspectRatio),
        packages: packages.map((summary) => bindHandoffPackageToCurrentShot(summary, shot)),
      };
    }));
    return generationCenterSchema.parse({
      project,
      capabilities,
      skills: skills.map((skill) => skill.provenance),
      bootstrap,
      assets,
      shots: shotsWithStatus,
    });
  }

  async getGenerationReadiness(projectId: string): Promise<NarrativeFeasibilityReport | null> {
    const project = await this.requireProject(projectId);
    const screenplayArtifact = await this.latestApprovedArtifact(projectId, "screenplay");
    if (!screenplayArtifact?.structuredPath) return null;
    const screenplay = screenplaySchema.parse(JSON.parse(await fs.readFile(screenplayArtifact.structuredPath, "utf8")));
    return inspectScreenplayFeasibility(screenplay, project.targetDurationSec, 5);
  }

  async lockAssets(projectId: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.currentStage !== "STORYBOARD_APPROVED") throw new Error("只有分镜批准后才能锁定素材");
    const [storyboard, currentAssets, currentShots] = await Promise.all([
      this.latestApprovedArtifact(projectId, "storyboard"),
      this.listAssets(projectId),
      this.listShots(projectId),
    ]);
    if (!storyboard?.structuredPath) throw new Error("没有可用的已批准结构化分镜");
    if (!currentAssets.length || currentAssets.some((asset) => !asset.approved)) throw new Error("所有被使用的素材定义都必须先批准");
    if (!currentShots.length || currentShots.some((shot) => shot.status !== "approved")) throw new Error("所有 ShotSpec 都必须先批准");
    return this.transition(project, "ASSETS_LOCKED", "assets.locked");
  }

  async createUpdreamBootstrap(projectId: string, options: { agentFirst?: boolean } = {}): Promise<{ project: Project; bootstrap: BootstrapSummary }> {
    const project = await this.requireProject(projectId);
    if (!options.agentFirst && !(["ASSETS_LOCKED", "READY_FOR_GENERATION"] as ProjectStage[]).includes(project.currentStage)) {
      throw new Error("必须先锁定素材，才能创建 Updream 初始化包");
    }
    const [currentAssets, currentShots, approvedStoryboard] = await Promise.all([
      this.listAssets(projectId),
      this.listShots(projectId),
      options.agentFirst ? this.approvedHeadArtifact(projectId, "storyboard") : this.latestApprovedArtifact(projectId, "storyboard"),
    ]);
    if (options.agentFirst && !approvedStoryboard?.structuredPath) throw new Error("当前 storyboard Head 尚未批准或缺少结构化数据");
    if (options.agentFirst && (!currentShots.length || currentShots.some((shot) => shot.status !== "approved"))) {
      throw new Error("当前导演脚本中的所有镜头必须先批准，才能准备生成素材");
    }
    if (currentAssets.some((asset) => !asset.approved)) throw new Error("存在未批准素材，不能创建初始化包");
    const skill = await this.providerSkills.load("updream-handoff");
    const bootstrap = await this.updreamPackages.createBootstrap(project, currentAssets, skill.provenance);
    const updated = !options.agentFirst && project.currentStage === "ASSETS_LOCKED"
      ? await this.transition(project, "READY_FOR_GENERATION", "updream.bootstrap.created")
      : project;
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.bootstrap.ready", projectId, bootstrapPath: bootstrap.path,
      skill: skill.provenance, createdAt: new Date().toISOString(),
    });
    return { project: updated, bootstrap };
  }

  async createUpdreamShotPackage(projectId: string, shotId: string, rawGenerationResolution: GenerationResolution, options: {
    agentFirst?: boolean;
    signal?: AbortSignal;
    onEvent?: (eventType: string, payload?: Record<string, unknown>) => void;
    onProcessId?: (processId: number | null) => void;
  } = {}): Promise<{ project: Project; package: HandoffPackageSummary }> {
    const project = await this.requireProject(projectId);
    const generationResolution = generationResolutionSchema.parse(rawGenerationResolution);
    if (!options.agentFirst && !(project.currentStage === "READY_FOR_GENERATION" || project.currentStage === "GENERATING")) {
      throw new Error("只有等待生成或重试生成阶段可以创建 Updream 镜头包");
    }
    if (!await this.updreamPackages.readBootstrap(project)) throw new Error("Updream 初始化包不存在");
    const [currentAssets, currentShots, storyboardArtifact, capabilities, providerSkills] = await Promise.all([
      this.listAssets(projectId),
      this.listShots(projectId),
      options.agentFirst ? this.approvedHeadArtifact(projectId, "storyboard") : this.latestApprovedArtifact(projectId, "storyboard"),
      this.loadH3Capabilities(),
      this.providerSkills.loadMany(["h3-prompt-writing", "updream-handoff"]),
    ]);
    const shot = currentShots.find((item) => item.id === shotId);
    if (!shot) throw new Error("镜头不存在");
    if (!storyboardArtifact?.structuredPath) throw new Error("没有可用的已批准结构化分镜");
    const storyboard = storyboardSchema.parse(JSON.parse(await fs.readFile(storyboardArtifact.structuredPath, "utf8")));
    const storyboardShot = storyboard.shots.find((item) => item.shotId === shotId);
    if (!storyboardShot) throw new Error("已批准分镜中缺少该镜头");
    const preflight = await preflightH3Shot(shot, currentAssets, capabilities, project.aspectRatio, storyboardShot);
    if (!preflight.passed) throw new Error(`H3 参数预检未通过：${preflight.errors.join("；")}`);
    const h3Input = {
      project,
      shot,
      storyboardShot,
      assets: currentAssets.filter((asset) => [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds].includes(asset.id)),
      mode: preflight.mode,
      referenceLabels: preflight.references,
      operation: { signal: options.signal, onEvent: options.onEvent, onProcessId: options.onProcessId },
    } as const;
    const referenceIdentities = preflight.references.map((reference) => {
      const asset = currentAssets.find((item) => item.id === reference.assetId);
      return { label: reference.label, name: asset?.name ?? reference.assetId, assetType: asset?.type ?? "reference", role: reference.role };
    });
    let generated = await this.textProvider.generateH3Prompt(h3Input);
    let optimization: ReturnType<typeof optimizeH3Prompt> | null = null;
    let executabilityIssues: ReturnType<typeof inspectH3PromptExecutability> = [];
    let blockingIssues: ReturnType<typeof inspectH3PromptExecutability> = [];
    let correctionFeedback: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        generated = await this.textProvider.generateH3Prompt({ ...h3Input, correctionFeedback });
      }
      try {
        optimization = optimizeH3Prompt({
          value: h3PromptOutputSchema.parse(generated.value),
          durationSec: shot.durationSec,
          references: referenceIdentities,
        });
      } catch (error) {
        optimization = null;
        correctionFeedback = [`H3_PROMPT_OPTIMIZATION_FAILED：${error instanceof Error ? error.message : String(error)}`];
        if (attempt === 2) {
          throw new Error(`H3 提示词内部三次生成后仍未通过长度与结构优化，未保存问题版本：${correctionFeedback[0]}`);
        }
        continue;
      }
      executabilityIssues = inspectH3PromptExecutability(optimization.value.prompt, shot.durationSec, {
        cameraContinuityMode: shot.physicalPlan?.cameraContinuityMode,
      });
      blockingIssues = executabilityIssues.filter((issue) => issue.severity === "error");
      if (!blockingIssues.length) break;
      correctionFeedback = blockingIssues.map((issue) => `${issue.code}：${issue.message} ${issue.suggestedFix}`);
    }
    if (!optimization) throw new Error("H3 提示词优化未产生可保存版本");
    if (blockingIssues.length) {
      throw new Error(`H3 提示词内部三次生成后仍未通过付费生成执行检查，未保存问题版本：${blockingIssues.map((issue) => `${issue.code} ${issue.message}`).join("；")}`);
    }
    const prompt = h3PromptOutputSchema.parse({
      ...optimization.value,
      notes: [
        ...optimization.value.notes,
        `AI 模型可执行性策略：${H3_EXECUTION_POLICY_VERSION}；检查通过${executabilityIssues.length ? `，保留 ${executabilityIssues.length} 条非阻断提醒` : ""}。`,
      ],
    });
    const packageSummary = await this.updreamPackages.createShotPackage({
      project, shot, assets: currentAssets, preflight, prompt, trace: generated.trace, generationResolution,
      sourceStoryboardArtifactId: storyboardArtifact.id,
      skills: providerSkills.map((skill) => skill.provenance),
      promptOptimization: {
        strategy: H3_EXECUTION_POLICY_VERSION,
        targetCharacters: optimization.targetCharacters,
        originalCharacters: optimization.originalCharacters,
        finalCharacters: optimization.finalCharacters,
        referenceOccurrences: optimization.referenceOccurrences,
      },
    });
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.shot-package.created", projectId, shotId, version: packageSummary.version,
      path: packageSummary.path, mode: packageSummary.mode, generationResolution: packageSummary.generationResolution, createdAt: packageSummary.createdAt,
    });
    return { project, package: packageSummary };
  }

  async setAssetUploadState(projectId: string, assetId: string, state: "not-uploaded" | "uploaded", options: { agentFirst?: boolean } = {}): Promise<Asset> {
    const project = await this.requireProject(projectId);
    if (!options.agentFirst && stageOrder.indexOf(project.currentStage) < stageOrder.indexOf("ASSETS_LOCKED")) throw new Error("素材锁定后才能记录 Updream 上传状态");
    const row = await this.requireCurrentAssetRow(projectId, assetId);
    const asset = assetSchema.parse({ ...row.payload, id: row.id, projectId: row.projectId, type: row.type, name: row.name, version: row.version, approved: row.approved });
    const updated = assetSchema.parse({ ...asset, uploadState: { ...asset.uploadState, updream: state } });
    await this.studio.db.update(assetRecords).set({ payload: updated })
      .where(and(eq(assetRecords.projectId, projectId), eq(assetRecords.id, assetId), eq(assetRecords.version, row.version)));
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.asset-upload-state.changed", projectId, assetId, state, createdAt: new Date().toISOString(),
    });
    return updated;
  }

  async setShotPackageUploadState(projectId: string, shotId: string, version: number, state: "not-uploaded" | "uploaded", options: { agentFirst?: boolean } = {}): Promise<HandoffPackageSummary> {
    const project = await this.requireProject(projectId);
    if (!options.agentFirst && !(project.currentStage === "READY_FOR_GENERATION" || project.currentStage === "GENERATING")) {
      throw new Error("当前阶段不能修改镜头投递状态");
    }
    const { shot } = await this.requireCurrentShotPackage(project, shotId, version);
    const summary = bindHandoffPackageToCurrentShot(await this.updreamPackages.setPackageUploadState(project, shotId, version, state), shot);
    await this.appendLog(project.projectDir, "handoff.log.jsonl", {
      type: "updream.shot-upload-state.changed", projectId, shotId, version, state, createdAt: new Date().toISOString(),
    });
    return summary;
  }

  async copyShotPackageMaterials(projectId: string, shotId: string, version: number, label?: string) {
    const project = await this.requireProject(projectId);
    await this.requireCurrentShotPackage(project, shotId, version);
    return this.updreamPackages.copyPackageMaterials(project, shotId, version, label);
  }

  async readShotPackagePrompt(projectId: string, shotId: string, version: number): Promise<{ prompt: string; path: string }> {
    const project = await this.requireProject(projectId);
    await this.requireCurrentShotPackage(project, shotId, version);
    return this.updreamPackages.readPrompt(project, shotId, version);
  }

  private async requireCurrentShotPackage(project: Project, shotId: string, version: number): Promise<{ shot: ShotSpec; summary: HandoffPackageSummary }> {
    const shot = (await this.listShots(project.id)).find((item) => item.id === shotId);
    if (!shot) throw new Error("镜头不存在");
    const summary = (await this.updreamPackages.listShotPackages(project, shotId)).find((item) => item.version === version);
    if (!summary) throw new Error("镜头包不存在");
    const bound = bindHandoffPackageToCurrentShot(summary, shot);
    if (bound.isStale) {
      throw new Error(`${shotId} V${String(version).padStart(3, "0")} 是历史投递包，不能继续复制或标记投递：${bound.staleReasons.join("；")}。请按当前导演脚本生成新版本。`);
    }
    return { shot, summary: bound };
  }

  async updateShot(projectId: string, shotId: string, rawShot: unknown, expectedLatestArtifactId: string): Promise<{ project: Project; artifact: ArtifactWithContent; shot: ShotSpec }> {
    const project = await this.requireProject(projectId);
    this.assertArtifactRoute(project, "shooting-script");
    const replacement = shotSpecSchema.parse({ ...(rawShot as Record<string, unknown>), id: shotId, projectId, status: "draft" });
    const [latestRow] = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, "shooting-script")))
      .orderBy(desc(artifacts.version)).limit(1);
    if (!latestRow?.structuredPath) throw new Error("没有可编辑的结构化导演脚本");
    if (latestRow.id !== expectedLatestArtifactId) throw new ArtifactVersionConflictError();
    const current = shootingScriptSchema.parse(JSON.parse(await fs.readFile(latestRow.structuredPath, "utf8")));
    if (!current.shots.some((shot) => shot.id === shotId)) throw new Error("镜头不存在");
    const updatedScript = shootingScriptSchema.parse({
      ...current,
      shots: current.shots.map((shot) => shot.id === shotId ? replacement : shot),
    });
    const approvedAssetBible = await this.latestApprovedArtifact(projectId, "asset-bible");
    if (!approvedAssetBible?.structuredPath) throw new Error("没有可用于校验的已批准资产定义");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    this.assertShotAssetReferences(assetBible, updatedScript);
    const result = await this.createArtifactVersion(projectId, "shooting-script", renderShootingScript(updatedScript), {
      structured: updatedScript,
      sourceArtifactId: latestRow.id,
      metadata: { origin: "manual-shot-edit", editedShotId: shotId, basedOnArtifactId: latestRow.id },
    });
    await this.syncShotProjection(project, updatedScript);
    return { ...result, shot: replacement };
  }

  async createArtifactVersion(
    projectId: string,
    type: ArtifactType,
    content: string,
    options: { structured?: unknown; sourceArtifactId?: string | null; expectedLatestArtifactId?: string | null; metadata?: Record<string, unknown>; workflowMode?: "legacy" | "agent-first" } = {},
  ): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(projectId);
    this.assertArtifactRoute(project, type);
    if (!(["outline", "screenplay"] as ArtifactType[]).includes(type) && options.structured === undefined) {
      throw new Error(`${type} 必须通过结构化编辑器或对应 Skill 创建`);
    }
    if (options.sourceArtifactId) {
      const [sourceRow] = await this.studio.db.select().from(artifacts)
        .where(eq(artifacts.id, options.sourceArtifactId)).limit(1);
      if (!sourceRow || sourceRow.projectId !== projectId) {
        throw new Error("来源产物不存在或不属于当前项目");
      }
      if (options.metadata?.origin === "manual-edit" && sourceRow.type !== type) {
        throw new Error(`手工另存的来源产物类型必须同为 ${type}`);
      }
    }
    const existing = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type)))
      .orderBy(desc(artifacts.version));
    if (options.metadata?.origin === "manual-edit"
      && (existing[0]?.id ?? null) !== (options.expectedLatestArtifactId ?? null)) {
      throw new ArtifactVersionConflictError();
    }
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    if (existing[0]?.contentHash === contentHash) {
      throw new Error("内容与当前最新版本完全相同，未创建重复版本");
    }
    const version = (existing[0]?.version ?? 0) + 1;
    const now = new Date().toISOString();
    const stem = `${type}-v${String(version).padStart(3, "0")}`;
    const artifactDirectory = artifactDirectoryByType[type];
    const filePath = path.join(project.projectDir, artifactDirectory, `${stem}.md`);
    const structuredPath = options.structured === undefined ? null : path.join(project.projectDir, artifactDirectory, `${stem}.json`);
    if (!isInside(project.projectDir, filePath) || (structuredPath && !isInside(project.projectDir, structuredPath))) throw new Error("产物路径越界");

    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
    try {
      if (structuredPath) await fs.writeFile(structuredPath, `${JSON.stringify(options.structured, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      const artifact = artifactSchema.parse({
        id: randomUUID(), projectId, type, version, filePath, structuredPath,
        contentHash,
        status: "draft", sourceArtifactId: options.sourceArtifactId ?? null, metadata: options.metadata ?? {}, createdAt: now, updatedAt: now,
      });
      if (options.workflowMode !== "agent-first") {
        await this.studio.db.update(artifacts).set({ status: "stale", updatedAt: now })
          .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type)));
        for (const dependentType of dependentArtifactTypes[type]) {
          await this.studio.db.update(artifacts).set({ status: "stale", updatedAt: now })
            .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, dependentType)));
        }
        if (dependentArtifactTypes[type].includes("asset-bible")) {
          await this.studio.db.update(assetRecords).set({ approved: false }).where(eq(assetRecords.projectId, projectId));
        }
        if (dependentArtifactTypes[type].includes("shooting-script") || type === "shooting-script") {
          await this.studio.db.update(shots).set({ status: "stale" }).where(eq(shots.projectId, projectId));
        }
      }
      await this.studio.db.insert(artifacts).values(artifact);
      const updatedProject = options.workflowMode === "agent-first" ? project : await this.moveToReview(project, type, artifact.id);
      return { project: updatedProject, artifact: { ...artifact, content } };
    } catch (error) {
      await Promise.all([fs.rm(filePath, { force: true }), structuredPath ? fs.rm(structuredPath, { force: true }) : Promise.resolve()]);
      throw error;
    }
  }

  async generateOutline(id: string): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "outline");
    const sourceText = await fs.readFile(project.sourcePath, "utf8");
    const generated = await this.textProvider.generateOutline({ project, sourceText });
    const parsed = storyOutlineSchema.parse(generated.value);
    const readiness = inspectOutlineFeasibility(parsed, project.targetDurationSec);
    return this.createArtifactVersion(id, "outline", renderOutline(parsed), {
      structured: parsed,
      metadata: { ...generationMetadata(generated.trace), generationReadiness: readiness },
    });
  }

  async generateScreenplay(id: string): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    if (!(["OUTLINE_APPROVED", "SCREENPLAY_REVIEW"] as ProjectStage[]).includes(project.currentStage)) {
      throw new Error("必须先批准剧情大纲，才能生成影视剧本");
    }
    const approved = await this.latestApprovedArtifact(id, "outline");
    if (!approved) throw new Error("没有可用的已批准剧情大纲");
    const sourceText = await fs.readFile(project.sourcePath, "utf8");
    let approvedOutline: StoryOutline | string = await fs.readFile(approved.filePath, "utf8");
    if (approved.structuredPath) approvedOutline = storyOutlineSchema.parse(JSON.parse(await fs.readFile(approved.structuredPath, "utf8")));
    const generated = await this.textProvider.generateScreenplay({
      project,
      approvedOutline,
      approvedOutlineRef: `outline-v${String(approved.version).padStart(3, "0")}:${approved.contentHash}`,
      sourceText,
    });
    const screenplay = screenplaySchema.parse(generated.value);
    const readiness = inspectScreenplayFeasibility(screenplay, project.targetDurationSec);
    const existing = await this.listArtifacts(id, "screenplay");
    const versioned = screenplaySchema.parse({ ...screenplay, version: (existing[0]?.version ?? 0) + 1 });
    return this.createArtifactVersion(id, "screenplay", renderScreenplay(versioned), {
      structured: versioned,
      sourceArtifactId: approved.id,
      metadata: { ...generationMetadata(generated.trace), generationReadiness: readiness },
    });
  }

  async generateAssetBible(id: string, designMode: AssetDesignMode = "original-proposal"): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "asset-bible");
    const approvedScreenplay = await this.latestApprovedArtifact(id, "screenplay");
    if (!approvedScreenplay) throw new Error("必须先批准影视剧本，才能生成资产定义");
    const sourceText = await fs.readFile(project.sourcePath, "utf8");
    const screenplay = approvedScreenplay.structuredPath
      ? screenplaySchema.parse(JSON.parse(await fs.readFile(approvedScreenplay.structuredPath, "utf8")))
      : await fs.readFile(approvedScreenplay.filePath, "utf8");
    const screenplayRef = `screenplay-v${String(approvedScreenplay.version).padStart(3, "0")}:${approvedScreenplay.contentHash}`;
    const generated = await this.textProvider.generateAssetBible({
      project,
      approvedScreenplay: screenplay,
      approvedScreenplayRef: screenplayRef,
      sourceText,
      designMode,
    });
    const assetBible = assetBibleSchema.parse(generated.value);
    const result = await this.createArtifactVersion(id, "asset-bible", renderAssetBible(assetBible), {
      structured: assetBible,
      sourceArtifactId: approvedScreenplay.id,
      metadata: { ...generationMetadata(generated.trace), inputArtifacts: [screenplayRef], designMode },
    });
    await this.syncAssetProjection(project, result.artifact.version, assetBible);
    return result;
  }

  async generateShootingScript(id: string): Promise<{ project: Project; artifact: ArtifactWithContent }> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "shooting-script");
    const approvedScreenplay = await this.latestApprovedArtifact(id, "screenplay");
    const approvedAssetBible = await this.latestApprovedArtifact(id, "asset-bible");
    if (!approvedScreenplay || !approvedAssetBible?.structuredPath) {
      throw new Error("必须先批准影视剧本和资产定义，才能生成导演脚本");
    }
    const screenplay = approvedScreenplay.structuredPath
      ? screenplaySchema.parse(JSON.parse(await fs.readFile(approvedScreenplay.structuredPath, "utf8")))
      : await fs.readFile(approvedScreenplay.filePath, "utf8");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    const screenplayRef = `screenplay-v${String(approvedScreenplay.version).padStart(3, "0")}:${approvedScreenplay.contentHash}`;
    const assetBibleRef = `asset-bible-v${String(approvedAssetBible.version).padStart(3, "0")}:${approvedAssetBible.contentHash}`;
    const capabilities = await this.loadH3Capabilities();
    const durationMinSec = h3ProductDurationMin(capabilities.durationMinSec);
    const durationMaxSec = Math.floor(capabilities.durationMaxSec);
    if (typeof screenplay === "string") {
      throw new Error("旧版非结构化剧本缺少付费生成复杂度数据；请重新生成结构化剧本版本后再创建导演脚本");
    }
    const narrativeReadiness = inspectScreenplayFeasibility(screenplay, project.targetDurationSec, durationMinSec);
    if (narrativeReadiness.status === "blocked") {
      throw new Error(`已批准剧本不满足付费生成预算：${narrativeReadiness.issues.map((issue) => `${issue.code} ${issue.message} ${issue.suggestedFix}`).join("；")}`);
    }
    const generationInput = {
      project,
      approvedScreenplay: screenplay,
      approvedScreenplayRef: screenplayRef,
      approvedAssetBible: assetBible,
      approvedAssetBibleRef: assetBibleRef,
      generationConstraints: {
        provider: capabilities.provider,
        model: capabilities.model,
        durationMinSec,
        durationMaxSec,
        durationStepSec: 1,
        preferredShotDurationSec: Math.min(project.targetDurationSec, durationMaxSec),
        minimumShotsForTargetDuration: Math.ceil(project.targetDurationSec / durationMaxSec),
        recommendedMinimumShots: narrativeReadiness.recommendedMinimumShots,
        maxShotsForTargetDuration: Math.floor(project.targetDurationSec / durationMinSec),
        segmentationPolicy: "content-led-longest-feasible",
        avoidDurationPadding: true,
        taskGranularity: "one-shot-per-generation-task",
        maxMajorBeatsPerShot: 4,
        maxCameraPhasesPerShot: 3,
        maxTimedStateGatesPerShot: 6,
        maxHighRiskLayersPerShot: 2,
      },
    } as const;
    const attemptedTraces: TextGenerationTrace[] = [];
    let generated = await this.textProvider.generateShootingScript(generationInput);
    attemptedTraces.push(generated.trace);
    let shootingScript = shootingScriptSchema.parse({
      ...generated.value,
      targetDurationSec: project.targetDurationSec,
      shots: generated.value.shots.map((shot) => ({ ...shot, projectId: project.id, status: "draft" })),
    });
    let preflightIssues = inspectShootingScriptPreflight(shootingScript.shots, {
      recommendedMinimumShots: narrativeReadiness.recommendedMinimumShots,
    });
    for (let retry = 0; preflightIssues.length && retry < 2; retry += 1) {
      generated = await this.textProvider.generateShootingScript({
        ...generationInput,
        correctionFeedback: preflightIssues.map((issue) => `${issue.code}：${issue.message}；${issue.suggestedFix}`),
      });
      attemptedTraces.push(generated.trace);
      shootingScript = shootingScriptSchema.parse({
        ...generated.value,
        targetDurationSec: project.targetDurationSec,
        shots: generated.value.shots.map((shot) => ({ ...shot, projectId: project.id, status: "draft" })),
      });
      preflightIssues = inspectShootingScriptPreflight(shootingScript.shots, {
        recommendedMinimumShots: narrativeReadiness.recommendedMinimumShots,
      });
    }
    if (preflightIssues.length) {
      throw new Error(`导演脚本在内部三次生成后仍有付费生成执行问题，未保存问题版本：${preflightIssues.map((issue) => `${issue.code} ${issue.message}`).join("；")}`);
    }
    this.assertShotAssetReferences(assetBible, shootingScript);
    const result = await this.createArtifactVersion(id, "shooting-script", renderShootingScript(shootingScript), {
      structured: shootingScript,
      sourceArtifactId: approvedAssetBible.id,
      metadata: {
        ...generationMetadata(generated.trace, attemptedTraces.slice(0, -1)),
        inputArtifacts: [screenplayRef, assetBibleRef],
        approvedAssetBibleLock: createApprovedAssetBibleLock(approvedAssetBible),
        generationReadiness: narrativeReadiness,
        shotComplexityPolicy: GENERATION_READINESS_POLICY_VERSION,
      },
    });
    await this.syncShotProjection(project, shootingScript);
    return result;
  }

  async generateStoryboard(
    id: string,
    options: { autoRepair?: boolean; maxAutoRepairAttempts?: number; onPhase?: (phase: StoryboardGenerationPhase) => void } = {},
  ): Promise<({ project: Project; artifact: ArtifactWithContent; continuityReview: StoryboardContinuityReviewSummary }) | AutoContinuityRepairResult> {
    const project = await this.requireProject(id);
    this.assertArtifactRoute(project, "storyboard");
    const approvedScreenplay = await this.latestApprovedArtifact(id, "screenplay");
    const approvedAssetBible = await this.latestApprovedArtifact(id, "asset-bible");
    const approvedShootingScript = await this.latestApprovedArtifact(id, "shooting-script");
    if (!approvedScreenplay || !approvedAssetBible?.structuredPath || !approvedShootingScript?.structuredPath) {
      throw new Error("必须先批准剧本、资产定义和导演脚本，才能生成分镜");
    }
    const screenplay = approvedScreenplay.structuredPath
      ? screenplaySchema.parse(JSON.parse(await fs.readFile(approvedScreenplay.structuredPath, "utf8")))
      : await fs.readFile(approvedScreenplay.filePath, "utf8");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    const shootingScript = shootingScriptSchema.parse(JSON.parse(await fs.readFile(approvedShootingScript.structuredPath, "utf8")));
    const shootingScriptRef = `shooting-script-v${String(approvedShootingScript.version).padStart(3, "0")}:${approvedShootingScript.contentHash}`;
    const assetBibleRef = `asset-bible-v${String(approvedAssetBible.version).padStart(3, "0")}:${approvedAssetBible.contentHash}`;
    options.onPhase?.("storyboard");
    const generated = await this.textProvider.generateStoryboard({
      project,
      approvedShootingScript: shootingScript,
      approvedShootingScriptRef: shootingScriptRef,
      approvedAssetBible: assetBible,
      approvedAssetBibleRef: assetBibleRef,
    });
    const storyboard = this.normalizeStoryboardReferences(
      shootingScript,
      storyboardSchema.parse(generated.value),
    );
    this.assertStoryboardCoverage(assetBible, shootingScript, storyboard);
    let result = await this.createArtifactVersion(id, "storyboard", renderStoryboard(storyboard), {
      structured: storyboard,
      sourceArtifactId: approvedShootingScript.id,
      metadata: {
        ...generationMetadata(generated.trace),
        inputArtifacts: [shootingScriptRef, assetBibleRef],
        approvedAssetBibleLock: createApprovedAssetBibleLock(approvedAssetBible),
        continuityReviewStatus: "pending",
        continuityPassed: false,
      },
    });

    options.onPhase?.("continuity");
    let continuityReport: ContinuityReport;
    let continuityTrace: TextGenerationTrace | null = null;
    try {
      const continuity = await this.textProvider.reviewContinuity({
        project: result.project,
        approvedScreenplay: screenplay,
        approvedAssetBible: assetBible,
        approvedAssetBibleRef: assetBibleRef,
        approvedAssetBibleLock: createApprovedAssetBibleLock(approvedAssetBible),
        approvedShootingScript: shootingScript,
        approvedShootingScriptRef: shootingScriptRef,
        storyboard,
      });
      continuityTrace = continuity.trace;
      continuityReport = mergeModelExecutionContinuityReport(
        shootingScript,
        mergePhysicalContinuityReport(shootingScript, storyboard, continuity.value),
      );
      this.assertContinuityCoverage(shootingScript, continuityReport);
    } catch (error) {
      const message = error instanceof Error ? error.message : "连续性检查发生未知错误";
      continuityReport = this.createUnavailableContinuityReport(shootingScript, message);
      result = {
        ...result,
        artifact: await this.attachStoryboardContinuityReport(result.project, result.artifact, shootingScript, continuityReport, null, "failed", message),
      };
      return { ...result, continuityReview: { status: "failed", message } };
    }

    result = {
      ...result,
      artifact: await this.attachStoryboardContinuityReport(result.project, result.artifact, shootingScript, continuityReport, continuityTrace, "completed", null),
    };
    if (options.autoRepair === true && !continuityReport.passed) {
      options.onPhase?.("auto-repair");
      return this.autoRepairContinuity(id, result.artifact.id, { maxAttempts: options.maxAutoRepairAttempts });
    }
    return { ...result, continuityReview: { status: "completed", message: null } };
  }

  async reviewStoryboardContinuity(
    projectId: string,
    storyboardArtifactId: string,
  ): Promise<{ project: Project; artifact: ArtifactWithContent; continuityReview: StoryboardContinuityReviewSummary }> {
    const project = await this.requireProject(projectId);
    if (project.currentStage !== "STORYBOARD_REVIEW") throw new Error("只有分镜审核阶段可以单独重试连续性检查");
    const [row] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, storyboardArtifactId)).limit(1);
    const [latest] = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, "storyboard")))
      .orderBy(desc(artifacts.version)).limit(1);
    if (!row || row.projectId !== projectId || row.type !== "storyboard" || row.status !== "draft" || latest?.id !== row.id || !row.structuredPath) {
      throw new Error("只能复检当前最新的分镜草案");
    }
    const approvedScreenplay = await this.latestApprovedArtifact(projectId, "screenplay");
    const approvedAssetBible = await this.latestApprovedArtifact(projectId, "asset-bible");
    const approvedShootingScript = await this.latestApprovedArtifact(projectId, "shooting-script");
    if (!approvedScreenplay?.structuredPath || !approvedAssetBible?.structuredPath || !approvedShootingScript?.structuredPath) {
      throw new Error("连续性复检所需的已批准剧本、资产定义或导演脚本缺失");
    }
    const [screenplay, assetBible, shootingScript, storyboard, content] = await Promise.all([
      fs.readFile(approvedScreenplay.structuredPath, "utf8").then((value) => screenplaySchema.parse(JSON.parse(value))),
      fs.readFile(approvedAssetBible.structuredPath, "utf8").then((value) => assetBibleSchema.parse(JSON.parse(value))),
      fs.readFile(approvedShootingScript.structuredPath, "utf8").then((value) => shootingScriptSchema.parse(JSON.parse(value))),
      fs.readFile(row.structuredPath, "utf8").then((value) => storyboardSchema.parse(JSON.parse(value))),
      fs.readFile(row.filePath, "utf8"),
    ]);
    const artifact = { ...mapArtifactRow(row), content };
    const assetBibleRef = `asset-bible-v${String(approvedAssetBible.version).padStart(3, "0")}:${approvedAssetBible.contentHash}`;
    const shootingScriptRef = `shooting-script-v${String(approvedShootingScript.version).padStart(3, "0")}:${approvedShootingScript.contentHash}`;
    try {
      const continuity = await this.textProvider.reviewContinuity({
        project,
        approvedScreenplay: screenplay,
        approvedAssetBible: assetBible,
        approvedAssetBibleRef: assetBibleRef,
        approvedAssetBibleLock: createApprovedAssetBibleLock(approvedAssetBible),
        approvedShootingScript: shootingScript,
        approvedShootingScriptRef: shootingScriptRef,
        storyboard,
      });
      const report = mergeModelExecutionContinuityReport(
        shootingScript,
        mergePhysicalContinuityReport(shootingScript, storyboard, continuity.value),
      );
      this.assertContinuityCoverage(shootingScript, report);
      const updated = await this.attachStoryboardContinuityReport(project, artifact, shootingScript, report, continuity.trace, "completed", null);
      return { project, artifact: updated, continuityReview: { status: "completed", message: null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : "连续性检查发生未知错误";
      const report = this.createUnavailableContinuityReport(shootingScript, message);
      const updated = await this.attachStoryboardContinuityReport(project, artifact, shootingScript, report, null, "failed", message);
      return { project, artifact: updated, continuityReview: { status: "failed", message } };
    }
  }

  private createUnavailableContinuityReport(shootingScript: ShootingScript, message: string): ContinuityReport {
    const checkedShotIds = shootingScript.shots.map((shot) => shot.id);
    return continuityReportSchema.parse({
      checkedShotIds,
      issues: [{
        severity: "error",
        code: "CONTINUITY_REVIEW_UNAVAILABLE",
        message: `模型连续性检查未完成：${message.slice(0, 500)}`,
        affectedIds: checkedShotIds,
        suggestedFix: "只重试连续性检查；分镜草案已经保留，不要重新生成分镜。",
        requiresReapproval: false,
      }],
      passed: false,
      uncheckedClaims: ["模型连续性检查尚未完成；当前分镜不得批准或进入视频生成。"],
    });
  }

  private async attachStoryboardContinuityReport(
    project: Project,
    artifact: ArtifactWithContent,
    shootingScript: ShootingScript,
    continuityReport: ContinuityReport,
    continuityTrace: TextGenerationTrace | null,
    status: "completed" | "failed",
    failureMessage: string | null,
  ): Promise<ArtifactWithContent> {
    const previousAttempts = Array.isArray(artifact.metadata.continuityReviewAttempts)
      ? artifact.metadata.continuityReviewAttempts as unknown[]
      : [];
    const attempt = previousAttempts.length + 1;
    const stem = `continuity-storyboard-v${String(artifact.version).padStart(3, "0")}-attempt-${String(attempt).padStart(3, "0")}`;
    const reportPath = path.join(project.projectDir, "qa", `${stem}.md`);
    const reportStructuredPath = path.join(project.projectDir, "qa", `${stem}.json`);
    if (!isInside(project.projectDir, reportPath) || !isInside(project.projectDir, reportStructuredPath)) throw new Error("连续性报告路径越界");
    await fs.writeFile(reportPath, renderContinuityReport(continuityReport), { encoding: "utf8", flag: "wx" });
    try {
      await fs.writeFile(reportStructuredPath, `${JSON.stringify(continuityReport, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      const modelExecutionIssues = inspectShootingScriptPreflight(shootingScript.shots);
      const traceMetadata = continuityTrace ? generationMetadata(continuityTrace) : null;
      const currentSkills = Array.isArray(artifact.metadata.skills) ? artifact.metadata.skills as Array<Record<string, unknown>> : [];
      const addedSkills = traceMetadata && Array.isArray(traceMetadata.skills) ? traceMetadata.skills as Array<Record<string, unknown>> : [];
      const skills = [...new Map([...currentSkills, ...addedSkills].map((skill) => [`${String(skill.name)}:${String(skill.sha256)}`, skill])).values()];
      const relatedRuns = Array.isArray(artifact.metadata.relatedRuns) ? artifact.metadata.relatedRuns as unknown[] : [];
      if (continuityTrace) relatedRuns.push({
        runId: continuityTrace.runId,
        threadId: continuityTrace.threadId,
        usage: continuityTrace.usage,
        eventTypes: continuityTrace.eventTypes,
        schema: continuityTrace.schemaVersion,
        route: continuityTrace.route,
        completedAt: continuityTrace.completedAt,
      });
      const updatedAt = new Date().toISOString();
      const metadata: Record<string, unknown> = {
        ...artifact.metadata,
        skills,
        relatedRuns,
        continuityReviewStatus: status,
        continuityReviewError: failureMessage,
        continuityReviewAttempts: [...previousAttempts, {
          attempt,
          status,
          reportPath,
          reportStructuredPath,
          runId: continuityTrace?.runId ?? null,
          message: failureMessage,
          completedAt: updatedAt,
        }],
        continuityReportPath: reportPath,
        continuityReportStructuredPath: reportStructuredPath,
        continuityPassed: continuityReport.passed,
        continuityIssueCount: continuityReport.issues.length,
        verification: {
          policyVersion: GENERATION_READINESS_POLICY_VERSION,
          structuralConsistency: continuityReport.passed ? "passed" : "blocked",
          modelExecutability: modelExecutionIssues.length ? "blocked" : "passed",
          visualResult: "not-run",
          modelExecutionIssues,
        },
      };
      await this.studio.db.update(artifacts).set({ metadata, updatedAt }).where(eq(artifacts.id, artifact.id));
      return { ...artifact, metadata, updatedAt };
    } catch (error) {
      await Promise.all([fs.rm(reportPath, { force: true }), fs.rm(reportStructuredPath, { force: true })]);
      throw error;
    }
  }

  async recordDecision(input: {
    projectId: string;
    stage: ProjectStage;
    decision: "approved" | "rejected";
    artifactId?: string;
    artifactPath?: string;
    artifactVersion?: number;
    comment?: string;
  }): Promise<{ project: Project; approval: ApprovalRecord }> {
    const project = await this.requireProject(input.projectId);
    if (project.currentStage !== input.stage) throw new Error(`项目当前阶段为 ${project.currentStage}，不能审批 ${input.stage}`);
    if (!input.stage.endsWith("_REVIEW")) throw new Error("只有 REVIEW 阶段可以审批");

    const managedType: ArtifactType | null = artifactTypeByReviewStage[input.stage] ?? null;
    if (!managedType) {
      throw new Error("该阶段有独立审核流程，不能使用通用产物批准/驳回接口");
    }
    let managedArtifact: Artifact | null = null;
    let artifactPath: string;
    let artifactVersion: number;
    if (managedType) {
      if (!input.artifactId) throw new Error("必须选择要审批的产物版本");
      const [row] = await this.studio.db.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1);
      if (!row || row.projectId !== project.id || row.type !== managedType) throw new Error("审批产物与当前阶段不匹配");
      const [latest] = await this.studio.db.select().from(artifacts)
        .where(and(eq(artifacts.projectId, project.id), eq(artifacts.type, managedType)))
        .orderBy(desc(artifacts.version)).limit(1);
      if (!latest || latest.id !== row.id) throw new Error("只能审批当前最新版本");
      managedArtifact = mapArtifactRow(row);
      if (managedArtifact.status !== "draft") {
        if (managedArtifact.status === "rejected") throw new Error("该版本已被驳回，必须修改或重新生成新版本后才能审批");
        throw new Error(`该版本当前状态为 ${managedArtifact.status}，不能重复审批`);
      }
      if (input.decision === "rejected" && !input.comment?.trim()) {
        throw new Error("驳回时必须填写修改意见");
      }
      if (input.decision === "approved" && (managedType === "outline" || managedType === "screenplay")) {
        if (!managedArtifact.structuredPath) {
          if (!input.comment?.trim()) {
            throw new Error(`${managedType === "outline" ? "剧情大纲" : "影视剧本"}是人工文本版本，缺少结构化复杂度数据；请在审批意见中明确确认该人工版本后再批准`);
          }
        } else {
          const structured = JSON.parse(await fs.readFile(managedArtifact.structuredPath, "utf8")) as unknown;
          const readiness = managedType === "outline"
            ? inspectOutlineFeasibility(storyOutlineSchema.parse(structured), project.targetDurationSec)
            : inspectScreenplayFeasibility(screenplaySchema.parse(structured), project.targetDurationSec);
          if (readiness.status === "blocked") {
            throw new Error(`当前${managedType === "outline" ? "大纲" : "剧本"}不能进入付费生产链：${readiness.issues.map((issue) => `${issue.message} ${issue.suggestedFix}`).join("；")}`);
          }
          if (readiness.acknowledgementRequired && !input.comment?.trim()) {
            throw new Error(`当前${managedType === "outline" ? "大纲" : "剧本"}仍有需要人工确认的选择；请在审批意见中明确采用方案后再批准：${readiness.acknowledgementReasons.slice(0, 4).join("；")}`);
          }
        }
      }
      if (input.decision === "approved" && managedType === "storyboard") {
        const continuityReport = await this.readContinuityReport(project.id, managedArtifact.id);
        if (!continuityReport.passed || managedArtifact.metadata.continuityPassed !== true) {
          throw new Error("连续性检查尚未通过，或分镜元数据与实际报告不一致，不能批准当前分镜版本");
        }
        const verification = managedArtifact.metadata.verification;
        if (!verification || typeof verification !== "object" || (verification as Record<string, unknown>).modelExecutability !== "passed") {
          throw new Error("模型可执行性检查尚未通过，不能批准当前分镜版本；结构一致性通过不代表可以安全付费生成");
        }
        const currentModelIssues = inspectShootingScriptPreflight(await this.listShots(project.id));
        if (currentModelIssues.length) {
          throw new Error(`当前导演脚本未通过最新付费生成门禁，不能批准分镜：${currentModelIssues.map((issue) => `${issue.code} ${issue.message}`).join("；")}`);
        }
      }
      if (input.decision === "approved" && managedType === "asset-bible") {
        const readinessIssues = await this.assetReadinessIssues(project, await this.listAssets(project.id));
        if (readinessIssues.length) {
          throw new Error(`资产定义不能批准：仍有 ${readinessIssues.length} 项制作缺口。${readinessIssues.slice(0, 8).join("；")}。请选择原创完整设定重新生成，或上传参考图后再批准。`);
        }
      }
      if (input.decision === "approved" && managedType === "shooting-script") {
        const [currentShots, capabilities] = await Promise.all([this.listShots(project.id), this.loadH3Capabilities()]);
        const durationMinSec = h3ProductDurationMin(capabilities.durationMinSec);
        const durationMaxSec = Math.floor(capabilities.durationMaxSec);
        const incompatible = currentShots.filter((shot) =>
          !isH3ProductDurationCompatible(shot.durationSec, capabilities.durationMinSec, capabilities.durationMaxSec)
          || !Number.isInteger(shot.startTimeSec)
          || !Number.isInteger(shot.endTimeSec));
        if (incompatible.length) {
          const details = incompatible.map((shot) => `${shot.id}=${shot.durationSec}秒`).join("、");
          const maximum = Math.floor(project.targetDurationSec / durationMinSec);
          throw new Error(`导演脚本不能批准：当前产品规则要求每镜 ${durationMinSec}–${durationMaxSec} 的整数秒；不兼容镜头：${details}。${project.targetDurationSec} 秒项目最多建议 ${maximum} 镜，请驳回并重新生成。`);
        }
        const readinessMetadata = managedArtifact.metadata.generationReadiness;
        const recommendedMinimumShots = readinessMetadata && typeof readinessMetadata === "object"
          ? Number((readinessMetadata as Record<string, unknown>).recommendedMinimumShots)
          : undefined;
        const modelExecutionIssues = inspectShootingScriptPreflight(currentShots, {
          recommendedMinimumShots: Number.isInteger(recommendedMinimumShots) ? recommendedMinimumShots : undefined,
        });
        if (modelExecutionIssues.length) {
          throw new Error(`导演脚本不能批准：仍有 ${modelExecutionIssues.length} 项付费生成执行问题。${modelExecutionIssues.map((issue) => `${issue.code} ${issue.message}`).join("；")}`);
        }
      }
      artifactPath = row.filePath;
      artifactVersion = row.version;
    } else {
      artifactPath = input.artifactPath ? path.resolve(project.projectDir, input.artifactPath) : project.sourcePath;
      artifactVersion = input.artifactVersion ?? 1;
    }
    if (!isInside(project.projectDir, artifactPath)) throw new Error("审批文件必须位于项目目录内");
    const artifactBytes = await fs.readFile(artifactPath);
    const currentHash = createHash("sha256").update(artifactBytes).digest("hex");
    if (managedArtifact && currentHash !== managedArtifact.contentHash) throw new Error("产物文件已在数据库外被修改，请另存为新版本后再审批");
    const approval = approvalRecordSchema.parse({
      id: randomUUID(), projectId: project.id, stage: input.stage, artifactPath, artifactHash: currentHash,
      artifactVersion, decision: input.decision, comment: input.comment ?? null, createdAt: new Date().toISOString(),
    });
    await this.studio.db.insert(approvals).values(approval);
    if (managedArtifact) {
      await this.studio.db.update(artifacts).set({ status: input.decision, updatedAt: approval.createdAt }).where(eq(artifacts.id, managedArtifact.id));
      if (managedType === "asset-bible") {
        await this.studio.db.update(assetRecords).set({ approved: input.decision === "approved" })
          .where(and(eq(assetRecords.projectId, project.id), eq(assetRecords.version, managedArtifact.version)));
      }
      if (managedType === "shooting-script") {
        await this.studio.db.update(shots).set({ status: input.decision === "approved" ? "approved" : "rejected" })
          .where(eq(shots.projectId, project.id));
      }
    }

    let updated = project;
    if (input.decision === "approved") {
      const target = nextStage(project.currentStage);
      if (!target || !target.endsWith("_APPROVED")) throw new Error("当前审核阶段没有对应的批准状态");
      updated = await this.transition(project, target, "stage.approved");
    } else {
      await this.appendLog(project.projectDir, "workflow.log.jsonl", {
        type: "stage.rejected", projectId: project.id, stage: project.currentStage, approvalId: approval.id,
        artifactId: managedArtifact?.id, createdAt: approval.createdAt,
      });
    }
    return { project: updated, approval };
  }

  private async syncAssetProjection(project: Project, version: number, assetBible: AssetBible): Promise<void> {
    const previousRows = await this.studio.db.select().from(assetRecords).where(eq(assetRecords.projectId, project.id));
    const previousVersion = previousRows.reduce((latest, row) => Math.max(latest, row.version), 0);
    const previousById = new Map(previousRows
      .filter((row) => row.version === previousVersion)
      .map((row) => [row.id, assetSchema.parse({
        ...row.payload,
        id: row.id,
        projectId: row.projectId,
        type: row.type,
        name: row.name,
        version: row.version,
        approved: row.approved,
      })]));
    const projectedAssets = assetBible.assets.map((logical) => {
      const previous = previousById.get(logical.id);
      const reusableReference = previous?.type === logical.type
        && referenceCompatibilityKey(previous) === referenceCompatibilityKey(logical)
        ? previous
        : null;
      return assetSchema.parse({
        ...logical,
        projectId: project.id,
        version,
        localFiles: reusableReference?.localFiles ?? [],
        sha256: reusableReference?.sha256 ?? [],
        approved: false,
        authorizationState: reusableReference?.authorizationState ?? "unknown",
        uploadState: {},
        referencedBy: [],
        fileRoles: reusableReference?.fileRoles ?? [],
        referencePrompts: reusableReference?.referencePrompts ?? [],
        designBasis: reusableReference?.localFiles.length ? "reference-guided" : logical.designBasis,
        productionReady: logical.productionReady || Boolean(reusableReference?.localFiles.length),
      });
    });
    this.studio.db.transaction((transaction) => {
      transaction.update(assetRecords).set({ approved: false }).where(eq(assetRecords.projectId, project.id)).run();
      for (const asset of projectedAssets) transaction.insert(assetRecords).values({
        id: asset.id,
        projectId: asset.projectId,
        type: asset.type,
        name: asset.name,
        version: asset.version,
        payload: asset,
        approved: false,
      }).run();
    });
  }

  private async requireCurrentAssetRow(projectId: string, assetId: string): Promise<typeof assetRecords.$inferSelect> {
    const rows = await this.studio.db.select().from(assetRecords).where(eq(assetRecords.projectId, projectId));
    const currentVersion = rows.reduce((latest, row) => Math.max(latest, row.version), 0);
    const row = rows.find((candidate) => candidate.id === assetId && candidate.version === currentVersion);
    if (!row) throw new Error("资产不存在于当前资产定义版本");
    return row;
  }

  private async syncShotProjection(project: Project, shootingScript: ShootingScript): Promise<void> {
    const projectedShots = shootingScript.shots.map((candidate) =>
      shotSpecSchema.parse({ ...candidate, projectId: project.id, status: "draft" }));
    this.studio.db.transaction((transaction) => {
      transaction.delete(shots).where(eq(shots.projectId, project.id)).run();
      for (const shot of projectedShots) transaction.insert(shots).values({
        id: shot.id,
        projectId: project.id,
        sequence: shot.sequence,
        payload: shot,
        status: shot.status,
      }).run();
    });
  }

  private continuityRepairContextFromArtifact(artifact: Artifact): ContinuityRepairContext {
    const parsed = continuityRepairContextSchema.safeParse(artifact.metadata.continuityRepair);
    if (!parsed.success) throw new Error("当前批准版本不属于连续性定点修复流程");
    return parsed.data;
  }

  private async createTargetedShootingScriptRepair(
    project: Project,
    context: ContinuityRepairContext,
    report: ContinuityReport,
    signal?: AbortSignal,
    workflowMode: "legacy" | "agent-first" = "legacy",
  ): Promise<ContinuityRepairResult> {
    const [sourceStoryboardRow] = workflowMode === "agent-first"
      ? await this.studio.db.select().from(artifacts).where(eq(artifacts.id, context.sourceStoryboardArtifactId)).limit(1)
      : [];
    const [sourceShootingRow] = sourceStoryboardRow?.sourceArtifactId
      ? await this.studio.db.select().from(artifacts).where(eq(artifacts.id, sourceStoryboardRow.sourceArtifactId)).limit(1)
      : [];
    const exactSourceShooting = sourceShootingRow?.projectId === project.id && sourceShootingRow.type === "shooting-script" && sourceShootingRow.structuredPath
      ? mapArtifactRow(sourceShootingRow)
      : null;
    const latestRow = workflowMode === "agent-first"
      ? exactSourceShooting ?? await this.approvedHeadArtifact(project.id, "shooting-script") ?? await this.latestApprovedArtifact(project.id, "shooting-script")
      : (await this.studio.db.select().from(artifacts)
        .where(and(eq(artifacts.projectId, project.id), eq(artifacts.type, "shooting-script")))
        .orderBy(desc(artifacts.version)).limit(1))[0];
    if (!latestRow?.structuredPath) throw new Error("没有可定点修复的已批准 Head 导演脚本");
    const current = shootingScriptSchema.parse(JSON.parse(await fs.readFile(latestRow.structuredPath, "utf8")));
    const timingIssues = report.issues.filter((issue) => issue.severity !== "info" && continuityRepairKind(issue.code) === "shooting-timing");
    const soundSyncIssues = report.issues.filter((issue) => issue.severity !== "info" && continuityRepairKind(issue.code) === "shooting-sound-sync");
    const orientationIssues = report.issues.filter((issue) => issue.severity !== "info" && continuityRepairKind(issue.code) === "shooting-orientation-state");
    const causalVisibilityIssues = report.issues.filter((issue) => issue.severity !== "info" && continuityRepairKind(issue.code) === "shooting-causal-visibility");
    const propHandoffIssues = report.issues.filter((issue) => issue.severity !== "info" && continuityRepairKind(issue.code) === "shooting-prop-handoff");
    const versionLockIssues = report.issues.filter((issue) => issue.severity !== "info" && continuityRepairKind(issue.code) === "asset-version-lock");
    const genericShootingIssues = report.issues.filter((issue) => issue.severity !== "info" && continuityRepairKindForIssue(issue) === "generic-shooting-script");
    const approvedAssetBible = workflowMode === "agent-first"
      ? await this.approvedHeadArtifact(project.id, "asset-bible") ?? await this.latestApprovedArtifact(project.id, "asset-bible")
      : await this.latestApprovedArtifact(project.id, "asset-bible");
    if (!approvedAssetBible?.structuredPath) throw new Error("必须先批准定点修复后的资产定义");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    const assetBibleLock = createApprovedAssetBibleLock(approvedAssetBible);
    const changedShotIds = new Set<string>();
    let genericRepairTrace: TextGenerationTrace | null = null;
    let repairBase = current;
    if (genericShootingIssues.length) {
      if (!this.textProvider.repairShootingScript) throw new Error("当前文本 Provider 不支持通用导演脚本定点修复");
      const affectedShotIds = new Set(genericShootingIssues.flatMap((issue) => issue.affectedIds).filter((id) => current.shots.some((shot) => shot.id === id)));
      if (!affectedShotIds.size) throw new Error("连续性报告提供了修复建议，但没有指出可安全修改的导演镜头 ID");
      const generated = await this.textProvider.repairShootingScript({
        project,
        currentShootingScript: current,
        approvedAssetBible: assetBible,
        approvedAssetBibleRef: assetBibleLock.reference,
        issues: genericShootingIssues,
      });
      assertContinuityRepairActive(signal);
      genericRepairTrace = generated.trace;
      const candidate = shootingScriptSchema.parse(generated.value);
      const candidatesById = new Map(candidate.shots.map((shot) => [shot.id, shot]));
      repairBase = shootingScriptSchema.parse({
        ...current,
        shots: current.shots.map((shot) => {
          if (!affectedShotIds.has(shot.id)) return shot;
          const replacement = candidatesById.get(shot.id);
          if (!replacement) throw new Error(`通用定点修复没有返回受影响镜头 ${shot.id}`);
          changedShotIds.add(shot.id);
          return {
            ...replacement,
            id: shot.id,
            projectId: shot.projectId,
            startTimeSec: shot.startTimeSec,
            endTimeSec: shot.endTimeSec,
            durationSec: shot.durationSec,
            sceneId: shot.sceneId,
            characterIds: shot.characterIds,
            propIds: shot.propIds,
            styleIds: shot.styleIds,
            status: "draft" as const,
          };
        }),
      });
    }
    const shotIndexById = new Map(repairBase.shots.map((shot, index) => [shot.id, index]));
    const repairedShots = repairBase.shots.map((shot) => {
      let action = shot.action;
      let sound = [...shot.sound];
      let startState = shot.startState;
      let endState = shot.endState;
      let physicalPlan = shot.physicalPlan;
      for (const issue of timingIssues.filter((candidate) => candidate.affectedIds.includes(shot.id))) {
        const updated = repairTimingText(action, issue, shot.endTimeSec);
        if (updated === action) throw new Error(`${issue.code} 指向 ${shot.id}，但动作文本中没有可安全替换的歧义时间段`);
        action = updated;
        changedShotIds.add(shot.id);
      }
      for (const issue of soundSyncIssues.filter((candidate) => candidate.affectedIds.includes(shot.id))) {
        const updated = sound.map((item) => repairSoundTimingText(item, issue));
        if (JSON.stringify(updated) === JSON.stringify(sound)) throw new Error(`${issue.code} 指向 ${shot.id}，但声音说明中没有可安全替换的冲突时间码`);
        sound = updated;
        changedShotIds.add(shot.id);
      }
      for (const issue of orientationIssues.filter((candidate) => candidate.affectedIds.includes(shot.id))) {
        const affectedShotIds = issue.affectedIds
          .filter((id) => shotIndexById.has(id))
          .sort((left, right) => (shotIndexById.get(left) ?? 0) - (shotIndexById.get(right) ?? 0));
        if (affectedShotIds[0] === shot.id) {
          endState = appendUniqueText(endState, `人物朝向边界锁定：${issue.suggestedFix}`);
        } else {
          startState = appendUniqueText(startState, `人物朝向边界锁定：${issue.suggestedFix}`);
        }
        changedShotIds.add(shot.id);
      }
      for (const issue of causalVisibilityIssues.filter((candidate) => candidate.affectedIds.includes(shot.id))) {
        action = repairCausalRevealText(action, issue);
        const [partialRevealSec, clearRevealSec] = issueTimes(issue);
        if (physicalPlan && partialRevealSec != null && clearRevealSec != null) {
          physicalPlan = {
            ...physicalPlan,
            timedStateGates: physicalPlan.timedStateGates.map((gate) => {
              if (Math.abs(gate.startsAtOffsetSec - partialRevealSec) < 0.001 && /(?:打开|分离)|门缝/u.test(gate.afterState)) {
                return { ...gate, afterState: appendUniqueText(gate.afterState, "门缝形成时直连空间同步首次部分显露") };
              }
              if (Math.abs(gate.startsAtOffsetSec - clearRevealSec) < 0.001 && /遮挡|不可见|显露|露出/u.test(`${gate.beforeState} ${gate.afterState}`)) {
                return { ...gate, beforeState: "门缝已经部分显露直连空间，但主体尚不可清晰辨认", afterState: "门缝扩大，主体首次清晰可辨" };
              }
              return gate;
            }),
            subjectOrientations: physicalPlan.subjectOrientations.map((orientation) => orientation.startOffsetSec < clearRevealSec && orientation.endOffsetSec > partialRevealSec && /群体|CROWD/u.test(orientation.gazeTarget)
              ? { ...orientation, headFaces: "逐渐打开的门缝与部分显露的直连空间", gazeTarget: `${clearRevealSec}秒前只观察门缝与空间轮廓，不锁定尚不可清晰辨认的群体` }
              : orientation),
            feasibilityNotes: uniqueStrings([...physicalPlan.feasibilityNotes, `物理显露关系已锁定：${partialRevealSec}秒门缝形成即部分显露，${clearRevealSec}秒主体才首次清晰可辨。`]),
          };
        }
        changedShotIds.add(shot.id);
      }
      for (const issue of propHandoffIssues.filter((candidate) => candidate.affectedIds.includes(shot.id))) {
        const planText = physicalPlan ? JSON.stringify(physicalPlan) : "";
        if (!/低位(?:持握|握持|持机)?/u.test(`${action} ${startState} ${endState} ${planText}`)) continue;
        action = repairPropHandoffText(action, issue);
        startState = repairPropHandoffText(startState, issue);
        endState = endState.replace(/低位(?:持握|握持|持机)?/gu, "承接上一镜结束时的胸口阅读高度持握");
        if (physicalPlan) {
          physicalPlan = {
            ...physicalPlan,
            entities: physicalPlan.entities.map((entity) => ({ ...entity, role: entity.role.replace(/低位(?:持握|握持|持机)?/gu, "承接上一镜结束时的胸口阅读高度持握") })),
            feasibilityNotes: physicalPlan.feasibilityNotes.map((note) => note.replace(/低位(?:持握|握持|持机)?/gu, "承接上一镜结束时的胸口阅读高度持握")),
          };
        }
        changedShotIds.add(shot.id);
      }
      return { ...shot, action, sound, startState, endState, physicalPlan, status: "draft" as const };
    });
    const affectedAssetIds = report.issues
      .filter((issue) => {
        const kind = continuityRepairKind(issue.code);
        return kind === "asset-aspect" || kind === "asset-mirror-parity";
      })
      .flatMap((issue) => issue.affectedIds)
      .filter((id) => /^(?:STYLE|SCENE|PROP|CHAR|COSTUME)-\d{3}$/.test(id));
    const validationNotes = repairBase.validationNotes.filter((note) => note.code !== "CONTINUITY_TARGETED_REBASE" && note.code !== "APPROVED_ASSET_BIBLE_VERSION_LOCK");
    validationNotes.push({
      severity: "info",
      code: "CONTINUITY_TARGETED_REBASE",
      message: changedShotIds.size
        ? `仅修复 ${[...changedShotIds].join("、")} 的连续性报告点名问题，并依据最新批准资产重新校验；其余镜头保持不变。`
        : `镜头内容保持不变，仅依据已修复并批准的资产 ${[...new Set(affectedAssetIds)].join("、") || "定义"} 建立新的审批版本。`,
      affectedIds: [...new Set([...changedShotIds, ...affectedAssetIds])],
    });
    if (versionLockIssues.length) {
      validationNotes.push({
        severity: "info",
        code: "APPROVED_ASSET_BIBLE_VERSION_LOCK",
        message: `导演脚本已锁定 ${assetBibleLock.reference}（artifact ${assetBibleLock.artifactId}），后续分镜必须绑定同一版本。`,
        affectedIds: uniqueStrings(versionLockIssues.flatMap((issue) => issue.affectedIds)),
      });
    }
    const repaired = shootingScriptSchema.parse({ ...repairBase, shots: repairedShots, validationNotes });
    this.assertShotAssetReferences(assetBible, repaired);
    assertContinuityRepairActive(signal);
    const result = await this.createArtifactVersion(project.id, "shooting-script", renderShootingScript(repaired), {
      structured: repaired,
      sourceArtifactId: latestRow.id,
      workflowMode,
      metadata: {
        ...(genericRepairTrace ? generationMetadata(genericRepairTrace) : {}),
        origin: "continuity-targeted-repair",
        continuityRepair: context,
        continuityRepairNext: "storyboard",
        fixedIssueCodes: [...timingIssues, ...soundSyncIssues, ...orientationIssues, ...causalVisibilityIssues, ...propHandoffIssues, ...versionLockIssues, ...genericShootingIssues].map((issue) => issue.code),
        changedShotIds: [...changedShotIds],
        rebasedAssetIds: [...new Set(affectedAssetIds)],
        approvedAssetBibleLock: assetBibleLock,
      },
    });
    if (workflowMode !== "agent-first") await this.syncShotProjection(project, repaired);
    const supportedCodes = new Set([
      ...report.issues.filter((issue) => {
        const kind = continuityRepairKind(issue.code);
        return kind === "asset-aspect" || kind === "asset-mirror-parity";
      }).map((issue) => issue.code),
      ...timingIssues.map((issue) => issue.code),
      ...soundSyncIssues.map((issue) => issue.code),
      ...orientationIssues.map((issue) => issue.code),
      ...causalVisibilityIssues.map((issue) => issue.code),
      ...propHandoffIssues.map((issue) => issue.code),
      ...versionLockIssues.map((issue) => issue.code),
      ...genericShootingIssues.map((issue) => issue.code),
    ]);
    return {
      ...result,
      repair: {
        fixedIssueCodes: [...timingIssues, ...soundSyncIssues, ...orientationIssues, ...causalVisibilityIssues, ...propHandoffIssues, ...versionLockIssues, ...genericShootingIssues].map((issue) => issue.code),
        remainingIssueCodes: context.issueCodes.filter((code) => !supportedCodes.has(code)),
        nextTarget: "shooting-script",
      },
    };
  }

  private async createTargetedStoryboardRepair(
    project: Project,
    context: ContinuityRepairContext,
    previousReport: ContinuityReport,
    signal?: AbortSignal,
    workflowMode: "legacy" | "agent-first" = "legacy",
  ): Promise<ContinuityRepairResult> {
    const [sourceStoryboardRow] = await this.studio.db.select().from(artifacts)
      .where(eq(artifacts.id, context.sourceStoryboardArtifactId)).limit(1);
    if (!sourceStoryboardRow?.structuredPath || sourceStoryboardRow.projectId !== project.id || sourceStoryboardRow.type !== "storyboard") {
      throw new Error("定点修复来源分镜不存在");
    }
    const current = storyboardSchema.parse(JSON.parse(await fs.readFile(sourceStoryboardRow.structuredPath, "utf8")));
    const resolveApproved = (type: ArtifactType) => workflowMode === "agent-first"
      ? this.approvedHeadArtifact(project.id, type).then((artifact) => artifact ?? this.latestApprovedArtifact(project.id, type))
      : this.latestApprovedArtifact(project.id, type);
    const [approvedScreenplay, approvedAssetBible, approvedShootingScript] = await Promise.all([
      resolveApproved("screenplay"),
      resolveApproved("asset-bible"),
      resolveApproved("shooting-script"),
    ]);
    if (!approvedScreenplay || !approvedAssetBible?.structuredPath || !approvedShootingScript?.structuredPath) {
      throw new Error("必须先批准定点修复后的资产定义和导演脚本");
    }
    const screenplay = approvedScreenplay.structuredPath
      ? screenplaySchema.parse(JSON.parse(await fs.readFile(approvedScreenplay.structuredPath, "utf8")))
      : await fs.readFile(approvedScreenplay.filePath, "utf8");
    const assetBible = assetBibleSchema.parse(JSON.parse(await fs.readFile(approvedAssetBible.structuredPath, "utf8")));
    const shootingScript = shootingScriptSchema.parse(JSON.parse(await fs.readFile(approvedShootingScript.structuredPath, "utf8")));
    const assetBibleLock = createApprovedAssetBibleLock(approvedAssetBible);
    const shootingScriptRef = `shooting-script-v${String(approvedShootingScript.version).padStart(3, "0")}:${approvedShootingScript.contentHash}`;
    const repairResult = repairStoryboardContinuityIssues(current, previousReport.issues, project.aspectRatio, assetBibleLock.reference, shootingScript);
    const genericStoryboardIssues = previousReport.issues.filter((issue) => {
      if (issue.severity === "info") return false;
      const kind = continuityRepairKindForIssue(issue);
      return kind === "generic-storyboard" || kind === "generic-shooting-script";
    });
    let genericRepairTrace: TextGenerationTrace | null = null;
    let repairedCandidate = repairResult.storyboard;
    const changedShotIds = new Set(repairResult.changedShotIds);
    if (genericStoryboardIssues.length) {
      if (!this.textProvider.repairStoryboard) throw new Error("当前文本 Provider 不支持通用分镜定点修复");
      const affectedShotIds = new Set(genericStoryboardIssues.flatMap((issue) => issue.affectedIds).filter((id) => repairedCandidate.shots.some((shot) => shot.shotId === id)));
      if (!affectedShotIds.size) throw new Error("连续性报告提供了修复建议，但没有指出可安全修改的分镜 ID");
      const generated = await this.textProvider.repairStoryboard({
        project,
        currentStoryboard: repairedCandidate,
        approvedShootingScript: shootingScript,
        approvedShootingScriptRef: shootingScriptRef,
        approvedAssetBible: assetBible,
        approvedAssetBibleRef: assetBibleLock.reference,
        issues: genericStoryboardIssues,
      });
      assertContinuityRepairActive(signal);
      genericRepairTrace = generated.trace;
      const candidate = storyboardSchema.parse(generated.value);
      const candidatesById = new Map(candidate.shots.map((shot) => [shot.shotId, shot]));
      repairedCandidate = storyboardSchema.parse({
        ...repairedCandidate,
        shots: repairedCandidate.shots.map((shot) => {
          if (!affectedShotIds.has(shot.shotId)) return shot;
          const replacement = candidatesById.get(shot.shotId);
          if (!replacement) throw new Error(`通用定点修复没有返回受影响分镜 ${shot.shotId}`);
          changedShotIds.add(shot.shotId);
          return {
            ...replacement,
            shotId: shot.shotId,
            characterIds: shot.characterIds,
            sceneId: shot.sceneId,
            requiredAssetIds: shot.requiredAssetIds,
            approved: false,
          };
        }),
      });
    }
    const repaired = this.normalizeStoryboardReferences(shootingScript, repairedCandidate);
    this.assertStoryboardCoverage(assetBible, shootingScript, repaired);
    const continuity = await this.textProvider.reviewContinuity({
      project,
      approvedScreenplay: screenplay,
      approvedAssetBible: assetBible,
      approvedAssetBibleRef: assetBibleLock.reference,
      approvedAssetBibleLock: assetBibleLock,
      approvedShootingScript: shootingScript,
      approvedShootingScriptRef: shootingScriptRef,
      storyboard: repaired,
    });
    assertContinuityRepairActive(signal);
    const continuityReport = mergeModelExecutionContinuityReport(
      shootingScript,
      mergePhysicalContinuityReport(shootingScript, repaired, continuity.value),
    );
    this.assertContinuityCoverage(shootingScript, continuityReport);
    const modelExecutionIssues = inspectShootingScriptPreflight(shootingScript.shots);
    const verification = {
      policyVersion: GENERATION_READINESS_POLICY_VERSION,
      structuralConsistency: continuityReport.passed ? "passed" : "blocked",
      modelExecutability: modelExecutionIssues.length ? "blocked" : "passed",
      visualResult: "not-run",
      modelExecutionIssues,
    } as const;
    const existing = await this.listArtifacts(project.id, "storyboard");
    const nextVersion = (existing[0]?.version ?? 0) + 1;
    const reportStem = `continuity-storyboard-v${String(nextVersion).padStart(3, "0")}`;
    const reportPath = path.join(project.projectDir, "qa", `${reportStem}.md`);
    const reportStructuredPath = path.join(project.projectDir, "qa", `${reportStem}.json`);
    if (!isInside(project.projectDir, reportPath) || !isInside(project.projectDir, reportStructuredPath)) throw new Error("连续性报告路径越界");
    await fs.writeFile(reportPath, renderContinuityReport(continuityReport), { encoding: "utf8", flag: "wx" });
    try {
      await fs.writeFile(reportStructuredPath, `${JSON.stringify(continuityReport, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      assertContinuityRepairActive(signal);
      const result = await this.createArtifactVersion(project.id, "storyboard", renderStoryboard(repaired), {
        structured: repaired,
        sourceArtifactId: approvedShootingScript.id,
        workflowMode,
        metadata: {
          ...generationMetadata(continuity.trace, genericRepairTrace ? [genericRepairTrace] : []),
          origin: "continuity-targeted-repair",
          continuityRepair: context,
          fixedIssueCodes: [...repairResult.fixedIssueCodes, ...genericStoryboardIssues.map((issue) => issue.code)],
          changedShotIds: [...changedShotIds],
          approvedAssetBibleLock: assetBibleLock,
          continuityReportPath: reportPath,
          continuityReportStructuredPath: reportStructuredPath,
          continuityPassed: continuityReport.passed,
          continuityIssueCount: continuityReport.issues.length,
          verification,
        },
      });
      return {
        ...result,
        repair: {
          fixedIssueCodes: [...repairResult.fixedIssueCodes, ...genericStoryboardIssues.map((issue) => issue.code)],
          remainingIssueCodes: continuityReport.issues.filter((issue) => issue.severity !== "info").map((issue) => issue.code),
          nextTarget: "storyboard",
        },
      };
    } catch (error) {
      await Promise.all([fs.rm(reportPath, { force: true }), fs.rm(reportStructuredPath, { force: true })]);
      throw error;
    }
  }

  private assertShotAssetReferences(assetBible: AssetBible, shootingScript: ShootingScript): void {
    const assetsById = new Map(assetBible.assets.map((asset) => [asset.id, asset]));
    const missing = new Set<string>();
    const typeErrors = new Set<string>();
    for (const shot of shootingScript.shots) {
      const references: Array<[string, Asset["type"]]> = [
        [shot.sceneId, "scene"],
        ...shot.characterIds.map((id) => [id, "character"] as [string, Asset["type"]]),
        ...shot.propIds.map((id) => [id, "prop"] as [string, Asset["type"]]),
        ...shot.styleIds.map((id) => [id, "style"] as [string, Asset["type"]]),
        ...shot.dialogue.map((line) => [line.speakerId, "character"] as [string, Asset["type"]]),
      ];
      for (const [id, expectedType] of references) {
        const asset = assetsById.get(id);
        if (!asset) missing.add(id);
        else if (asset.type !== expectedType) typeErrors.add(`${id} 应为 ${expectedType}，实际为 ${asset.type}`);
      }
    }
    if (missing.size) throw new Error(`导演脚本引用了不存在的资产：${[...missing].join("、")}`);
    if (typeErrors.size) throw new Error(`导演脚本资产类型不匹配：${[...typeErrors].join("；")}`);
  }

  private async assetReadinessIssues(project: Project, currentAssets: Asset[]): Promise<string[]> {
    const issues: string[] = [];
    const projectAspectRatio = normalizeAspectRatio(project.aspectRatio);
    for (const asset of currentAssets) {
      if (!visualAssetTypes.has(asset.type)) continue;
      if (aspectConstrainedAssetTypes.has(asset.type)) {
        const aspectDescription = [
          asset.identity,
          asset.appearance,
          asset.designSummary,
          ...asset.distinctiveFeatures,
          ...asset.continuityRules,
          ...asset.usage,
        ].join("\n");
        const declaredRatios = extractAspectRatios(aspectDescription);
        const conflictingRatios = declaredRatios.filter((ratio) => ratio !== projectAspectRatio);
        const conflictingOrientations = conflictingOrientationTerms(aspectDescription, projectAspectRatio);
        if (conflictingRatios.length || conflictingOrientations.length) {
          const declarations = [...conflictingRatios, ...conflictingOrientations].join("、");
          issues.push(`${asset.id} 声明了 ${declarations}，与项目固定画幅 ${projectAspectRatio} 冲突`);
        }
      }
      const hasReference = asset.localFiles.length > 0 && asset.sha256.length === asset.localFiles.length;
      if (!asset.productionReady && !hasReference) {
        issues.push(`${asset.id} ${asset.name} 尚未形成可制作视觉设定`);
        continue;
      }
      if (hasReference) {
        for (const [index, filePath] of asset.localFiles.entries()) {
          if (!isInside(project.projectDir, filePath)) {
            issues.push(`${asset.id} 参考图路径不在项目目录内`);
            continue;
          }
          const bytes = await fs.readFile(filePath).catch(() => null);
          if (!bytes) issues.push(`${asset.id} 参考图不存在`);
          else if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256[index]) issues.push(`${asset.id} 参考图哈希已变化`);
        }
        continue;
      }
      if (asset.designSummary.trim().length < 20) issues.push(`${asset.id} 缺少可执行的视觉摘要`);
      if (asset.appearance.trim().length < 30 || unresolvedVisualPattern.test(asset.appearance)) issues.push(`${asset.id} 外观仍是占位或过于简略`);
      if (asset.distinctiveFeatures.filter((item) => item.trim()).length < 2) issues.push(`${asset.id} 至少需要两个固定识别特征`);
      if (asset.negativeConstraints.filter((item) => item.trim()).length < 1) issues.push(`${asset.id} 缺少禁止漂移约束`);
      const unresolvedCritical = asset.unknowns.some((item) => /(颜色|色板|服装|头饰|发型|面部|脸型|体型|身形|外貌|外观|形态|材质|比例|光照|地貌)/.test(item));
      if (unresolvedCritical) issues.push(`${asset.id} 仍把关键可视信息留在未知项`);
    }
    return [...new Set(issues)];
  }

  private assertStoryboardCoverage(assetBible: AssetBible, shootingScript: ShootingScript, storyboard: Storyboard): void {
    const expected = shootingScript.shots.map((shot) => shot.id).sort();
    const actual = storyboard.shots.map((shot) => shot.shotId).sort();
    if (new Set(actual).size !== actual.length || expected.join("|") !== actual.join("|")) {
      throw new Error("分镜必须与已批准导演脚本保持一镜一项且镜头编号完全一致");
    }
    if (storyboard.shots.some((shot) => shot.approved)) {
      throw new Error("新生成分镜不得伪造批准状态");
    }
    const assetIds = new Set(assetBible.assets.map((asset) => asset.id));
    for (const board of storyboard.shots) {
      const shot = shootingScript.shots.find((item) => item.id === board.shotId);
      const required = new Set(shot ? [shot.sceneId, ...shot.characterIds, ...shot.propIds, ...shot.styleIds] : []);
      const boardAssets = new Set(board.requiredAssetIds);
      const missing = [...required].filter((id) => !boardAssets.has(id));
      const unknown = [...boardAssets].filter((id) => !assetIds.has(id));
      if (missing.length) throw new Error(`${board.shotId} 分镜缺少导演脚本资产：${missing.join("、")}`);
      if (unknown.length) throw new Error(`${board.shotId} 分镜引用未知资产：${unknown.join("、")}`);
      if (shot && (board.sceneId !== shot.sceneId || [...board.characterIds].sort().join("|") !== [...shot.characterIds].sort().join("|"))) {
        throw new Error(`${board.shotId} 分镜的人物或场景引用与导演脚本不一致`);
      }
    }
  }

  private normalizeStoryboardReferences(shootingScript: ShootingScript, storyboard: Storyboard): Storyboard {
    const approvedShots = new Map(shootingScript.shots.map((shot) => [shot.id, shot]));
    return storyboardSchema.parse({
      ...storyboard,
      shots: storyboard.shots.map((board) => {
        const approvedShot = approvedShots.get(board.shotId);
        if (!approvedShot) return board;
        const inheritedAssetIds = [
          ...approvedShot.characterIds,
          approvedShot.sceneId,
          ...approvedShot.propIds,
          ...approvedShot.styleIds,
        ];
        return {
          ...board,
          characterIds: [...approvedShot.characterIds],
          sceneId: approvedShot.sceneId,
          requiredAssetIds: [...new Set([...inheritedAssetIds, ...board.requiredAssetIds])],
        };
      }),
    });
  }

  private assertContinuityCoverage(shootingScript: ShootingScript, report: ContinuityReport): void {
    const expected = shootingScript.shots.map((shot) => shot.id).sort();
    const checked = [...new Set(report.checkedShotIds)].sort();
    if (expected.join("|") !== checked.join("|")) {
      throw new Error("连续性报告必须覆盖全部已批准镜头");
    }
  }

  private assertArtifactRoute(project: Project, type: ArtifactType): void {
    const minimumIndex: Record<ArtifactType, number> = {
      outline: stageOrder.indexOf("SOURCE_IMPORTED"),
      screenplay: stageOrder.indexOf("OUTLINE_APPROVED"),
      "asset-bible": stageOrder.indexOf("SCREENPLAY_APPROVED"),
      "shooting-script": stageOrder.indexOf("ASSET_BIBLE_APPROVED"),
      storyboard: stageOrder.indexOf("SHOOTING_SCRIPT_APPROVED"),
    };
    if (stageOrder.indexOf(project.currentStage) < minimumIndex[type]) {
      throw new Error(`当前 ${project.currentStage} 阶段不能新建 ${type} 版本`);
    }
  }

  private async latestApprovedArtifact(projectId: string, type: ArtifactType): Promise<Artifact | null> {
    const [row] = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.type, type), eq(artifacts.status, "approved")))
      .orderBy(desc(artifacts.version)).limit(1);
    return row ? mapArtifactRow(row) : null;
  }

  private async approvedHeadArtifact(projectId: string, type: ArtifactType): Promise<Artifact | null> {
    const head = this.studio.sqlite.prepare(`
      SELECT artifact_id AS artifactId FROM project_heads WHERE project_id = ? AND artifact_type = ?
    `).get(projectId, type) as { artifactId: string } | undefined;
    if (!head) return null;
    const [row] = await this.studio.db.select().from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), eq(artifacts.id, head.artifactId), eq(artifacts.status, "approved")))
      .limit(1);
    return row ? mapArtifactRow(row) : null;
  }

  private async loadH3Capabilities() {
    const configPath = path.join(this.studio.runtimeRoot, "configs", "providers", "minimax-h3.json");
    return h3CapabilitiesSchema.parse(JSON.parse(await fs.readFile(configPath, "utf8")));
  }

  private async moveToReview(project: Project, type: ArtifactType, artifactId: string): Promise<Project> {
    const target = reviewStageByType[type];
    const oldIndex = stageOrder.indexOf(project.currentStage);
    const newlyStale = downstreamStages(target).filter((stage) => stageOrder.indexOf(stage) <= oldIndex);
    const staleStages = Array.from(new Set([...project.staleStages, ...newlyStale])).filter((stage) => stage !== target);
    const updatedAt = new Date().toISOString();
    await this.studio.db.update(projects).set({ currentStage: target, staleStages, updatedAt }).where(eq(projects.id, project.id));
    const updated = projectSchema.parse({ ...project, currentStage: target, staleStages, updatedAt });
    await this.writeProjectManifest(updated);
    await this.appendLog(project.projectDir, "workflow.log.jsonl", {
      type: "artifact.version.created", projectId: project.id, artifactId, artifactType: type,
      from: project.currentStage, to: target, invalidatedStages: newlyStale, createdAt: updatedAt,
    });
    return updated;
  }

  private async transition(project: Project, target: ProjectStage, event: string): Promise<Project> {
    assertTransition(project.currentStage, target);
    const updatedAt = new Date().toISOString();
    const staleStages = project.staleStages.filter((stage) => stage !== project.currentStage && stage !== target);
    await this.studio.db.update(projects).set({ currentStage: target, staleStages, updatedAt }).where(eq(projects.id, project.id));
    const updated = projectSchema.parse({ ...project, currentStage: target, staleStages, updatedAt });
    await this.writeProjectManifest(updated);
    await this.appendLog(project.projectDir, "workflow.log.jsonl", { type: event, projectId: project.id, from: project.currentStage, to: target, createdAt: updatedAt });
    return updated;
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.get(id);
    if (!project) throw new Error("项目不存在");
    return project;
  }

  private async writeProjectManifest(project: Project): Promise<void> {
    const manifestPath = path.join(project.projectDir, "project.yaml");
    const temporaryPath = `${manifestPath}.tmp`;
    await fs.writeFile(temporaryPath, toYaml(project), "utf8");
    await fs.rename(temporaryPath, manifestPath);
  }

  private async appendLog(projectDir: string, fileName: string, event: Record<string, unknown>): Promise<void> {
    await fs.appendFile(path.join(projectDir, "logs", fileName), `${JSON.stringify(event)}\n`, "utf8");
  }
}
