import { describe, expect, it } from "vitest";
import { hasReachedProjectStage, projectStageOrder } from "./workflow-stage";

describe("workflow stage progress", () => {
  it("keeps every project stage in one unique ordered sequence", () => {
    expect(projectStageOrder).toHaveLength(18);
    expect(new Set(projectStageOrder).size).toBe(projectStageOrder.length);
  });

  it("treats downstream stages as having reached generation", () => {
    expect(hasReachedProjectStage("STORYBOARD_REVIEW", "STORYBOARD_APPROVED")).toBe(false);
    expect(hasReachedProjectStage("STORYBOARD_APPROVED", "STORYBOARD_APPROVED")).toBe(true);
    expect(hasReachedProjectStage("GENERATION_REVIEW", "STORYBOARD_APPROVED")).toBe(true);
    expect(hasReachedProjectStage("EDITING", "STORYBOARD_APPROVED")).toBe(true);
    expect(hasReachedProjectStage("FINAL_REVIEW", "STORYBOARD_APPROVED")).toBe(true);
    expect(hasReachedProjectStage("DELIVERED", "STORYBOARD_APPROVED")).toBe(true);
  });

  it("is monotonic for every possible current stage", () => {
    for (const [targetIndex, target] of projectStageOrder.entries()) {
      for (const [currentIndex, current] of projectStageOrder.entries()) {
        expect(hasReachedProjectStage(current, target)).toBe(currentIndex >= targetIndex);
      }
    }
  });
});
