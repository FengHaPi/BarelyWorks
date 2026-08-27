import type { ArtifactType, GenerationCenter, ImportedGeneration, ProjectStage, QualityDecision, ShotSpec } from "./types";

export const nextArtifactByApprovedStage: Partial<Record<ProjectStage, ArtifactType>> = {
  OUTLINE_APPROVED: "screenplay",
  SCREENPLAY_APPROVED: "asset-bible",
  ASSET_BIBLE_APPROVED: "shooting-script",
  SHOOTING_SCRIPT_APPROVED: "storyboard",
};

/** @deprecated Approval is evidence for one artifact and must never trigger another command. */
export function nextArtifactAfterApproval(_stage: ProjectStage): ArtifactType | null {
  return null;
}

export type GenerationPreparationStep = "lock-assets" | "create-bootstrap";

/** @deprecated Preparation commands are explicit, one-operation actions. */
export function generationPreparationPlan(_stage: ProjectStage, _hasBootstrap: boolean): GenerationPreparationStep[] {
  return [];
}

export function packageCandidates(shots: GenerationCenter["shots"]): { eligibleIds: string[]; blockedIds: string[] } {
  const missing = shots.filter((item) => !item.packages.some((packageSummary) => !packageSummary.isStale));
  return {
    eligibleIds: missing.filter((item) => item.preflight.passed).map((item) => item.shot.id),
    blockedIds: missing.filter((item) => !item.preflight.passed).map((item) => item.shot.id),
  };
}

export function legacyPhysicalShotIds(shots: GenerationCenter["shots"]): string[] {
  return shots.filter(({ shot }) => !shot.physicalPlan).map(({ shot }) => shot.id);
}

export function shotPreflightLabel(shot: Pick<ShotSpec, "physicalPlan">, passed: boolean): "PREFLIGHT OK" | "LEGACY RULES" | "BLOCKED" {
  if (!passed) return "BLOCKED";
  return shot.physicalPlan ? "PREFLIGHT OK" : "LEGACY RULES";
}

export function shouldAutoRenderAfterReview(input: {
  decision: QualityDecision;
  currentShotId: string;
  shots: Pick<ShotSpec, "id">[];
  generations: Pick<ImportedGeneration, "shotId" | "status">[];
  stage: ProjectStage;
  roughCutReady: boolean;
}): boolean {
  void input;
  return false;
}
