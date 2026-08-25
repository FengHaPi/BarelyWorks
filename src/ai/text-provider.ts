import type { z } from "zod";
import type {
  assetBibleSchema,
  continuityReportSchema,
  screenplaySchema,
  shootingScriptSchema,
  storyboardSchema,
  storyOutlineSchema,
} from "../shared/skill-schemas";
import type { H3Mode, H3PromptOutput, H3ReferenceLabel } from "../shared/handoff-schemas";
import type { Asset, Project, ShotSpec } from "../shared/schemas";
import type { SkillProvenance } from "../skills/skill-registry";

export type StoryOutline = z.infer<typeof storyOutlineSchema>;
export type Screenplay = z.infer<typeof screenplaySchema>;
export type AssetBible = z.infer<typeof assetBibleSchema>;
export type ShootingScript = z.infer<typeof shootingScriptSchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;
export type ContinuityReport = z.infer<typeof continuityReportSchema>;
export type AssetDesignMode = "original-proposal" | "reference-first";

export interface OutlineGenerationInput {
  project: Project;
  sourceText: string;
}

export interface ScreenplayGenerationInput {
  project: Project;
  approvedOutline: StoryOutline | string;
  approvedOutlineRef: string;
  sourceText: string;
}

export interface AssetBibleGenerationInput {
  project: Project;
  approvedScreenplay: Screenplay | string;
  approvedScreenplayRef: string;
  sourceText: string;
  designMode: AssetDesignMode;
}

export interface ShootingScriptGenerationInput {
  project: Project;
  approvedScreenplay: Screenplay | string;
  approvedScreenplayRef: string;
  approvedAssetBible: AssetBible;
  approvedAssetBibleRef: string;
  generationConstraints: {
    provider: string;
    model: string;
    durationMinSec: number;
    durationMaxSec: number;
    maxShotsForTargetDuration: number;
    taskGranularity: "one-shot-per-generation-task";
  };
}

export interface StoryboardGenerationInput {
  project: Project;
  approvedShootingScript: ShootingScript;
  approvedShootingScriptRef: string;
  approvedAssetBible: AssetBible;
  approvedAssetBibleRef: string;
}

export interface ContinuityReviewInput {
  project: Project;
  approvedScreenplay: Screenplay | string;
  approvedAssetBible: AssetBible;
  approvedShootingScript: ShootingScript;
  storyboard: Storyboard;
}

export interface H3PromptGenerationInput {
  project: Project;
  shot: ShotSpec;
  storyboardShot: Storyboard["shots"][number];
  assets: Asset[];
  mode: H3Mode;
  referenceLabels: H3ReferenceLabel[];
}

export interface TextGenerationTrace {
  provider: "codex-cli" | "test-double";
  runId: string;
  threadId: string | null;
  usage: Record<string, unknown> | null;
  eventTypes: string[];
  schemaVersion: string;
  route: string[];
  skills: SkillProvenance[];
  durationMs?: number;
  completedAt: string;
}

export interface TextGenerationResult<T> {
  value: T;
  trace: TextGenerationTrace;
}

export interface TextIntelligenceProvider {
  generateOutline(input: OutlineGenerationInput): Promise<TextGenerationResult<StoryOutline>>;
  generateScreenplay(input: ScreenplayGenerationInput): Promise<TextGenerationResult<Screenplay>>;
  generateAssetBible(input: AssetBibleGenerationInput): Promise<TextGenerationResult<AssetBible>>;
  generateShootingScript(input: ShootingScriptGenerationInput): Promise<TextGenerationResult<ShootingScript>>;
  generateStoryboard(input: StoryboardGenerationInput): Promise<TextGenerationResult<Storyboard>>;
  reviewContinuity(input: ContinuityReviewInput): Promise<TextGenerationResult<ContinuityReport>>;
  generateH3Prompt(input: H3PromptGenerationInput): Promise<TextGenerationResult<H3PromptOutput>>;
  getSkillStatus?(): Promise<SkillProvenance[]>;
}
