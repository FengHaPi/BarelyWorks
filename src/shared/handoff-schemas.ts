import { z } from "zod";
import { assetSchema, projectSchema, shotSpecSchema } from "./schemas";

export const h3ModeSchema = z.enum(["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"]);
export type H3Mode = z.infer<typeof h3ModeSchema>;

export const generationResolutionSchema = z.enum(["platform-default", "480p", "720p", "768p", "1080p"]);
export type GenerationResolution = z.infer<typeof generationResolutionSchema>;

export const h3ReferenceLabelSchema = z.object({
  assetId: z.string().min(1),
  label: z.string().regex(/^<(Subject|Picture|Video|Audio) \d+>$/),
  kind: z.enum(["image", "video", "audio"]),
  filePath: z.string().min(1),
  role: z.string().min(1),
});
export type H3ReferenceLabel = z.infer<typeof h3ReferenceLabelSchema>;

export const h3PromptOutputSchema = z.object({
  mode: h3ModeSchema,
  prompt: z.string().trim().min(20),
  referenceLabels: z.array(h3ReferenceLabelSchema),
  notes: z.array(z.string()).default([]),
}).superRefine((value, context) => {
  const fields = value.mode === "Ref2VA"
    ? ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]
    : ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"];
  let previous = -1;
  for (const field of fields) {
    const position = value.prompt.indexOf(field);
    if (position < 0) context.addIssue({ code: "custom", path: ["prompt"], message: `H3 提示词缺少字段 ${field}` });
    if (position >= 0 && position <= previous) context.addIssue({ code: "custom", path: ["prompt"], message: `H3 提示词字段顺序错误：${field}` });
    previous = Math.max(previous, position);
  }
  if (value.mode === "T2VA" && value.referenceLabels.length) {
    context.addIssue({ code: "custom", path: ["referenceLabels"], message: "T2VA 不应包含外部参考标签" });
  }
  for (const reference of value.referenceLabels) {
    if (!value.prompt.includes(reference.label)) {
      context.addIssue({ code: "custom", path: ["prompt"], message: `提示词未使用参考标签 ${reference.label}` });
    }
  }
});
export type H3PromptOutput = z.infer<typeof h3PromptOutputSchema>;

export const h3CapabilitiesSchema = z.object({
  provider: z.literal("minimax"),
  model: z.literal("MiniMax H3"),
  modes: z.array(h3ModeSchema).min(1),
  durationMinSec: z.number().positive(),
  durationMaxSec: z.number().positive(),
  aspectRatios: z.array(z.string()).min(1),
  defaultShortSide: z.number().int().positive(),
  maxReferenceImages: z.number().int().nonnegative(),
  maxReferenceVideos: z.number().int().nonnegative(),
  maxReferenceAudioFiles: z.number().int().nonnegative(),
  maxMixedReferences: z.number().int().nonnegative(),
  supportsAudioInput: z.boolean(),
  supportsReferenceVideo: z.boolean(),
  verifiedAt: z.iso.datetime(),
  source: z.url(),
});
export type H3Capabilities = z.infer<typeof h3CapabilitiesSchema>;

export const h3PreflightSchema = z.object({
  passed: z.boolean(),
  mode: h3ModeSchema,
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  references: z.array(h3ReferenceLabelSchema),
});
export type H3Preflight = z.infer<typeof h3PreflightSchema>;

export const handoffPackageSummarySchema = z.object({
  shotId: z.string().regex(/^S\d{3}$/),
  version: z.number().int().positive(),
  path: z.string().min(1),
  promptPath: z.string().min(1),
  createdAt: z.iso.datetime(),
  mode: h3ModeSchema,
  generationResolution: generationResolutionSchema.default("platform-default"),
  uploadState: z.enum(["not-uploaded", "uploaded"]),
});
export type HandoffPackageSummary = z.infer<typeof handoffPackageSummarySchema>;

export const generationCenterSchema = z.object({
  project: projectSchema,
  capabilities: h3CapabilitiesSchema,
  skills: z.array(z.object({
    name: z.string(), version: z.string(), sha256: z.string(), sourceFiles: z.array(z.string()),
  })),
  bootstrap: z.object({ path: z.string(), createdAt: z.iso.datetime(), assetCount: z.number().int().nonnegative() }).nullable(),
  assets: z.array(assetSchema),
  shots: z.array(z.object({
    shot: shotSpecSchema,
    preflight: h3PreflightSchema,
    packages: z.array(handoffPackageSummarySchema),
  })),
});
export type GenerationCenter = z.infer<typeof generationCenterSchema>;
