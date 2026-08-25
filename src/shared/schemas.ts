import { z } from "zod";

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

export const projectSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(120),
  sourceType: sourceTypeSchema,
  targetDurationSec: z.number().int().positive().max(21_600),
  aspectRatio: z.string().trim().min(1).max(20),
  resolution: z.string().trim().min(1).max(40),
  videoType: z.string().trim().max(80).nullable().default(null),
  visualStyle: z.string().trim().max(1_000).nullable().default(null),
  releasePlatform: z.string().trim().max(120).nullable().default(null),
  targetAudience: z.string().trim().max(300).nullable().default(null),
  allowStorySuggestions: z.boolean().default(true),
  currentStage: projectStageSchema,
  staleStages: z.array(projectStageSchema).default([]),
  sourcePath: z.string().min(1),
  projectDir: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.object({
  title: z.string().trim().min(1, "请输入项目名称").max(120),
  sourceType: sourceTypeSchema,
  sourceText: z.string().min(1, "请输入原始内容").max(5_000_000),
  targetDurationSec: z.coerce.number().int().positive().max(21_600),
  aspectRatio: z.string().trim().min(1).default("16:9"),
  resolution: z.string().trim().min(1).default("1920x1080"),
  videoType: z.string().trim().max(80).nullable().optional(),
  visualStyle: z.string().trim().max(1_000).nullable().optional(),
  releasePlatform: z.string().trim().max(120).nullable().optional(),
  targetAudience: z.string().trim().max(300).nullable().optional(),
  allowStorySuggestions: z.boolean().default(true),
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
