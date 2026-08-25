export type SourceType = "story" | "screenplay" | "shooting-script" | "storyboard";

export type ProjectStage =
  | "SOURCE_IMPORTED"
  | "OUTLINE_REVIEW"
  | "OUTLINE_APPROVED"
  | "SCREENPLAY_REVIEW"
  | "SCREENPLAY_APPROVED"
  | "ASSET_BIBLE_REVIEW"
  | "ASSET_BIBLE_APPROVED"
  | "SHOOTING_SCRIPT_REVIEW"
  | "SHOOTING_SCRIPT_APPROVED"
  | "STORYBOARD_REVIEW"
  | "STORYBOARD_APPROVED"
  | "ASSETS_LOCKED"
  | "READY_FOR_GENERATION"
  | "GENERATING"
  | "GENERATION_REVIEW"
  | "EDITING"
  | "FINAL_REVIEW"
  | "DELIVERED";

export interface Project {
  id: string;
  title: string;
  sourceType: SourceType;
  targetDurationSec: number;
  aspectRatio: string;
  resolution: string;
  videoType: string | null;
  visualStyle: string | null;
  releasePlatform: string | null;
  targetAudience: string | null;
  allowStorySuggestions: boolean;
  currentStage: ProjectStage;
  staleStages: ProjectStage[];
  sourcePath: string;
  projectDir: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  title: string;
  sourceType: SourceType;
  sourceText: string;
  targetDurationSec: number;
  aspectRatio: string;
  resolution: string;
  videoType: string;
  visualStyle: string;
  releasePlatform: string;
  targetAudience: string;
  allowStorySuggestions: boolean;
}

export interface Health {
  ok: boolean;
  version: string;
  bind: string;
  paidVideoApiEnabled: boolean;
  skillDrivenTextGeneration: boolean;
  textSkills: SkillProvenance[];
  skillLoadError: string | null;
  mediaTools: MediaToolStatus;
}

export interface SkillProvenance {
  name: string;
  version: string;
  sha256: string;
  sourceFiles: string[];
}

export type ArtifactType = "outline" | "screenplay" | "asset-bible" | "shooting-script" | "storyboard";
export type ArtifactStatus = "draft" | "approved" | "rejected" | "stale";

export interface Artifact {
  id: string;
  projectId: string;
  type: ArtifactType;
  version: number;
  filePath: string;
  structuredPath: string | null;
  contentHash: string;
  status: ArtifactStatus;
  sourceArtifactId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  content: string;
}

export type AssetType = "character" | "scene" | "prop" | "costume" | "style" | "audio" | "reference";
export type AssetDesignMode = "original-proposal" | "reference-first";

export interface Asset {
  id: string;
  projectId: string;
  type: AssetType;
  name: string;
  version: number;
  localFiles: string[];
  sha256: string[];
  approved: boolean;
  authorizationState: "confirmed" | "missing" | "not-required" | "unknown";
  uploadState: Record<string, "not-uploaded" | "uploaded" | "unknown">;
  referencedBy: string[];
  identity: string;
  appearance: string;
  designBasis: "source-grounded" | "creative-proposal" | "reference-guided";
  productionReady: boolean;
  designSummary: string;
  distinctiveFeatures: string[];
  negativeConstraints: string[];
  fileRoles: string[];
  continuityRules: string[];
  usage: string[];
  sourceEvidence: string[];
  unknowns: string[];
}

export interface ShotSpec {
  id: string;
  projectId: string;
  sequence: number;
  startTimeSec: number;
  endTimeSec: number;
  durationSec: number;
  purpose: string;
  characterIds: string[];
  sceneId: string;
  propIds: string[];
  styleIds: string[];
  shotSize: string;
  camera: { position: string; movement: string; lens?: string | null; composition?: string | null };
  action: string;
  dialogue: Array<{ speakerId: string; text: string; language: string }>;
  sound: string[];
  startState: string;
  endState: string;
  preferredProvider?: string | null;
  status: "draft" | "review" | "approved" | "stale" | "generating" | "generated" | "accepted" | "rejected";
}

