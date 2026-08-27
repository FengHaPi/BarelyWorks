import { describe, expect, it } from "vitest";
import { currentProjectStepIndex, projectStepState, projectWorkbenchSteps } from "./project-workbench";
import type { Project, ProjectIntegrityAudit } from "./types";

function project(currentStage: Project["currentStage"], staleStages: Project["staleStages"] = []): Project {
  return {
    id: "project-1", title: "测试项目", sourceType: "story", targetDurationSec: 20,
    aspectRatio: "16:9", resolution: "1280x720", videoType: null, visualStyle: null,
    releasePlatform: null, targetAudience: null, allowStorySuggestions: true,
    currentStage, staleStages, sourcePath: "source.txt", projectDir: "project",
    archivedAt: null, createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("project workbench navigation", () => {
  it("keeps all nine project steps addressable after delivery", () => {
    expect(projectWorkbenchSteps).toHaveLength(9);
    expect(currentProjectStepIndex("DELIVERED")).toBe(8);
    expect(projectWorkbenchSteps[1].artifactType).toBe("outline");
    expect(projectWorkbenchSteps[5].artifactType).toBe("storyboard");
  });

  it("shows completed projects as reviewable history instead of future steps", () => {
    const delivered = project("DELIVERED");
    expect(projectWorkbenchSteps.map((_, index) => projectStepState(delivered, index))).toEqual([
      "done", "done", "done", "done", "done", "done", "done", "done", "done",
    ]);
  });

  it("surfaces stale earlier work as needing an update", () => {
    const revised = project("SHOOTING_SCRIPT_REVIEW", ["SCREENPLAY_APPROVED", "ASSET_BIBLE_REVIEW"]);
    expect(projectStepState(revised, 2)).toBe("needs-update");
    expect(projectStepState(revised, 3)).toBe("needs-update");
    expect(projectStepState(revised, 4)).toBe("current");
    expect(projectStepState(revised, 5)).toBe("future");
  });

  it("uses evidence audit failures instead of trusting a delivered stage label", () => {
    const delivered = project("DELIVERED");
    const audit: ProjectIntegrityAudit = {
      projectId: delivered.id,
      status: "blocked",
      firstBlockedStepId: "storyboard",
      issues: [{ stepId: "storyboard", code: "CONTINUITY_REPORT_MISSING", message: "连续性报告不存在", severity: "error" }],
      checkedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(projectStepState(delivered, 5, audit)).toBe("needs-update");
    expect(projectStepState(delivered, 6, audit)).toBe("needs-update");
    expect(projectStepState(delivered, 8, audit)).toBe("needs-update");
  });
});
