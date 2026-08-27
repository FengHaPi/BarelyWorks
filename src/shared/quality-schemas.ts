import { z } from "zod";
import { generationJobSchema, projectSchema, shotSpecSchema } from "./schemas";

export const mediaToolStatusSchema = z.object({
  ffmpegAvailable: z.boolean(),
  ffprobeAvailable: z.boolean(),
  libx264Available: z.boolean(),
  aacAvailable: z.boolean(),
  roughCutReady: z.boolean(),
  ffmpegVersion: z.string().nullable(),
  ffprobeVersion: z.string().nullable(),
  ffmpegPath: z.string(),
  ffprobePath: z.string(),
  setupDirectory: z.string().min(1),
});
export type MediaToolStatus = z.infer<typeof mediaToolStatusSchema>;

export const mediaMetadataSchema = z.object({
  durationSec: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: z.number().positive(),
  videoCodec: z.string().min(1),
  audioCodec: z.string().min(1).nullable(),
  hasAudio: z.boolean(),
  formatName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});
export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;

export const importedGenerationSchema = generationJobSchema.extend({
  sourceFileName: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/i),
  importedPath: z.string().min(1),
  reviewFramePaths: z.array(z.string().min(1)).default([]),
  generationVersion: z.number().int().positive(),
  media: mediaMetadataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ImportedGeneration = z.infer<typeof importedGenerationSchema>;

export const reviewDimensions = [
  "identity",
  "costume-props",
  "scene",
  "action",
  "camera",
  "composition-direction",
  "start-end-state",
  "picture-quality",
  "sound-quality",
] as const;
export const reviewDimensionSchema = z.enum(reviewDimensions);
export const reviewDimensionStatusSchema = z.enum(["pass", "warning", "fail", "not-reviewed"]);
export const qualityDecisionSchema = z.enum([
  "accepted",
  "conditional-pass",
  "retry-same-model",
  "revise-prompt-retry",
  "switch-model",
  "manual-fix",
]);

export const qualityReviewInputSchema = z.object({
  dimensions: z.array(z.object({
    dimension: reviewDimensionSchema,
    status: reviewDimensionStatusSchema,
    note: z.string().trim().min(1).max(2_000),
    evidence: z.string().trim().min(1).max(2_000),
  })).length(reviewDimensions.length),
  decision: qualityDecisionSchema,
  summary: z.string().trim().min(1).max(4_000),
  conditions: z.array(z.string().trim().min(1).max(1_000)),
  retryInstructions: z.array(z.string().trim().min(1).max(1_000)),
  unverifiedClaims: z.array(z.string().trim().min(1).max(1_000)),
}).superRefine((value, context) => {
  const actual = value.dimensions.map((item) => item.dimension);
  if (new Set(actual).size !== reviewDimensions.length || reviewDimensions.some((dimension) => !actual.includes(dimension))) {
    context.addIssue({ code: "custom", path: ["dimensions"], message: "质量审核必须且只能覆盖全部九个维度" });
  }
  const failed = value.dimensions.some((item) => item.status === "fail");
  const notReviewed = value.dimensions.some((item) => item.status === "not-reviewed");
  const notFullyPassed = value.dimensions.some((item) => item.status !== "pass");
  if (value.decision === "accepted" && (notFullyPassed || value.conditions.length || value.unverifiedClaims.length)) {
    context.addIssue({ code: "custom", path: ["decision"], message: "正式通过要求九个维度全部通过，且不得保留条件或未验证声明" });
  }
  if (value.decision === "conditional-pass" && (failed || notReviewed || !value.conditions.length)) {
    context.addIssue({ code: "custom", path: ["decision"], message: "有条件通过必须完成全部维度审核、不能包含失败维度，且必须填写待闭环条件" });
  }
  if (["retry-same-model", "revise-prompt-retry", "switch-model"].includes(value.decision) && (!failed || !value.retryInstructions.length)) {
    context.addIssue({ code: "custom", path: ["decision"], message: "重试或换模型必须包含失败维度和重试说明" });
  }
});
export type QualityReviewInput = z.infer<typeof qualityReviewInputSchema>;

export const qualityReviewSchema = qualityReviewInputSchema.safeExtend({
  id: z.uuid(),
  projectId: z.uuid(),
  jobId: z.uuid(),
  shotId: z.string().regex(/^S\d{3}$/),
  generationVersion: z.number().int().positive(),
  reviewer: z.literal("human"),
  skill: z.object({ name: z.string(), version: z.string(), sha256: z.string(), sourceFiles: z.array(z.string()) }),
  createdAt: z.iso.datetime(),
});
export type QualityReview = z.infer<typeof qualityReviewSchema>;

export const renderRecordSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["rendering", "review", "approved", "rejected", "failed"]),
  videoPath: z.string().min(1),
  subtitlePath: z.string().min(1).nullable(),
  reportPath: z.string().min(1),
  sourceJobIds: z.array(z.uuid()).min(1),
  media: mediaMetadataSchema.nullable(),
  error: z.string().nullable(),
  deliveryVideoPath: z.string().min(1).nullable(),
  deliverySubtitlePath: z.string().min(1).nullable(),
  deliveryReportPath: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RenderRecord = z.infer<typeof renderRecordSchema>;

export const qualityCenterSchema = z.object({
  project: projectSchema,
  mediaTools: mediaToolStatusSchema,
  inboxPath: z.string().min(1),
  skill: z.object({ name: z.string(), version: z.string(), sha256: z.string(), sourceFiles: z.array(z.string()) }),
  shots: z.array(shotSpecSchema),
  generations: z.array(importedGenerationSchema),
  reviews: z.array(qualityReviewSchema),
  renders: z.array(renderRecordSchema),
  gateAudit: z.object({
    passed: z.boolean(),
    acceptedShotIds: z.array(z.string().regex(/^S\d{3}$/)),
    blockers: z.array(z.string().min(1)),
  }),
});
export type QualityCenter = z.infer<typeof qualityCenterSchema>;
