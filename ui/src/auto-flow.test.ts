import { describe, expect, it } from "vitest";
import { generationPreparationPlan, legacyPhysicalShotIds, nextArtifactAfterApproval, packageCandidates, shotPreflightLabel, shouldAutoRenderAfterReview } from "./auto-flow";

describe("explicit action flow", () => {
  it("never chooses a follow-up artifact after approval", () => {
    expect(nextArtifactAfterApproval("OUTLINE_REVIEW")).toBeNull();
    expect(nextArtifactAfterApproval("SHOOTING_SCRIPT_REVIEW")).toBeNull();
    expect(nextArtifactAfterApproval("STORYBOARD_REVIEW")).toBeNull();
  });

  it("never chains generation preparation steps", () => {
    expect(generationPreparationPlan("STORYBOARD_APPROVED", false)).toEqual([]);
    expect(generationPreparationPlan("ASSETS_LOCKED", false)).toEqual([]);
    expect(generationPreparationPlan("READY_FOR_GENERATION", true)).toEqual([]);
  });

  it("generates only missing packages that passed preflight", () => {
    const result = packageCandidates([
      { shot: { id: "S001" }, preflight: { passed: true }, packages: [{ isStale: false }] },
      { shot: { id: "S002" }, preflight: { passed: true }, packages: [] },
      { shot: { id: "S003" }, preflight: { passed: false }, packages: [] },
      { shot: { id: "S004" }, preflight: { passed: true }, packages: [{ isStale: true }] },
    ] as never);
    expect(result).toEqual({ eligibleIds: ["S002", "S004"], blockedIds: ["S003"] });
  });

  it("separates legacy shots from physical-plan preflight success", () => {
    const shots = [
      { shot: { id: "S001", physicalPlan: null }, preflight: { passed: true } },
      { shot: { id: "S002", physicalPlan: { schemaVersion: "shot-physical-plan-v1" } }, preflight: { passed: true } },
    ];
    expect(legacyPhysicalShotIds(shots as never)).toEqual(["S001"]);
    expect(shotPreflightLabel(shots[0].shot as never, true)).toBe("LEGACY RULES");
    expect(shotPreflightLabel(shots[1].shot as never, true)).toBe("PREFLIGHT OK");
    expect(shotPreflightLabel(shots[1].shot as never, false)).toBe("BLOCKED");
  });

  it("never creates a rough cut after a review", () => {
    const base = {
      decision: "accepted" as const,
      currentShotId: "S002",
      shots: [{ id: "S001" }, { id: "S002" }],
      generations: [{ shotId: "S001", status: "accepted" as const }],
      stage: "GENERATION_REVIEW" as const,
      roughCutReady: true,
    };
    expect(shouldAutoRenderAfterReview(base)).toBe(false);
    expect(shouldAutoRenderAfterReview({ ...base, roughCutReady: false })).toBe(false);
    expect(shouldAutoRenderAfterReview({ ...base, decision: "conditional-pass" })).toBe(false);
    expect(shouldAutoRenderAfterReview({ ...base, decision: "retry-same-model" })).toBe(false);
    expect(shouldAutoRenderAfterReview({ ...base, generations: [] })).toBe(false);
  });
});
