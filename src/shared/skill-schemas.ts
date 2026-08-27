import { z } from "zod";
import { assetTypeSchema, projectStageSchema, shotSpecSchema, sourceTypeSchema } from "./schemas";

const issueSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  affectedIds: z.array(z.string()).default([]),
});

export const producerDecisionSchema = z.object({
  currentStage: projectStageSchema,
  nextAction: z.string().min(1),
  requiredSkill: z.string().min(1).nullable(),
  blockers: z.array(issueSchema),
  approvalRequired: z.boolean(),
  unverifiedClaims: z.array(z.string()),
});

export const projectIntakeOutputSchema = z.object({
  sourceType: sourceTypeSchema,
  detectedStage: projectStageSchema,
  confidence: z.number().min(0).max(1),
  constraints: z.object({
    targetDurationSec: z.number().int().positive(),
    aspectRatio: z.string().min(1),
    resolution: z.string().min(1),
    videoType: z.string().nullable(),
    visualStyle: z.string().nullable(),
    releasePlatform: z.string().nullable(),
    targetAudience: z.string().nullable(),
    allowStorySuggestions: z.boolean(),
  }),
  preservedFacts: z.array(z.string()),
  missingInformation: z.array(z.string()),
  warnings: z.array(issueSchema),
});

export const storyOutlineSchema = z.object({
  title: z.string().min(1),
  logline: z.string().min(1),
  themes: z.array(z.string()).min(1),
  targetDurationSec: z.number().int().positive(),
  structure: z.array(
    z.object({
      sequence: z.number().int().positive(),
      heading: z.string().min(1),
      purpose: z.string().min(1),
      events: z.array(z.string()).min(1),
      estimatedDurationSec: z.number().positive(),
    }),
  ).min(1),
  lockedFacts: z.array(z.string()),
  proposedChanges: z.array(z.object({ change: z.string().min(1), reason: z.string().min(1) })),
  approvalNotes: z.array(z.string()),
});

export const screenplaySchema = z.object({
  title: z.string().min(1),
  version: z.number().int().positive(),
  basedOnApprovedArtifact: z.string().min(1),
  sourcePreserved: z.boolean(),
  scenes: z.array(
    z.object({
      sequence: z.number().int().positive(),
      heading: z.string().min(1),
      location: z.string().min(1),
      timeOfDay: z.string().min(1),
      action: z.array(z.string()).min(1),
      dialogue: z.array(z.object({ speaker: z.string().min(1), text: z.string().min(1) })),
    }),
  ).min(1),
  unresolvedQuestions: z.array(z.string()),
});

export const assetBibleSchema = z.object({
  assets: z.array(
    z.object({
      id: z.string().regex(/^(CHAR|SCENE|PROP|COSTUME|STYLE|AUDIO|REF)-\d{3}$/),
      type: assetTypeSchema,
      name: z.string().min(1),
      identity: z.string().min(1),
      appearance: z.string().min(1),
      designBasis: z.enum(["source-grounded", "creative-proposal", "reference-guided"]).default("source-grounded"),
      productionReady: z.boolean().default(false),
      designSummary: z.string().default(""),
      distinctiveFeatures: z.array(z.string()).default([]),
      negativeConstraints: z.array(z.string()).default([]),
      continuityRules: z.array(z.string()),
      usage: z.array(z.string()),
      sourceEvidence: z.array(z.string()),
      unknowns: z.array(z.string()),
    }),
  ).min(1),
  conflicts: z.array(issueSchema),
}).superRefine((value, context) => {
  const ids = value.assets.map((asset) => asset.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["assets"], message: "资产 ID 必须唯一" });
  }
  const prefixes: Record<(typeof value.assets)[number]["type"], string> = {
    character: "CHAR-",
    scene: "SCENE-",
    prop: "PROP-",
    costume: "COSTUME-",
    style: "STYLE-",
    audio: "AUDIO-",
    reference: "REF-",
  };
  value.assets.forEach((asset, index) => {
    if (!asset.id.startsWith(prefixes[asset.type])) {
      context.addIssue({ code: "custom", path: ["assets", index, "id"], message: `资产 ID 前缀与类型 ${asset.type} 不匹配` });
    }
  });
});

export const assetReferencePromptOutputSchema = z.object({
  schemaVersion: z.literal("asset-reference-prompt-v1"),
  assetId: z.string().regex(/^(CHAR|SCENE|PROP|COSTUME|STYLE|REF)-\d{3}$/),
  role: z.enum(["主参考", "正面", "侧面", "背面", "表情", "服装", "其他"]),
  promptZh: z.string().trim().min(80),
  promptEn: z.string().trim().min(80),
  negativePrompt: z.string().trim().min(20),
  compositionNotes: z.array(z.string().trim().min(1)).min(1),
  continuityLocks: z.array(z.string().trim().min(1)).min(2),
});

