import type { z } from "zod";
import type {
  assetBibleSchema,
  assetReferencePromptOutputSchema,
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
export type AssetReferencePromptOutput = z.infer<typeof assetReferencePromptOutputSchema>;
export type ShootingScript = z.infer<typeof shootingScriptSchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;
export type ContinuityReport = z.infer<typeof continuityReportSchema>;
export type AssetDesignMode = "original-proposal" | "reference-first";

export interface ProviderOperationContext {
  signal?: AbortSignal;
  onEvent?: (eventType: string, payload?: Record<string, unknown>) => void;
  onProcessId?: (processId: number | null) => void;
}

export interface ApprovedAssetBibleLock {
  artifactId: string;
  version: number;
  contentHash: string;
  reference: string;
  appliesTo: Array<"approvedShootingScript" | "storyboardUnderReview">;
}

export interface OutlineGenerationInput {
  project: Project;
  sourceText: string;
  operation?: ProviderOperationContext;
}

export interface ScreenplayGenerationInput {
  project: Project;
  approvedOutline: StoryOutline | string;
  approvedOutlineRef: string;
  sourceText: string;
  operation?: ProviderOperationContext;
}

export interface AssetBibleGenerationInput {
  project: Project;
  approvedScreenplay: Screenplay | string;
  approvedScreenplayRef: string;
  sourceText: string;
  designMode: AssetDesignMode;
  operation?: ProviderOperationContext;
}

export interface AssetReferencePromptGenerationInput {
  project: Project;
  asset: Asset;
  allAssets: Asset[];
  role: "主参考" | "正面" | "侧面" | "背面" | "表情" | "服装" | "其他";
  operation?: ProviderOperationContext;
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
    durationStepSec: 1;
    preferredShotDurationSec: number;
    minimumShotsForTargetDuration: number;
    recommendedMinimumShots: number;
    maxShotsForTargetDuration: number;
    segmentationPolicy: "content-led-longest-feasible";
    avoidDurationPadding: true;
    taskGranularity: "one-shot-per-generation-task";
    maxMajorBeatsPerShot: 4;
    maxCameraPhasesPerShot: 3;
    maxTimedStateGatesPerShot: 6;
    maxHighRiskLayersPerShot: 2;
  };
  correctionFeedback?: string[];
  operation?: ProviderOperationContext;
}

export interface StoryboardGenerationInput {
  project: Project;
  approvedShootingScript: ShootingScript;
  approvedShootingScriptRef: string;
  approvedAssetBible: AssetBible;
  approvedAssetBibleRef: string;
  operation?: ProviderOperationContext;
}

export interface ContinuityRepairRequestIssue {
  code: string;
  message: string;
  affectedIds: string[];
  suggestedFix: string;
}

export interface ShootingScriptRepairInput {
  project: Project;
  currentShootingScript: ShootingScript;
  approvedAssetBible: AssetBible;
  approvedAssetBibleRef: string;
  issues: ContinuityRepairRequestIssue[];
  operation?: ProviderOperationContext;
}

export interface StoryboardRepairInput {
  project: Project;
  currentStoryboard: Storyboard;
  approvedShootingScript: ShootingScript;
  approvedShootingScriptRef: string;
  approvedAssetBible: AssetBible;
  approvedAssetBibleRef: string;
  issues: ContinuityRepairRequestIssue[];
  operation?: ProviderOperationContext;
}

export interface ContinuityReviewInput {
  project: Project;
  approvedScreenplay: Screenplay | string;
  approvedAssetBible: AssetBible;
  approvedAssetBibleRef: string;
  approvedAssetBibleLock: ApprovedAssetBibleLock;
  approvedShootingScript: ShootingScript;
  approvedShootingScriptRef: string;
  storyboard: Storyboard;
  operation?: ProviderOperationContext;
}

export interface H3PromptGenerationInput {
  project: Project;
  shot: ShotSpec;
  storyboardShot: Storyboard["shots"][number];
  assets: Asset[];
  mode: H3Mode;
  referenceLabels: H3ReferenceLabel[];
  correctionFeedback?: string[];
  operation?: ProviderOperationContext;
}

export interface TextGenerationTrace {
  provider: "codex-cli" | "test-double";
  model?: string;
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
  generateAssetReferencePrompt(input: AssetReferencePromptGenerationInput): Promise<TextGenerationResult<AssetReferencePromptOutput>>;
  generateShootingScript(input: ShootingScriptGenerationInput): Promise<TextGenerationResult<ShootingScript>>;
  generateStoryboard(input: StoryboardGenerationInput): Promise<TextGenerationResult<Storyboard>>;
  repairShootingScript?(input: ShootingScriptRepairInput): Promise<TextGenerationResult<ShootingScript>>;
  repairStoryboard?(input: StoryboardRepairInput): Promise<TextGenerationResult<Storyboard>>;
  reviewContinuity(input: ContinuityReviewInput): Promise<TextGenerationResult<ContinuityReport>>;
  generateH3Prompt(input: H3PromptGenerationInput): Promise<TextGenerationResult<H3PromptOutput>>;
  getSkillStatus?(): Promise<SkillProvenance[]>;
  getTextModel?(): string;
}
