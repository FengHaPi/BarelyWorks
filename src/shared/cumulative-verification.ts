import type { ArtifactType } from "./schemas";

export const cumulativeVerificationStageIds = [
  "source", "outline", "screenplay", "asset-bible", "shooting-script", "storyboard", "production",
] as const;

export type CumulativeVerificationStageId = (typeof cumulativeVerificationStageIds)[number];
export type CumulativeVerificationTarget = ArtifactType | "production";
export type VerificationCheckStatus = "passed" | "failed" | "unknown";

export interface VerificationDetector {
  id: string;
  kind: "deterministic" | "model-skill" | "human";
  name: string;
  version: string;
  health: "healthy" | "unavailable" | "failed";
  model: string | null;
  runId: string | null;
  skillName: string | null;
  skillVersion: string | null;
  skillHash: string | null;
  detail: string;
}

export interface CumulativeVerificationCheck {
  code: string;
  status: VerificationCheckStatus;
  severity: "error" | "warning" | "info";
  blocking: boolean;
  message: string;
  suggestedAction: string | null;
  detectorId: string;
  responsibleStage: CumulativeVerificationStageId;
  evidence: string[];
}

export interface CumulativeVerificationStage {
  id: CumulativeVerificationStageId;
  label: string;
  status: "passed" | "blocked" | "incomplete" | "not-applicable";
  artifact: {
    id: string;
    type: ArtifactType;
    version: number;
    status: string;
    contentHash: string;
    isHead: boolean;
  } | null;
  checks: CumulativeVerificationCheck[];
}

export interface CumulativeVerificationLedger {
  schemaVersion: "cumulative-verification-v1";
  projectId: string;
  target: CumulativeVerificationTarget;
  targetArtifactId: string | null;
  status: "healthy" | "blocked" | "incomplete";
  earliestResponsibleStage: CumulativeVerificationStageId | null;
  blockerCount: number;
  incompleteCount: number;
  checkedAt: string;
  detectors: VerificationDetector[];
  stages: CumulativeVerificationStage[];
}

export function verificationBlockingChecks(ledger: CumulativeVerificationLedger): CumulativeVerificationCheck[] {
  return ledger.stages.flatMap((stage) => stage.checks)
    .filter((check) => check.blocking && check.status !== "passed");
}
