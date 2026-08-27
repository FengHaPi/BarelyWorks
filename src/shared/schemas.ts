import { z } from "zod";
import { inspectPhysicalPlan, shotPhysicalPlanSchema } from "./physical-plan";

export const projectStages = [
  "SOURCE_IMPORTED",
  "OUTLINE_REVIEW",
  "OUTLINE_APPROVED",
  "SCREENPLAY_REVIEW",
  "SCREENPLAY_APPROVED",
  "ASSET_BIBLE_REVIEW",
  "ASSET_BIBLE_APPROVED",
  "SHOOTING_SCRIPT_REVIEW",
  "SHOOTING_SCRIPT_APPROVED",
  "STORYBOARD_REVIEW",
  "STORYBOARD_APPROVED",
  "ASSETS_LOCKED",
  "READY_FOR_GENERATION",
  "GENERATING",
  "GENERATION_REVIEW",
  "EDITING",
  "FINAL_REVIEW",
  "DELIVERED",
] as const;

export const projectStageSchema = z.enum(projectStages);
export type ProjectStage = z.infer<typeof projectStageSchema>;

export const sourceTypeSchema = z.enum([
  "story",
  "screenplay",
  "shooting-script",
  "storyboard",
]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const aspectRatioSchema = z.string().trim().regex(/^\d{1,3}\s*[:：]\s*\d{1,3}$/, "画幅必须使用 宽:高 格式")
  .transform((value) => value.replace(/\s+/g, "").replace("：", ":"))
  .superRefine((value, context) => {
    const [width, height] = value.split(":").map(Number);
    if (width <= 0 || height <= 0) context.addIssue({ code: "custom", message: "画幅宽高必须大于 0" });
  });

export const outputResolutionSchema = z.string().trim().min(1).max(40).superRefine((value, context) => {
  const match = /^(\d{3,4})\s*[xX×]\s*(\d{3,4})$/.exec(value);
  if (!match) {
    context.addIssue({ code: "custom", message: "成片输出规格必须使用 宽x高 格式" });
    return;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (Math.min(width, height) < 480) {
    context.addIssue({ code: "custom", message: "成片输出最低短边为 480px" });
  }
  if (Math.max(width, height) > 7_680) {
    context.addIssue({ code: "custom", message: "成片输出最长边不能超过 7680px" });
  }
});

function validateResolutionMatchesAspect(
  value: { aspectRatio: string; resolution: string },
  context: z.RefinementCtx,
): void {
  const ratioMatch = /^(\d+):(\d+)$/.exec(value.aspectRatio);
  const resolutionMatch = /^(\d{3,4})\s*[xX×]\s*(\d{3,4})$/.exec(value.resolution);
  if (!ratioMatch || !resolutionMatch) return;
  const expected = Number(ratioMatch[1]) / Number(ratioMatch[2]);
  const actual = Number(resolutionMatch[1]) / Number(resolutionMatch[2]);
  if (Number.isFinite(expected) && expected > 0 && Math.abs(actual - expected) / expected > 0.02) {
    context.addIssue({
      code: "custom",
      path: ["resolution"],
      message: `输出分辨率 ${value.resolution} 与项目画幅 ${value.aspectRatio} 不一致`,
    });
  }
}

export const projectSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(120),
  sourceType: sourceTypeSchema,
  targetDurationSec: z.number().int().min(4, "当前 H3 工作流的项目时长不能少于 4 秒").max(21_600),
  aspectRatio: aspectRatioSchema,
  resolution: outputResolutionSchema,
  videoType: z.string().trim().max(80).nullable().default(null),
  visualStyle: z.string().trim().max(1_000).nullable().default(null),
  releasePlatform: z.string().trim().max(120).nullable().default(null),
  targetAudience: z.string().trim().max(300).nullable().default(null),
  allowStorySuggestions: z.boolean().default(true),
  currentStage: projectStageSchema,
  staleStages: z.array(projectStageSchema).default([]),
  sourcePath: z.string().min(1),
  projectDir: z.string().min(1),
  archivedAt: z.iso.datetime().nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine(validateResolutionMatchesAspect);
export type Project = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.object({
  title: z.string().trim().min(1, "请输入项目名称").max(120),
  sourceType: sourceTypeSchema,
  sourceText: z.string().min(1, "请输入原始内容").max(5_000_000),
  targetDurationSec: z.coerce.number().int().min(5, "当前生产规则的项目时长不能少于 5 秒").max(21_600),
  aspectRatio: aspectRatioSchema.default("16:9"),
  resolution: outputResolutionSchema.default("1920x1080"),
  videoType: z.string().trim().max(80).nullable().optional(),
  visualStyle: z.string().trim().max(1_000).nullable().optional(),
  releasePlatform: z.string().trim().max(120).nullable().optional(),
  targetAudience: z.string().trim().max(300).nullable().optional(),
  allowStorySuggestions: z.boolean().default(true),
}).superRefine((value, context) => {
  validateResolutionMatchesAspect(value, context);
  if (value.sourceType === "shooting-script" || value.sourceType === "storyboard") {
    context.addIssue({
      code: "custom",
      path: ["sourceType"],
      message: "导演脚本/分镜的结构化导入尚未开放；当前请选择原始故事或已有剧本",
    });
  }
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const assetTypeSchema = z.enum([
  "character",
  "scene",
  "prop",
  "costume",
  "style",
  "audio",
  "reference",
]);
export const uploadStateSchema = z.enum(["not-uploaded", "uploaded", "unknown"]);
export const assetReferenceRoleSchema = z.enum(["主参考", "正面", "侧面", "背面", "表情", "服装", "其他"]);
export const assetReferencePromptRecordSchema = z.object({
  id: z.uuid(),
  schemaVersion: z.literal("asset-reference-prompt-v1"),
  version: z.number().int().positive(),
  assetId: z.string().regex(/^(CHAR|SCENE|PROP|COSTUME|STYLE|REF)-\d{3}$/),
  role: assetReferenceRoleSchema,
  promptZh: z.string().trim().min(80),
  promptEn: z.string().trim().min(80),
  negativePrompt: z.string().trim().min(20),
  compositionNotes: z.array(z.string().trim().min(1)).min(1),
  continuityLocks: z.array(z.string().trim().min(1)).min(2),
  provider: z.string().min(1),
  providerRunId: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type AssetReferenceRole = z.infer<typeof assetReferenceRoleSchema>;
export type AssetReferencePromptRecord = z.infer<typeof assetReferencePromptRecordSchema>;
export const assetReferenceBaselineSchema = z.object({
  productionReady: z.boolean(),
  designBasis: z.enum(["source-grounded", "creative-proposal", "reference-guided"]),
  designSummary: z.string(),
}).nullable().default(null);
export const assetSchema = z.object({
  id: z.string().regex(/^(CHAR|SCENE|PROP|COSTUME|STYLE|AUDIO|REF)-\d{3}$/),
  projectId: z.uuid(),
  type: assetTypeSchema,
  name: z.string().trim().min(1),
  version: z.number().int().positive(),
  localFiles: z.array(z.string()),
  sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/i)),
  approved: z.boolean(),
  authorizationState: z.enum(["confirmed", "missing", "not-required", "unknown"]).default("unknown"),
  uploadState: z.record(z.string(), uploadStateSchema),
  referencedBy: z.array(z.string()),
  identity: z.string().min(1),
  appearance: z.string().min(1),
  designBasis: z.enum(["source-grounded", "creative-proposal", "reference-guided"]).default("source-grounded"),
  productionReady: z.boolean().default(false),
  designSummary: z.string().default(""),
  distinctiveFeatures: z.array(z.string()).default([]),
  negativeConstraints: z.array(z.string()).default([]),
  fileRoles: z.array(z.string()).default([]),
  referencePrompts: z.array(assetReferencePromptRecordSchema).default([]),
  referenceBaseline: assetReferenceBaselineSchema,
  continuityRules: z.array(z.string()),
  usage: z.array(z.string()),
  sourceEvidence: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export type Asset = z.infer<typeof assetSchema>;

export const shotStatusSchema = z.enum([
  "draft",
  "review",
  "approved",
  "stale",
  "generating",
  "generated",
  "accepted",
  "rejected",
]);
export const shotSpecSchema = z
  .object({
    id: z.string().regex(/^S\d{3}$/),
    projectId: z.uuid(),
    sequence: z.number().int().positive(),
    startTimeSec: z.number().nonnegative(),
    endTimeSec: z.number().positive(),
    durationSec: z.number().positive(),
    purpose: z.string().trim().min(1),
    characterIds: z.array(z.string()),
    sceneId: z.string().min(1),
    propIds: z.array(z.string()),
    styleIds: z.array(z.string()),
    shotSize: z.string().trim().min(1),
    camera: z.object({
      position: z.string().trim().min(1),
      movement: z.string().trim().min(1),
      lens: z.string().trim().nullable().optional(),
      composition: z.string().trim().nullable().optional(),
    }),
    action: z.string().trim().min(1),
    dialogue: z.array(
      z.object({
        speakerId: z.string().min(1),
        text: z.string().min(1),
        language: z.string().min(1),
      }),
    ),
    sound: z.array(z.string()),
    startState: z.string().trim().min(1),
    endState: z.string().trim().min(1),
    physicalPlan: shotPhysicalPlanSchema.nullable().default(null),
    preferredProvider: z.string().trim().nullable().optional(),
    status: shotStatusSchema,
  })
  .superRefine((shot, context) => {
    const calculatedDuration = shot.endTimeSec - shot.startTimeSec;
    if (Math.abs(calculatedDuration - shot.durationSec) > 0.001) {
      context.addIssue({
        code: "custom",
        path: ["durationSec"],
        message: "durationSec 必须等于 endTimeSec - startTimeSec",
      });
    }
    if (shot.physicalPlan) {
      for (const problem of inspectPhysicalPlan(shot.physicalPlan, shot.durationSec, shot.characterIds, shot.propIds)) {
        if (problem.severity !== "error") continue;
        context.addIssue({
          code: "custom",
          path: ["physicalPlan"],
          message: `${problem.code}：${problem.message}`,
        });
      }
    }
  });
export type ShotSpec = z.infer<typeof shotSpecSchema>;

export const approvalRecordSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  stage: projectStageSchema,
  artifactPath: z.string().min(1),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/i),
  artifactVersion: z.number().int().positive(),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(2_000).nullable().optional(),
  createdAt: z.iso.datetime(),
});
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export const artifactTypeSchema = z.enum(["outline", "screenplay", "asset-bible", "shooting-script", "storyboard"]);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const artifactStatusSchema = z.enum(["draft", "approved", "rejected", "stale"]);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

export const artifactSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  type: artifactTypeSchema,
  version: z.number().int().positive(),
  filePath: z.string().min(1),
  structuredPath: z.string().min(1).nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  status: artifactStatusSchema,
  sourceArtifactId: z.uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const createArtifactVersionInputSchema = z.object({
  content: z.string().trim().min(1, "产物内容不能为空").max(5_000_000),
  sourceArtifactId: z.uuid().nullable().optional(),
  expectedLatestArtifactId: z.uuid().nullable().optional(),
});

export const updateShotInputSchema = z.object({
  shot: z.unknown(),
  expectedLatestArtifactId: z.uuid(),
});

export const generationJobSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  shotId: z.string().regex(/^S\d{3}$/),
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  mode: z.enum(["manual", "api"]),
  promptVersion: z.number().int().positive(),
  referenceAssetIds: z.array(z.string()),
  providerTaskId: z.string().nullable().optional(),
  estimatedCost: z.number().nonnegative().nullable().optional(),
  actualCost: z.number().nonnegative().nullable().optional(),
  status: z.enum([
    "draft",
    "approved",
    "submitted",
    "running",
    "downloaded",
    "review",
    "accepted",
    "failed",
  ]),
  retryCount: z.number().int().nonnegative(),
  parameterHash: z.string().regex(/^[a-f0-9]{64}$/i),
});
export type GenerationJob = z.infer<typeof generationJobSchema>;

export const providerCapabilitiesSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  modes: z.array(z.string()),
  durations: z.array(z.number().positive()),
  aspectRatios: z.array(z.string()),
  resolutions: z.array(z.string()),
  maxReferenceImages: z.number().int().nonnegative().nullable(),
  supportsAudioInput: z.boolean().nullable(),
  supportsReferenceVideo: z.boolean().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
});
