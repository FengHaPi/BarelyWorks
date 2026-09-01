import { z } from "zod";

export const artifactKindsV3 = [
  "source",
  "outline",
  "screenplay",
  "asset-bible",
  "shooting-script",
  "storyboard",
  "generation-package",
] as const;

export type ArtifactKindV3 = (typeof artifactKindsV3)[number];

export const projectV3Schema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1),
  targetDurationSec: z.number().positive(),
  aspectRatio: z.string().trim().min(1),
  resolution: z.string().trim().min(1),
  visualStyle: z.string().trim().min(1).optional(),
});
export type ProjectV3 = z.infer<typeof projectV3Schema>;

export const sourceContentV3Schema = z.object({ text: z.string().trim().min(1) });
export type SourceContentV3 = z.infer<typeof sourceContentV3Schema>;

export const outlineContentV3Schema = z.object({
  title: z.string().trim().min(1),
  logline: z.string().trim().min(1),
  beats: z.array(z.object({ beatId: z.string().trim().min(1), summary: z.string().trim().min(1) })).min(1),
});
export type OutlineContentV3 = z.infer<typeof outlineContentV3Schema>;

export const screenplayContentV3Schema = z.object({
  title: z.string().trim().min(1),
  scenes: z.array(z.object({
    sceneId: z.string().trim().min(1),
    heading: z.string().trim().min(1),
    action: z.array(z.string().trim().min(1)).min(1),
    beatIds: z.array(z.string().trim().min(1)),
  })).min(1),
});
export type ScreenplayContentV3 = z.infer<typeof screenplayContentV3Schema>;

export const assetBibleContentV3Schema = z.object({
  assets: z.array(z.object({
    assetId: z.string().trim().min(1),
    kind: z.string().trim().min(1),
    name: z.string().trim().min(1),
    promptFacts: z.array(z.string().trim().min(1)).min(1),
  })).min(1),
}).superRefine((value, context) => {
  const ids = value.assets.map((asset) => asset.assetId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["assets"], message: "assetId 必须唯一" });
});
export type AssetBibleContentV3 = z.infer<typeof assetBibleContentV3Schema>;

const generatedShotV3Schema = z.object({
  displayId: z.string().trim().min(1),
  sceneId: z.string().trim().min(1),
  durationSec: z.number().positive(),
  action: z.string().trim().min(1),
  startState: z.string().trim().min(1),
  endState: z.string().trim().min(1),
  camera: z.object({ position: z.string().trim().min(1), movement: z.string().trim().min(1) }),
  assetIds: z.array(z.string().trim().min(1)),
});

export const generatedShootingScriptContentV3Schema = z.object({ shots: z.array(generatedShotV3Schema).min(1) });
export type GeneratedShootingScriptContentV3 = z.infer<typeof generatedShootingScriptContentV3Schema>;

export const shootingScriptContentV3Schema = z.object({
  shots: z.array(generatedShotV3Schema.extend({ shotUid: z.uuid() })).min(1),
}).superRefine((value, context) => {
  for (const [field, values] of [
    ["shotUid", value.shots.map((shot) => shot.shotUid)],
    ["displayId", value.shots.map((shot) => shot.displayId)],
  ] as const) {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: ["shots"], message: `${field} 必须唯一` });
  }
});
export type ShootingScriptContentV3 = z.infer<typeof shootingScriptContentV3Schema>;

const generatedStoryboardFrameV3Schema = z.object({
  displayId: z.string().trim().min(1),
  startFrame: z.string().trim().min(1),
  endFrame: z.string().trim().min(1),
  composition: z.string().trim().min(1),
  motion: z.string().trim().min(1),
});
export const generatedStoryboardContentV3Schema = z.object({ frames: z.array(generatedStoryboardFrameV3Schema).min(1) });
export type GeneratedStoryboardContentV3 = z.infer<typeof generatedStoryboardContentV3Schema>;

export const storyboardContentV3Schema = z.object({
  frames: z.array(generatedStoryboardFrameV3Schema.extend({ shotUid: z.uuid() })).min(1),
});
export type StoryboardContentV3 = z.infer<typeof storyboardContentV3Schema>;

export const generationPackageContentV3Schema = z.object({
  schemaVersion: z.literal("generation-package-v3"),
  sourceArtifactIds: z.array(z.string().trim().min(1)).length(3),
  tasks: z.array(z.object({
    shotUid: z.uuid(),
    displayId: z.string().trim().min(1),
    durationSec: z.number().positive(),
    prompt: z.string().trim().min(1),
    assetIds: z.array(z.string().trim().min(1)),
  })).min(1),
});
export type GenerationPackageContentV3 = z.infer<typeof generationPackageContentV3Schema>;