export const shootingScriptSchema = z.object({
  schemaVersion: z.enum(["shooting-script-v1", "shooting-script-v2"]).default("shooting-script-v1"),
  targetDurationSec: z.number().positive(),
  shots: z.array(shotSpecSchema).min(1),
  validationNotes: z.array(issueSchema),
}).superRefine((value, context) => {
  const sorted = [...value.shots].sort((a, b) => a.sequence - b.sequence);
  const ids = sorted.map((shot) => shot.id);
  const sequences = sorted.map((shot) => shot.sequence);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["shots"], message: "镜头 ID 必须唯一" });
  }
  if (new Set(sequences).size !== sequences.length) {
    context.addIssue({ code: "custom", path: ["shots"], message: "镜头 sequence 必须唯一" });
  }
  if (sorted.length && Math.abs(sorted[0].startTimeSec) > 0.001) {
    context.addIssue({ code: "custom", path: ["shots", 0, "startTimeSec"], message: "第一个镜头必须从 0 秒开始" });
  }
  sorted.forEach((shot, index) => {
    if (index > 0 && Math.abs(shot.startTimeSec - sorted[index - 1].endTimeSec) > 0.001) {
      context.addIssue({ code: "custom", path: ["shots", index, "startTimeSec"], message: "镜头时间码不连续" });
    }
  });
  const finalEnd = sorted.at(-1)?.endTimeSec ?? 0;
  if (Math.abs(finalEnd - value.targetDurationSec) > 0.001) {
    context.addIssue({ code: "custom", path: ["targetDurationSec"], message: "镜头总时长与目标时长不一致" });
  }
  if (value.schemaVersion === "shooting-script-v2") {
    value.shots.forEach((shot, index) => {
      if (!shot.physicalPlan) {
        context.addIssue({ code: "custom", path: ["shots", index, "physicalPlan"], message: "shooting-script-v2 的每个镜头都必须包含结构化 physicalPlan" });
      }
    });
  }
});

export const storyboardSchema = z.object({
  schemaVersion: z.enum(["storyboard-v1", "storyboard-v2"]).default("storyboard-v1"),
  shots: z.array(
    z.object({
      shotId: z.string().regex(/^S\d{3}$/),
      startFrame: z.string().min(1),
      endFrame: z.string().min(1),
      composition: z.string().min(1),
      motionPlan: z.string().min(1),
      characterIds: z.array(z.string()),
      sceneId: z.string().min(1),
      requiredAssetIds: z.array(z.string()),
      continuityRisks: z.array(z.string()),
      physicalVerification: z.object({
        cameraBlocking: z.enum(["pass", "fail"]),
        displayGeometry: z.enum(["pass", "fail", "not-applicable"]),
        reflectionTopology: z.enum(["pass", "fail", "not-applicable"]),
        timedStateGates: z.enum(["pass", "fail", "not-applicable"]),
        notes: z.array(z.string().trim().min(1)),
      }).nullable().default(null),
      approved: z.boolean(),
    }),
  ).min(1),
  globalContinuityNotes: z.array(z.string()),
}).superRefine((value, context) => {
  if (value.schemaVersion !== "storyboard-v2") return;
  value.shots.forEach((shot, index) => {
    if (!shot.physicalVerification) {
      context.addIssue({ code: "custom", path: ["shots", index, "physicalVerification"], message: "storyboard-v2 的每个镜头都必须包含 physicalVerification" });
    }
  });
});

export const continuityReportSchema = z.object({
  checkedShotIds: z.array(z.string()).min(1),
  issues: z.array(issueSchema.extend({ suggestedFix: z.string().min(1), requiresReapproval: z.boolean() })),
  passed: z.boolean(),
  uncheckedClaims: z.array(z.string()),
}).superRefine((value, context) => {
  if (value.passed && value.issues.some((issue) => issue.severity === "error")) {
    context.addIssue({ code: "custom", path: ["passed"], message: "存在 error 级问题时 passed 不能为 true" });
  }
});

export const skillOutputSchemas = {
  "ai-video-producer": producerDecisionSchema,
  "project-intake": projectIntakeOutputSchema,
  "story-architect": storyOutlineSchema,
  "screenplay-writer": screenplaySchema,
  "asset-bible-builder": assetBibleSchema,
  "asset-reference-prompt-writer": assetReferencePromptOutputSchema,
  "shooting-script-director": shootingScriptSchema,
  "storyboard-director": storyboardSchema,
  "continuity-supervisor": continuityReportSchema,
} as const;
