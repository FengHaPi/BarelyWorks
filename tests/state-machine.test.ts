import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, initialStageBySourceType } from "../src/workflow/state-machine";

describe("project workflow", () => {
  it("routes each source type to its actual entry stage", () => {
    expect(initialStageBySourceType.story).toBe("SOURCE_IMPORTED");
    expect(initialStageBySourceType.screenplay).toBe("SCREENPLAY_REVIEW");
    expect(initialStageBySourceType["shooting-script"]).toBe("SHOOTING_SCRIPT_REVIEW");
    expect(initialStageBySourceType.storyboard).toBe("STORYBOARD_REVIEW");
  });

  it("does not allow skipping approval gates", () => {
    expect(canTransition("OUTLINE_REVIEW", "SCREENPLAY_REVIEW")).toBe(false);
    expect(() => assertTransition("OUTLINE_REVIEW", "SCREENPLAY_REVIEW")).toThrow(/不允许/);
  });
});