export interface GenerationTraceV3 {
  provider: string;
  model?: string;
  runId: string;
  threadId?: string | null;
  usage?: Record<string, unknown> | null;
  eventTypes?: string[];
  schemaVersion?: string;
  route?: string[];
  completedAt: string;
}

export interface GeneratedContentV3<T> {
  content: T;
  providerPayload?: unknown;
  trace: GenerationTraceV3;
}

export interface ArtifactInputRefV3 {
  artifactId: string;
  contentHash: string;
}

export interface ArtifactRecordV3<T = unknown> {
  schemaVersion: "workflow-v3-artifact-v1";
  artifactId: string;
  projectId: string;
  kind: ArtifactKindV3;
  version: number;
  ordinal: number;
  parentArtifactId: string | null;
  inputArtifactIds: string[];
  inputArtifactRefs: ArtifactInputRefV3[];
  contentHash: string;
  payload: T;
  createdAt: string;
}

export interface ContentGeneratorV3 {
  generateOutline(input: { project: ProjectV3; sourceText: string }): Promise<GeneratedContentV3<OutlineContentV3>>;
  generateScreenplay(input: {
    project: ProjectV3;
    sourceText: string;
    outline: OutlineContentV3;
    outlineProviderPayload?: unknown;
    outlineArtifact: ArtifactRecordV3;
  }): Promise<GeneratedContentV3<ScreenplayContentV3>>;
  generateAssetBible(input: {
    project: ProjectV3;
    sourceText: string;
    screenplay: ScreenplayContentV3;
    screenplayProviderPayload?: unknown;
    screenplayArtifact: ArtifactRecordV3;
  }): Promise<GeneratedContentV3<AssetBibleContentV3>>;
  generateShootingScript(input: {
    project: ProjectV3;
    sourceText: string;
    screenplay: ScreenplayContentV3;
    screenplayProviderPayload?: unknown;
    screenplayArtifact: ArtifactRecordV3;
    assetBible: AssetBibleContentV3;
    assetBibleProviderPayload?: unknown;
    assetBibleArtifact: ArtifactRecordV3;
  }): Promise<GeneratedContentV3<GeneratedShootingScriptContentV3>>;
  generateStoryboard(input: {
    project: ProjectV3;
    shootingScript: ShootingScriptContentV3;
    shootingScriptProviderPayload?: unknown;
    shootingScriptArtifact: ArtifactRecordV3;
    assetBible: AssetBibleContentV3;
    assetBibleProviderPayload?: unknown;
    assetBibleArtifact: ArtifactRecordV3;
  }): Promise<GeneratedContentV3<GeneratedStoryboardContentV3>>;
}

export interface VerificationCheckV3 {
  code: string;
  passed: boolean;
  evidence: string[];
}

export interface VerificationReceiptV3 {
  schemaVersion: "workflow-v3-verification-v1";
  receiptId: string;
  artifactId: string;
  artifactHash: string;
  verifierId: string;
  verifierVersion: string;
  status: "passed" | "failed" | "unknown";
  checks: VerificationCheckV3[];
  createdAt: string;
}

export interface ApprovalReceiptV3 {
  schemaVersion: "workflow-v3-approval-v1";
  receiptId: string;
  projectId: string;
  artifactId: string;
  artifactHash: string;
  verificationReceiptId: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  decidedBy: "human";
}

export interface AdoptionV3 {
  schemaVersion: "workflow-v3-adoption-v1";
  adoptionId: string;
  projectId: string;
  artifactKind: ArtifactKindV3;
  artifactId: string;
  artifactHash: string;
  approvalReceiptId: string;
  adoptedAt: string;
}

export interface AdoptionReceiptV3 {
  schemaVersion: "workflow-v3-adoption-receipt-v1";
  adoptionId: string;
  projectId: string;
  artifactKind: ArtifactKindV3;
  artifactId: string;
  artifactHash: string;
  approvalReceiptId: string;
  adoptedAt: string;
  adoptedBy: "human";
}

export interface ProductionGateResultV3 {
  schemaVersion: "workflow-v3-production-gate-v1";
  passed: boolean;
  blockers: Array<{ code: string; message: string; artifactId?: string }>;
  checkedArtifactIds: string[];
}