export type H3Mode = "T2VA" | "I2VA" | "FL2VA" | "L2VA" | "Ref2VA";
export type GenerationResolution = "platform-default" | "480p" | "720p" | "768p" | "1080p";
export interface H3ReferenceLabel {
  assetId: string;
  label: string;
  kind: "image" | "video" | "audio";
  filePath: string;
  role: string;
}
export interface H3Preflight {
  passed: boolean;
  mode: H3Mode;
  errors: string[];
  warnings: string[];
  references: H3ReferenceLabel[];
}
export interface H3Capabilities {
  provider: "minimax";
  model: "MiniMax H3";
  modes: H3Mode[];
  durationMinSec: number;
  durationMaxSec: number;
  aspectRatios: string[];
  defaultShortSide: number;
  maxReferenceImages: number;
  maxReferenceVideos: number;
  maxReferenceAudioFiles: number;
  maxMixedReferences: number;
  supportsAudioInput: boolean;
  supportsReferenceVideo: boolean;
  verifiedAt: string;
  source: string;
}
export interface HandoffPackageSummary {
  shotId: string;
  version: number;
  path: string;
  promptPath: string;
  createdAt: string;
  mode: H3Mode;
  generationResolution: GenerationResolution;
  uploadState: "not-uploaded" | "uploaded";
}
export interface GenerationCenter {
  project: Project;
  capabilities: H3Capabilities;
  skills: SkillProvenance[];
  bootstrap: { path: string; createdAt: string; assetCount: number } | null;
  assets: Asset[];
  shots: Array<{ shot: ShotSpec; preflight: H3Preflight; packages: HandoffPackageSummary[] }>;
}

export interface MediaToolStatus {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  libx264Available: boolean;
  aacAvailable: boolean;
  roughCutReady: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  ffmpegPath: string;
  ffprobePath: string;
  setupDirectory: string;
}

export interface MediaMetadata {
  durationSec: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  formatName: string;
  sizeBytes: number;
}

export interface ImportedGeneration {
  id: string;
  projectId: string;
  shotId: string;
  provider: string;
  model?: string | null;
  mode: "manual" | "api";
  promptVersion: number;
  referenceAssetIds: string[];
  status: "draft" | "approved" | "submitted" | "running" | "downloaded" | "review" | "accepted" | "failed";
  retryCount: number;
  parameterHash: string;
  sourceFileName: string;
  sourceHash: string;
  importedPath: string;
  reviewFramePaths: string[];
  generationVersion: number;
  media: MediaMetadata;
  createdAt: string;
  updatedAt: string;
}

export const reviewDimensions = [
  "identity", "costume-props", "scene", "action", "camera", "composition-direction",
  "start-end-state", "picture-quality", "sound-quality",
] as const;
export type ReviewDimension = typeof reviewDimensions[number];
export type ReviewDimensionStatus = "pass" | "warning" | "fail" | "not-reviewed";
export type QualityDecision = "accepted" | "conditional-pass" | "retry-same-model" | "revise-prompt-retry" | "switch-model" | "manual-fix";

export interface QualityReviewInput {
  dimensions: Array<{ dimension: ReviewDimension; status: ReviewDimensionStatus; note: string; evidence: string }>;
  decision: QualityDecision;
  summary: string;
  conditions: string[];
  retryInstructions: string[];
  unverifiedClaims: string[];
}

export interface QualityReview extends QualityReviewInput {
  id: string;
  projectId: string;
  jobId: string;
  shotId: string;
  generationVersion: number;
  reviewer: "human";
  skill: SkillProvenance;
  createdAt: string;
}

export interface RenderRecord {
  id: string;
  projectId: string;
  version: number;
  status: "rendering" | "review" | "approved" | "rejected" | "failed";
  videoPath: string;
  subtitlePath: string | null;
  reportPath: string;
  sourceJobIds: string[];
  media: MediaMetadata | null;
  error: string | null;
  deliveryVideoPath: string | null;
  deliverySubtitlePath: string | null;
  deliveryReportPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QualityCenter {
  project: Project;
  mediaTools: MediaToolStatus;
  inboxPath: string;
  skill: SkillProvenance;
  shots: ShotSpec[];
  generations: ImportedGeneration[];
  reviews: QualityReview[];
  renders: RenderRecord[];
}

export interface GenerationScanResult {
  project: Project;
  imported: ImportedGeneration[];
  skipped: Array<{ fileName: string; reason: string }>;
  errors: Array<{ fileName: string; reason: string }>;
}
