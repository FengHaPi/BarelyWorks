export type ContinuityRepairKind =
  | "asset-aspect"
  | "asset-mirror-parity"
  | "shooting-timing"
  | "shooting-sound-sync"
  | "shooting-orientation-state"
  | "shooting-causal-visibility"
  | "shooting-prop-handoff"
  | "asset-version-lock"
  | "storyboard-scene-reference"
  | "storyboard-boundary-state"
  | "storyboard-physical-verification"
  | "generic-shooting-script"
  | "generic-storyboard";

export interface ContinuityRepairIssueLike {
  code: string;
  message?: string;
  suggestedFix?: string;
  affectedIds?: string[];
}

export type ContinuityRepairTarget = "asset-bible" | "shooting-script" | "storyboard";

export interface ContinuityRepairPlanStep {
  order: number;
  target: ContinuityRepairTarget;
  label: string;
  issueCount: number;
  issues: Array<{
    code: string;
    severity: string;
    message: string;
    suggestedFix: string;
    affectedIds: string[];
  }>;
  issueCodes: string[];
  affectedIds: string[];
  purpose: "repair" | "rebuild-and-review";
  actionLabel: string;
}

export interface ContinuityRepairPlan {
  sourceStoryboardArtifactId: string;
  totalIssueCount: number;
  repairableIssueCodes: string[];
  manualIssueCodes: string[];
  steps: ContinuityRepairPlanStep[];
  currentStep: ContinuityRepairPlanStep | null;
  requiresApprovalBetweenSteps: true;
}

export function continuityRepairKind(code: string): ContinuityRepairKind | null {
  if (code.includes("ASPECT_RATIO")) return "asset-aspect";
  if (code.includes("MIRROR_PARITY_RULE_UNDEFINED")) return "asset-mirror-parity";
  if (code.includes("TIMING_AMBIGUOUS")) return "shooting-timing";
  if (code.includes("LIGHT_SOUND_SYNC_TIMECODE_CONFLICT") || (code.includes("SOUND_SYNC") && code.includes("TIMECODE"))) return "shooting-sound-sync";
  if (code.includes("CHARACTER_ORIENTATION_STATE_CONFLICT")) return "shooting-orientation-state";
  if (code.includes("PHYSICAL_TIMED_GATE_EARLY_REVEAL")) return "shooting-causal-visibility";
  if (code.includes("PROP_POSITION_HANDOFF_DISCONTINUITY")) return "shooting-prop-handoff";
  if (code.includes("ASSET_VERSION_LOCK_UNVERIFIABLE")) return "asset-version-lock";
  if (code.includes("NEAR_SCENE_ASSET_NOT_LOCKED") || code.includes("SCENE_REFERENCE_MISSING")) return "storyboard-scene-reference";
  if (code.includes("BOUNDARY_FRAME_STATE_UNDERSPECIFIED")) return "storyboard-boundary-state";
  if (/^PHYSICAL_.+_STORYBOARD_FAILED$/.test(code)) return "storyboard-physical-verification";
  return null;
}

export function continuityRepairKindForIssue(issue: ContinuityRepairIssueLike): ContinuityRepairKind | null {
  const known = continuityRepairKind(issue.code);
  if (known) return known;
  if (!issue.suggestedFix?.trim()) return null;

  const text = `${issue.code} ${issue.message ?? ""} ${issue.suggestedFix}`;
  const requiresUpstreamShotSpec = /(?:ShotSpec|physicalPlan|cameraSegments|subjectOrientations|displayRelations|timedStateGates|startState|endState|导演脚本|动作与表演|\baction\b|\bsound\b)/iu.test(text);
  const explicitlyStoryboardOnly = /(?:分镜|起始帧|结束帧|motionPlan|composition|physicalVerification)/iu.test(text);
  return explicitlyStoryboardOnly && !requiresUpstreamShotSpec ? "generic-storyboard" : "generic-shooting-script";
}

export function isContinuityIssueRepairable(issueOrCode: string | ContinuityRepairIssueLike): boolean {
  return typeof issueOrCode === "string"
    ? continuityRepairKind(issueOrCode) !== null
    : continuityRepairKindForIssue(issueOrCode) !== null;
}

export function continuityRepairTargetForIssue(issue: ContinuityRepairIssueLike): ContinuityRepairTarget | null {
  const kind = continuityRepairKindForIssue(issue);
  if (!kind) return null;
  if (kind === "asset-aspect" || kind === "asset-mirror-parity") return "asset-bible";
  if (kind === "storyboard-scene-reference" || kind === "storyboard-boundary-state"
    || kind === "storyboard-physical-verification" || kind === "generic-storyboard") return "storyboard";
  return "shooting-script";
}
